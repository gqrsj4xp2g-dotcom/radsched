-- Interim hardening for the 3 DUAL-WRITE entities: move the client blob write
-- to identity-pinned DEFINER RPCs (blob stays canonical; owner-table mirror
-- unchanged). This makes EVERY non-admin blob write server-validated so the
-- Phase-5 non-admin RLS lockdown is safe, WITHOUT touching _PERSISTED_KEYS /
-- the catastrophic-loss guard (that owner-table-canonical cutover is separate).

-- 9. Acknowledge on-call: self, or AAL2 admin for anyone. Idempotent.
CREATE OR REPLACE FUNCTION public.rs_acknowledge_oncall(p_practice text, p_phys_id integer, p_date text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_is_admin boolean; v_entry jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_phys_id is null or p_date is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  if p_date !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'error','bad date'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  v_is_admin := coalesce(radscheduler_admin_aal2(), false);
  if not v_is_admin and (v_pid is null or v_pid <> p_phys_id) then
    return jsonb_build_object('ok',false,'error','you can only confirm your own on-call'); end if;

  if exists(select 1 from jsonb_array_elements(coalesce(v_blob->'onCallAcks','[]'::jsonb)) a
            where (a->>'physId') = p_phys_id::text and (a->>'date') = p_date) then
    return jsonb_build_object('ok',true,'noop',true); end if;

  v_entry := jsonb_build_object('physId',p_phys_id,'date',p_date,'ackBy',v_uid,'ackAt',v_now);
  v_blob := jsonb_set(v_blob, '{onCallAcks}', coalesce(v_blob->'onCallAcks','[]'::jsonb) || v_entry);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true);
end $function$;

-- 10. Create a swap request. fromPhysId pinned to caller; caller must OWN the
--     offered ("my") shift. Server derives date/label/site.
CREATE OR REPLACE FUNCTION public.rs_create_swap_request(
    p_practice text, p_kind text, p_shift_id bigint, p_to_phys_id integer,
    p_their_kind text, p_their_shift_id bigint, p_reason text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_pid int; v_nextid bigint;
  v_mine jsonb; v_theirs jsonb; v_mycol text; v_theircol text;
  v_date text; v_label text; v_site text; v_theirdate text; v_swap jsonb;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  colmap jsonb := '{"dr":"drShifts","ir":"irShifts","irc":"irCalls","wk":"weekendCalls"}'::jsonb;
begin
  if p_practice is null or p_kind is null or p_shift_id is null or p_to_phys_id is null then
    return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_mycol := colmap->>p_kind;
  if v_mycol is null then return jsonb_build_object('ok',false,'error','bad kind'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (u->>'physId')::int into v_pid
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u
    where (u->>'id')=v_uid and (u->>'physId') ~ '^[0-9]{1,9}$' limit 1;
  if v_pid is null then return jsonb_build_object('ok',false,'error','your account is not linked to a physician'); end if;

  select value into v_mine from jsonb_array_elements(coalesce(v_blob->v_mycol,'[]'::jsonb)) value
    where (value->>'id')::bigint = p_shift_id limit 1;
  if v_mine is null then return jsonb_build_object('ok',false,'error','shift not found'); end if;
  if (v_mine->>'physId')::int is distinct from v_pid then
    return jsonb_build_object('ok',false,'error','you can only offer your own shift for a swap'); end if;

  -- optional "their" shift (display only)
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

  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);
  v_swap := jsonb_build_object('id',v_nextid,'fromPhysId',v_pid,'toPhysId',p_to_phys_id,
    'date',v_date,'theirDate',v_theirdate,'shiftType',v_label,'site',v_site,
    'reason',left(coalesce(p_reason,''),1000),'status','pending','ts',v_now);
  v_blob := jsonb_set(v_blob, '{swapRequests}', coalesce(v_blob->'swapRequests','[]'::jsonb) || v_swap);
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid+1));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'swap',v_swap);
end $function$;

-- 11. Set the caller's own comm/notification prefs (whitelisted boolean keys).
CREATE OR REPLACE FUNCTION public.rs_set_comm_prefs(p_practice text, p_prefs jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
declare v_blob jsonb; v_uid text; v_uidx int; v_clean jsonb := '{}'::jsonb; k text;
  v_keys text[] := array['master','chatDM','chatGroup','chatMention','swapReq','swapRes',
    'shiftAssign','shiftRemove','holiday','vacation','openShift','broadcast',
    'tumorBoard','clinic','schedulePublish'];
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null or p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;

  foreach k in array v_keys loop
    if p_prefs ? k then
      v_clean := v_clean || jsonb_build_object(k, coalesce((p_prefs->>k)::boolean, false));
    end if;
  end loop;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  select (ordinality-1)::int into v_uidx
    from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) with ordinality
    where (value->>'id')=v_uid limit 1;
  if v_uidx is null then return jsonb_build_object('ok',false,'error','not a member of this practice'); end if;

  v_blob := jsonb_set(v_blob, array['users',v_uidx::text,'notifPrefs'], v_clean, true);
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'prefs',v_clean);
end $function$;

REVOKE ALL ON FUNCTION public.rs_acknowledge_oncall(text,integer,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_create_swap_request(text,text,bigint,integer,text,bigint,text) FROM public, anon;
REVOKE ALL ON FUNCTION public.rs_set_comm_prefs(text,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rs_acknowledge_oncall(text,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_create_swap_request(text,text,bigint,integer,text,bigint,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rs_set_comm_prefs(text,jsonb) TO authenticated;;
