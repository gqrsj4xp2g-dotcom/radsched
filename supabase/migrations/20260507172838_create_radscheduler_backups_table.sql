-- Backups can't go into the radscheduler table because that table has a
-- foreign key to practices(id), and backup rows are keyed `<practice>_backup_YYYY-MM-DD`
-- which doesn't exist as a practice. Dedicated table with matching RLS so
-- backups inherit the same access pattern as the source row.
CREATE TABLE IF NOT EXISTS radscheduler_backups (
  id          TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  data        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS radscheduler_backups_practice_idx ON radscheduler_backups(practice_id, created_at DESC);

ALTER TABLE radscheduler_backups ENABLE ROW LEVEL SECURITY;

-- Same gating as radscheduler: caller must be admin OR have matching practiceId.
DROP POLICY IF EXISTS radscheduler_backups_select ON radscheduler_backups;
CREATE POLICY radscheduler_backups_select ON radscheduler_backups
  FOR SELECT TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') OR
    ((auth.jwt() -> 'app_metadata' ->> 'practiceId') = practice_id)
  );

DROP POLICY IF EXISTS radscheduler_backups_modify ON radscheduler_backups;
CREATE POLICY radscheduler_backups_modify ON radscheduler_backups
  FOR ALL TO authenticated
  USING (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') OR
    ((auth.jwt() -> 'app_metadata' ->> 'practiceId') = practice_id)
  )
  WITH CHECK (
    ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') OR
    ((auth.jwt() -> 'app_metadata' ->> 'practiceId') = practice_id)
  );;
