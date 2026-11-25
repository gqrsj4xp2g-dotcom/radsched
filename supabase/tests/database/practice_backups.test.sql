begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into public.practices(id,name) values ('backup-test-a','Backup test A'), ('backup-test-b','Backup test B');
insert into public.radscheduler(id,data) values
  ('backup-test-a','{"physicians":[],"drShifts":[{"id":1}],"newField":"preserve","savedAt":"2026-01-01T00:00:00Z"}'),
  ('backup-test-b','{"sites":[]}');
insert into public.radscheduler_backups(id,practice_id,data,backup_day,created_at) values
  ('old-managed','backup-test-a','{"sites":[]}', (now() at time zone 'UTC')::date - 8, now()-interval '8 days'),
  ('old-manual','backup-test-a','{"sites":[]}',null,now()-interval '2 years'),
  ('picked','backup-test-a','{"physicians":[],"drShifts":[{"id":2}],"swapRequests":[{}],"onCallAcks":[{}],"chatMessages":[{}],"chatPins":[{}],"cfg":{"_widgetSecret":"obsolete"}}',null,now());
insert into public.rs_swap_requests(practice_id,client_id,owner_uid) values
  ('backup-test-a',991,'00000000-0000-4000-8000-000000000001');
insert into public.rs_on_call_acks(practice_id,owner_uid,ack_date) values
  ('backup-test-a','00000000-0000-4000-8000-000000000001','2026-01-01');

select ok(exists(select from cron.job where jobname='rs-daily-practice-backups'
              and command='select public.rs_run_daily_practice_backups()' and active),'server schedules backups without a login');
select ok(not has_table_privilege('authenticated','public.radscheduler_audit','truncate'),'browser cannot truncate the audit trail');
select lives_ok('select public.rs_run_daily_practice_backups()', 'schedule captures without a browser or JWT');
select lives_ok('select public.rs_run_daily_practice_backups()', 'same-day rerun succeeds');
select is((select count(*) from public.radscheduler_backups where practice_id='backup-test-a' and backup_day is not null),
  1::bigint,'one daily point per UTC date with expired daily points pruned');
select is((select count(*) from public.radscheduler_backups where id='old-manual'),1::bigint,'existing manual point is preserved');

insert into public.radscheduler_backups(id,practice_id,data,backup_day)
 values ('backup-test-b-old-good','backup-test-b','{"sites":[]}',(now() at time zone 'UTC')::date - 10);
delete from public.radscheduler_backups where practice_id='backup-test-b' and backup_day=(now() at time zone 'UTC')::date;
update public.radscheduler set data='{"drShifts":"invalid"}' where id='backup-test-b';
select lives_ok('select public.rs_run_daily_practice_backups()','invalid practice is isolated from the daily run');
select is((select count(*) from public.radscheduler_backups where id='backup-test-b-old-good'),1::bigint,'invalid source preserves last good daily point');
select ok(not exists(select from public.radscheduler_backups where practice_id='backup-test-b' and backup_day=(now() at time zone 'UTC')::date),
          'invalid source is never reported as a successful daily capture');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","app_metadata":{"role":"admin","practiceId":"backup-test-a"}}';
select is((select count(*) from public.radscheduler where id='backup-test-a'),1::bigint,'own-practice admin can read schedule at AAL1');
select is((select count(*) from public.radscheduler where id='backup-test-b'),0::bigint,'AAL1 admin cannot read another schedule');
select is((select count(*) from public.radscheduler_backups where practice_id='backup-test-a'),0::bigint,'raw backups require MFA');
select is(public.radscheduler_non_admin_same_practice('backup-test-a'),false,'AAL1 admin gets no mutation membership override');
select ok(not has_function_privilege(current_user,'public.rs_restore_practice_backup(text,text,timestamptz,uuid,uuid,text,text)','execute'),'browser cannot supply a restore actor');
set local "request.jwt.claims" = '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","app_metadata":{"role":"admin","practiceId":"backup-test-a"}}';
select is((select count(*) from public.radscheduler where id='backup-test-b'),0::bigint,'AAL2 tenant administrator cannot read another schedule');
select lives_ok($$select public.rs_capture_practice_backup('backup-test-a','manual')$$,'MFA admin can capture own practice');
select throws_ok($$select public.rs_capture_practice_backup('backup-test-b','manual')$$,'42501','Practice administrator MFA required','manual capture rejects another practice');
reset role;

