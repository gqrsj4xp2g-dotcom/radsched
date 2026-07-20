-- Secure server-side open-shift claim. Replaces the client-side claimShift
-- blob mutation (any same-practice user could otherwise insert arbitrary shift
-- rows from devtools). SECURITY DEFINER: runs as owner, resolves the caller's
-- physId from the roster via auth.uid() (user_metadata physId is untrusted),
-- enforces the hard invariants atomically (row lock), materializes exactly one
-- claim, and stamps savedAt so clients see it.
create or replace function public.rs_claim_open_shift(p_practice text, p_oid bigint, p_pid integer default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean; v_pid integer;
  v_open jsonb; v_idx int; v_group text; v_date text; v_site text; v_sub text; v_stype text; v_ym text;
  v_nextid bigint; v_p jsonb; v_role text; v_irfte numeric; v_irgroup text; v_irsiteprim text;
  v_newshift jsonb; v_is_weekend boolean; v_resolved_site text;
  v_dr_conflict boolean; v_we_conflict boolean; v_has_ir boolean;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_oid is null then return jsonb_build_object('ok',false,'error','bad args'); end if;

  select data::jsonb into v_blob from public.radscheduler where id = p_practice for update;   -- atomic
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  -- Trusted caller identity from the roster (never a client-supplied physId).
  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id') = (auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);
  if v_is_admin then
    v_pid := coalesce(p_pid, v_caller_pid);
  else
    if v_caller_pid is null then return jsonb_build_object('ok',false,'error','caller not on roster'); end if;
    if p_pid is not null and p_pid <> v_caller_pid then return jsonb_build_object('ok',false,'error','you can only claim for yourself'); end if;
    v_pid := v_caller_pid;
  end if;
  if v_pid is null then return jsonb_build_object('ok',false,'error','no physician resolved'); end if;

  select value, (ordinality-1)::int into v_open, v_idx
  from jsonb_array_elements(coalesce(v_blob->'openShifts','[]'::jsonb)) with ordinality
  where (value->>'id')::bigint = p_oid limit 1;
  if v_open is null then return jsonb_build_object('ok',false,'error','open shift not found'); end if;
  if coalesce(v_open->>'claimedBy','') <> '' then return jsonb_build_object('ok',false,'error','already claimed'); end if;

  v_group := coalesce(v_open->>'group','DR'); v_date := v_open->>'date';
  v_site := coalesce(v_open->>'site',''); v_sub := coalesce(v_open->>'sub','');
  v_stype := coalesce(v_open->>'shiftType','');
  if v_date is null or v_date !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'error','malformed date'); end if;
  v_ym := substring(v_date,1,7);
  if (v_blob->'lockedMonths') ? v_ym then return jsonb_build_object('ok',false,'error','month locked'); end if;

  select value into v_p from jsonb_array_elements(coalesce(v_blob->'physicians','[]'::jsonb)) value
  where (value->>'id')::int = v_pid limit 1;
  if v_p is null then return jsonb_build_object('ok',false,'error','physician not found'); end if;
  v_role := coalesce(v_p->>'role','DR'); v_irfte := coalesce((v_p->>'irFte')::numeric,0);
  v_irgroup := coalesce(v_p->>'irGroup',''); v_irsiteprim := coalesce(v_p->>'irSitePrim','');
  v_is_weekend := (v_stype like '%Weekend%');
  if v_group='DR' and v_role='IR' then return jsonb_build_object('ok',false,'error','IR-only physician cannot claim a DR shift'); end if;
  if v_group='IR' and not (v_irfte > 0) then return jsonb_build_object('ok',false,'error','only IR physicians can claim an IR shift'); end if;

  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);
  if v_group='IR' then
    v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_date,'callType','daily','irGroup',v_irgroup,'site',v_site,'notes','Claimed');
    v_blob := jsonb_set(v_blob,'{irCalls}', coalesce(v_blob->'irCalls','[]'::jsonb) || v_newshift); v_nextid := v_nextid+1;
    v_has_ir := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s where (s->>'physId')::int=v_pid and s->>'date'=v_date);
    v_dr_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s where (s->>'physId')::int=v_pid and s->>'date'=v_date and coalesce(s->>'shift','')<>'Home');
    v_we_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) w where (w->>'physId')::int=v_pid and (w->>'satDate'=v_date or w->>'sunDate'=v_date or w->>'date'=v_date));
    if not v_has_ir and not v_dr_conflict and not v_we_conflict then
      v_resolved_site := coalesce(nullif(v_site,''), nullif(v_irsiteprim,''), 'At Home / Remote');
      v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_date,'shift','1st','site',v_resolved_site,'sub','','notes','Auto-paired with IR call (open-shift-claim)','irGroup',v_irgroup);
      v_blob := jsonb_set(v_blob,'{irShifts}', coalesce(v_blob->'irShifts','[]'::jsonb) || v_newshift); v_nextid := v_nextid+1;
    end if;
  elsif v_is_weekend then
    v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'satDate',v_date,'sunDate',to_char((v_date::date+1),'YYYY-MM-DD'),'sub',v_sub,'site',v_site,'ctype','Primary','notes','Claimed');
    v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce(v_blob->'weekendCalls','[]'::jsonb) || v_newshift); v_nextid := v_nextid+1;
  else
    v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_date,'shift','1st','site',v_site,'sub',v_sub,'notes','Claimed','autoHome',false);
    v_blob := jsonb_set(v_blob,'{drShifts}', coalesce(v_blob->'drShifts','[]'::jsonb) || v_newshift); v_nextid := v_nextid+1;
  end if;

  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], to_jsonb(v_pid));
  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedAt'], to_jsonb(v_now));
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));

  update public.radscheduler set data = v_blob::text where id = p_practice;
  return jsonb_build_object('ok',true,'oid',p_oid,'pid',v_pid,'group',v_group,'date',v_date,'shiftId',v_nextid-1);
end;
$$;
revoke all on function public.rs_claim_open_shift(text,bigint,integer) from public, anon;
grant execute on function public.rs_claim_open_shift(text,bigint,integer) to authenticated;;
