# Supabase Audit - 2026-05-27

Project audited: `tpbgwvisikbuqhmlqtky`

This audit covered the production schema, RLS policy alignment, edge function
inventory, required secrets, and live data health for RadScheduler.

## Summary

- RLS is enabled on the active application tables.
- Production RLS now matches the client role model: `admin` and `superuser`
  are privileged; regular users are scoped to their `app_metadata.practiceId`.
- The legacy fallback that let authenticated users without a practice id read
  the `main` practice row has been removed.
- The canonical audit side table `public.radscheduler_audit` is present,
  populated, and protected by practice-scoped RLS.
- Enterprise hardening is now active: privileged cross-practice database
  paths require JWT `aal2`, and `public.radscheduler_telemetry` is present
  for durable operational evidence.
- Edge functions are deployed and reachable enough to return expected 400/401
  responses without privileged credentials.
- The live practice data row, backup history, and shift side table contain
  current data.
- The real authenticated browser health test is now available but was not run
  during this audit because no live superuser email/password were provided.

## RLS Status

Tables checked:

| Table | RLS | Notes |
| --- | --- | --- |
| `public.practices` | enabled | Policy set recreated for scoped select plus privileged insert/update. |
| `public.radscheduler` | enabled | Policy set recreated for scoped select/insert/update. |
| `public.radscheduler_backups` | enabled | Policy set recreated for scoped select and scoped modify. |
| `public.radscheduler_shifts` | enabled | Existing policies already included `admin` and `superuser`. |
| `public.radscheduler_audit` | enabled | Scoped insert/select policies for own practice plus admin/superuser access. |
| `public.radscheduler_telemetry` | enabled | Scoped insert/select policies for own practice plus AAL2 privileged access. |

Migrations applied:

- `docs/sql/03-rls-superuser-alignment.sql`
- Supabase migration name: `align_rls_superuser_access`
- `docs/sql/05-admin-mfa-aal2-hardening.sql`
- Supabase migration name: `admin_mfa_aal2_hardening`
- `docs/sql/06-enterprise-telemetry.sql`
- Supabase migration name: `enterprise_telemetry`

Policies now present:

- `practices_select_scoped`
- `practices_insert_privileged`
- `practices_update_privileged`
- `radscheduler_select_scoped`
- `radscheduler_insert_scoped`
- `radscheduler_update_scoped`
- `radscheduler_backups_select_scoped`
- `radscheduler_backups_insert_scoped`
- `radscheduler_backups_update_scoped`
- `radscheduler_backups_delete_scoped`

Follow-up hardening applied:

- `docs/sql/04-rls-advisor-hardening.sql`
- Supabase migration name: `rls_advisor_hardening`
- RLS policies now wrap `auth.jwt()` as `(select auth.jwt())` to avoid
  per-row init-plan overhead.
- Backup policies are action-specific instead of one broad `FOR ALL` policy.
- `_radscheduler_shifts_touch()` has a fixed `search_path`.
- Public execution was revoked from the internal `rls_auto_enable()` security
  definer function.

## Auth Metadata

Current user-role distribution:

| Role | Practice | Count |
| --- | --- | ---: |
| `admin` | `main` | 5 |
| `user` | `main` | 7 |

No active `superuser` accounts were present at audit time, but RLS is now ready
for that role.

## Practice Data

| Practice | Name | Schedule Row | Approx Data Size | Saved At | Schema |
| --- | --- | --- | ---: | --- | --- |
| `main` | Rad Indiana | yes | 198775 bytes | `2026-05-27T16:45:12.436Z` | 8 |
| `rgroup` | RadGroup | yes | 728 bytes | `2026-04-20T20:59:05.760Z` | null |

Backups:

- Rows: 41
- Oldest backup: `2026-05-09`
- Newest backup: `2026-05-27`

Shift side table:

- Rows: 3532
- Newest row: `2026-05-27T16:45:21Z`

Audit side table:

- Rows: 343
- Oldest row: `2026-05-10T00:03:02.088Z`
- Newest row: `2026-05-27T17:07:40.622Z`

## Edge Functions

Deployed functions:

| Function | Version | Status |
| --- | ---: | --- |
| `create-user` | 42 | active |
| `admin-ops` | 2 | active |
| `maps-proxy` | 17 | active |
| `auto-refresh-traffic` | 20 | active |
| `ai-proxy` | 13 | active |
| `SendFx` | 8 | active |
| `send-notification` | 11 | active |
| `calendar-feed` | 4 | active |
| `widget-data` | 75 | active |

Unauthenticated reachability probes:

| Endpoint | Probe Result | Interpretation |
| --- | --- | --- |
| `create-user` | HTTP 401 | Expected without service credentials. |
| `admin-ops` | HTTP 401 | Expected without a valid admin JWT. |
| `send-notification` | HTTP 400 | Function reachable; request was missing required kind/body. |
| `widget-data` | HTTP 401 | Expected without a valid token. |
| `calendar-feed` | HTTP 401 | Expected without a valid token. |
| `maps-proxy` | HTTP 401 | Expected without a valid token. |
| `ai-proxy` | HTTP 401 | Expected without a valid token. |

## Secrets

Present Supabase secrets:

- `ANTHROPIC_API_KEY`
- `FROM_EMAIL`
- `RESEND_API_KEY`
- `SUPABASE_ANON_KEY`
- `SUPABASE_DB_URL`
- `SUPABASE_JWKS`
- `SUPABASE_PUBLISHABLE_KEYS`
- `SUPABASE_SECRET_KEYS`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_URL`

Optional secrets not currently configured:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `RS_CRON_SECRET`

These are only blockers if SMS, web-push, or protected scheduled digest routes
are required for launch.

## Residual Risks

- The audit side table is present, but live authenticated UI verification still
  depends on a real superuser session.
- Supabase Auth leaked-password protection is disabled. Enable it from the
  Supabase dashboard under Auth password security.
- The authenticated live System Health browser run still needs real credentials.
  Run it with:

```bash
RAD_E2E_LIVE=1 RAD_E2E_EMAIL='superuser@example.com' RAD_E2E_PASSWORD='...' npm run test:e2e:live
```

- Optional Twilio, VAPID, and cron secrets should be installed if those channels
  are part of the intended production workflow.
