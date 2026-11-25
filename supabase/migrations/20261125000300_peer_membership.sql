-- Review access follows the current server-assigned practice even while an old
-- session token or a former practice's physician roster still contains a user.
create function public.rs_peer_can_access(
  p_practice text, p_reviewer uuid, p_allow_management boolean
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid()) and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and (
        (p_allow_management and public.radscheduler_admin_aal2()
          and u.raw_app_meta_data->>'role' = 'superuser')
        or (
          u.raw_app_meta_data->>'practiceId' = p_practice
          and (select auth.jwt())->'app_metadata'->>'practiceId' = p_practice
          and (
            u.id = p_reviewer
            or (p_allow_management and public.radscheduler_admin_same_practice(p_practice)
              and u.raw_app_meta_data->>'role' in ('admin', 'superuser'))
          )
        )
      )
  );
$$;
revoke all on function public.rs_peer_can_access(text, uuid, boolean) from public, anon;
grant execute on function public.rs_peer_can_access(text, uuid, boolean) to authenticated;

alter policy rs_peer_select on public.rs_peer_reviews to authenticated
  using (public.rs_peer_can_access(practice_id, reviewer_uid, true));
alter policy rs_peer_insert on public.rs_peer_reviews to authenticated
  with check (
    public.rs_peer_can_access(practice_id, null, true)
    or (origin = 'manual' and public.rs_peer_can_access(practice_id, reviewer_uid, false))
  );
alter policy rs_peer_update on public.rs_peer_reviews to authenticated
  using (public.rs_peer_can_access(practice_id, reviewer_uid, true))
  with check (public.rs_peer_can_access(practice_id, reviewer_uid, true));
alter policy rs_peer_delete on public.rs_peer_reviews to authenticated
  using (public.rs_peer_can_access(practice_id, reviewer_uid, true));

-- Older grading screens send the original physician IDs again on a score
-- update. Allow those no-op assignments while keeping the review attached to
-- the same people, practice, report, and reporting period.
create function public.rs_peer_keep_assignment()
returns trigger language plpgsql set search_path = '' as $$
declare
  grade_fields constant text[] := array['score', 'comments', 'status', 'updated_at'];
begin
  if (to_jsonb(new) - grade_fields) is distinct from (to_jsonb(old) - grade_fields) then
    raise exception 'Peer review assignment cannot change after creation' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.rs_peer_keep_assignment() from public, anon, authenticated;
create trigger rs_peer_keep_assignment before update on public.rs_peer_reviews
  for each row execute function public.rs_peer_keep_assignment();

-- Keep the existing blinded scorecard shape. A stale roster entry cannot
-- match until the authenticated account and its session both match the practice.
create or replace function public.rs_peer_my_scorecard(p_practice text, p_quarter text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with physician as (
    select (u->>'physId')::integer as id
    from public.radscheduler r
    cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users', '[]'::jsonb)) u
    where r.id = p_practice
      and public.rs_peer_can_access(p_practice, (select auth.uid()), false)
      and u->>'id' = (select auth.uid())::text and u->>'physId' ~ '^[0-9]{1,9}$'
    limit 1
  )
  select jsonb_build_object(
    'n', count(score), 'mean', coalesce(round(avg(score), 2), 0),
    'dist', jsonb_build_object('1', count(*) filter (where score=1), '2', count(*) filter (where score=2),
                               '3', count(*) filter (where score=3), '4', count(*) filter (where score=4)),
    'comments', coalesce(jsonb_agg(jsonb_build_object('score', score, 'text', comments) order by ts desc, id desc)
                        filter (where nullif(comments, '') is not null), '[]'::jsonb)
  )
  from public.rs_peer_reviews
  where practice_id = p_practice and quarter = p_quarter and status = 'completed'
    and reviewed_phys_id = (select id from physician);
$$;
