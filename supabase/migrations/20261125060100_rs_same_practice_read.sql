-- Version the behavior of docs/sql/08 for read policies. The historical
-- helper is also used by FOR UPDATE and FOR INSERT policies, so making it
-- universally true for same-tenant administrators loosens those MFA gates.
create or replace function public.radscheduler_same_practice_member(target_practice_id text)
returns boolean language sql stable set search_path = pg_catalog as $$
  select target_practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId');
$$;
revoke all on function public.radscheduler_same_practice_member(text) from public, anon;
grant execute on function public.radscheduler_same_practice_member(text) to authenticated;

create or replace function public.radscheduler_non_admin_same_practice(target_practice_id text)
returns boolean language sql stable set search_path = pg_catalog as $$
  select public.radscheduler_same_practice_member(target_practice_id)
     and (coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', 'user') not in ('admin','superuser')
          or (select auth.jwt()) ->> 'aal' = 'aal2');
$$;

-- Preserve every additional predicate (e.g. ownership) and change only the
-- named membership helper in SELECT policies. Mutation policies/RPCs keep
-- the MFA-aware helper, including on previously manually patched databases.
do $migration$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname, qual from pg_catalog.pg_policies
     where schemaname='public' and cmd='SELECT'
       and strpos(qual, 'radscheduler_non_admin_same_practice(') > 0
  loop
    execute format('alter policy %I on %I.%I using (%s)',
      p.policyname, p.schemaname, p.tablename,
      replace(p.qual, 'radscheduler_non_admin_same_practice(', 'radscheduler_same_practice_member('));
  end loop;
end;
$migration$;
