-- Synthetic legacy payload written before the private chat cutover by the disposable DB test.
insert into public.practices(id,name) values ('chat-upgrade','Chat upgrade fixture');
insert into public.radscheduler(id,data) values ('chat-upgrade',
'{"sites":[{"id":1}],"chatGroups":[{"id":91,"memberIds":["b"],"createdBy":"a","isPrivate":true}],
"chatMessages":[{"id":1,"channel":"dm","text":"fixture direct","userId":"a","toUserId":"b","dmId":"a::b","ts":"2025-01-01"},
{"id":2,"channel":"91","text":"fixture group","toGroupId":91,"userId":"a","ts":"2025-01-02"},
{"id":3,"channel":"dm","text":"fixture ambiguous","userId":"a","ts":"2025-01-03"}],
"chatPins":{"91":[2]}}');
insert into public.radscheduler_backups(id,practice_id,data) values
 ('chat-upgrade-backup','chat-upgrade','{"sites":[{"id":2}],"chatMessages":[{"text":"fixture backup only"}]}'),
 ('chat-upgrade-invalid','chat-upgrade','{"chatMessages": [');
