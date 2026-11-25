-- Practice-wide schedule sync and portable backups must never transport chat bodies or pins.
-- Run as one transaction so old writers cannot insert a private payload between copy and scrub.
begin;
lock table public.radscheduler, public.radscheduler_backups in share row exclusive mode;

create table public.rs_chat_messages (
  id bigint generated always as identity (start with 1000000000000) primary key,
  practice_id text not null references public.practices(id) on delete cascade on update cascade,
  sender_id text not null,
  recipient_id text,
  group_id text,
  audience_ids text[], -- NULL for public groups and DMs
  body text not null,
  sent_at text not null,
  pinned_at timestamptz,
  check ((recipient_id is null) <> (group_id is null))
);
create index rs_chat_practice_order on public.rs_chat_messages(practice_id, id);
create index rs_chat_group_pins on public.rs_chat_messages(practice_id, group_id) where pinned_at is not null;
alter table public.rs_chat_messages enable row level security;
revoke all on public.rs_chat_messages from public, anon, authenticated;
grant select on public.rs_chat_messages to authenticated;
revoke all on sequence public.rs_chat_messages_id_seq from public,anon,authenticated;
grant all on public.rs_chat_messages to service_role;

-- Retain originals, including unrouteable historical records and backup-only versions, for
-- service-side recovery. Backup copies are never promoted into active conversations.
create table public.rs_chat_legacy_archive (
  source_table text not null, source_id text not null, practice_id text not null,
  messages jsonb, pins jsonb, invalid_source text, archived_at timestamptz not null default now(),
  primary key (source_table, source_id)
);
alter table public.rs_chat_legacy_archive enable row level security;
revoke all on public.rs_chat_legacy_archive from public, anon, authenticated;
grant all on public.rs_chat_legacy_archive to service_role;
create policy rs_chat_archive_no_clients on public.rs_chat_legacy_archive to anon, authenticated
  using (false) with check (false);

create function public.rs_chat_member(p_practice text, p_user text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.users u where u.id=case when p_user ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then p_user::uuid end
    and u.raw_app_meta_data->>'practiceId'=p_practice and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= now()));
$$;
-- Uncorrelated lookups let PostgreSQL check membership and read the group list once
-- per inbox query, even when the schedule contains a large historical roster.
create function public.rs_chat_current_practice() returns text
language sql stable security definer set search_path = '' as $$
  select u.raw_app_meta_data->>'practiceId' from auth.users u where u.id=auth.uid()
    and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
    and u.raw_app_meta_data->>'practiceId'=auth.jwt()->'app_metadata'->>'practiceId';
$$;
create function public.rs_chat_visible_groups() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(g->>'id'),array[]::text[]) from public.radscheduler r
    cross join lateral jsonb_array_elements(case jsonb_typeof(r.data::jsonb->'chatGroups')
      when 'array' then r.data::jsonb->'chatGroups' else '[]'::jsonb end) g
    where r.id=public.rs_chat_current_practice() and (
      (g->>'createdBy')=auth.uid()::text or (g->'memberIds') ? auth.uid()::text or
      (coalesce(g->'memberIds','[]'::jsonb)='[]'::jsonb and coalesce(g->>'isPrivate','false') <> 'true'));
$$;
-- Private messages belong to the group members at send time as well as the
-- currently authorized group. Later additions or reuse of a group ID cannot expose old private posts.
create function public.rs_chat_group_audience(p_practice text,p_group text) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare grp jsonb;
begin
  if p_group is null then return null; end if;
  select g into grp from public.radscheduler r cross join lateral jsonb_array_elements(
    case jsonb_typeof(r.data::jsonb->'chatGroups') when 'array' then r.data::jsonb->'chatGroups' else '[]'::jsonb end) g
    where r.id=p_practice and g->>'id'=p_group limit 1;
  if grp is null then return array[]::text[]; end if;
  if coalesce(grp->'memberIds','[]'::jsonb)='[]'::jsonb and coalesce(grp->>'isPrivate','false') <> 'true'
    then return null; end if;
  return array(select distinct member_id from (
    select grp->>'createdBy' member_id union all
    select jsonb_array_elements_text(case jsonb_typeof(grp->'memberIds') when 'array' then grp->'memberIds' else '[]'::jsonb end)
  ) members where member_id is not null);
