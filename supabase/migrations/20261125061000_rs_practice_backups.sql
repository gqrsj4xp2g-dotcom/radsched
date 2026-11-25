-- Existing records have no backup_day. Preserve them, including manually named
-- restore points. Only verified server-created daily points expire automatically.
alter table public.radscheduler_backups add column if not exists backup_day date;
create unique index if not exists rs_daily_backup_day
  on public.radscheduler_backups(practice_id, backup_day) where backup_day is not null;

-- Historical grants allowed same-practice clients to replace or delete restore
-- points directly. All new captures go through a server-side validation step.
revoke insert, update, delete, truncate on public.radscheduler_backups from public, anon, authenticated;
drop policy if exists radscheduler_backups_insert_scoped on public.radscheduler_backups;
drop policy if exists radscheduler_backups_update_scoped on public.radscheduler_backups;
drop policy if exists radscheduler_backups_delete_scoped on public.radscheduler_backups;
alter policy radscheduler_backups_select_scoped on public.radscheduler_backups
  using (public.radscheduler_admin_aal2() or public.radscheduler_admin_same_practice(practice_id));

create table public.rs_restore_receipts (
  request_id uuid primary key,
  actor_id uuid not null,
  practice_id text not null,
  backup_id text not null,
  expected_saved_at timestamptz not null,
  restored_at timestamptz not null,
  safety_backup_id text not null
);
alter table public.rs_restore_receipts enable row level security;
revoke all on public.rs_restore_receipts from public, anon, authenticated;

-- Validate both past and future restore points without changing old originals.
create function public.rs_backup_payload(p_data text)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
declare
  payload jsonb;
  cores constant text[] := array['physicians','sites','drShifts','irShifts','irCalls','weekendCalls','holidays','vacations'];
begin
  if p_data is null or octet_length(p_data) > 15000000 then
    raise exception 'Invalid practice backup size' using errcode = '22023';
  end if;
  payload := p_data::jsonb;
  if jsonb_typeof(payload) <> 'object' or not (payload ?| cores)
     or exists (select from unnest(cores) f where payload ? f and jsonb_typeof(payload->f) <> 'array')
     or (payload ? 'cfg' and jsonb_typeof(payload->'cfg') <> 'object') then
    raise exception 'Invalid practice backup structure' using errcode = '22023';
  end if;
  return (payload - array['swapRequests','onCallAcks','chatMessages','chatPins','_dbSavedAt'])
    #- '{cfg,_widgetSecret}' #- '{cfg,mapsKey}' #- '{cfg,gmapsKey}';
end;
$$;
revoke all on function public.rs_backup_payload(text) from public, anon, authenticated;

create function public.rs_capture_practice_backup(p_practice text, p_kind text)
returns text language plpgsql security definer set search_path = pg_catalog as $$
declare
  raw_data text;
  backup_id text;
begin
  if not (coalesce(public.radscheduler_admin_aal2(),false)
          or coalesce(public.radscheduler_admin_same_practice(p_practice),false)) then
    raise exception 'Practice administrator MFA required' using errcode = '42501';
  end if;
  if p_kind is null or p_kind !~ '^[a-zA-Z0-9_-]{1,80}$' then
    raise exception 'Invalid snapshot label' using errcode = '22023';
  end if;
  select data into strict raw_data from public.radscheduler where id = p_practice;
  backup_id := p_practice || '_pre-' || p_kind || '_' || gen_random_uuid();
  insert into public.radscheduler_backups(id,practice_id,data)
    values(backup_id,p_practice,public.rs_backup_payload(raw_data)::text);
  return backup_id;
end;
$$;
revoke all on function public.rs_capture_practice_backup(text,text) from public, anon;
grant execute on function public.rs_capture_practice_backup(text,text) to authenticated;

-- Capture once per UTC date without requiring a login. An hourly retry picks
-- up newly created practices and practices repaired after an invalid source.
create function public.rs_run_daily_practice_backups()
returns void language plpgsql security definer set search_path = pg_catalog as $$
declare
  p record;
  utc_day date := (statement_timestamp() at time zone 'UTC')::date;
begin
  for p in select r.id from public.radscheduler r
           where not exists (select from public.radscheduler_backups b
                             where b.practice_id = r.id and b.backup_day = utc_day)
           order by r.id
  loop
    begin
      insert into public.radscheduler_backups(id, practice_id, data, backup_day)
        select r.id || '_daily_' || gen_random_uuid(), r.id, public.rs_backup_payload(r.data)::text, utc_day
        from public.radscheduler r where r.id = p.id
        on conflict (practice_id, backup_day) where backup_day is not null do nothing;
      if found then
        delete from public.radscheduler_backups
         where practice_id = p.id and backup_day < utc_day - 6;
      end if;
    exception when data_exception then
      raise warning 'No valid daily schedule snapshot for practice %', p.id;
    end;
  end loop;
