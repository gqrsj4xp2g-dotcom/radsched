-- Per-entity migration, swaps: owner-writable swap requests with true RLS.
-- Blob stays canonical until Phase 5; this table is dual-written + read-merged.
create table if not exists public.rs_swap_requests (
  practice_id  text not null,
  client_id    bigint not null,              -- the app's S.nextId id (union-merge key)
  owner_uid    uuid not null default auth.uid(),
  from_phys_id integer,
  to_phys_id   integer,
  shift_date   text,                          -- ISO yyyy-mm-dd (requester's shift)
  their_date   text,                          -- ISO or '' (two-sided return leg)
  shift_type   text default '',
  site         text default '',
  reason       text default '',
  status       text not null default 'pending' check (status in ('pending','approved','denied')),
  ts           timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (practice_id, client_id)
);

alter table public.rs_swap_requests enable row level security;

create or replace function public.rs_swap_touch_updated_at()
returns trigger language plpgsql security invoker set search_path='' as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists trg_rs_swap_touch on public.rs_swap_requests;
create trigger trg_rs_swap_touch before update on public.rs_swap_requests
  for each row execute function public.rs_swap_touch_updated_at();

-- READ: anyone in the practice (swaps are practice-visible), or admin.
create policy rs_swap_select on public.rs_swap_requests for select
  using ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) );

-- INSERT: you may create your OWN request, in YOUR practice, only as 'pending'
-- (from_phys is informational; ownership is auth.uid-keyed). Admins may insert anything in-practice.
create policy rs_swap_insert on public.rs_swap_requests for insert
  with check (
    (radscheduler_admin_aal2() and radscheduler_non_admin_same_practice(practice_id) is not false)
    or ( radscheduler_owns_row(owner_uid)
         and radscheduler_non_admin_same_practice(practice_id)
         and status = 'pending' )
  );

-- UPDATE: owner may edit their own request while it is pending, and it must STAY
-- pending (no self-approval). Admin (AAL2) may set any status.
create policy rs_swap_update on public.rs_swap_requests for update
  using ( radscheduler_admin_aal2()
          or (radscheduler_owns_row(owner_uid) and status = 'pending') )
  with check ( radscheduler_admin_aal2() or status = 'pending' );

-- DELETE: owner may withdraw a pending request; admin may delete any.
create policy rs_swap_delete on public.rs_swap_requests for delete
  using ( radscheduler_admin_aal2()
          or (radscheduler_owns_row(owner_uid) and status = 'pending') );

grant select, insert, update, delete on public.rs_swap_requests to authenticated;;
