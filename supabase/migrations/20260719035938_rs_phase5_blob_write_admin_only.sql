-- PHASE 5: close the F1 RLS hole. Non-admins can no longer directly overwrite
-- the practice blob; their legitimate actions go through the DEFINER RPCs
-- (which bypass RLS). Admins (role admin/superuser, same practice, MFA optional
-- per user's "role-only admin write" decision) retain direct blob write.
-- SELECT policy is intentionally UNCHANGED so non-admins can still READ the blob.
-- Rollback if ever needed: set both to
--   (radscheduler_admin_aal2() OR radscheduler_non_admin_same_practice(id))

ALTER POLICY radscheduler_update_scoped ON public.radscheduler
  USING (radscheduler_admin_same_practice(id))
  WITH CHECK (radscheduler_admin_same_practice(id));

ALTER POLICY radscheduler_insert_scoped ON public.radscheduler
  WITH CHECK (radscheduler_admin_same_practice(id));;
