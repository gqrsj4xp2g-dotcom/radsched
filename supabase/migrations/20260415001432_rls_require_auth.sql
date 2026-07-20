
-- Replace the open policy with one requiring a valid authenticated session
DROP POLICY IF EXISTS "public_all" ON public.radscheduler;

CREATE POLICY "authenticated_only"
  ON public.radscheduler
  FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);
;
