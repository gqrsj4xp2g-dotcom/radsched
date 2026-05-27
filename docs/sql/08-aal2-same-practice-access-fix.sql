-- Hotfix for AAL2 hardening.
--
-- 05-admin-mfa-aal2-hardening.sql accidentally made same-practice admins at
-- aal1 fail both branches of the RLS predicate:
--   radscheduler_admin_aal2() OR radscheduler_non_admin_same_practice(...)
--
-- That meant an admin without a completed MFA challenge could see zero rows
-- for their own practice, which looked like deleted data even though the
-- canonical practice blob was still present. Keep AAL2 for cross-practice
-- admin/superuser access, but allow any authenticated member whose JWT
-- practiceId matches the target practice to access that practice row.

CREATE OR REPLACE FUNCTION public.radscheduler_non_admin_same_practice(target_practice_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT target_practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId');
$$;
