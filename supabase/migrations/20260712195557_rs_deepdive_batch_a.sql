-- #4: column-scope the client write surface. Non-admins may only set the two
-- derived scoring columns; phys_id / report_text / mrn / patient_name / etc.
-- become unwritable from a client (blocks wRVU-credit theft + record tampering).
-- service_role (edge fns) keeps full access.
revoke update on public.rs_reports from authenticated;
grant update (wrvu, cpt_codes) on public.rs_reports to authenticated;

-- #5: a corrected/addended report (report_text changes on re-ingest) must be
-- re-scored. Reset the derived fields when the text actually changes; the
-- DISTINCT-FROM guard means the client's own {wrvu,cpt_codes} score-back write
-- (which never touches report_text) is untouched.
create or replace function public.rs_reports_reset_score_on_edit()
returns trigger language plpgsql
set search_path to 'public','pg_temp' as $$
begin
  if NEW.report_text is distinct from OLD.report_text then
    NEW.wrvu := null;
    NEW.cpt_codes := '[]'::jsonb;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_rs_reports_reset_score on public.rs_reports;
create trigger trg_rs_reports_reset_score before update on public.rs_reports
  for each row execute function public.rs_reports_reset_score_on_edit();

-- #1 defense-in-depth: quarter can only ever hold a well-formed value, closing
-- the PostgREST-write vector for the (now-fixed) client attribute sink and any
-- future sink. Table is empty so no backfill needed.
alter table public.rs_peer_reviews
  add constraint rs_peer_reviews_quarter_fmt
  check (quarter is null or quarter ~ '^[0-9]{4}-Q[1-4]$');

-- #13 + #11: make the like-for-like SELECT sargable (compare raw normalized
-- columns → uses rs_reports_practice_modality_bp instead of a seq scan) AND
-- enforce strict like-for-like: NO unrestricted tier. A report whose modality
-- can't be derived gets no auto review (better than a clinically-mismatched one).
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
  if v_mod is null then return null; end if;   -- strict like-for-like: no modality → no review

  select s.shift_date into v_shift
  from public.radscheduler_shifts s
  where s.practice_id = p_practice and s.phys_id = p_phys_id
    and s.shift_date between p_shift_date - 1 and p_shift_date + 1
  order by abs(s.shift_date - p_shift_date), s.shift_date
  limit 1;
  if v_shift is not null then p_shift_date := v_shift; end if;

  if exists (select 1 from public.rs_peer_reviews
             where practice_id=p_practice and reviewer_phys_id=p_phys_id
               and shift_date=p_shift_date and origin='auto') then
    return null;
  end if;

  select (u->>'id')::uuid into v_uid
  from public.radscheduler r
  cross join lateral jsonb_array_elements(coalesce(r.data::jsonb->'users','[]'::jsonb)) u
  where r.id = p_practice
    and (u->>'physId') = p_phys_id::text
    and (u->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  limit 1;
  if v_uid is null then return null; end if;

  v_quarter := extract(year from p_shift_date)::text || '-Q' || (floor((extract(month from p_shift_date)-1)/3)+1)::text;

  for v_attempt in 1..3 loop
    v_report_uid := null;
    -- tier 1: same modality + body part (sargable: raw column compare)
    if v_bp is not null then
      select rr.report_uid, rr.accession, rr.phys_id into v_report_uid, v_accession, v_reviewed
      from public.rs_reports rr
      where rr.practice_id = p_practice and rr.phys_id is not null and rr.phys_id <> p_phys_id
        and rr.modality = v_mod and rr.body_part = v_bp
        and rr.signed_at > now() - interval '2 years'
        and rr.report_uid <> all(v_tried)
        and not exists (select 1 from public.rs_peer_reviews pr
                        where pr.practice_id=p_practice and pr.report_uid=rr.report_uid and pr.reviewer_uid=v_uid)
      order by random() limit 1;
    end if;
    -- tier 2: same modality only
    if v_report_uid is null then
      select rr.report_uid, rr.accession, rr.phys_id into v_report_uid, v_accession, v_reviewed
      from public.rs_reports rr
      where rr.practice_id = p_practice and rr.phys_id is not null and rr.phys_id <> p_phys_id
        and rr.modality = v_mod
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
revoke all on function public.rs_peer_review_autotrigger(text,integer,date,text,text) from public, anon, authenticated;
grant execute on function public.rs_peer_review_autotrigger(text,integer,date,text,text) to service_role;

-- critic: close the 9h overnight blind window (cron last runs 23:00 UTC but the
-- shift day's window runs to 08:00 next day). A 09:00 UTC catch-up sweeps
-- YESTERDAY's shift day, whose window has fully elapsed by then.
select cron.schedule('rs-peer-review-catchup', '0 9 * * *',
  $$select public.rs_peer_review_roster_sweep(current_date - 1)$$);;
