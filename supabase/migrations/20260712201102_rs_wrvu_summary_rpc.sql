-- Per-physician wRVU aggregation over the FULL rs_reports table for a period,
-- so the wRVU tracker no longer silently truncates to the newest 3000 cached
-- rows. SECURITY INVOKER → the caller's same-practice SELECT RLS applies.
-- Bounds are timestamptz (the client passes local-midnight instants) so the
-- server buckets exactly like the client's local-calendar period.
create or replace function public.rs_wrvu_summary(
  p_practice text, p_from timestamptz, p_to timestamptz)
returns table(phys_id integer, total_wrvu numeric, n bigint)
language sql
stable
security invoker
set search_path to 'public','pg_temp'
as $$
  select rr.phys_id, coalesce(sum(rr.wrvu), 0)::numeric, count(*)::bigint
  from public.rs_reports rr
  where rr.practice_id = p_practice
    and rr.phys_id is not null
    and rr.signed_at >= p_from and rr.signed_at < p_to
  group by rr.phys_id;
$$;
revoke all on function public.rs_wrvu_summary(text, timestamptz, timestamptz) from public, anon;
grant execute on function public.rs_wrvu_summary(text, timestamptz, timestamptz) to authenticated;;
