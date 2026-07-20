-- TASK #17: owner-table-canonical cutover for swaps + on-call acks.
-- rs_swap_requests / rs_on_call_acks become the CANONICAL stores; the RPCs stop
-- writing the blob's swapRequests/onCallAcks keys (they now only touch nextId /
-- savedAt — savedAt bumps drive existing client polls, which post-cutover
-- trigger table-cache refreshes). Signatures are UNCHANGED so the deployed
-- client keeps working during the deploy window. notifPrefs intentionally stays
-- blob-canonical (client-side cross-user pref gating needs it; see memory).

-- 0. Viewed-tracking columns (were blob-only fields on swap objects)
ALTER TABLE public.rs_swap_requests
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS viewed_by uuid;

-- 1. Swap create → INSERT INTO rs_swap_requests (client_id still allocated from
--    the blob's central nextId so the id-space stays unified).
CREATE OR REPLACE FUNCTION public.rs_create_swap_request(
    p_practice text, p_kind text, p_shift_id bigint, p_to_phys_id integer,
    p_their_kind text, p_their_shift_id bigint, p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid uuid; v_pid int; v_nextid bigint;
  v_mine jsonb; v_theirs jsonb; v_mycol text; v_theircol text;
  v_date text; v_label text; v_site text; v_theirdate text; v_swap jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  colmap jsonb := '{"dr":"drShifts","ir":"irShifts","irc":"irCalls","wk":"weekendCalls"}'::jsonb;
begin
  if p_practice is null or p_kind is null or p_shift_id is null or p_to_phys_id is null then
    return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_mycol := colmap->>p_kind;
  if v_mycol is null then return jsonb_build_object('ok',false,'error','bad kind'); end if;
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',false,'error','your account is not linked to a physician'); end if;

  select value into v_mine from jsonb_array_elements(coalesce(v_blob->v_mycol,'[]'::jsonb)) value
    where (value->>'id')::bigint = p_shift_id limit 1;
  if v_mine is null then return jsonb_build_object('ok',false,'error','shift not found'); end if;
  if (v_mine->>'physId')::int is distinct from v_pid then
    return jsonb_build_object('ok',false,'error','you can only offer your own shift for a swap'); end if;

  if p_their_kind is not null and p_their_shift_id is not null then
    v_theircol := colmap->>p_their_kind;
    if v_theircol is not null then
      select value into v_theirs from jsonb_array_elements(coalesce(v_blob->v_theircol,'[]'::jsonb)) value
        where (value->>'id')::bigint = p_their_shift_id limit 1;
    end if;
  end if;

  v_date  := coalesce(nullif(v_mine->>'date',''), nullif(v_mine->>'satDate',''), '');
  v_site  := coalesce(v_mine->>'site','');
  v_label := case when coalesce(v_mine->>'callType','')<>'' then 'IR Call ('||(v_mine->>'callType')||')'
                  when coalesce(v_mine->>'satDate','')<>'' or coalesce(v_mine->>'sunDate','')<>'' then 'Weekend Call'
                  else coalesce(nullif(v_mine->>'shift',''),'Shift') end;
  v_theirdate := coalesce(nullif(v_theirs->>'date',''), nullif(v_theirs->>'satDate',''), '');

  -- Allocate id from the central blob nextId; bump savedAt so clients poll-refresh.
  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid+1));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;

  insert into public.rs_swap_requests
    (practice_id, client_id, owner_uid, from_phys_id, to_phys_id, shift_date,
     their_date, shift_type, site, reason, status, ts)
  values
    (p_practice, v_nextid, v_uid, v_pid, p_to_phys_id, nullif(v_date,''),
     v_theirdate, v_label, v_site, left(coalesce(p_reason,''),1000), 'pending', now())
  on conflict (practice_id, client_id) do nothing;

  v_swap := jsonb_build_object('id',v_nextid,'fromPhysId',v_pid,'toPhysId',p_to_phys_id,
    'date',v_date,'theirDate',v_theirdate,'shiftType',v_label,'site',v_site,
    'reason',left(coalesce(p_reason,''),1000),'status','pending','ts',v_now);
  return jsonb_build_object('ok',true,'swap',v_swap);
