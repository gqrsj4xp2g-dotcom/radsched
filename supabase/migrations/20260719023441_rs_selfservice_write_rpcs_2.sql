-- Round 2 of self-service per-user blob writes → SECURITY DEFINER RPCs.

-- 7. Set a whitelisted per-user preference on the caller's own user record.
--    Only {fontScale, calFeedToken} are writable; anything else is rejected.
CREATE OR REPLACE FUNCTION public.rs_set_user_pref(p_practice text, p_field text, p_value jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_uidx int; v_num numeric; v_str text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_field is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  -- Per-field validation + normalization (whitelist)
  if p_field = 'fontScale' then
    if jsonb_typeof(p_value) <> 'number' then return jsonb_build_object('ok',false,'error','fontScale must be a number'); end if;
    v_num := p_value::text::numeric;
    if v_num < 0.5 or v_num > 2 then return jsonb_build_object('ok',false,'error','fontScale out of range'); end if;
  elsif p_field = 'calFeedToken' then
    if p_value is null or jsonb_typeof(p_value) <> 'string' then return jsonb_build_object('ok',false,'error','calFeedToken must be a string'); end if;
    v_str := p_value #>> '{}';
    if length(v_str) > 64 then return jsonb_build_object('ok',false,'error','calFeedToken too long'); end if;
  else
    return jsonb_build_object('ok',false,'error','field not writable');
  end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (ordinality-1)::int into v_uidx
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) with ordinality
    where (value->>'id')=v_uid limit 1;
  if v_uidx is null then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  v_blob := jsonb_set(v_blob, array['users',v_uidx::text,p_field], p_value, true);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'field',p_field);
end $function$;

-- 8. Set/clear a shift handoff note: only the shift's own physician or an AAL2 admin.
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
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);

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
end $function$;

REVOKE ALL ON FUNCTION public.rs_set_user_pref(text,text,jsonb) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_set_shift_handoff(text,text,bigint,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rs_set_user_pref(text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_set_shift_handoff(text,text,bigint,text) TO authenticated;;
