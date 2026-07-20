-- Per-entity migration Phase 1: owner-write tables (additive; blob stays canonical).
-- Ownership keys on auth.uid() because physId lives in user-editable user_metadata.

create or replace function public.radscheduler_owns_row(row_owner uuid)
returns boolean language sql stable set search_path to 'public','pg_temp' as $$
  select row_owner = (select auth.uid());
$$;

-- ── rs_comm_prefs: one row per user, owner-writable, private-ish ──
create table if not exists public.rs_comm_prefs (
  practice_id text not null,
  owner_uid   uuid not null,
  phys_id     bigint,
  prefs       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (practice_id, owner_uid)
);
alter table public.rs_comm_prefs enable row level security;
grant select, insert, update, delete on public.rs_comm_prefs to authenticated;

create policy prefs_select on public.rs_comm_prefs for select to authenticated
  using ( radscheduler_admin_aal2() or radscheduler_owns_row(owner_uid) );
create policy prefs_insert on public.rs_comm_prefs for insert to authenticated
  with check ( radscheduler_owns_row(owner_uid)
               and practice_id = ((select auth.jwt())->'app_metadata'->>'practiceId') );
create policy prefs_update on public.rs_comm_prefs for update to authenticated
  using ( radscheduler_owns_row(owner_uid) )
  with check ( radscheduler_owns_row(owner_uid) );

-- ── rs_on_call_acks: one row per (user, date), owner-writable, same-practice readable ──
create table if not exists public.rs_on_call_acks (
  id          bigint generated always as identity primary key,
  practice_id text not null,
  owner_uid   uuid not null,
  phys_id     bigint,
  ack_date    date not null,
  ts          timestamptz not null default now(),
  unique (practice_id, owner_uid, ack_date)
);
alter table public.rs_on_call_acks enable row level security;
grant select, insert, delete on public.rs_on_call_acks to authenticated;

create policy ack_select on public.rs_on_call_acks for select to authenticated
  using ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) );
create policy ack_insert on public.rs_on_call_acks for insert to authenticated
  with check ( radscheduler_owns_row(owner_uid)
               and practice_id = ((select auth.jwt())->'app_metadata'->>'practiceId') );
create policy ack_delete on public.rs_on_call_acks for delete to authenticated
  using ( radscheduler_admin_aal2() or radscheduler_owns_row(owner_uid) );;
