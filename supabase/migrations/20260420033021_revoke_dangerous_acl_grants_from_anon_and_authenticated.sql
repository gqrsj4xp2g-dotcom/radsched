-- ═══════════════════════════════════════════════════════════════════════
-- Revoke ACL grants that aren't needed and would bypass RLS.
--
-- RLS does NOT apply to TRUNCATE — it's a hard-coded Postgres behavior.
-- So an attacker with the anon key could previously run TRUNCATE and wipe
-- the practice row. Same concern, lesser degree, for DELETE: our RLS has no
-- DELETE policy (so RLS blocks all deletes), but removing the ACL grant
-- makes that refusal explicit at the lowest layer rather than relying on
-- the absence-of-policy behavior.
--
-- service_role keeps everything (edge function uses it with full bypass).
-- ═══════════════════════════════════════════════════════════════════════

-- TRUNCATE — bypasses RLS entirely; no legitimate use by client roles
REVOKE TRUNCATE ON radscheduler, practices FROM anon, authenticated;

-- DELETE — no DELETE policy exists for either table; revoke ACL for defense-in-depth
REVOKE DELETE ON radscheduler, practices FROM anon, authenticated;

-- TRIGGER / REFERENCES — client roles should not be able to attach triggers
-- or foreign keys to our tables
REVOKE TRIGGER, REFERENCES ON radscheduler, practices FROM anon, authenticated;

-- anon should not touch radscheduler at all — revoke SELECT/INSERT/UPDATE.
-- RLS already blocks these because our policies are scoped TO authenticated,
-- but revoking at the ACL layer means PostgREST rejects earlier with a clear
-- error rather than returning empty results.
REVOKE SELECT, INSERT, UPDATE ON radscheduler FROM anon;

-- anon can still SELECT practices (public login-screen lookup). Revoke write.
REVOKE INSERT, UPDATE ON practices FROM anon;;
