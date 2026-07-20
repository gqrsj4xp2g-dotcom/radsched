-- Admin quarterly aggregation over the FULL rs_peer_reviews table (the client's
-- 4000-row cache would silently undercount historical quarters). SECURITY
-- INVOKER → the caller's SELECT RLS applies: an admin (admin_aal2) sees all
-- reviews; a non-admin only sees their own authored rows (so this returns their
-- authored-review stats, not others' — the confidential scorecard RPC is the
-- rad-facing path).
create or replace function public.rs_peer_review_summary(p_practice text, p_quarter text)
returns table(reviewed_phys_id integer, n bigint, mean_score numeric, d1 bigint, d2 bigint, d3 bigint, d4 bigint)
language sql stable security invoker set search_path to 'public','pg_temp' as $$
  select reviewed_phys_id, count(*)::bigint, avg(score)::numeric,
         count(*) filter (where score=1)::bigint, count(*) filter (where score=2)::bigint,
         count(*) filter (where score=3)::bigint, count(*) filter (where score=4)::bigint
  from public.rs_peer_reviews
  where practice_id=p_practice and quarter=p_quarter and status='completed'
    and reviewed_phys_id is not null and score is not null
  group by reviewed_phys_id;
$$;
revoke all on function public.rs_peer_review_summary(text,text) from public, anon;
grant execute on function public.rs_peer_review_summary(text,text) to authenticated;;
