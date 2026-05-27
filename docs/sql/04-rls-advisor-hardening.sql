-- Supabase advisor hardening for RadScheduler.
--
-- Purpose:
--   1. Avoid per-row auth.jwt() re-evaluation in RLS policies by wrapping it
--      as (select auth.jwt()).
--   2. Split the backups FOR ALL policy into action-specific policies so
--      SELECT does not run through two permissive policies.
--   3. Set a fixed search_path on the shifts touch trigger function.
--   4. Revoke public execution of the internal SECURITY DEFINER event trigger
--      function used to auto-enable RLS on newly-created public tables.

CREATE OR REPLACE FUNCTION public._radscheduler_shifts_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;

-- ── Practices ───────────────────────────────────────────────────
DROP POLICY IF EXISTS practices_read_authenticated ON public.practices;
DROP POLICY IF EXISTS practices_insert_admin_only ON public.practices;
DROP POLICY IF EXISTS practices_update_admin_only ON public.practices;
DROP POLICY IF EXISTS practices_select_scoped ON public.practices;
DROP POLICY IF EXISTS practices_insert_privileged ON public.practices;
DROP POLICY IF EXISTS practices_update_privileged ON public.practices;

CREATE POLICY practices_select_scoped ON public.practices
  FOR SELECT TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY practices_insert_privileged ON public.practices
  FOR INSERT TO authenticated
  WITH CHECK (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'));

CREATE POLICY practices_update_privileged ON public.practices
  FOR UPDATE TO authenticated
  USING (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
  WITH CHECK (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'));

-- ── Practice blob ────────────────────────────────────────────────
DROP POLICY IF EXISTS radscheduler_select_own_practice ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_insert_own_practice ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_update_own_practice ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_select_scoped ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_insert_scoped ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_update_scoped ON public.radscheduler;

CREATE POLICY radscheduler_select_scoped ON public.radscheduler
  FOR SELECT TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

CREATE POLICY radscheduler_insert_scoped ON public.radscheduler
  FOR INSERT TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

CREATE POLICY radscheduler_update_scoped ON public.radscheduler
  FOR UPDATE TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = id)
  );

-- ── Backups ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS radscheduler_backups_select ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_modify ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_modify_scoped ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_select_scoped ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_insert_scoped ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_update_scoped ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_delete_scoped ON public.radscheduler_backups;

CREATE POLICY radscheduler_backups_select_scoped ON public.radscheduler_backups
  FOR SELECT TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY radscheduler_backups_insert_scoped ON public.radscheduler_backups
  FOR INSERT TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY radscheduler_backups_update_scoped ON public.radscheduler_backups
  FOR UPDATE TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY radscheduler_backups_delete_scoped ON public.radscheduler_backups
  FOR DELETE TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

-- ── Shift side table ────────────────────────────────────────────
DROP POLICY IF EXISTS shifts_insert_authed ON public.radscheduler_shifts;
DROP POLICY IF EXISTS shifts_update_authed ON public.radscheduler_shifts;
DROP POLICY IF EXISTS shifts_delete_authed ON public.radscheduler_shifts;
DROP POLICY IF EXISTS shifts_select_authed ON public.radscheduler_shifts;

CREATE POLICY shifts_insert_authed
  ON public.radscheduler_shifts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY shifts_update_authed
  ON public.radscheduler_shifts
  FOR UPDATE
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY shifts_delete_authed
  ON public.radscheduler_shifts
  FOR DELETE
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY shifts_select_authed
  ON public.radscheduler_shifts
  FOR SELECT
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

-- ── Audit side table ────────────────────────────────────────────
DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_insert_scoped ON public.radscheduler_audit;
DROP POLICY IF EXISTS audit_select_scoped ON public.radscheduler_audit;

CREATE POLICY audit_insert_scoped
  ON public.radscheduler_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );

CREATE POLICY audit_select_scoped
  ON public.radscheduler_audit
  FOR SELECT
  TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId'))
  );
