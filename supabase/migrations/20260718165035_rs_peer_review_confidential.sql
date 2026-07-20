-- Confidential peer review (RADPEER model): reviewers are anonymous to the
-- reviewed physician, and rads cannot read each other's reviews. Admins/QA
-- still see everything for quarterly reporting.

-- 1) A rad's own RECEIVED scorecard, fully BLINDED (no reviewer identity ever
--    leaves the DB). SECURITY DEFINER so it can read rows the tightened SELECT
--    policy hides; it only ever returns the CALLER's own received reviews.
create or replace function public.rs_peer_my_scorecard(p_practice text, p_quarter text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public','pg_temp'
as $$
declare v_pid integer; v_n int; v_sum numeric; v_d1 int; v_d2 int; v_d3 int; v_d4 int; v_comments jsonb;
begin
  select (u->>'physId')::int into v_pid
  from public.radscheduler r
  cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
  where r.id = p_practice and (u->>'id') = (auth.uid())::text and (u->>'physId') ~ '^[0-9]{1,9}$'
  limit 1;
  if v_pid is null then return jsonb_build_object('n',0,'mean',0,'dist',jsonb_build_object('1',0,'2',0,'3',0,'4',0),'comments','[]'::jsonb); end if;

  select count(*), coalesce(sum(score),0),
         count(*) filter (where score=1), count(*) filter (where score=2),
         count(*) filter (where score=3), count(*) filter (where score=4)
    into v_n, v_sum, v_d1, v_d2, v_d3, v_d4
  from public.rs_peer_reviews
  where practice_id=p_practice and quarter=p_quarter and status='completed'
    and reviewed_phys_id = v_pid and score is not null;

  select coalesce(jsonb_agg(jsonb_build_object('score',score,'text',comments) order by ts desc), '[]'::jsonb)
    into v_comments
  from public.rs_peer_reviews
  where practice_id=p_practice and quarter=p_quarter and status='completed'
    and reviewed_phys_id = v_pid and comments is not null and comments <> '';

  return jsonb_build_object('n',v_n,'mean', case when v_n>0 then round(v_sum/v_n,2) else 0 end,
    'dist', jsonb_build_object('1',v_d1,'2',v_d2,'3',v_d3,'4',v_d4), 'comments', v_comments);
end $$;
revoke all on function public.rs_peer_my_scorecard(text,text) from public, anon;
grant execute on function public.rs_peer_my_scorecard(text,text) to authenticated;

-- 2) Tighten SELECT: a non-admin may read ONLY reviews they authored (their own
--    pending queue + reviews they wrote). They can no longer read rows where
--    they are the reviewed party, nor anyone else's — closing the reviewer-
--    identity / cross-rad-snooping hole. Admins (AAL2) still read all.
drop policy if exists rs_peer_select on public.rs_peer_reviews;
create policy rs_peer_select on public.rs_peer_reviews
  for select
  using ( radscheduler_admin_aal2() OR radscheduler_owns_row(reviewer_uid) );;
