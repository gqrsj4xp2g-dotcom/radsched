-- Security boundary cleanup: tenant-scoped administrators, atomic blob saves,
-- server-only widget signing material, and locked-down trigger functions.

create extension if not exists pgcrypto with schema extensions;

-- This legacy helper is used throughout older policies to mean "global
-- privileged access". Restrict that meaning to superusers at AAL2. Tenant
-- administrators use radscheduler_admin_same_practice(target) below.
create or replace function public.radscheduler_admin_aal2()
returns boolean
language sql
stable
set search_path = 'public', 'pg_temp'
as $function$
  select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') = 'superuser', false)
     and coalesce(((select auth.jwt()) ->> 'aal') = 'aal2', false);
$function$;

create or replace function public.radscheduler_admin_same_practice(target_practice_id text)
returns boolean
language sql
stable
set search_path = 'public', 'pg_temp'
as $function$
  select coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'role') in ('admin','superuser'), false)
     and coalesce(((select auth.jwt()) ->> 'aal') = 'aal2', false)
     and target_practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId');
$function$;

revoke all on function public.radscheduler_admin_aal2() from public, anon;
revoke all on function public.radscheduler_admin_same_practice(text) from public, anon;
grant execute on function public.radscheduler_admin_aal2() to authenticated;
grant execute on function public.radscheduler_admin_same_practice(text) to authenticated;

-- Policies that previously relied on the global admin helper alone need an
-- explicit same-tenant administrator branch after the helper is narrowed.
alter policy rs_peer_select on public.rs_peer_reviews
  using (radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id) or radscheduler_owns_row(reviewer_uid));
alter policy rs_peer_insert on public.rs_peer_reviews
  with check (
    radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id)
    or (radscheduler_owns_row(reviewer_uid) and radscheduler_non_admin_same_practice(practice_id) and origin = 'manual')
  );
alter policy rs_peer_update on public.rs_peer_reviews
  using (radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id) or radscheduler_owns_row(reviewer_uid))
  with check (radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id) or radscheduler_owns_row(reviewer_uid));
alter policy rs_peer_delete on public.rs_peer_reviews
  using (radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id) or radscheduler_owns_row(reviewer_uid));

alter policy rs_reports_admin_delete on public.rs_reports
  using (radscheduler_admin_aal2() or radscheduler_admin_same_practice(practice_id));

-- Preserve same-practice administrator overrides inside older business RPCs;
-- superusers retain global AAL2 overrides through radscheduler_admin_aal2().
do $migration$
declare
  fn record;
  old_def text;
  new_def text;
begin
  for fn in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in (
         'rs_accept_listing_claim', 'rs_cancel_shift_listing',
         'rs_cancel_shift_offer', 'rs_claim_offered_shift',
         'rs_claim_open_shift', 'rs_unclaim_open_shift'
       )
  loop
    old_def := pg_get_functiondef(fn.oid);
    new_def := regexp_replace(
      old_def,
      'v_is_admin[[:space:]]*:=[[:space:]]*coalesce\(radscheduler_admin_aal2\(\),[[:space:]]*false\);',
      'v_is_admin := coalesce(radscheduler_admin_aal2(), false) or coalesce(radscheduler_admin_same_practice(p_practice), false);',
      'g'
    );
    if new_def = old_def then
      raise exception 'Expected admin assignment not found in %', fn.proname;
    end if;
    execute new_def;
  end loop;

  for fn in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname in ('rs_ingest_token_get', 'rs_ingest_token_rotate')
  loop
    old_def := pg_get_functiondef(fn.oid);
    new_def := replace(
      old_def,
      'radscheduler_admin_aal2() and radscheduler_non_admin_same_practice(p_practice)',
      '(radscheduler_admin_aal2() or radscheduler_admin_same_practice(p_practice))'
    );
    if new_def = old_def then
      raise exception 'Expected ingest authorization expression not found in %', fn.proname;
    end if;
    execute new_def;
  end loop;
end;
$migration$;

-- Compare-and-save is the only supported whole-practice write. The final
-- timestamp predicate is evaluated while the row lock is held, eliminating
-- the race left by browser-side "check then upsert" logic.
create or replace function public.rs_save_practice_cas(
  p_practice text,
  p_data text,
  p_expected_saved_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = 'public', 'pg_temp'
as $function$
declare
  current_stamp timestamptz;
  saved_stamp timestamptz;
  row_exists boolean := false;
  service_call boolean := coalesce((select auth.jwt()) ->> 'role', '') = 'service_role';
  parsed jsonb;
begin
  if p_practice is null or length(p_practice) < 1 or length(p_practice) > 160 then
    raise exception 'invalid practice id' using errcode = '22023';
  end if;
  if p_data is null or octet_length(p_data) > 15000000 then
    raise exception 'invalid practice payload size' using errcode = '22023';
  end if;
  begin
    parsed := p_data::jsonb;
  exception when others then
    raise exception 'practice payload must be valid JSON' using errcode = '22023';
  end;
  if jsonb_typeof(parsed) <> 'object' then
    raise exception 'practice payload must be a JSON object' using errcode = '22023';
  end if;
  if not service_call
     and not coalesce(radscheduler_admin_aal2(), false)
     and not coalesce(radscheduler_admin_same_practice(p_practice), false) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select saved_at, true into current_stamp, row_exists
    from public.radscheduler
   where id = p_practice
   for update;

  if row_exists then
    if current_stamp is distinct from p_expected_saved_at then
      return jsonb_build_object('ok', false, 'conflict', true, 'current_saved_at', current_stamp);
    end if;
    update public.radscheduler
       set data = p_data
     where id = p_practice
       and saved_at is not distinct from p_expected_saved_at
     returning saved_at into saved_stamp;
  else
    if p_expected_saved_at is not null then
      return jsonb_build_object('ok', false, 'conflict', true, 'current_saved_at', null);
    end if;
    insert into public.radscheduler(id, data)
      values (p_practice, p_data)
      returning saved_at into saved_stamp;
  end if;

  return jsonb_build_object('ok', true, 'saved_at', saved_stamp);
end;
$function$;

revoke all on function public.rs_save_practice_cas(text,text,timestamptz) from public, anon;
grant execute on function public.rs_save_practice_cas(text,text,timestamptz) to authenticated, service_role;

-- Widget HMAC keys must not live inside client-readable practice JSON.
create table if not exists public.rs_widget_secrets (
  practice_id text primary key references public.radscheduler(id) on delete cascade,
  secret text not null check (length(secret) >= 32),
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);
alter table public.rs_widget_secrets enable row level security;
revoke all on table public.rs_widget_secrets from public, anon, authenticated;
grant select, insert, update, delete on table public.rs_widget_secrets to service_role;

insert into public.rs_widget_secrets(practice_id, secret)
select id,
       coalesce(nullif(data::jsonb #>> '{cfg,_widgetSecret}', ''), encode(extensions.gen_random_bytes(32), 'hex'))
  from public.radscheduler
on conflict (practice_id) do nothing;

update public.radscheduler
   set data = ((data::jsonb #- '{cfg,_widgetSecret}')::text)
 where (data::jsonb #> '{cfg}') ? '_widgetSecret';

-- Trigger functions should be invokable only by their triggers, not as public
-- RPC endpoints. This closes the default-PUBLIC EXECUTE advisor finding.
do $migration$
declare
  f record;
begin
  for f in
    select distinct n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace n on n.oid = p.pronamespace
     where not t.tgisinternal and n.nspname = 'public'
  loop
    execute format('revoke all on function %I.%I(%s) from public, anon, authenticated', f.nspname, f.proname, f.args);
  end loop;
end;
$migration$;
