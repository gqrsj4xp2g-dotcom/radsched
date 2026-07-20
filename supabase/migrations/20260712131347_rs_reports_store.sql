-- Signed-report store: the substrate for wRVU tracking, the PACS-fed CPT tab,
-- and peer review. Populated by the pacs-ingest edge function (service role);
-- clients read (practice-scoped) and cache computed wRVU back.
create table if not exists public.rs_reports (
  practice_id   text not null,
  report_uid    text not null,             -- dedup key (accession, else hash) → idempotent ingest
  accession     text,
  mrn           text,                        -- may be null when de-id'd at ingest
  patient_name  text,
  exam          text,
  report_text   text,
  modality      text,
  interpreter_raw text,                      -- OBR-32 / FHIR performer as received
  phys_id       integer,                     -- mapped interpreting radiologist (null until mapped)
  cpt_codes     jsonb default '[]'::jsonb,   -- client-computed CPT lines
  wrvu          numeric,                     -- client-computed + cached work RVU
  signed_at     timestamptz,
  source        text default 'webhook',      -- hl7 | fhir | json | paste | webhook
  ingested_at   timestamptz not null default now(),
  primary key (practice_id, report_uid)
);
create index if not exists rs_reports_practice_signed on public.rs_reports(practice_id, signed_at desc);
create index if not exists rs_reports_practice_phys on public.rs_reports(practice_id, phys_id);

alter table public.rs_reports enable row level security;

-- READ: any signed-in member of the practice (rads peer-review each other's
-- reports; admins see all). Consistent with the practice-scoped access model.
create policy rs_reports_select on public.rs_reports for select
  using ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) );

-- WRITE(client): only the cached derivations (wrvu/cpt/phys mapping) may be set
-- by a signed-in practice member; raw report content arrives via the service-role
-- ingest edge function (which bypasses RLS). No client INSERT/DELETE.
create policy rs_reports_update on public.rs_reports for update
  using ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) )
  with check ( radscheduler_admin_aal2() or radscheduler_non_admin_same_practice(practice_id) );
create policy rs_reports_admin_delete on public.rs_reports for delete
  using ( radscheduler_admin_aal2() );

grant select, update on public.rs_reports to authenticated;
grant delete on public.rs_reports to authenticated;   -- gated to admins by the delete policy;
