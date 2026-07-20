-- Secure server-side claim of a one-sided trade OFFER (reassigns the offerer's
-- shift to the claimant). Non-admin may only claim for themselves; enforces the
-- hard invariants atomically (row lock). Client keeps soft pre-checks + does
-- notifications after {ok:true}.
create or replace function public.rs_claim_offered_shift(p_practice text, p_offer_id bigint, p_claimer_pid integer)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_blob jsonb; v_caller_pid integer; v_is_admin boolean;
  v_offer jsonb; v_oidx int; v_kind text; v_shiftid bigint; v_from integer;
  v_arr text; v_sidx int; v_sdate text; v_snotes text; v_spid integer;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_offer_id is null or p_claimer_pid is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;

  select (u->>'physId')::int into v_caller_pid
  from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
  where (u->>'id')=(auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);
  if not v_is_admin then
    if v_caller_pid is null or v_caller_pid <> p_claimer_pid then return jsonb_build_object('ok',false,'error','you can only claim a shift for yourself'); end if;
  end if;

  select value,(ordinality-1)::int into v_offer,v_oidx
  from jsonb_array_elements(coalesce(v_blob->'shiftOffers','[]'::jsonb)) with ordinality
  where (value->>'id')::bigint=p_offer_id limit 1;
  if v_offer is null then return jsonb_build_object('ok',false,'error','offer not found'); end if;
  if coalesce(v_offer->>'claimedBy','')<>'' or coalesce((v_offer->>'cancelled')::boolean,false) then
    return jsonb_build_object('ok',false,'error','that offer is no longer available'); end if;
  v_from := (v_offer->>'fromPhysId')::int;
  if p_claimer_pid = v_from then return jsonb_build_object('ok',false,'error','you cannot claim your own offer'); end if;

  v_kind := coalesce(v_offer->>'kind','dr');
  v_shiftid := (v_offer->>'shiftId')::bigint;
  v_arr := case v_kind when 'ir' then 'irShifts' else 'drShifts' end;

  select (ordinality-1)::int, (value->>'date'), (value->>'notes'), (value->>'physId')::int
    into v_sidx, v_sdate, v_snotes, v_spid
  from jsonb_array_elements(coalesce(v_blob->v_arr,'[]'::jsonb)) with ordinality
  where (value->>'id')::bigint=v_shiftid limit 1;
  if v_sidx is null then return jsonb_build_object('ok',false,'error','original shift no longer exists'); end if;
  if v_spid is distinct from v_from then return jsonb_build_object('ok',false,'error','offered shift no longer belongs to the offerer'); end if;

  v_blob := jsonb_set(v_blob, array[v_arr, v_sidx::text, 'physId'], to_jsonb(p_claimer_pid));
  v_blob := jsonb_set(v_blob, array[v_arr, v_sidx::text, 'notes'],
    to_jsonb((case when coalesce(v_snotes,'')<>'' then v_snotes||' ' else '' end)||'(traded from #'||v_from||')'));
  v_blob := jsonb_set(v_blob, array['shiftOffers',v_oidx::text,'claimedBy'], to_jsonb(p_claimer_pid));
  v_blob := jsonb_set(v_blob, array['shiftOffers',v_oidx::text,'claimedAt'], to_jsonb(v_now));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'claimerPid',p_claimer_pid,'fromPid',v_from,'kind',v_kind,'date',v_sdate,'shiftId',v_shiftid);
end $$;
revoke all on function public.rs_claim_offered_shift(text,bigint,integer) from public, anon;
grant execute on function public.rs_claim_offered_shift(text,bigint,integer) to authenticated;;
