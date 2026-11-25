-- Participant read, notification routing, private pins and shared snapshot contract.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(23);
insert into public.practices(id,name) values ('chat-fixture-a','Chat A'),('chat-fixture-b','Chat B');
insert into auth.users(id,raw_app_meta_data) values
 ('13500000-0000-4000-8000-000000000011','{"role":"user","practiceId":"chat-fixture-a"}'),
 ('13500000-0000-4000-8000-000000000012','{"role":"user","practiceId":"chat-fixture-a"}'),
 ('13500000-0000-4000-8000-000000000013','{"role":"admin","practiceId":"chat-fixture-a"}'),
 ('13500000-0000-4000-8000-000000000014','{"role":"user","practiceId":"chat-fixture-b"}');
insert into public.radscheduler(id,data) values ('chat-fixture-a',
 '{"users":[{"id":"13500000-0000-4000-8000-000000000011","email":"a@example.invalid"},{"id":"13500000-0000-4000-8000-000000000012","email":"b@example.invalid"},{"id":"13500000-0000-4000-8000-000000000013","email":"c@example.invalid"}],"chatMessages":[{"text":"old fixture"}],"chatPins":{"7":[1]},"chatGroups":[{"id":7,"isPrivate":true,"createdBy":"13500000-0000-4000-8000-000000000011","memberIds":["13500000-0000-4000-8000-000000000012"]},{"id":8,"memberIds":[],"isPrivate":false}]}');
insert into public.radscheduler_backups(id,practice_id,data) values
 ('chat-fixture-a_backup','chat-fixture-a','{"physicians":[],"chatMessages":[{"text":"private fixture"}],"chatPins":{}}');
select is((select data::jsonb ?| array['chatMessages','chatPins'] from public.radscheduler where id='chat-fixture-a'),false,'schedule contains no legacy chat keys');
select is((select data::jsonb from public.radscheduler_backups where id='chat-fixture-a_backup'),'{"physicians":[]}'::jsonb,'shared backup retains schedule data and strips chat');
select is(has_table_privilege('authenticated','public.rs_chat_legacy_archive','SELECT'),false,'client cannot read archived originals');
select is(has_table_privilege('authenticated','public.rs_chat_messages','INSERT'),false,'sends go through server routing');
select ok(exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rs_chat_messages'),'chat is published for authorized realtime subscribers');

set local role authenticated;
set local "request.jwt.claims"='{"sub":"13500000-0000-4000-8000-000000000011","app_metadata":{"practiceId":"chat-fixture-a","role":"user"}}';
select is(public.rs_send_chat_message('chat-fixture-a','direct','dm',null,'13500000-0000-4000-8000-000000000012',null)->>'ok','true','member can send a direct message');
select is(public.rs_send_chat_message('chat-fixture-a','private group','7',7,null,null)->>'ok','true','group creator can send to their private group');
select is(public.rs_send_chat_message('chat-fixture-a','public group','8',8,null,null)->>'ok','true','member can post to an open group');
select is(public.rs_send_chat_message('chat-fixture-a','foreign','dm',null,'13500000-0000-4000-8000-000000000014',null)->>'ok','false','DM recipient must belong to the same current practice');
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a'),3::bigint,'sender reads sent conversations');

reset role;
select is((select array_agg(t.email) from public.rs_chat_messages m cross join lateral
  public.rs_chat_notification_targets('chat-fixture-a',m.sender_id,m.id,
    array['13500000-0000-4000-8000-000000000012','13500000-0000-4000-8000-000000000013'],'chatDM') t
  where m.practice_id='chat-fixture-a' and m.body='direct'),array['b@example.invalid'],
  'notifications resolve only the stored DM recipient address');
select is((select array_agg(t.email) from public.rs_chat_messages m cross join lateral
  public.rs_chat_notification_targets('chat-fixture-a',m.sender_id,m.id,
    array['13500000-0000-4000-8000-000000000012','13500000-0000-4000-8000-000000000013'],'chatMention') t
  where m.practice_id='chat-fixture-a' and m.body='private group'),array['b@example.invalid'],
  'a private group mention cannot email a nonmember');
select is(has_function_privilege('authenticated','public.rs_chat_notification_targets(text,text,bigint,text[],text)','execute'),
  false,'only the mail service can resolve delivery addresses');
set local role authenticated;
set local "request.jwt.claims"='{"sub":"13500000-0000-4000-8000-000000000012","app_metadata":{"practiceId":"chat-fixture-a","role":"user"}}';
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a'),3::bigint,'recipient and group member reads their conversations');
select is((select public.rs_toggle_chat_pin('chat-fixture-a','7',id)->>'pinned' from public.rs_chat_messages where group_id='7'), 'true','member pins visible group message');
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a' and pinned_at is not null),1::bigint,'private pin is available to participants');

set local "request.jwt.claims"='{"sub":"13500000-0000-4000-8000-000000000013","aal":"aal2","app_metadata":{"practiceId":"chat-fixture-a","role":"admin"}}';
select is((select array_agg(body) from public.rs_chat_messages where practice_id='chat-fixture-a'),array['public group'],'nonparticipant admin receives only open-group message');
select is(public.rs_send_chat_message('chat-fixture-a','private','7',7,null,null)->>'ok','false','nonparticipant cannot post to a private group');
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a' and pinned_at is not null),0::bigint,'private pin metadata is also scoped');

reset role;
update public.radscheduler set data=jsonb_set(data::jsonb,'{chatGroups,0,memberIds}',
  '["13500000-0000-4000-8000-000000000012","13500000-0000-4000-8000-000000000013"]')::text
where id='chat-fixture-a';
set local role authenticated;
select is((select count(*) from public.rs_chat_messages where group_id='7'),0::bigint,
  'joining a private group later does not reveal messages sent to its earlier membership');
reset role;
update auth.users set raw_app_meta_data='{"practiceId":"chat-fixture-b","role":"user"}'
where id='13500000-0000-4000-8000-000000000012';
set local role authenticated;
set local "request.jwt.claims"='{"sub":"13500000-0000-4000-8000-000000000012","app_metadata":{"practiceId":"chat-fixture-a","role":"user"}}';
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a'),0::bigint,'transferred member loses prior conversations, including with old session');
set local "request.jwt.claims"='{"sub":"13500000-0000-4000-8000-000000000014","app_metadata":{"practiceId":"chat-fixture-b","role":"user"}}';
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a'),0::bigint,'foreign member cannot read open or private groups');
reset role;
delete from auth.users where id='13500000-0000-4000-8000-000000000011';
select is((select count(*) from public.rs_chat_messages where practice_id='chat-fixture-a'),0::bigint,'deleted account messages are removed from the active inbox');
select * from finish();
rollback;