end;
$$;
revoke all on function public.rs_chat_group_audience(text,text) from public,anon,authenticated;
create function public.rs_chat_can_read(p_practice text,p_sender text,p_recipient text,p_group text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_practice=public.rs_chat_current_practice() and
    case when p_group is null then p_recipient is not null and auth.uid()::text in (p_sender,p_recipient)
         else p_group=any(public.rs_chat_visible_groups()) end,false);
$$;
revoke all on function public.rs_chat_member(text,text), public.rs_chat_can_read(text,text,text,text)
  from public,anon,authenticated;
revoke all on function public.rs_chat_current_practice(), public.rs_chat_visible_groups() from public,anon;
grant execute on function public.rs_chat_current_practice(), public.rs_chat_visible_groups() to authenticated;
create policy rs_chat_participants on public.rs_chat_messages for select to authenticated using (
  practice_id=(select public.rs_chat_current_practice()) and
  case when group_id is null then (select auth.uid())::text in (sender_id,recipient_id)
       else group_id=any((select public.rs_chat_visible_groups())::text[])
         and (audience_ids is null or (select auth.uid())::text=any(audience_ids)) end
);

-- Old snapshots use a TEXT column and may be malformed. Preserve such backup
-- originals in full for recovery without exposing them or blocking the cutover.
create function pg_temp.rs_chat_parse_snapshot(raw text) returns jsonb
language plpgsql immutable strict as $$
begin return raw::jsonb;
exception when data_exception then return null;
end;
$$;
insert into public.rs_chat_legacy_archive (source_table,source_id,practice_id,messages,pins,invalid_source)
select 'practice',id,id,data::jsonb->'chatMessages',data::jsonb->'chatPins',null from public.radscheduler
where data::jsonb ?| array['chatMessages','chatPins']
union all
select 'backup',id,practice_id,blob->'chatMessages',blob->'chatPins',case when blob is null then data end
from public.radscheduler_backups b cross join lateral (select pg_temp.rs_chat_parse_snapshot(b.data) blob) parsed
where data is not null and (blob is null or blob ?| array['chatMessages','chatPins']);

-- An ambiguous route is archived privately; it is never guessed from the text or a group name.
with legacy as (
  select a.practice_id, entry.msg, entry.n, a.pins, entry.msg->>'userId' sender,
    nullif(entry.msg->>'toUserId','') recipient,
    nullif(entry.msg->>'toGroupId','') explicit_group,
    nullif(entry.msg->>'dmId','') dm, nullif(entry.msg->>'channel','') channel
  from public.rs_chat_legacy_archive a cross join lateral jsonb_array_elements(
    case jsonb_typeof(a.messages) when 'array' then a.messages else '[]'::jsonb end)
    with ordinality entry(msg,n) where a.source_table='practice'
), routed as (
  select *, case when explicit_group is null and coalesce(channel,'dm')='dm' then
    case when recipient is not null then recipient
      when cardinality(string_to_array(dm,'::'))=2 then
        case when split_part(dm,'::',1)=sender then nullif(split_part(dm,'::',2),'')
             when split_part(dm,'::',2)=sender then nullif(split_part(dm,'::',1),'') end end
    end target,
    case when recipient is null and dm is null then coalesce(explicit_group,nullif(channel,'dm')) end grp
  from legacy
), normalized as (
  select *, coalesce(grp,least(sender,target) || '::' || greatest(sender,target)) conv from routed
  where sender is not null and jsonb_typeof(msg->'text')='string' and ((target is null) <> (grp is null))
    and (dm is null or dm=least(sender,target) || '::' || greatest(sender,target))
)
insert into public.rs_chat_messages(practice_id,sender_id,recipient_id,group_id,audience_ids,body,sent_at,pinned_at)
select practice_id,sender,target,grp,public.rs_chat_group_audience(practice_id,grp),msg->>'text',coalesce(msg->>'ts',''),
  case when (pins->conv) @> jsonb_build_array(msg->'id') then now() end
