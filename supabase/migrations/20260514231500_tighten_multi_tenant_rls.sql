-- B1 fix: scope radscheduler_shifts + radscheduler_audit to the
-- requester's own practice. Previously USING (true) — any
-- authenticated user could SELECT every practice's rows.
--
-- The JWT carries `app_metadata.practiceId` (already set by the
-- main app via _updateUserAuthMeta). Admins / super users get an
-- "admin" role flag and can read across practices for support.

-- ── radscheduler_shifts ────────────────────────────────────────
DROP POLICY IF EXISTS shifts_select_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_select_authed
  ON public.radscheduler_shifts
  FOR SELECT TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS shifts_insert_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_insert_authed
  ON public.radscheduler_shifts
  FOR INSERT TO authenticated
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS shifts_update_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_update_authed
  ON public.radscheduler_shifts
  FOR UPDATE TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  )
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS shifts_delete_authed ON public.radscheduler_shifts;
CREATE POLICY shifts_delete_authed
  ON public.radscheduler_shifts
  FOR DELETE TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

-- ── radscheduler_audit ─────────────────────────────────────────
DROP POLICY IF EXISTS audit_select_authed ON public.radscheduler_audit;
CREATE POLICY audit_select_authed
  ON public.radscheduler_audit
  FOR SELECT TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );

DROP POLICY IF EXISTS audit_insert_authed ON public.radscheduler_audit;
CREATE POLICY audit_insert_authed
  ON public.radscheduler_audit
  FOR INSERT TO authenticated
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
    OR
    (practice_id = (auth.jwt() -> 'app_metadata' ->> 'practiceId'))
  );;
