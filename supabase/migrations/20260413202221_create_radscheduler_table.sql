
CREATE TABLE IF NOT EXISTS radscheduler (
  id TEXT PRIMARY KEY,
  data TEXT
);

ALTER TABLE radscheduler ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_all" ON radscheduler;
CREATE POLICY "public_all" ON radscheduler
  FOR ALL USING (true) WITH CHECK (true);
;
