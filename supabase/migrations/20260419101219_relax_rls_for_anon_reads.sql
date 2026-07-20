
-- Drop the auth-required policy and replace with a permissive one
-- The app uses the anon key for all access and handles practice isolation
-- at the application layer (via _ROW_ID being set from user metadata on login)
DROP POLICY IF EXISTS "practice_access" ON radscheduler;
DROP POLICY IF EXISTS "authenticated_only" ON radscheduler;

CREATE POLICY "allow_all_with_anon_key"
  ON radscheduler FOR ALL
  USING (true)
  WITH CHECK (true);

-- Same for practices table
DROP POLICY IF EXISTS "authenticated read practices" ON practices;

CREATE POLICY "allow_read_practices"
  ON practices FOR SELECT
  USING (true);

CREATE POLICY "allow_insert_practices"
  ON practices FOR INSERT
  WITH CHECK (true);

CREATE POLICY "allow_update_practices"
  ON practices FOR UPDATE
  USING (true)
  WITH CHECK (true);
;
