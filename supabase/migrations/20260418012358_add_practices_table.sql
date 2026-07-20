
-- Practices table: one row per practice
CREATE TABLE IF NOT EXISTS practices (
  id          text PRIMARY KEY,          -- slug, e.g. 'rad-indiana'
  name        text NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- Insert the existing practice so its data row is registered
INSERT INTO practices (id, name) VALUES ('main', 'Rad Indiana')
  ON CONFLICT (id) DO NOTHING;

-- RLS on practices (anyone authenticated can read; only superadmin can write via service key)
ALTER TABLE practices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read practices"
  ON practices FOR SELECT USING (auth.uid() IS NOT NULL);

-- RLS on radscheduler: each row is a practice; users can only access their own practice row.
-- practice_id is stored in user_metadata.practiceId — default 'main' if missing.
-- Using a permissive policy: any authenticated user can access; the app enforces practice routing.
-- (Fine-grained RLS would require a practice_users join table — add later if needed.)
DROP POLICY IF EXISTS "authenticated_only" ON radscheduler;
CREATE POLICY "practice_access"
  ON radscheduler FOR ALL
  USING (auth.uid() IS NOT NULL);
;
