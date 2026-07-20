-- Fixes for the #17 adversarial-review confirmed findings.

-- (F3) rs_resolve_swap: pending-only guard. No deny-after-approve divergence,
-- no re-resolving, no setting back to 'pending'. Distinguish not-found from
-- already-resolved so the client can message correctly.
CREATE OR REPLACE FUNCTION public.rs_resolve_swap(p_practice text, p_client_id bigint, p_status text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_count int; v_current text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_client_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_status not in ('approved','denied') then return jsonb_build_object('ok',false,'error','bad status'); end if;
  if not coalesce(radscheduler_admin_same_practice(p_practice), false) then
    return jsonb_build_object('ok',false,'error','admin only'); end if;

  update public.rs_swap_requests set status = p_status
   where practice_id = p_practice and client_id = p_client_id and status = 'pending';
  get diagnostics v_count = row_count;
  if v_count = 0 then
    select status into v_current from public.rs_swap_requests
     where practice_id = p_practice and client_id = p_client_id;
    if v_current is null then return jsonb_build_object('ok',false,'error','swap not found'); end if;
    return jsonb_build_object('ok',false,'error','swap already '||v_current,'status',v_current);
  end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is not null then
    v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
    update public.radscheduler set data=v_blob::text where id=p_practice;
  end if;
  return jsonb_build_object('ok',true,'status',p_status);
end $function$;

-- (F4) Practice-bind the admin branches (bare admin_aal2() was cross-tenant).
ALTER POLICY rs_swap_select ON public.rs_swap_requests
  USING (radscheduler_admin_same_practice(practice_id) OR radscheduler_non_admin_same_practice(practice_id));
ALTER POLICY rs_swap_delete ON public.rs_swap_requests
  USING (radscheduler_admin_same_practice(practice_id) OR (radscheduler_owns_row(owner_uid) AND status = 'pending'));
ALTER POLICY rs_swap_update ON public.rs_swap_requests
  USING (radscheduler_admin_same_practice(practice_id) OR (radscheduler_owns_row(owner_uid) AND status = 'pending'))
  WITH CHECK (radscheduler_admin_same_practice(practice_id));
ALTER POLICY rs_swap_insert ON public.rs_swap_requests
  WITH CHECK ((radscheduler_admin_same_practice(practice_id)) OR (radscheduler_owns_row(owner_uid) AND radscheduler_non_admin_same_practice(practice_id) AND (status = 'pending')));
ALTER POLICY ack_select ON public.rs_on_call_acks
  USING (radscheduler_admin_same_practice(practice_id) OR radscheduler_non_admin_same_practice(practice_id));
ALTER POLICY ack_delete ON public.rs_on_call_acks
  USING (radscheduler_admin_same_practice(practice_id) OR radscheduler_owns_row(owner_uid));
ALTER POLICY prefs_select ON public.rs_comm_prefs
  USING (radscheduler_admin_same_practice(practice_id) OR radscheduler_non_admin_same_practice(practice_id));

-- (F5/F6) rs_swap_requests: policies were TO public with anon DML grants, and
-- the owner-UPDATE branch let a non-admin rewrite operative fields of their own
-- pending row (from/to/date forgery that an admin approve would then execute).
-- All legitimate writes go through DEFINER RPCs — remove the direct surface.
ALTER POLICY rs_swap_select ON public.rs_swap_requests TO authenticated;
ALTER POLICY rs_swap_insert ON public.rs_swap_requests TO authenticated;
ALTER POLICY rs_swap_update ON public.rs_swap_requests TO authenticated;
ALTER POLICY rs_swap_delete ON public.rs_swap_requests TO authenticated;
REVOKE ALL ON public.rs_swap_requests FROM anon;
REVOKE UPDATE, DELETE ON public.rs_swap_requests FROM authenticated;

-- (F7) rs_on_call_acks: semantic idempotency key is (practice, PHYSICIAN, date)
-- — the old (practice, owner_uid, date) unique made an admin's 2nd same-day
-- ack-for-another-physician silently no-op.
ALTER TABLE public.rs_on_call_acks DROP CONSTRAINT rs_on_call_acks_practice_id_owner_uid_ack_date_key;
CREATE UNIQUE INDEX rs_on_call_acks_practice_phys_date_key
  ON public.rs_on_call_acks (practice_id, phys_id, ack_date);

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

  -- Idempotent on (practice, phys, date) — matching the unique index, so a
  -- concurrent duplicate resolves via DO NOTHING instead of erroring.
  if exists(select 1 from public.rs_on_call_acks
            where practice_id=p_practice and phys_id=p_phys_id and ack_date=p_date::date) then
    return jsonb_build_object('ok',true,'noop',true); end if;

  insert into public.rs_on_call_acks (practice_id, owner_uid, phys_id, ack_date)
  values (p_practice, v_uid, p_phys_id, p_date::date)
  on conflict (practice_id, phys_id, ack_date) do nothing;

  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $function$;

-- (F8) rs_set_comm_prefs: emit the practice-wide change signal (savedAt bump)
-- like every other mutation RPC, so other tabs' recipient filters re-hydrate
-- promptly instead of waiting for an unrelated blob change.
CREATE OR REPLACE FUNCTION public.rs_set_comm_prefs(p_practice text, p_prefs jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_uid uuid; v_pid bigint; v_blob jsonb; v_clean jsonb := '{}'::jsonb; k text;
  v_keys text[] := array['master','chatDM','chatGroup','chatMention','swapReq','swapRes',
    'shiftAssign','shiftRemove','holiday','vacation','openShift','broadcast',
    'tumorBoard','clinic','schedulePublish','digest'];
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := auth.uid();
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  foreach k in array v_keys loop
    if p_prefs ? k then
      v_clean := v_clean || jsonb_build_object(k, coalesce((p_prefs->>k)::boolean, false));
    end if;
  end loop;

  select data::jsonb into v_blob from public.radscheduler where id = p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::bigint into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id') = v_uid::text limit 1;
  if not found then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  insert into public.rs_comm_prefs (practice_id, owner_uid, phys_id, prefs, updated_at)
  values (p_practice, v_uid, v_pid, v_clean, now())
  on conflict (practice_id, owner_uid)
  do update set prefs = excluded.prefs, phys_id = excluded.phys_id, updated_at = now();

  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data = v_blob::text where id = p_practice;
  return jsonb_build_object('ok',true,'prefs',v_clean);
end $function$;;
