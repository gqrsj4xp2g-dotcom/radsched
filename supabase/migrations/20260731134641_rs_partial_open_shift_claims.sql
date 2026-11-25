-- Partial claiming of market shifts (2026-07-31).
-- Every open shift is offered as DAYS (Weekend Call = its Sat + Sun;
-- everything else the single posted date); each day is claimable whole or as
-- an HH:MM hour range. Claims accumulate on the open-shift row in
-- `claims` [{cid, physId, date, from, to, at, rows:[materialized row ids]}].
-- A whole-day claim closes its day (a blank-hours claim takes the remainder
-- of a partially-claimed day); claimedBy is set only when every offered day
-- is closed, so legacy `!claimedBy` open filters keep working. Old 3-arg /
-- 2-arg signatures are DROPPED (CREATE OR REPLACE would otherwise leave the
-- claims-unaware overloads callable and double-materialize claimed days).

DROP FUNCTION IF EXISTS public.rs_claim_open_shift(text, bigint, integer);
DROP FUNCTION IF EXISTS public.rs_unclaim_open_shift(text, bigint);

CREATE FUNCTION public.rs_claim_open_shift(p_practice text, p_oid bigint, p_pid integer DEFAULT NULL, p_parts jsonb DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean; v_pid integer;
  v_open jsonb; v_idx int; v_group text; v_date text; v_site text; v_sub text; v_stype text; v_ym text;
  v_nextid bigint; v_p jsonb; v_role text; v_irfte numeric; v_irgroup text; v_irsiteprim text;
  v_is_weekend boolean; v_wshift text; v_sun text;
  v_days text[]; v_claims jsonb; v_parts jsonb; v_part jsonb; v_pa jsonb; v_pb jsonb;
  v_pd text; v_pf text; v_pt text; v_lbl text; v_hours text;
  v_legacy_full boolean; v_all_closed boolean;
  v_newshift jsonb; v_rowids jsonb; v_cid bigint;
  v_resolved_site text; v_has_ir boolean; v_dr_conflict boolean; v_we_conflict boolean;
  i int; j int; n int;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_oid is null then return jsonb_build_object('ok',false,'error','bad args'); end if;

  select data::jsonb into v_blob from public.radscheduler where id = p_practice for update;   -- atomic
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  -- Trusted caller identity from the roster (never a client-supplied physId).
  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id') = (auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false) or coalesce(radscheduler_admin_same_practice(p_practice), false);
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

  v_is_weekend := (v_stype like '%Weekend%');
  v_wshift := coalesce(nullif(v_open->>'wshift',''), case when v_open->>'notes'='Swing shift' then 'swing' else 'day' end);
  if v_wshift not in ('day','swing') then v_wshift := 'day'; end if;
  v_sun := to_char((v_date::date+1),'YYYY-MM-DD');
  v_days := case when v_is_weekend then array[v_date, v_sun] else array[v_date] end;
  v_claims := coalesce(v_open->'claims','[]'::jsonb);

  -- Default = claim every day that is not yet closed, whole.
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('date', d)),'[]'::jsonb) into v_parts
    from unnest(v_days) d
    where not exists (select 1 from jsonb_array_elements(v_claims) c where c->>'date'=d and (c->>'from') is null);
  else
    v_parts := p_parts;
  end if;
  n := jsonb_array_length(v_parts);
  if n = 0 then return jsonb_build_object('ok',false,'error','nothing left to claim'); end if;
  if n > 8 then return jsonb_build_object('ok',false,'error','too many parts'); end if;

  -- Validate each part against the offer + existing claims.
  for i in 0..n-1 loop
    v_part := v_parts->i;
    v_pd := v_part->>'date'; v_pf := nullif(v_part->>'from',''); v_pt := nullif(v_part->>'to','');
    if v_pd is null or not (v_pd = any(v_days)) then return jsonb_build_object('ok',false,'error','day not offered: '||coalesce(v_pd,'?')); end if;
    if exists (select 1 from jsonb_array_elements(v_claims) c where c->>'date'=v_pd and (c->>'from') is null) then
      return jsonb_build_object('ok',false,'error','already fully claimed: '||v_pd);
    end if;
    if (v_pf is null) <> (v_pt is null) then return jsonb_build_object('ok',false,'error','need both from and to (or neither)'); end if;
    if v_pf is not null then
      if v_pf !~ '^([01]\d|2[0-3]):[0-5]\d$' or v_pt !~ '^([01]\d|2[0-3]):[0-5]\d$' or v_pf >= v_pt then
        return jsonb_build_object('ok',false,'error','bad hour range on '||v_pd);
      end if;
      if exists (select 1 from jsonb_array_elements(v_claims) c
                 where c->>'date'=v_pd and (c->>'from') is not null
                   and (c->>'from') < v_pt and v_pf < (c->>'to')) then
        return jsonb_build_object('ok',false,'error','hours overlap an existing claim on '||v_pd);
      end if;
    end if;
    -- pairwise consistency inside this request
    for j in 0..i-1 loop
      v_pa := v_parts->j;
      if (v_pa->>'date') = v_pd then
        if v_pf is null or nullif(v_pa->>'from','') is null then
          return jsonb_build_object('ok',false,'error','conflicting parts for '||v_pd);
        end if;
        if (v_pa->>'from') < v_pt and v_pf < (v_pa->>'to') then
          return jsonb_build_object('ok',false,'error','overlapping parts for '||v_pd);
        end if;
      end if;
    end loop;
  end loop;

  select value into v_p from jsonb_array_elements(coalesce(v_blob->'physicians','[]'::jsonb)) value
  where (value->>'id')::int = v_pid limit 1;
  if v_p is null then return jsonb_build_object('ok',false,'error','physician not found'); end if;
  v_role := coalesce(v_p->>'role','DR'); v_irfte := coalesce((v_p->>'irFte')::numeric,0);
  v_irgroup := coalesce(v_p->>'irGroup',''); v_irsiteprim := coalesce(v_p->>'irSitePrim','');
  if v_group='DR' and v_role='IR' then return jsonb_build_object('ok',false,'error','IR-only physician cannot claim a DR shift'); end if;
  if v_group='IR' and not (v_irfte > 0) then return jsonb_build_object('ok',false,'error','only IR physicians can claim an IR shift'); end if;

  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);

  -- A first-touch whole-weekend claim stays ONE weekendCall row (legacy shape).
  v_legacy_full := v_is_weekend and jsonb_array_length(v_claims) = 0
    and (select count(*) from jsonb_array_elements(v_parts) pt where nullif(pt->>'from','') is null) = array_length(v_days,1)
    and (select count(distinct pt->>'date') from jsonb_array_elements(v_parts) pt) = array_length(v_days,1);

  if v_legacy_full then
    v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'satDate',v_date,'sunDate',v_sun,'sub',v_sub,'site','','ctype','Primary','wshift',v_wshift,'notes','Claimed');
    v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce(v_blob->'weekendCalls','[]'::jsonb) || v_newshift);
    v_rowids := jsonb_build_array(v_nextid); v_nextid := v_nextid + 1;
    for i in 0..n-1 loop
      v_part := v_parts->i;
      v_claims := v_claims || jsonb_build_object('cid',v_nextid,'physId',v_pid,'date',v_part->>'date','from',null,'to',null,'at',v_now,'rows',v_rowids);
      v_nextid := v_nextid + 1;
    end loop;
  else
    for i in 0..n-1 loop
      v_part := v_parts->i;
      v_pd := v_part->>'date'; v_pf := nullif(v_part->>'from',''); v_pt := nullif(v_part->>'to','');
      v_hours := case when v_pf is not null then ' '||v_pf||'–'||v_pt else '' end;
      v_rowids := '[]'::jsonb;
      if v_group = 'IR' then
        v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_pd,'callType','daily','irGroup',v_irgroup,'site',v_site,
          'covFrom',v_pf,'covTo',v_pt,'notes','Claimed'||v_hours);
        v_blob := jsonb_set(v_blob,'{irCalls}', coalesce(v_blob->'irCalls','[]'::jsonb) || v_newshift);
        v_rowids := v_rowids || to_jsonb(v_nextid); v_nextid := v_nextid + 1;
        -- IR auto-pair only for a whole-day claim of the posted date
        if v_pf is null and v_pd = v_date then
          v_has_ir := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s where (s->>'physId')::int=v_pid and s->>'date'=v_pd);
          v_dr_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s where (s->>'physId')::int=v_pid and s->>'date'=v_pd and coalesce(s->>'shift','')<>'Home');
          v_we_conflict := exists(select 1 from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) w where (w->>'physId')::int=v_pid and (w->>'satDate'=v_pd or w->>'sunDate'=v_pd or w->>'date'=v_pd));
          if not v_has_ir and not v_dr_conflict and not v_we_conflict then
            v_resolved_site := coalesce(nullif(v_site,''), nullif(v_irsiteprim,''), 'At Home / Remote');
            v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_pd,'shift','1st','site',v_resolved_site,'sub','','notes','Auto-paired with IR call (open-shift-claim)','irGroup',v_irgroup);
            v_blob := jsonb_set(v_blob,'{irShifts}', coalesce(v_blob->'irShifts','[]'::jsonb) || v_newshift);
            v_rowids := v_rowids || to_jsonb(v_nextid); v_nextid := v_nextid + 1;
          end if;
        end if;
      elsif v_is_weekend then
        v_lbl := case when v_pd = v_date then 'Sat' else 'Sun' end;
        v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'satDate',v_date,'sunDate',v_sun,'sub',v_sub,'site','','ctype','Primary','wshift',v_wshift,
          'covDay',v_pd,'covFrom',v_pf,'covTo',v_pt,'notes','Claimed ('||v_lbl||' only'||v_hours||')');
        v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce(v_blob->'weekendCalls','[]'::jsonb) || v_newshift);
        v_rowids := v_rowids || to_jsonb(v_nextid); v_nextid := v_nextid + 1;
      else
        v_newshift := jsonb_build_object('id',v_nextid,'physId',v_pid,'date',v_pd,'shift','1st','site',v_site,'sub',v_sub,
          'covFrom',v_pf,'covTo',v_pt,'notes','Claimed'||v_hours,'autoHome',false);
        v_blob := jsonb_set(v_blob,'{drShifts}', coalesce(v_blob->'drShifts','[]'::jsonb) || v_newshift);
        v_rowids := v_rowids || to_jsonb(v_nextid); v_nextid := v_nextid + 1;
      end if;
      v_claims := v_claims || jsonb_build_object('cid',v_nextid,'physId',v_pid,'date',v_pd,'from',v_pf,'to',v_pt,'at',v_now,'rows',v_rowids);
      v_nextid := v_nextid + 1;
    end loop;
  end if;

  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claims'], v_claims);
  v_all_closed := not exists (
    select 1 from unnest(v_days) d
    where not exists (select 1 from jsonb_array_elements(v_claims) c where c->>'date'=d and (c->>'from') is null));
  if v_all_closed then
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], to_jsonb(v_pid));
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedAt'], to_jsonb(v_now));
  end if;
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));

  update public.radscheduler set data = v_blob::text where id = p_practice;
  return jsonb_build_object('ok',true,'oid',p_oid,'pid',v_pid,'group',v_group,'date',v_date,'parts',n,'fully',v_all_closed);