-- The service performs one RPC. Exercise the verified actor's transaction,
-- including a real database fault injected at the required audit write.
create temp table backup_test_version as select saved_at as expected from public.radscheduler where id='backup-test-a';
create function pg_temp.restore_backup_test() returns jsonb language sql as $$
  select public.rs_restore_practice_backup('backup-test-a','picked',
    (select expected from backup_test_version),
    '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','synthetic@example.invalid','admin')
$$;
create function pg_temp.reject_restore_audit() returns trigger language plpgsql as $$
begin
  if new.action='admin.restoreBackup' then raise exception 'Synthetic audit failure'; end if;
  return new;
end;
$$;
create trigger backup_test_reject_audit before insert on public.radscheduler_audit
  for each row execute function pg_temp.reject_restore_audit();
select throws_ok('select pg_temp.restore_backup_test()','P0001','Synthetic audit failure','audit failure fails the restore');
select is((select data::jsonb#>>'{drShifts,0,id}' from public.radscheduler where id='backup-test-a'),'1','failed restore rolls back schedule');
select is((select count(*) from public.rs_restore_receipts where practice_id='backup-test-a'),0::bigint,'failed restore has no receipt');
select is((select count(*) from public.radscheduler_backups where id='backup-test-a_pre-restore_00000000-0000-4000-8000-000000000002'),0::bigint,'failed restore rolls back its safety point');
drop trigger backup_test_reject_audit on public.radscheduler_audit;

select is(pg_temp.restore_backup_test()->>'replayed','false','first successful restore commits');
select is(pg_temp.restore_backup_test()->>'replayed','true','retry returns the original receipt');
select is((select data::jsonb#>>'{drShifts,0,id}' from public.radscheduler where id='backup-test-a'),'2','restore reverts the shift');
select is((select data::jsonb->>'newField' from public.radscheduler where id='backup-test-a'),'preserve','older backup preserves fields it did not cover');
select ok((select not (data::jsonb ?| array['swapRequests','onCallAcks','chatMessages','chatPins'])
              and not (data::jsonb->'cfg' ? '_widgetSecret') from public.radscheduler where id='backup-test-a'),
          'restore excludes stale side-table data and secrets');
select is((select count(*) from public.rs_swap_requests where practice_id='backup-test-a' and client_id=991),1::bigint,'canonical swap survives');
select is((select count(*) from public.rs_on_call_acks where practice_id='backup-test-a' and ack_date='2026-01-01'),1::bigint,'canonical acknowledgement survives');
select is((select count(*) from public.radscheduler_audit where practice_id='backup-test-a' and action='admin.restoreBackup'
           and detail->>'requestId'='00000000-0000-4000-8000-000000000002' and entry_hash is not null),1::bigint,'exactly one traceable hashed audit event');
select is((select count(*) from public.rs_restore_receipts where practice_id='backup-test-a'),1::bigint,'exactly one receipt');
select throws_ok($$select public.rs_restore_practice_backup('backup-test-a','picked',
  (select expected from backup_test_version),'00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',
  'synthetic@example.invalid','admin')$$,'40001','Practice changed. Review the current schedule and confirm again.','stale version fails closed');
insert into public.radscheduler_audit(practice_id,ts,action) values ('backup-test-a','2020-01-01T00:00:00Z','test.backdated');
insert into public.radscheduler_audit(practice_id,ts,action,prev_hash) values ('backup-test-a','2019-01-01T00:00:00Z','test.next','client-supplied');
select is((select prev_hash from public.radscheduler_audit where practice_id='backup-test-a' and action='test.next'),
          (select entry_hash from public.radscheduler_audit where practice_id='backup-test-a' and action='test.backdated'),
          'new audit entries follow insertion order and ignore supplied predecessor hashes');
select throws_ok($$update public.radscheduler_audit set who='changed' where practice_id='backup-test-a'$$,
  'P0001','radscheduler_audit is append-only; insert a compensating event instead','database prevents rewriting audit history');
select throws_ok($$delete from public.radscheduler_audit where practice_id='backup-test-a'$$,
  'P0001','radscheduler_audit is append-only; insert a compensating event instead','database prevents deleting audit history');
update public.radscheduler set data='{"sites":[],"drShifts":[{"id":3}],"savedAt":"2026-10-01T00:00:00Z"}' where id='backup-test-a';
select is(pg_temp.restore_backup_test()#>>'{payload,drShifts,0,id}','3','delayed retry returns subsequent edits without overwriting them');
select * from finish();
rollback;
