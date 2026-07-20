-- #4: Non-admin client inserts may only create origin='manual' rows. The
-- once-per-shift auto slot (origin='auto') becomes forgeable ONLY by the
-- SECURITY DEFINER autotrigger / service_role — a normal rad can no longer
-- self-exempt from a mandatory review or plant a slot for a colleague.
drop policy if exists rs_peer_insert on public.rs_peer_reviews;
create policy rs_peer_insert on public.rs_peer_reviews
  for insert
  with check (
    radscheduler_admin_aal2()
    OR (radscheduler_owns_row(reviewer_uid) AND radscheduler_non_admin_same_practice(practice_id) AND origin = 'manual')
  );

-- Autotrigger hardened: (#8) reconcile shift_date to the actual roster shift so
-- the ingest (UTC-derived) and cron (roster) paths converge to one key; (#2)
-- compare physId as text (no ::int overflow on a 10-digit NPI); (#1) bounded
-- retry when a report-level unique collision is swallowed while the shift slot
-- is still free.
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
  v_shift date; v_tried text[] := '{}'; v_attempt int;
begin
  if p_practice is null or p_phys_id is null or p_shift_date is null then return null; end if;

  -- (#8) Snap to the rad's roster shift within ±1 day so both trigger paths
  -- agree on one shift_date even across a UTC-date boundary.
  select s.shift_date into v_shift
  from public.radscheduler_shifts s
  where s.practice_id = p_practice and s.phys_id = p_phys_id
    and s.shift_date between p_shift_date - 1 and p_shift_date + 1
  order by abs(s.shift_date - p_shift_date), s.shift_date
  limit 1;
  if v_shift is not null then p_shift_date := v_shift; end if;

  -- Fast path: already have this rad's auto review for the shift day.
  if exists (select 1 from public.rs_peer_reviews
             where practice_id=p_practice and reviewer_phys_id=p_phys_id
               and shift_date=p_shift_date and origin='auto') then
    return null;
  end if;

  -- (#2) Resolve reviewer uid; compare physId as TEXT (no overflow).
  select (u->>'id')::uuid into v_uid
  from public.radscheduler r
  cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
  where r.id = p_practice
    and (u->>'physId') = p_phys_id::text
    and (u->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  limit 1;
  if v_uid is null then return null; end if;

  v_quarter := extract(year from p_shift_date)::text || '-Q' || (floor((extract(month from p_shift_date)-1)/3)+1)::text;

  -- (#1) Up to 3 attempts, excluding any report a swallowed insert collided on.
  for v_attempt in 1..3 loop
    v_report_uid := null;
    if v_mod is not null and v_bp is not null then
      select rr.report_uid, rr.accession, rr.phys_id into v_report_uid, v_accession, v_reviewed
      from public.rs_reports rr
      where rr.practice_id = p_practice and rr.phys_id is not null and rr.phys_id <> p_phys_id
        and rr.signed_at > now() - interval '2 years'
        and upper(coalesce(rr.modality,'')) = v_mod and upper(coalesce(rr.body_part,'')) = v_bp
        and rr.report_uid <> all(v_tried)
        and not exists (select 1 from public.rs_peer_reviews pr
                        where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
      order by random() limit 1;
    end if;
    if v_report_uid is null and v_mod is not null then
      select rr.report_uid, rr.accession, rr.phys_id into v_report_uid, v_accession, v_reviewed
      from public.rs_reports rr
      where rr.practice_id = p_practice and rr.phys_id is not null and rr.phys_id <> p_phys_id
        and rr.signed_at > now() - interval '2 years'
        and upper(coalesce(rr.modality,'')) = v_mod
        and rr.report_uid <> all(v_tried)
        and not exists (select 1 from public.rs_peer_reviews pr
                        where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
      order by random() limit 1;
    end if;
    if v_report_uid is null and v_mod is null then
      select rr.report_uid, rr.accession, rr.phys_id into v_report_uid, v_accession, v_reviewed
      from public.rs_reports rr
      where rr.practice_id = p_practice and rr.phys_id is not null and rr.phys_id <> p_phys_id
        and rr.signed_at > now() - interval '2 years'
        and rr.report_uid <> all(v_tried)
        and not exists (select 1 from public.rs_peer_reviews pr
                        where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
      order by random() limit 1;
    end if;
    if v_report_uid is null then return null; end if;

    insert into public.rs_peer_reviews
      (practice_id, report_uid, accession, reviewed_phys_id, reviewer_phys_id, reviewer_uid, quarter, status, origin, shift_date)
    values
      (p_practice, v_report_uid, v_accession, v_reviewed, p_phys_id, v_uid, v_quarter, 'pending', 'auto', p_shift_date)
    on conflict do nothing
    returning id into v_id;
    if v_id is not null then return v_id; end if;

    -- Insert no-op: if the shift slot is now filled, a concurrent caller won.
    -- Else it was a report-level collision → exclude that report and retry.
    if exists (select 1 from public.rs_peer_reviews
               where practice_id=p_practice and reviewer_phys_id=p_phys_id
                 and shift_date=p_shift_date and origin='auto') then
      return null;
    end if;
    v_tried := array_append(v_tried, v_report_uid);
  end loop;
  return null;
end;
$$;

-- (#3) Roster sweep: isolate each rad in its own subtransaction so one bad row
-- can't abort the whole day; bound phys_id to int range before casting.
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
    where shift_date = p_date and phys_id is not null and phys_id between 1 and 2147483647
  loop
    begin
      v_id := null;
      for c in
        select upper(coalesce(rr.modality,'')) as m, upper(coalesce(rr.body_part,'')) as b, max(rr.signed_at) as latest
        from public.rs_reports rr
        where rr.practice_id = r.practice_id and rr.phys_id = r.phys_id::int
          and rr.signed_at >= p_date::timestamptz + interval '8 hours'
          and rr.signed_at <  p_date::timestamptz + interval '32 hours'
        group by 1, 2 order by latest desc limit 10
      loop
        v_id := public.rs_peer_review_autotrigger(r.practice_id, r.phys_id::int, p_date, nullif(c.m,''), nullif(c.b,''));
        exit when v_id is not null;
      end loop;
      if v_id is not null then v_count := v_count + 1; end if;
    exception when others then
      null;  -- isolate this rad's failure; continue the sweep
    end;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.rs_peer_review_autotrigger(text,integer,date,text,text) from public, anon, authenticated;
revoke all on function public.rs_peer_review_roster_sweep(date) from public, anon, authenticated;
grant execute on function public.rs_peer_review_autotrigger(text,integer,date,text,text) to service_role;
grant execute on function public.rs_peer_review_roster_sweep(date) to service_role;;
