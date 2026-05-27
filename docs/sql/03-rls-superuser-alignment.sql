-- Align production RLS with the RadScheduler role model.
--
-- The client treats app_metadata.role='superuser' as fully privileged.
-- These policies make the database agree with that model, and remove the
-- legacy fallback where an authenticated user with no app_metadata.practiceId
-- could access the default "main" practice row.

DROP POLICY IF EXISTS practices_read_authenticated ON public.practices;
DROP POLICY IF EXISTS practices_insert_admin_only ON public.practices;
DROP POLICY IF EXISTS practices_update_admin_only ON public.practices;

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

DROP POLICY IF EXISTS radscheduler_select_own_practice ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_insert_own_practice ON public.radscheduler;
DROP POLICY IF EXISTS radscheduler_update_own_practice ON public.radscheduler;

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

DROP POLICY IF EXISTS radscheduler_backups_select ON public.radscheduler_backups;
DROP POLICY IF EXISTS radscheduler_backups_modify ON public.radscheduler_backups;

CREATE POLICY radscheduler_backups_select_scoped ON public.radscheduler_backups
  FOR SELECT TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

CREATE POLICY radscheduler_backups_modify_scoped ON public.radscheduler_backups
  FOR ALL TO authenticated
  USING (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  )
  WITH CHECK (
    (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser')) OR
    (((select auth.jwt()) -> 'app_metadata' ->> 'practiceId') = practice_id)
  );