end;
$$;
revoke all on function public.rs_run_daily_practice_backups() from public, anon, authenticated;
create extension if not exists pg_cron;
select cron.schedule('rs-daily-practice-backups', '15 * * * *', 'select public.rs_run_daily_practice_backups()');

-- The edge verifies admin role, practice and MFA using the caller's verified
-- session. Only the trusted service role may supply actor details to this RPC.
create function public.rs_restore_practice_backup(
  p_practice text, p_backup text, p_expected_saved_at timestamptz, p_request uuid,
  p_actor uuid, p_email text, p_role text
)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  current_row public.radscheduler%rowtype;
  source public.radscheduler_backups%rowtype;
  receipt public.rs_restore_receipts%rowtype;
  restored jsonb;
  safety_payload jsonb;
  stamp timestamptz;
  safety_id text;
  detail jsonb;
begin
  if p_request is null or p_actor is null or p_expected_saved_at is null
     or p_role is null or p_role not in ('admin','superuser') then
    raise exception 'Invalid restore request' using errcode = '22023';
  end if;
  select * into current_row from public.radscheduler where id = p_practice for update;
  if not found then raise exception 'Practice not found' using errcode = 'P0002'; end if;

  select * into receipt from public.rs_restore_receipts where request_id = p_request;
  if found then
    if receipt.actor_id <> p_actor or receipt.practice_id <> p_practice or receipt.backup_id <> p_backup
       or receipt.expected_saved_at <> p_expected_saved_at then
      raise exception 'Request ID already belongs to another restore' using errcode = '40001';
    end if;
    -- A delayed retry gets the latest state, including any intervening saves.
    return jsonb_build_object('ok',true,'replayed',true,'savedAt',current_row.saved_at,
      'restoredAt',receipt.restored_at,'safetyBackupId',receipt.safety_backup_id,
      'payload',public.rs_backup_payload(current_row.data) || jsonb_build_object('_dbSavedAt',current_row.saved_at));
  end if;
  if current_row.saved_at is distinct from p_expected_saved_at then
    raise exception 'Practice changed. Review the current schedule and confirm again.' using errcode = '40001';
  end if;
  select * into source from public.radscheduler_backups
    where practice_id = p_practice and id = p_backup for share;
  if not found then raise exception 'Backup not found for this practice' using errcode = 'P0002'; end if;
  restored := public.rs_backup_payload(source.data);
  safety_payload := public.rs_backup_payload(current_row.data);
  -- Older snapshots predate some practice fields. Keep currently stored
  -- top-level fields that the selected snapshot never captured.
  restored := safety_payload || restored;
  safety_id := p_practice || '_pre-restore_' || p_request;
  insert into public.radscheduler_backups(id,practice_id,data)
    values(safety_id,p_practice,safety_payload::text);

  stamp := clock_timestamp();
  restored := restored || jsonb_build_object('savedAt',stamp,'_restoredAt',stamp,'_restoredFromBackup',p_backup);
  update public.radscheduler set data = restored::text where id = p_practice returning data::jsonb, saved_at into restored, stamp;
  detail := jsonb_build_object('requestId',p_request,'backupId',p_backup,'backupCreatedAt',source.created_at,
                               'safetyBackupId',safety_id,'restoredAt',stamp,'via','admin-ops');
  insert into public.radscheduler_audit(practice_id,ts,who,who_id,role,action,detail)
    values(p_practice,stamp,p_email,p_actor::text,p_role,'admin.restoreBackup',detail);
  insert into public.radscheduler_telemetry(id,practice_id,user_id,user_email,level,event,detail,created_at)
    values(gen_random_uuid()::text,p_practice,p_actor::text,p_email,'warn','admin.restore_backup',detail,stamp);
  insert into public.rs_restore_receipts(request_id,actor_id,practice_id,backup_id,expected_saved_at,restored_at,safety_backup_id)
    values(p_request,p_actor,p_practice,p_backup,p_expected_saved_at,stamp,safety_id);
  return jsonb_build_object('ok',true,'replayed',false,'savedAt',stamp,'restoredAt',stamp,'safetyBackupId',safety_id,
                            'payload',restored || jsonb_build_object('_dbSavedAt',stamp));
end;
$$;
revoke all on function public.rs_restore_practice_backup(text,text,timestamptz,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.rs_restore_practice_backup(text,text,timestamptz,uuid,uuid,text,text) to service_role;
