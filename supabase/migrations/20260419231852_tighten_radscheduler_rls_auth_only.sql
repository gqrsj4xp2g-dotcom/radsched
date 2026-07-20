-- Tighten radscheduler RLS: require authenticated session for all operations.
-- This prevents unauth visitors from reading or writing any practice's data.

DROP POLICY IF EXISTS allow_all_with_anon_key ON radscheduler;

CREATE POLICY radscheduler_select
  ON radscheduler
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY radscheduler_insert
  ON radscheduler
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY radscheduler_update
  ON radscheduler
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Explicitly DO NOT create a DELETE policy. Row deletion is an admin-level operation
-- that should only happen via the edge function (service role bypasses RLS).
;
