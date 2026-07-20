-- Narrow the grace clause so it only covers the 'main' practice (the only one that
-- exists today). This way:
--  • Pre-v17 JWTs (no app_metadata.practiceId) can still read/write 'main' during
--    the ~1 hour token-refresh window
--  • They canNOT use the null fallback to reach any future practice
--  • Self-signup users (if somehow created without going through the edge function)
--    can only see the main practice, not everything
-- After all tokens have refreshed to include app_metadata.practiceId, this clause
-- becomes a no-op and can be removed entirely.

DROP POLICY IF EXISTS radscheduler_select_own_practice ON radscheduler;
DROP POLICY IF EXISTS radscheduler_insert_own_practice ON radscheduler;
DROP POLICY IF EXISTS radscheduler_update_own_practice ON radscheduler;

CREATE POLICY radscheduler_select_own_practice
  ON radscheduler
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR ((auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL AND id = 'main')
  );

CREATE POLICY radscheduler_insert_own_practice
  ON radscheduler
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR ((auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL AND id = 'main')
  );

CREATE POLICY radscheduler_update_own_practice
  ON radscheduler
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR ((auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL AND id = 'main')
  )
  WITH CHECK (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    OR (auth.jwt() -> 'app_metadata' ->> 'practiceId') = id
    OR ((auth.jwt() -> 'app_metadata' ->> 'practiceId') IS NULL AND id = 'main')
  );;
