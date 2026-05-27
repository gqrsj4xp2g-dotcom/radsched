# Enterprise readiness

This document maps RadScheduler controls to practical enterprise evidence.

## NIST CSF 2.0 mapping

| Function | RadScheduler evidence |
|---|---|
| Govern | Go-live checklist, environment policy, release/rollback docs, security workflow |
| Identify | Architecture docs, SQL inventory, edge-function inventory, dependency inventory |
| Protect | Supabase RLS, admin MFA, leaked-password protection checklist, CSP/security headers |
| Detect | System Health, Enterprise Readiness panel, audit log, telemetry table, CodeQL |
| Respond | Incident guide, error log exports, audit CSV exports, GitHub rollback workflow |
| Recover | Daily backups, restore E2E drill, rollback drill, staging restore rehearsal |

## OWASP ASVS control map

| Area | Control |
|---|---|
| Authentication | Supabase Auth, password reset flow, admin MFA/AAL2 enforcement |
| Access control | RLS policies by practice, superuser/admin role claims in app metadata |
| Validation | Schema validation before remote apply and backup restore |
| Cryptography/secrets | Anon key only in browser; service-role keys restricted to edge functions |
| Error handling | Global error capture, runtime error log, telemetry events |
| Logging | `radscheduler_audit` for mutations, `radscheduler_telemetry` for ops events |
| Data protection | Backups table, restore validation, archive export/import |
| Configuration | Supabase, GitHub, edge-function, and environment setup docs |
| Malicious code | CodeQL, Dependabot, SQL/RLS lint, migration drift checks |

## Manual enterprise controls

- Enable Supabase Auth leaked-password protection.
- Enable Supabase MFA in the dashboard before applying
  `docs/sql/05-admin-mfa-aal2-hardening.sql`.
- Enable GitHub secret scanning and push protection in repository settings.
- Configure branch protection for `main`: require CI, CodeQL, and review.
- Keep production service-role keys out of browsers and repo history.

## Launch evidence packet

Before a production launch, archive:

- Latest GitHub Pages deploy run URL.
- `npm run test:e2e` output.
- `npm run test:migration-drift` output.
- `npm run test:edge-monitor` output.
- Latest `.github/workflows/ops-monitor.yml` run URL.
- Screenshot/export of Tools > Logs & ops > Go-live readiness.
- Screenshot/export of Tools > Logs & ops > Enterprise readiness.
- Backup restore drill result.