end;
$function$;

CREATE FUNCTION public.rs_unclaim_open_shift(p_practice text, p_oid bigint, p_cid bigint DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean;
  v_open jsonb; v_idx int; v_claimed integer; v_date text;
  v_claims jsonb; v_keep jsonb; v_removed jsonb; v_ids jsonb;
  v_days text[]; v_sun text; v_is_weekend boolean; v_all_closed boolean; v_last_full integer;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_oid is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false) or coalesce(radscheduler_admin_same_practice(p_practice), false);

  select value, (ordinality-1)::int into v_open, v_idx
  from jsonb_array_elements(coalesce(v_blob->'openShifts','[]'::jsonb)) with ordinality
  where (value->>'id')::bigint = p_oid limit 1;
  if v_open is null then return jsonb_build_object('ok',false,'error','open shift not found'); end if;

  v_claims := coalesce(v_open->'claims','[]'::jsonb);
  v_date := v_open->>'date';

  if jsonb_array_length(v_claims) = 0 then
    -- Legacy entries claimed before partial claims existed: remove the
    -- materialized rows by the old (physId, date, notes='Claimed') match.
    if coalesce(v_open->>'claimedBy','')='' then return jsonb_build_object('ok',false,'error','not claimed'); end if;
    v_claimed := (v_open->>'claimedBy')::int;
    if not v_is_admin and (v_caller_pid is null or v_caller_pid <> v_claimed) then
      return jsonb_build_object('ok',false,'error','you can only unclaim your own shift');
    end if;
    v_blob := jsonb_set(v_blob,'{drShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s
      where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and s->>'notes'='Claimed')), '[]'::jsonb));
    v_blob := jsonb_set(v_blob,'{irCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irCalls','[]'::jsonb)) s
      where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and s->>'notes'='Claimed')), '[]'::jsonb));
    v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) s
      where not ((s->>'physId')::int=v_claimed and (s->>'satDate'=v_date or s->>'date'=v_date) and s->>'notes'='Claimed')), '[]'::jsonb));
    v_blob := jsonb_set(v_blob,'{irShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s
      where not ((s->>'physId')::int=v_claimed and s->>'date'=v_date and (s->>'notes') like 'Auto-paired with IR call%')), '[]'::jsonb));
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], 'null'::jsonb);
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedAt'], 'null'::jsonb);
    v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
    update public.radscheduler set data=v_blob::text where id=p_practice;
    return jsonb_build_object('ok',true,'oid',p_oid,'pid',v_claimed);
  end if;

  -- Partial-claims entry: p_cid targets one claim; null = all of the
  -- caller's claims (an admin with p_cid null resets every claim).
  if p_cid is not null then
    select coalesce(jsonb_agg(c),'[]'::jsonb) into v_removed from jsonb_array_elements(v_claims) c where (c->>'cid')::bigint = p_cid;
    if jsonb_array_length(v_removed) = 0 then return jsonb_build_object('ok',false,'error','claim not found'); end if;
    if not v_is_admin and (v_caller_pid is null or (v_removed->0->>'physId')::int <> v_caller_pid) then
      return jsonb_build_object('ok',false,'error','you can only unclaim your own claim');
    end if;
    select coalesce(jsonb_agg(c),'[]'::jsonb) into v_keep from jsonb_array_elements(v_claims) c where (c->>'cid')::bigint <> p_cid;
  elsif v_is_admin and (v_caller_pid is null or not exists (select 1 from jsonb_array_elements(v_claims) c where (c->>'physId')::int = v_caller_pid)) then
    v_removed := v_claims; v_keep := '[]'::jsonb;
  else
    if v_caller_pid is null then return jsonb_build_object('ok',false,'error','caller not on roster'); end if;
    select coalesce(jsonb_agg(c),'[]'::jsonb) into v_removed from jsonb_array_elements(v_claims) c where (c->>'physId')::int = v_caller_pid;
    if jsonb_array_length(v_removed) = 0 then return jsonb_build_object('ok',false,'error','you have no claim on this shift'); end if;
    select coalesce(jsonb_agg(c),'[]'::jsonb) into v_keep from jsonb_array_elements(v_claims) c where (c->>'physId')::int <> v_caller_pid;
  end if;

  select coalesce(jsonb_agg(distinct rid),'[]'::jsonb) into v_ids
  from jsonb_array_elements(v_removed) c, jsonb_array_elements(c->'rows') rid;

  v_blob := jsonb_set(v_blob,'{drShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'drShifts','[]'::jsonb)) s
    where not (v_ids @> jsonb_build_array((s->'id')))), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{irCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irCalls','[]'::jsonb)) s
    where not (v_ids @> jsonb_build_array((s->'id')))), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{weekendCalls}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'weekendCalls','[]'::jsonb)) s
    where not (v_ids @> jsonb_build_array((s->'id')))), '[]'::jsonb));
  v_blob := jsonb_set(v_blob,'{irShifts}', coalesce((select jsonb_agg(s) from jsonb_array_elements(coalesce(v_blob->'irShifts','[]'::jsonb)) s
    where not (v_ids @> jsonb_build_array((s->'id')))), '[]'::jsonb));

  v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claims'], v_keep);
  v_is_weekend := (coalesce(v_open->>'shiftType','') like '%Weekend%');
  v_sun := to_char((v_date::date+1),'YYYY-MM-DD');
  v_days := case when v_is_weekend then array[v_date, v_sun] else array[v_date] end;
  v_all_closed := jsonb_array_length(v_keep) > 0 and not exists (
    select 1 from unnest(v_days) d
    where not exists (select 1 from jsonb_array_elements(v_keep) c where c->>'date'=d and (c->>'from') is null));
  if v_all_closed then
    select (c->>'physId')::int into v_last_full from jsonb_array_elements(v_keep) c where (c->>'from') is null order by c->>'at' desc limit 1;
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], to_jsonb(v_last_full));
  else
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedBy'], 'null'::jsonb);
    v_blob := jsonb_set(v_blob, array['openShifts',v_idx::text,'claimedAt'], 'null'::jsonb);
  end if;
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'oid',p_oid,'removed',jsonb_array_length(v_removed));
end;
$function$;

REVOKE ALL ON FUNCTION public.rs_claim_open_shift(text,bigint,integer,jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_unclaim_open_shift(text,bigint,bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rs_claim_open_shift(text,bigint,integer,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_unclaim_open_shift(text,bigint,bigint) TO authenticated;;
