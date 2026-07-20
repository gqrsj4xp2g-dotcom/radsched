-- ═══════════════════════════════════════════════════════════════════════
-- Per-practice RLS isolation — secure version using app_metadata.
-- 
-- Why app_metadata (not user_metadata):
--   user_metadata is end-user writable via supabase.auth.updateUser({ data: {...} }),
--   so policies referencing it are BYPASSABLE. See Supabase lint 0015.
--   app_metadata can only be written by the service role (our edge function), so it's
--   safe for RLS.
--
-- Transition state:
--   All 9 existing users have had app_metadata.{role,practiceId} backfilled.
--   However, JWTs already in clients' browsers predate the backfill and do NOT yet
--   contain the claims. Supabase auto-refreshes JWTs every ~1 hour on active sessions.
--   During the transition window, the radscheduler policies allow access when the
--   JWT's app_metadata.practiceId is NULL. That permissive branch becomes a no-op
--   after all tokens refresh, because every subsequent JWT will carry the claim.
-- ═══════════════════════════════════════════════════════════════════════

-- ─── PRACTICES ─────────────────────────────────────────────────────────
-- SELECT stays public (login screen needs to list practices).
-- INSERT/UPDATE require admin role, strictly from app_metadata.
-- Admin users with pre-backfill JWTs will be briefly blocked until their token
-- refreshes; creating practices is a rare admin action so this is acceptable.

DROP POLICY IF EXISTS allow_insert_practices ON practices;
DROP POLICY IF EXISTS allow_update_practices ON practices;

CREATE POLICY practices_insert_admin_only
  ON practices
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY practices_update_admin_only
  ON practices
  FOR UPDATE
  TO authenticated
  USING      ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ─── RADSCHEDULER ──────────────────────────────────────────────────────
-- Admins can access any practice (needed for cross-practice admin tools like
-- the practices page). Regular users can only access their own practice.
-- Pre-backfill grace: if app_metadata.practiceId is NULL, allow (safe because
-- only service role can set or wipe app_metadata).

DROP POLICY IF EXISTS radscheduler_select ON radscheduler;
DROP POLICY IF EXISTS radscheduler_insert ON radscheduler;
DROP POLICY IF EXISTS radscheduler_update ON radscheduler;

CREATE POLICY radscheduler_select_own_practice
  ON radscheduler
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL  -- grace for pre-v17 JWTs
  );

CREATE POLICY radscheduler_insert_own_practice
  ON radscheduler
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL
  );

CREATE POLICY radscheduler_update_own_practice
  ON radscheduler
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL
  );
-- Still no DELETE policy — service role only.;
