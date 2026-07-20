-- Self-service per-user blob writes → SECURITY DEFINER RPCs. Each pins identity
-- to the caller (auth.uid()) and only mutates that caller's own data; a client
-- can no longer forge another user's notify email / push sub / time log / etc.
-- All bump savedAt (ISO string, matching the client) so poll/realtime clients refresh.

-- 1. Set the caller's own delivery email (users[i].notifyEmail)
CREATE OR REPLACE FUNCTION public.rs_set_notify_email(p_practice text, p_email text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_uidx int; v_email text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;
  v_email := nullif(lower(btrim(coalesce(p_email,''))),'');
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok',false,'error','invalid email format'); end if;
  if v_email is not null and length(v_email) > 254 then
    return jsonb_build_object('ok',false,'error','email too long'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (ordinality-1)::int into v_uidx
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) with ordinality
    where (value->>'id')=v_uid limit 1;
  if v_uidx is null then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  v_blob := jsonb_set(v_blob, array['users',v_uidx::text,'notifyEmail'], to_jsonb(v_email));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'email',v_email);
end $function$;

-- 2. Set the caller's own web-push subscription (users[i].pushSubscription); null = unsubscribe
CREATE OR REPLACE FUNCTION public.rs_set_push_subscription(p_practice text, p_sub jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_uidx int; v_ep text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;
  if p_sub is not null then
    if jsonb_typeof(p_sub) <> 'object' then return jsonb_build_object('ok',false,'error','bad subscription'); end if;
    v_ep := p_sub->>'endpoint';
    if v_ep is null or v_ep !~ '^https://' then return jsonb_build_object('ok',false,'error','bad endpoint'); end if;
    if length(p_sub::text) > 8000 then return jsonb_build_object('ok',false,'error','subscription too large'); end if;
  end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (ordinality-1)::int into v_uidx
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) with ordinality
    where (value->>'id')=v_uid limit 1;
  if v_uidx is null then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  v_blob := jsonb_set(v_blob, array['users',v_uidx::text,'pushSubscription'], coalesce(p_sub,'null'::jsonb));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $function$;

-- 3. Log a time entry for the caller (own physId only; option must be active + available to them)
CREATE OR REPLACE FUNCTION public.rs_log_time(p_practice text, p_option_id bigint, p_hours numeric, p_date text, p_note text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_opt jsonb; v_nextid bigint; v_hours numeric; v_note text; v_entry jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_option_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;
  if p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'error','bad date'); end if;
  v_hours := round(coalesce(p_hours,0), 2);
  if not (v_hours > 0) then return jsonb_build_object('ok',false,'error','hours must be > 0'); end if;
  if v_hours > 100000 then return jsonb_build_object('ok',false,'error','hours too large'); end if;
  v_note := left(coalesce(p_note,''), 200);

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',false,'error','your account is not linked to a physician'); end if;

  select value into v_opt from jsonb_array_elements(coalesce(v_blob->'timeLogOptions','[]'::jsonb)) value
    where (value->>'id')::bigint = p_option_id limit 1;
  if v_opt is null or coalesce((v_opt->>'active')::boolean, true) = false then
    return jsonb_build_object('ok',false,'error','activity not available'); end if;
  -- option.users empty/absent = everyone; else caller physId must be listed
  if jsonb_typeof(v_opt->'users') = 'array' and jsonb_array_length(v_opt->'users') > 0
     and not exists(select 1 from jsonb_array_elements_text(v_opt->'users') x where x = v_pid::text) then
    return jsonb_build_object('ok',false,'error','activity not available to you'); end if;

  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);
  v_entry := jsonb_build_object('id',v_nextid,'physId',v_pid,'optionId',p_option_id,
    'hours',v_hours,'date',p_date,'note',v_note,'by',v_uid,'ts',v_now);
  v_blob := jsonb_set(v_blob, '{timeLogEntries}', coalesce(v_blob->'timeLogEntries','[]'::jsonb) || v_entry);
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid+1));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'id',v_nextid);
end $function$;

-- 4. Delete a time entry: own entry, or admin (AAL2) may delete any
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
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);

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

-- 5. Mark all pending swaps addressed to the caller as viewed (blob-only field, not mirrored)
CREATE OR REPLACE FUNCTION public.rs_mark_swaps_viewed(p_practice text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_new jsonb; v_count int := 0;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',true,'count',0); end if;

  select coalesce(jsonb_agg(
    case when (s->>'toPhysId')::int = v_pid and coalesce(s->>'status','')='pending'
              and (s->'viewedAt' is null or s->>'viewedAt'='' )
         then s || jsonb_build_object('viewedAt',v_now,'viewedBy',v_uid)
         else s end
    order by ord), '[]'::jsonb)
  into v_new
  from jsonb_array_elements(coalesce(v_blob->'swapRequests','[]'::jsonb)) with ordinality t(s,ord);

  select count(*) into v_count
    from jsonb_array_elements(coalesce(v_blob->'swapRequests','[]'::jsonb)) s
    where (s->>'toPhysId')::int = v_pid and coalesce(s->>'status','')='pending'
          and (s->'viewedAt' is null or s->>'viewedAt'='');
  if v_count = 0 then return jsonb_build_object('ok',true,'count',0); end if;

  v_blob := jsonb_set(v_blob, '{swapRequests}', v_new);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'count',v_count);
end $function$;

-- 6. Toggle a chat pin for a conversation (any practice member; cap 5, drop oldest)
CREATE OR REPLACE FUNCTION public.rs_toggle_chat_pin(p_practice text, p_conv_id text, p_msg_id bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pins jsonb; v_pinned boolean; v_len int;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_conv_id is null or p_msg_id is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u where (u->>'id')=v_uid) then
    return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  if v_blob->'chatPins' is null or jsonb_typeof(v_blob->'chatPins') <> 'object' then
    v_blob := jsonb_set(v_blob, '{chatPins}', '{}'::jsonb); end if;
  v_pins := coalesce(v_blob->'chatPins'->p_conv_id, '[]'::jsonb);
  if jsonb_typeof(v_pins) <> 'array' then v_pins := '[]'::jsonb; end if;

  if exists(select 1 from jsonb_array_elements(v_pins) e where e = to_jsonb(p_msg_id)) then
    select coalesce(jsonb_agg(e), '[]'::jsonb) into v_pins from jsonb_array_elements(v_pins) e where e <> to_jsonb(p_msg_id);
    v_pinned := false;
  else
    v_pins := v_pins || to_jsonb(p_msg_id);
    v_len := jsonb_array_length(v_pins);
    if v_len > 5 then
      select coalesce(jsonb_agg(e order by ord), '[]'::jsonb) into v_pins
        from (select e, ord from jsonb_array_elements(v_pins) with ordinality z(e,ord) order by ord offset (v_len-5)) q;
    end if;
    v_pinned := true;
  end if;

  v_blob := jsonb_set(v_blob, array['chatPins', p_conv_id], v_pins, true);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'pinned',v_pinned);
end $function$;

-- Lock down: authenticated only (definer bypasses RLS internally, identity pinned to auth.uid())
REVOKE ALL ON FUNCTION public.rs_set_notify_email(text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_set_push_subscription(text,jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_log_time(text,bigint,numeric,text,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_delete_time_entry(text,bigint) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_mark_swaps_viewed(text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_toggle_chat_pin(text,text,bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rs_set_notify_email(text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_set_push_subscription(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_log_time(text,bigint,numeric,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_delete_time_entry(text,bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_mark_swaps_viewed(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_toggle_chat_pin(text,text,bigint) TO authenticated;;