from normalized order by practice_id,n;

create function public.rs_scrub_chat_from_schedule() returns trigger
language plpgsql set search_path = '' as $$
declare payload jsonb;
begin
  if new.data is null then return new; end if;
  payload := new.data::jsonb;
  if payload ?| array['chatMessages','chatPins'] then
    new.data := (payload - 'chatMessages' - 'chatPins')::text;
  end if;
  return new;
end;
$$;
revoke all on function public.rs_scrub_chat_from_schedule() from public,anon,authenticated;
create trigger rs_scrub_chat before insert or update of data on public.radscheduler
  for each row execute function public.rs_scrub_chat_from_schedule();
create trigger rs_scrub_chat before insert or update of data on public.radscheduler_backups
  for each row execute function public.rs_scrub_chat_from_schedule();
-- Avoid a full before-image of the legacy schedule on the first realtime update.
alter table public.radscheduler replica identity default;
-- The trigger keeps legacy clients, imports, and restores from putting chat back.
update public.radscheduler set data=data where data::jsonb ?| array['chatMessages','chatPins'];
update public.radscheduler_backups b set data=case when a.invalid_source is null then b.data else null end
from public.rs_chat_legacy_archive a where a.source_table='backup' and a.source_id=b.id;

alter table public.radscheduler replica identity full;

