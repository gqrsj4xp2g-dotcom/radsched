-- Optional enterprise hardening: require Supabase Auth AAL2 for admin and
-- superuser database paths. Apply after 04-rls-advisor-hardening.sql once
-- admin MFA enrollment is ready.
--
-- Client-side MFA gates are UX defense in depth. These policies move the
-- same control into Postgres RLS so an admin/superuser JWT at aal1 cannot
-- use privileged cross-practice access or update admin-scoped tables.

CREATE OR REPLACE FUNCTION public.radscheduler_admin_aal2()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    AND coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2';
$$;

CREATE OR REPLACE FUNCTION public.radscheduler_non_admin_same_practice(target_practice_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT target_practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId');
$$;

-- Practices
DROP POLICY IF EXISTS practices_select_scoped ON public.practices;
CREATE POLICY practices_select_scoped ON public.practices
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(id)
  );

DROP POLICY IF EXISTS practices_insert_privileged ON public.practices;
CREATE POLICY practices_insert_privileged ON public.practices
  FOR INSERT TO authenticated
  WITH CHECK (public.radscheduler_admin_aal2());

DROP POLICY IF EXISTS practices_update_privileged ON public.practices;
CREATE POLICY practices_update_privileged ON public.practices
  FOR UPDATE TO authenticated
  USING (public.radscheduler_admin_aal2())
  WITH CHECK (public.radscheduler_admin_aal2());

-- Practice blob
DROP POLICY IF EXISTS radscheduler_select_scoped ON public.radscheduler;
CREATE POLICY radscheduler_select_scoped ON public.radscheduler
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(id)
  );

DROP POLICY IF EXISTS radscheduler_insert_scoped ON public.radscheduler;
CREATE POLICY radscheduler_insert_scoped ON public.radscheduler
  FOR INSERT TO authenticated
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(id)
  );

DROP POLICY IF EXISTS radscheduler_update_scoped ON public.radscheduler;
CREATE POLICY radscheduler_update_scoped ON public.radscheduler
  FOR UPDATE TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(id)
  )
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(id)
  );

-- Backups
DROP POLICY IF EXISTS radscheduler_backups_select_scoped ON public.radscheduler_backups;
CREATE POLICY radscheduler_backups_select_scoped ON public.radscheduler_backups
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS radscheduler_backups_insert_scoped ON public.radscheduler_backups;
CREATE POLICY radscheduler_backups_insert_scoped ON public.radscheduler_backups
  FOR INSERT TO authenticated
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS radscheduler_backups_update_scoped ON public.radscheduler_backups;
CREATE POLICY radscheduler_backups_update_scoped ON public.radscheduler_backups
  FOR UPDATE TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  )
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS radscheduler_backups_delete_scoped ON public.radscheduler_backups;
CREATE POLICY radscheduler_backups_delete_scoped ON public.radscheduler_backups
  FOR DELETE TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

-- Shift side table
DROP POLICY IF EXISTS shifts_insert_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_insert_authed
  ON public.radscheduler_shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS shifts_update_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_update_authed
  ON public.radscheduler_shifts
  FOR UPDATE TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  )
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS shifts_delete_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_delete_authed
  ON public.radscheduler_shifts
  FOR DELETE TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS shifts_select_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_select_authed
  ON public.radscheduler_shifts
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

-- Audit and telemetry side tables
DROP POLICY IF EXISTS audit_insert_scoped ON public.radscheduler_audit;
CREATE POLICY audit_insert_scoped
  ON public.radscheduler_audit
  FOR INSERT TO authenticated
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS audit_select_scoped ON public.radscheduler_audit;
CREATE POLICY audit_select_scoped
  ON public.radscheduler_audit
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS telemetry_insert_scoped ON public.radscheduler_telemetry;
CREATE POLICY telemetry_insert_scoped
  ON public.radscheduler_telemetry
  FOR INSERT TO authenticated
  WITH CHECK (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );

DROP POLICY IF EXISTS telemetry_select_scoped ON public.radscheduler_telemetry;
CREATE POLICY telemetry_select_scoped
  ON public.radscheduler_telemetry
  FOR SELECT TO authenticated
  USING (
    public.radscheduler_admin_aal2() OR
    public.radscheduler_non_admin_same_practice(practice_id)
  );
