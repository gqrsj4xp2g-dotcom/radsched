-- Run against a disposable, migrated local Supabase database with "supabase test db".
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

insert into auth.users (id, raw_app_meta_data) values
  ('13500000-0000-4000-8000-000000000001', '{"role":"user","practiceId":"peer-test-a"}'),
  ('13500000-0000-4000-8000-000000000002', '{"role":"user","practiceId":"peer-test-a"}'),
  ('13500000-0000-4000-8000-000000000003', '{"role":"admin","practiceId":"peer-test-a"}');
insert into public.practices(id,name) values ('peer-test-a','Peer test A'), ('peer-test-b','Peer test B');
insert into public.radscheduler(id,data) values
  ('peer-test-a','{"users":[{"id":"13500000-0000-4000-8000-000000000001","physId":11}]}');
insert into public.rs_peer_reviews
  (practice_id, id, reviewer_uid, reviewer_phys_id, reviewed_phys_id, report_uid, status, score, quarter, comments)
values
  ('peer-test-a', 1, '13500000-0000-4000-8000-000000000001', 11, 12, 'synthetic-1', 'pending', null, '2026-Q4',''),
  ('peer-test-a', 2, '13500000-0000-4000-8000-000000000002', 12, 11, 'synthetic-2', 'completed', 2, '2026-Q4','Synthetic feedback'),
  ('peer-test-b', 1, '13500000-0000-4000-8000-000000000002', 12, 13, 'synthetic-3', 'pending', null, '2026-Q4','');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"13500000-0000-4000-8000-000000000001","aal":"aal1","app_metadata":{"role":"user","practiceId":"peer-test-a"}}';
select is((select array_agg(id) from public.rs_peer_reviews where practice_id like 'peer-test-%'), array[1]::bigint[], 'member sees their own authored review');
select is(public.rs_peer_my_scorecard('peer-test-a','2026-Q4'),
  '{"n":1,"mean":2,"dist":{"1":0,"2":1,"3":0,"4":0},"comments":[{"score":2,"text":"Synthetic feedback"}]}'::jsonb,
  'received scorecard preserves anonymized feedback');
select lives_ok($$update public.rs_peer_reviews set score=3, comments='Test grade', status='completed', reviewer_phys_id=11, reviewed_phys_id=12 where practice_id='peer-test-a' and id=1$$,
  'legacy grading request with original routing is supported');
select is((select score from public.rs_peer_reviews where practice_id='peer-test-a' and id=1), 3::smallint, 'grade was persisted');
select throws_ok($$update public.rs_peer_reviews set reviewed_phys_id=13 where practice_id='peer-test-a' and id=1$$,
  '23514', 'Peer review assignment cannot change after creation', 'grading cannot change assignment');

-- Transfer the account while intentionally keeping both the prior session and
-- its roster entry. Permissions must follow the current Auth account.
reset role;
update auth.users set raw_app_meta_data = '{"role":"user","practiceId":"peer-test-b"}'
where id='13500000-0000-4000-8000-000000000001';
set local role authenticated;
select is((select count(*) from public.rs_peer_reviews where practice_id='peer-test-a'), 0::bigint, 'transferred reviewer no longer sees former reviews');
select is((select public.rs_peer_my_scorecard('peer-test-a','2026-Q4')->>'n'), '0', 'old roster and old token cannot retrieve former scorecard');
with updated as (update public.rs_peer_reviews set comments='Changed' where practice_id='peer-test-a' and id=1 returning id)
  select is(count(*), 0::bigint, 'transfer prevents editing a former review') from updated;
with removed as (delete from public.rs_peer_reviews where practice_id='peer-test-a' and id=1 returning id)
  select is(count(*), 0::bigint, 'transfer prevents deleting a former review') from removed;
select is(public.rs_peer_can_access('peer-test-a','13500000-0000-4000-8000-000000000001',false), false, 'transfer prevents submitting a new review for the former practice');

set local "request.jwt.claims" = '{"sub":"13500000-0000-4000-8000-000000000003","aal":"aal2","app_metadata":{"role":"admin","practiceId":"peer-test-a"}}';
select is((select count(*) from public.rs_peer_reviews where practice_id='peer-test-a'), 2::bigint, 'MFA administrator sees their own practice reviews');
select is((select count(*) from public.rs_peer_reviews where practice_id='peer-test-b'), 0::bigint, 'MFA administrator stays inside their practice');
set local "request.jwt.claims" = '{"sub":"13500000-0000-4000-8000-000000000003","aal":"aal1","app_metadata":{"role":"admin","practiceId":"peer-test-a"}}';
select is((select count(*) from public.rs_peer_reviews where practice_id='peer-test-a'), 0::bigint, 'administrator must complete MFA to read other reviewers');

reset role;
update auth.users set raw_app_meta_data = '{"role":"superuser","practiceId":"peer-test-a"}'
where id='13500000-0000-4000-8000-000000000003';
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"13500000-0000-4000-8000-000000000003","aal":"aal2","app_metadata":{"role":"superuser","practiceId":"peer-test-a"}}';
select is((select count(*) from public.rs_peer_reviews where practice_id='peer-test-b'), 1::bigint, 'MFA superuser retains existing global management access');
select * from finish();
rollback;
