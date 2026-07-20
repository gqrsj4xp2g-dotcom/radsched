-- Like-for-like peer review: the auto-triggered review must target a prior of
-- the SAME study type (modality + body part) the reviewer is currently reading.

alter table public.rs_reports add column if not exists body_part text;

-- Replace the 3-arg trigger with a 5-arg version that takes the triggering
-- study's modality/body part. Drop the old signature so PostgREST rpc name
-- resolution stays unambiguous.
drop function if exists public.rs_peer_review_autotrigger(text,integer,date);

create or replace function public.rs_peer_review_autotrigger(
  p_practice text, p_phys_id integer, p_shift_date date,
  p_modality text default null, p_body_part text default null)
returns bigint
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_uid uuid; v_report_uid text; v_accession text; v_reviewed integer; v_id bigint; v_quarter text;
  v_mod text := nullif(upper(trim(p_modality)), '');
  v_bp  text := nullif(upper(trim(p_body_part)), '');
begin
  if p_practice is null or p_phys_id is null or p_shift_date is null then return null; end if;
  -- Fast path: this rad already has their auto review for this shift day.
  if exists (select 1 from public.rs_peer_reviews
             where practice_id=p_practice and reviewer_phys_id=p_phys_id
               and shift_date=p_shift_date and origin='auto') then
    return null;
  end if;
  -- Resolve the reviewer's account uid from the roster (needs a real login).
  select (u->>'id')::uuid into v_uid
  from public.radscheduler r
  cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
  where r.id = p_practice
    and (u->>'physId') ~ '^[0-9]+$' and (u->>'physId')::int = p_phys_id
    and (u->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  limit 1;
  if v_uid is null then return null; end if;

  -- Selection cascade (all tiers exclude the reviewer's own reports + reports
  -- they already reviewed, and only consider the last 2 years):
  --   1. STRICT: same modality AND same body part as the study being read.
  --   2. SAME MODALITY: body part unavailable/unmatched → same modality only.
  --   3. UNRESTRICTED: only when NO study context was provided at all
  --      (context exists but nothing matches → return null; a later study
  --      that shift may match, keeping reviews like-for-like).
  if v_mod is not null and v_bp is not null then
    select rr.report_uid, rr.accession, rr.phys_id
      into v_report_uid, v_accession, v_reviewed
    from public.rs_reports rr
    where rr.practice_id = p_practice
      and rr.phys_id is not null and rr.phys_id <> p_phys_id
      and rr.signed_at > now() - interval '2 years'
      and upper(coalesce(rr.modality,'')) = v_mod
      and upper(coalesce(rr.body_part,'')) = v_bp
      and not exists (select 1 from public.rs_peer_reviews pr
                      where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
    order by random() limit 1;
  end if;
  if v_report_uid is null and v_mod is not null then
    select rr.report_uid, rr.accession, rr.phys_id
      into v_report_uid, v_accession, v_reviewed
    from public.rs_reports rr
    where rr.practice_id = p_practice
      and rr.phys_id is not null and rr.phys_id <> p_phys_id
      and rr.signed_at > now() - interval '2 years'
      and upper(coalesce(rr.modality,'')) = v_mod
      and not exists (select 1 from public.rs_peer_reviews pr
                      where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
    order by random() limit 1;
  end if;
  if v_report_uid is null and v_mod is null then
    select rr.report_uid, rr.accession, rr.phys_id
      into v_report_uid, v_accession, v_reviewed
    from public.rs_reports rr
    where rr.practice_id = p_practice
      and rr.phys_id is not null and rr.phys_id <> p_phys_id
      and rr.signed_at > now() - interval '2 years'
      and not exists (select 1 from public.rs_peer_reviews pr
                      where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
    order by random() limit 1;
  end if;
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

-- Roster sweep, rewritten for like-for-like matching: for each rostered rad,
-- use the study types they ACTUALLY READ that shift day (rs_reports) as the
-- matching context, trying most-recent study types first. A rad with no
-- signed reports that day is skipped — the pacs-ingest hook covers them the
-- moment they start reading, and with no context there is nothing valid to
-- match "like-for-like" against.
-- Shift-day boundary: [p_date 08:00 UTC, p_date+1 08:00 UTC) — 3am ET/12am PT,
-- so one US work/evening shift lands on ONE shift day (matches the ingest hook).
create or replace function public.rs_peer_review_roster_sweep(p_date date default current_date)
returns integer
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare r record; c record; v_id bigint; v_count integer := 0;
begin
  for r in
    select distinct practice_id, phys_id
    from public.radscheduler_shifts
    where shift_date = p_date and phys_id is not null
  loop
    v_id := null;
    for c in
      select upper(coalesce(rr.modality,''))  as m,
             upper(coalesce(rr.body_part,'')) as b,
             max(rr.signed_at) as latest
      from public.rs_reports rr
      where rr.practice_id = r.practice_id and rr.phys_id = r.phys_id::int
        and rr.signed_at >= p_date::timestamptz + interval '8 hours'
        and rr.signed_at <  p_date::timestamptz + interval '32 hours'
      group by 1, 2
      order by latest desc
      limit 10
    loop
      v_id := public.rs_peer_review_autotrigger(
        r.practice_id, r.phys_id::int, p_date, nullif(c.m,''), nullif(c.b,''));
      exit when v_id is not null;
    end loop;
    if v_id is not null then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.rs_peer_review_autotrigger(text,integer,date,text,text) from public, anon, authenticated;
revoke all on function public.rs_peer_review_roster_sweep(date) from public, anon, authenticated;
grant execute on function public.rs_peer_review_autotrigger(text,integer,date,text,text) to service_role;
grant execute on function public.rs_peer_review_roster_sweep(date) to service_role;;
