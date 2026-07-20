-- #17 completion: comm-prefs → table-canonical (rs_comm_prefs), matching the
-- swaps/acks cutover. rs_set_comm_prefs now UPSERTS the owner table and no
-- longer touches blob users[].notifPrefs (which becomes a legacy fallback for
-- the 2 non-UUID bootstrap users only). SELECT opens to same-practice so the
-- client can hydrate ALL practice prefs (the _notify/broadcast/publish filters
-- read colleagues' prefs client-side).

-- 1. Same-practice SELECT (was admin-aal2-or-owner). Same shape as rs_on_call_acks/rs_swap_requests.
ALTER POLICY prefs_select ON public.rs_comm_prefs
  USING (radscheduler_admin_aal2() OR radscheduler_non_admin_same_practice(practice_id));

-- 2. rs_set_comm_prefs v2: table-canonical write, identity pinned to auth.uid().
--    Whitelist adds 'digest' (honored by the send-notification digest gate).
CREATE OR REPLACE FUNCTION public.rs_set_comm_prefs(p_practice text, p_prefs jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_uid uuid; v_pid bigint; v_clean jsonb := '{}'::jsonb; k text;
  v_keys text[] := array['master','chatDM','chatGroup','chatMention','swapReq','swapRes',
    'shiftAssign','shiftRemove','holiday','vacation','openShift','broadcast',
    'tumorBoard','clinic','schedulePublish','digest'];
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

  -- Membership check + phys_id from the roster (read-only blob use; no lock needed)
  select (u->>'physId')::bigint into v_pid
    from public.radscheduler r, jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
    where r.id = p_practice and (u->>'id') = v_uid::text
    limit 1;
  if not found then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  insert into public.rs_comm_prefs (practice_id, owner_uid, phys_id, prefs, updated_at)
  values (p_practice, v_uid, v_pid, v_clean, now())
  on conflict (practice_id, owner_uid)
  do update set prefs = excluded.prefs, phys_id = excluded.phys_id, updated_at = now();
  return jsonb_build_object('ok',true,'prefs',v_clean);
end $function$;

-- 3. Align the two remaining aal2-gated admin branches with the role-only decision.
CREATE OR REPLACE FUNCTION public.rs_delete_time_entry(p_practice text, p_entry_id bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_is_admin boolean; v_entry jsonb; v_owner text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_entry_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false) or coalesce(radscheduler_admin_same_practice(p_practice), false);

  select value into v_entry from jsonb_array_elements(coalesce(v_blob->'timeLogEntries','[]'::jsonb)) value
    where (value->>'id')::bigint = p_entry_id limit 1;
  if v_entry is null then return jsonb_build_object('ok',true,'noop',true); end if;
  v_owner := v_entry->>'physId';
  if not v_is_admin and v_owner is distinct from v_pid::text then
    return jsonb_build_object('ok',false,'error','you can only delete your own entries'); end if;

  v_blob := jsonb_set(v_blob, '{timeLogEntries}',
    coalesce((select jsonb_agg(value) from jsonb_array_elements(v_blob->'timeLogEntries') value
              where (value->>'id')::bigint <> p_entry_id), '[]'::jsonb));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $function$;

CREATE OR REPLACE FUNCTION public.rs_set_shift_handoff(p_practice text, p_kind text, p_shift_id bigint, p_text text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_is_admin boolean;
  v_key text; v_shift jsonb; v_idx int; v_owner int; v_txt text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_shift_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_kind = 'dr' then v_key := 'drShifts';
  elsif p_kind = 'ir' then v_key := 'irShifts';
  else return jsonb_build_object('ok',false,'error','bad kind'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;
  v_txt := nullif(left(coalesce(p_text,''), 500), '');

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false) or coalesce(radscheduler_admin_same_practice(p_practice), false);

  select value, (ordinality-1)::int into v_shift, v_idx
    from jsonb_array_elements(coalesce(v_blob->v_key,'[]'::jsonb)) with ordinality
    where (value->>'id')::bigint = p_shift_id limit 1;
  if v_shift is null then return jsonb_build_object('ok',false,'error','shift not found'); end if;
  v_owner := nullif(v_shift->>'physId','')::int;
  if not v_is_admin and (v_pid is null or v_owner is distinct from v_pid) then
    return jsonb_build_object('ok',false,'error','you can only edit the handoff for your own shift'); end if;

  v_blob := jsonb_set(v_blob, array[v_key, v_idx::text, 'handoff'], coalesce(to_jsonb(v_txt),'null'::jsonb), true);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'handoff',v_txt);
end $function$;;
