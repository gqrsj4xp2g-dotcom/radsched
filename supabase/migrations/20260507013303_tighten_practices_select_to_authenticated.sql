
-- Restrict practices list reads to authenticated users only.
-- The login screen no longer needs anonymous access to this table —
-- launchApp queries practices AFTER auth completes.
DROP POLICY IF EXISTS allow_read_practices ON public.practices;
CREATE POLICY practices_read_authenticated ON public.practices
  FOR SELECT TO authenticated USING (true);
;
