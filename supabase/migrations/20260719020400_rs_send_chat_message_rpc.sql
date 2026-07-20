-- Secure chat send: the SENDER (userId) is pinned to auth.uid() server-side, so
-- a client can no longer post a message AS another user by tampering with the
-- blob. Caller must be a member of the practice. Appends to chatMessages
-- atomically (row lock) and returns the created message for optimistic render.
create or replace function public.rs_send_chat_message(
  p_practice text, p_text text, p_channel text,
  p_to_group_id bigint default null, p_to_user_id text default null, p_dm_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare v_blob jsonb; v_uid text; v_nextid bigint; v_msg jsonb; v_text text;
  v_now text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_practice is null then return jsonb_build_object('ok',false,'error','bad args'); end if;
  v_uid := (auth.uid())::text;
  if v_uid is null then return jsonb_build_object('ok',false,'error','not authenticated'); end if;
  v_text := left(coalesce(p_text,''), 4000);
  if length(btrim(v_text)) = 0 then return jsonb_build_object('ok',false,'error','empty message'); end if;

  select data::jsonb into v_blob from public.radscheduler where id=p_practice for update;
  if v_blob is null then return jsonb_build_object('ok',false,'error','practice not found'); end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(v_blob->'users','[]'::jsonb)) u where (u->>'id')=v_uid) then
    return jsonb_build_object('ok',false,'error','not a member of this practice');
  end if;

  v_nextid := coalesce((v_blob->>'nextId')::bigint, 1);
  v_msg := jsonb_build_object(
    'id', v_nextid, 'userId', v_uid, 'text', v_text, 'ts', v_now,
    'channel', coalesce(p_channel,'dm'),
    'toGroupId', p_to_group_id, 'toUserId', p_to_user_id, 'dmId', p_dm_id);
  v_blob := jsonb_set(v_blob, '{chatMessages}', coalesce(v_blob->'chatMessages','[]'::jsonb) || v_msg);
  v_blob := jsonb_set(v_blob, '{nextId}', to_jsonb(v_nextid+1));
  v_blob := jsonb_set(v_blob, '{savedAt}', to_jsonb(v_now));
  update public.radscheduler set data=v_blob::text where id=p_practice;
  return jsonb_build_object('ok',true,'msg',v_msg);
end $$;
revoke all on function public.rs_send_chat_message(text,text,text,bigint,text,text) from public, anon;
grant execute on function public.rs_send_chat_message(text,text,text,bigint,text,text) to authenticated;;
