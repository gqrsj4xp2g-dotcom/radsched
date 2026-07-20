-- Tighten practices RLS: require JWT-authenticated caller for mutations.
-- SELECT remains public so users can see the list. INSERT/UPDATE now require a
-- valid session token (any authenticated user for this MVP; production would
-- add per-role checks).

DROP POLICY IF EXISTS allow_insert_practices ON practices;
DROP POLICY IF EXISTS allow_update_practices ON practices;

CREATE POLICY allow_insert_practices
  ON practices
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY allow_update_practices
  ON practices
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);
;
