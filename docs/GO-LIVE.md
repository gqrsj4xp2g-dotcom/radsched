# Go-live checklist

Use this after deploy and before letting a practice rely on the schedule.

## Automated checks

Run locally:

```bash
npm ci
npm run test:security-headers
npm run test:environment
npm run test:rbac
npm run test:migration-drift
npm run test:load
npm run test:e2e
RAD_E2E_LIVE=1 RAD_E2E_EMAIL='admin@example.com' RAD_E2E_PASSWORD='...' npm run test:e2e:live
npm run test:edge-monitor
```

Run in the app as an admin:

1. Open **Tools > Logs & ops**.
2. Run **Go-live readiness**.
3. Run **System health**.
4. Run **Enterprise readiness** and **Ops dashboard**.
5. Review **Audit log** and **Error log**.
6. Open **Show backups** and confirm at least one recent backup exists.

## Supabase dashboard checks

These settings cannot be verified from the public browser client:

- Auth > Security > **Leaked password protection** is enabled.
- Auth > URL Configuration includes the production site URL.
- Edge Functions shows deployed versions for `create-user`, `admin-ops`,
  `send-notification`, `widget-data`, `calendar-feed`, `maps-proxy`, and
  `ai-proxy`.
- Database policies match `docs/sql/04-rls-advisor-hardening.sql` plus the
  enterprise hardening migrations in `docs/sql/05-admin-mfa-aal2-hardening.sql`
  `docs/sql/06-enterprise-telemetry.sql`, and
  `docs/sql/07-immutable-audit-chain.sql`.
- SAML SSO is configured if the deployment requires IdP login; see
  `docs/SSO-SCIM.md`.

## Restore confidence

The browser drill verifies confirmation and local hydration. The database suite exercises the real restore transaction, including rollback on audit failure, idempotent retries and side-table preservation. Verify the `rs-daily-practice-backups` job is active in staging and that a practice receives a UTC-day snapshot with no browser open. Run a staging restore on a copied practice before launch.