end $function$;

-- 2. On-call ack → INSERT INTO rs_on_call_acks (self, or role-admin for anyone).
CREATE OR REPLACE FUNCTION public.rs_acknowledge_oncall(p_practice text, p_phys_id integer, p_date text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid uuid; v_pid int; v_is_admin boolean;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_phys_id is null or p_date is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'error','bad date'); end if;
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_same_practice(p_practice), false);
  if not v_is_admin and (v_pid is null or v_pid <> p_phys_id) then
    return jsonb_build_object('ok',false,'error','you can only confirm your own on-call'); end if;

  -- Idempotent on (practice, phys, date) regardless of who recorded it.
  if exists(select 1 from public.rs_on_call_acks
            where practice_id=p_practice and phys_id=p_phys_id and ack_date=p_date::date) then
    return jsonb_build_object('ok',true,'noop',true); end if;

  insert into public.rs_on_call_acks (practice_id, owner_uid, phys_id, ack_date)
  values (p_practice, v_uid, p_phys_id, p_date::date)
  on conflict (practice_id, owner_uid, ack_date) do nothing;

  -- savedAt bump → other clients' polls refresh their ack caches.
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $function$;

-- 3. Mark pending swaps addressed to the caller as viewed → table columns.
CREATE OR REPLACE FUNCTION public.rs_mark_swaps_viewed(p_practice text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid uuid; v_pid int; v_count int := 0;
begin
  if p_practice is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid::text and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',true,'count',0); end if;

  update public.rs_swap_requests
     set viewed_at = now(), viewed_by = v_uid
   where practice_id = p_practice and to_phys_id = v_pid
     and status = 'pending' and viewed_at is null;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'count',v_count);
end $function$;

-- 4. NEW: admin swap resolution (role-only admin per Phase-5 decision — the
--    table's own admin RLS branch requires AAL2, which the 2nd admin lacks).
CREATE OR REPLACE FUNCTION public.rs_resolve_swap(p_practice text, p_client_id bigint, p_status text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_count int;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_client_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_status not in ('approved','denied','pending') then return jsonb_build_object('ok',false,'error','bad status'); end if;
  if not coalesce(radscheduler_admin_same_practice(p_practice), false) then
    return jsonb_build_object('ok',false,'error','admin only'); end if;

  update public.rs_swap_requests set status = p_status
   where practice_id = p_practice and client_id = p_client_id;
  get diagnostics v_count = row_count;
  if v_count = 0 then return jsonb_build_object('ok',false,'error','swap not found'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is not null then
    v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
    update public.radscheduler set data=v_blob::text where id=p_practice;
  end if;
  return jsonb_build_object('ok',true,'status',p_status);
end $function$;

-- 5. NEW: admin swap deletion (physician removal / orphan repair).
CREATE OR REPLACE FUNCTION public.rs_delete_swaps(p_practice text, p_client_ids bigint[])
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_count int;
begin
  if p_practice is null or p_client_ids is null or array_length(p_client_ids,1) is null then
    return jsonb_build_object('ok',true,'count',0); end if;
  if not coalesce(radscheduler_admin_same_practice(p_practice), false) then
    return jsonb_build_object('ok',false,'error','admin only'); end if;
  delete from public.rs_swap_requests
   where practice_id = p_practice and client_id = any(p_client_ids);
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'count',v_count);
end $function$;

REVOKE ALL ON FUNCTION public.rs_resolve_swap(text,bigint,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_delete_swaps(text,bigint[]) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rs_resolve_swap(text,bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_delete_swaps(text,bigint[]) TO authenticated;;