create or replace function public.rs_send_chat_message(p_practice text,p_text text,p_channel text,
  p_to_group_id bigint default null,p_to_user_id text default null,p_dm_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sender text := auth.uid()::text; v_group text := p_to_group_id::text;
  v_id bigint; v_dm text; v_ts text := to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if p_text is null or btrim(p_text)='' or length(p_text)>4000 then
    return jsonb_build_object('ok',false,'error','Message must contain 1 to 4000 characters'); end if;
  if p_practice is null or p_practice is distinct from public.rs_chat_current_practice() then
    return jsonb_build_object('ok',false,'error','Conversation unavailable'); end if;
  -- Freeze the authoritative group roster until routing and audience capture both finish.
  perform 1 from public.radscheduler where id=p_practice for share;
  if (p_to_user_id is null) = (v_group is null) or
      not public.rs_chat_can_read(p_practice,v_sender,p_to_user_id,v_group) then
    return jsonb_build_object('ok',false,'error','Conversation unavailable'); end if;
  if p_to_user_id is not null then
    if not public.rs_chat_member(p_practice,p_to_user_id) then
      return jsonb_build_object('ok',false,'error','Conversation unavailable'); end if;
    v_dm := least(v_sender,p_to_user_id) || '::' || greatest(v_sender,p_to_user_id);
  end if;
  insert into public.rs_chat_messages(practice_id,sender_id,recipient_id,group_id,audience_ids,body,sent_at)
    values(p_practice,v_sender,p_to_user_id,v_group,public.rs_chat_group_audience(p_practice,v_group),p_text,v_ts) returning id into v_id;
  return jsonb_build_object('ok',true,'msg',jsonb_build_object('id',v_id,'userId',v_sender,
    'toUserId',p_to_user_id,'dmId',v_dm,'channel',coalesce(v_group,'dm'),
    'toGroupId',p_to_group_id,'text',p_text,'ts',v_ts));
end;
$$;

create or replace function public.rs_toggle_chat_pin(p_practice text,p_conv_id text,p_msg_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.rs_chat_messages%rowtype; active boolean;
begin
  -- Serialize the five-pin cap inside a conversation, including simultaneous different pins.
  perform pg_advisory_xact_lock(hashtextextended(p_practice || ':' || p_conv_id,0));
  select * into m from public.rs_chat_messages where practice_id=p_practice and id=p_msg_id for update;
  if not found or not public.rs_chat_can_read(m.practice_id,m.sender_id,m.recipient_id,m.group_id)
    or (m.audience_ids is not null and not (auth.uid()::text=any(m.audience_ids)))
    or p_conv_id is distinct from coalesce(m.group_id,least(m.sender_id,m.recipient_id)||'::'||greatest(m.sender_id,m.recipient_id)) then
    return jsonb_build_object('ok',false,'error','Message unavailable'); end if;
  active := m.pinned_at is null;
  update public.rs_chat_messages set pinned_at=case when active then clock_timestamp() end where id=m.id;
  if active then
    update public.rs_chat_messages set pinned_at=null where id in
      (select c.id from public.rs_chat_messages c
       where c.practice_id=p_practice and c.pinned_at is not null
         and (c.audience_ids is null or auth.uid()::text=any(c.audience_ids)) and
         (c.group_id=m.group_id or (c.group_id is null and
           least(c.sender_id,c.recipient_id)=least(m.sender_id,m.recipient_id) and
           greatest(c.sender_id,c.recipient_id)=greatest(m.sender_id,m.recipient_id) and m.group_id is null))
       order by c.pinned_at desc,c.id desc offset 5);
  end if;
  return jsonb_build_object('ok',true,'pinned',active);
end;
$$;
revoke all on function public.rs_send_chat_message(text,text,text,bigint,text,text),
  public.rs_toggle_chat_pin(text,text,bigint) from public,anon;
grant execute on function public.rs_send_chat_message(text,text,text,bigint,text,text),
  public.rs_toggle_chat_pin(text,text,bigint) to authenticated;

-- The mailer supplies the verified sender. Browser-supplied addresses and private
-- message content are never used to deliver chat notifications.
create function public.rs_chat_notification_targets(p_practice text,p_sender text,p_message bigint,p_users text[],p_kind text)
returns table(email text) language sql stable security definer set search_path = '' as $$
  select distinct lower(trim(coalesce(nullif(profile->>'notifyEmail',''),profile->>'email'))) email
  from public.rs_chat_messages m join public.radscheduler r on r.id=m.practice_id
  cross join lateral jsonb_array_elements(case jsonb_typeof(r.data::jsonb->'users')
    when 'array' then r.data::jsonb->'users' else '[]'::jsonb end) profile
  cross join lateral (select public.rs_chat_group_audience(m.practice_id,m.group_id) members) current_group
  where m.id=p_message and m.practice_id=p_practice and m.sender_id=p_sender
    and public.rs_chat_member(p_practice,p_sender) and cardinality(p_users) between 1 and 25
    and profile->>'id'=any(p_users) and profile->>'id'<>p_sender
    and public.rs_chat_member(p_practice,profile->>'id')
    and coalesce(profile->'notifPrefs'->>'master','true')='true'
    and coalesce(profile->'notifPrefs'->>p_kind,case when p_kind='chatGroup' then 'false' else 'true' end)='true'
    and (
      (m.group_id is null and p_kind='chatDM' and profile->>'id'=m.recipient_id)
      or (m.group_id is not null and p_kind in ('chatGroup','chatMention')
          and (m.audience_ids is null or profile->>'id'=any(m.audience_ids))
          and (current_group.members is null or profile->>'id'=any(current_group.members)))
    );
$$;
revoke all on function public.rs_chat_notification_targets(text,text,bigint,text[],text) from public,anon,authenticated;
grant execute on function public.rs_chat_notification_targets(text,text,bigint,text[],text) to service_role;

-- Existing user deletion UX removes live conversations involving a deleted account.
create function public.rs_chat_remove_deleted_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.rs_chat_messages where sender_id=old.id::text or recipient_id=old.id::text;
  return old;
end;
$$;
revoke all on function public.rs_chat_remove_deleted_user() from public,anon,authenticated;
create trigger rs_chat_clean_deleted_user after delete on auth.users
  for each row execute function public.rs_chat_remove_deleted_user();

alter publication supabase_realtime add table public.rs_chat_messages;
commit;
