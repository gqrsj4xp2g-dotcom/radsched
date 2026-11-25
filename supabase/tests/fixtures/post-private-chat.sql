-- Verify the actual data migration, in addition to the steady-state pgTAP suite.
do $$
begin
  if (select count(*) from public.rs_chat_messages where practice_id='chat-upgrade') <> 2
    or not exists(select 1 from public.rs_chat_messages where practice_id='chat-upgrade'
      and body='fixture direct' and sender_id='a' and recipient_id='b')
    or not exists(select 1 from public.rs_chat_messages where practice_id='chat-upgrade'
      and body='fixture group' and group_id='91' and pinned_at is not null
      and cardinality(audience_ids)=2 and audience_ids @> array['a','b'])
  then raise exception 'Legacy private conversation, pin or audience changed during upgrade'; end if;
  if (select count(*) from public.rs_chat_legacy_archive where practice_id='chat-upgrade') <> 3
    or not exists(select 1 from public.rs_chat_legacy_archive where source_id='chat-upgrade'
      and messages->2->>'text'='fixture ambiguous')
    or not exists(select 1 from public.rs_chat_legacy_archive where source_id='chat-upgrade-backup'
      and messages->0->>'text'='fixture backup only')
    or not exists(select 1 from public.rs_chat_legacy_archive where source_id='chat-upgrade-invalid'
      and invalid_source='{"chatMessages": [')
  then raise exception 'Legacy originals were not preserved in the private archive'; end if;
  if not exists(select 1 from public.radscheduler where id='chat-upgrade'
      and not (data::jsonb ?| array['chatMessages','chatPins']) and data::jsonb->'sites'='[{"id":1}]')
    or not exists(select 1 from public.radscheduler_backups where id='chat-upgrade-backup'
      and data::jsonb='{"sites":[{"id":2}]}')
    or not exists(select 1 from public.radscheduler_backups where id='chat-upgrade-invalid' and data is null)
  then raise exception 'Legacy message bodies remain in shared rows or other schedule data was lost'; end if;
end;
$$;
