-- ─── 1. Foreign key: radscheduler.id → practices.id ────────────────────
-- Ensures every radscheduler row corresponds to a real practice. ON DELETE CASCADE
-- so that deleting a practice (via service role, since there's no DELETE RLS) cleanly
-- removes its data row rather than leaving an orphan.
ALTER TABLE radscheduler
  ADD CONSTRAINT radscheduler_id_fkey
  FOREIGN KEY (id) REFERENCES practices(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. Size cap on radscheduler.data ─────────────────────────────────
-- Prevent a malicious or buggy authenticated client from posting a gigantic JSON
-- payload that would bloat the row and slow every load. 10MB is ~100x the current
-- ~100KB practice data, covering substantial growth while keeping abuse bounded.
ALTER TABLE radscheduler
  ADD CONSTRAINT radscheduler_data_size_check
  CHECK (data IS NULL OR octet_length(data) <= 10485760);

-- ─── 3. Shape check on radscheduler.id ─────────────────────────────────
-- Enforce the same slug format the edge function validates in practiceId.
-- Keeps ids clean for URL/key use and prevents weird characters in row IDs.
ALTER TABLE radscheduler
  ADD CONSTRAINT radscheduler_id_format_check
  CHECK (id ~ '^[a-zA-Z0-9_-]{1,64}$');

-- ─── 4. Same shape check on practices.id ───────────────────────────────
ALTER TABLE practices
  ADD CONSTRAINT practices_id_format_check
  CHECK (id ~ '^[a-zA-Z0-9_-]{1,64}$');

-- ─── 5. Non-empty check on practices.name ──────────────────────────────
ALTER TABLE practices
  ADD CONSTRAINT practices_name_not_empty_check
  CHECK (length(trim(name)) > 0 AND length(name) <= 200);;
