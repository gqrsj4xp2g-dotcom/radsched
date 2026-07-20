-- Role-only admin write predicate (admin/superuser + same practice, NO aal2).
-- Used to replace the F1-hole `non_admin_same_practice` branch on the write
-- policies while keeping both admins (MFA or not) able to edit.
CREATE OR REPLACE FUNCTION public.radscheduler_admin_same_practice(target_practice_id text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public','pg_temp'
AS $function$
  SELECT (((select auth.jwt()) -> 'app_metadata' ->> 'role') IN ('admin','superuser'))
     AND target_practice_id = ((select auth.jwt()) -> 'app_metadata' ->> 'practiceId');
$function$;
REVOKE ALL ON FUNCTION public.radscheduler_admin_same_practice(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.radscheduler_admin_same_practice(text) TO authenticated;;
