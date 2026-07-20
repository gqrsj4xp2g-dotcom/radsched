-- Peer review: reviewer grades a prior report by another rad (1-4) with comments;
-- aggregated per reviewed-rad quarterly.
create table if not exists public.rs_peer_reviews (
  practice_id     text not null,
  id              bigint not null,             -- client S.nextId
  report_uid      text,                        -- the report under review (rs_reports.report_uid)
  accession       text,
  reviewed_phys_id integer,                    -- the rad who signed the report being graded
  reviewer_phys_id integer,                    -- the rad giving the grade
  reviewer_uid    uuid not null default auth.uid(),
  score           smallint check (score between 1 and 4),   -- 1 agree … 4 disagree
  comments        text default '',
  quarter         text,                        -- e.g. '2026-Q3' (derived at write time)
  status          text not null default 'pending' check (status in ('pending','completed')),
  ts              timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (practice_id, id)
);
create index if not exists rs_peer_practice_reviewed on public.rs_peer_reviews(practice_id, reviewed_phys_id, quarter);

alter table public.rs_peer_reviews enable row level security;

create or replace function public.rs_peer_touch_updated_at()
returns trigger language plpgsql security invoker set search_path='' as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists trg_rs_peer_touch on public.rs_peer_reviews;
create trigger trg_rs_peer_touch before update on public.rs_peer_reviews
  for each row execute function public.rs_peer_touch_updated_at();

-- READ: admins see all (for the quarterly aggregate); a rad sees reviews they
-- authored OR reviews OF their own reports (their feedback).
create policy rs_peer_select on public.rs_peer_reviews for select
  using ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) );

-- INSERT: create a review request (pending) or your own completed grade, in-practice.
create policy rs_peer_insert on public.rs_peer_reviews for insert
  with check ( radscheduler_admin_aal2()
               or (radscheduler_owns_row(reviewer_uid) and radscheduler_non_admin_same_practice(practice_id)) );

-- UPDATE: the reviewer completes/edits their OWN review; admin any.
create policy rs_peer_update on public.rs_peer_reviews for update
  using ( radscheduler_admin_aal2() or radscheduler_owns_row(reviewer_uid) )
  with check ( radscheduler_admin_aal2() or radscheduler_owns_row(reviewer_uid) );

create policy rs_peer_delete on public.rs_peer_reviews for delete
  using ( radscheduler_admin_aal2() or radscheduler_owns_row(reviewer_uid) );

grant select, insert, update, delete on public.rs_peer_reviews to authenticated;;
