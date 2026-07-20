-- Schema: mark auto-triggered reviews + the shift day they belong to.
alter table public.rs_peer_reviews add column if not exists shift_date date;
alter table public.rs_peer_reviews add column if not exists origin text not null default 'manual';

-- Exactly ONE auto review per radiologist per shift day (the dedup guarantee).
create unique index if not exists rs_peer_reviews_auto_once_per_shift
  on public.rs_peer_reviews (practice_id, reviewer_phys_id, shift_date)
  where origin = 'auto';

-- Core: create one auto pending peer review for a rad on a given shift day,
-- targeting a RANDOM eligible prior (another rad's recent report the reviewer
-- hasn't already reviewed). Idempotent — safe to call from both the roster
-- cron and the pacs-ingest hook; the unique index makes it exactly-once.
create or replace function public.rs_peer_review_autotrigger(p_practice text, p_phys_id integer, p_shift_date date)
returns bigint
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_uid uuid; v_report_uid text; v_accession text; v_reviewed integer; v_id bigint; v_quarter text;
begin
  if p_practice is null or p_phys_id is null or p_shift_date is null then return null; end if;
  -- Fast path: already have this rad's auto review for this shift day.
  if exists (select 1 from public.rs_peer_reviews
             where practice_id=p_practice and reviewer_phys_id=p_phys_id
               and shift_date=p_shift_date and origin='auto') then
    return null;
  end if;
  -- Resolve the reviewer's account uid from the roster (must be a real login to route it).
  select (u->>'id')::uuid into v_uid
  from public.radscheduler r
  cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
  where r.id = p_practice
    and (u->>'physId') ~ '^[0-9]+$' and (u->>'physId')::int = p_phys_id
    and (u->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  limit 1;
  if v_uid is null then return null; end if;
  -- Random eligible prior: another rad's recent report, not already reviewed by this reviewer.
  select rr.report_uid, rr.accession, rr.phys_id
    into v_report_uid, v_accession, v_reviewed
  from public.rs_reports rr
  where rr.practice_id = p_practice
    and rr.phys_id is not null and rr.phys_id <> p_phys_id
    and rr.signed_at > now() - interval '2 years'
    and not exists (select 1 from public.rs_peer_reviews pr
                    where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
  order by random()
  limit 1;
  if v_report_uid is null then return null; end if;
  v_quarter := extract(year from p_shift_date)::text || '-Q' || (floor((extract(month from p_shift_date)-1)/3)+1)::text;
  insert into public.rs_peer_reviews
    (practice_id, report_uid, accession, reviewed_phys_id, reviewer_phys_id, reviewer_uid, quarter, status, origin, shift_date)
  values
    (p_practice, v_report_uid, v_accession, v_reviewed, p_phys_id, v_uid, v_quarter, 'pending', 'auto', p_shift_date)
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Roster sweep: create one auto review for every rad scheduled on p_date.
-- Called daily by pg_cron. Idempotent via the core function.
create or replace function public.rs_peer_review_roster_sweep(p_date date default current_date)
returns integer
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare r record; v_id bigint; v_count integer := 0;
begin
  for r in
    select distinct practice_id, phys_id
    from public.radscheduler_shifts
    where shift_date = p_date and phys_id is not null
  loop
    v_id := public.rs_peer_review_autotrigger(r.practice_id, r.phys_id::int, p_date);
    if v_id is not null then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.rs_peer_review_autotrigger(text,integer,date) from public, anon, authenticated;
revoke all on function public.rs_peer_review_roster_sweep(date) from public, anon, authenticated;
grant execute on function public.rs_peer_review_autotrigger(text,integer,date) to service_role;
grant execute on function public.rs_peer_review_roster_sweep(date) to service_role;;
