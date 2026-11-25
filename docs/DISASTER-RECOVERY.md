# Disaster recovery runbook

## Targets

| Target | Default |
|---|---|
| RPO | 24-hour target for valid shared practice schedules. Separate tables require a platform backup or PITR. |
| RTO | 60 minutes for app-level restore, longer for full platform outage |
| Restore authority | `superuser`, or `admin` for own practice with `aal2` |
| Evidence | Audit row, telemetry event, GitHub workflow run, operator notes |

## Backup sources

- `radscheduler_backups`: server-managed daily snapshots of the shared schedule, roster and settings. The hourly job captures each valid practice once per UTC day. Seven daily dates are retained. Pre-existing, manual, pre-bulk and pre-restore points are preserved. Fields absent from older snapshots keep their current values. Separate tables such as swaps, acknowledgements, chat, reports, accounts and audit records keep their current state during a schedule restore.
- Browser archive export: manual JSON export before high-risk operations.
- Supabase PITR: recommended for production once on Pro.
- GitHub history: static app shell and edge function source.

## Restore order

1. Pause high-risk writes by announcing downtime and asking users to close
   open tabs.
2. Preserve evidence: export Error log, Audit log CSV, and current app build.
3. Identify the last known-good backup.
4. Restore through Settings -> Backups & Restore. This calls `admin-ops`,
   requires `aal2`, validates the backup payload, writes the practice row,
   and writes a safety snapshot, audit event, telemetry and request receipt in one transaction. If the current schedule is corrupt, preserve the original via a platform backup and use platform recovery.
5. Run Tools -> Logs & ops -> System health.
6. Run Tools -> Logs & ops -> Go-live readiness.
7. Notify users to refresh.

## Drill cadence

- Staging restore drill: monthly.
- Production dry-run rollback drill: monthly using `npm run test:rollback-drill`.
- Full production restore: only during a declared incident or approved
  maintenance window.

## Failure modes

| Symptom | Action |
|---|---|
| Backup list is empty | Check Supabase RLS, `_BACKUP_TABLE`, and the pg_cron job `rs-daily-practice-backups` and PostgreSQL warnings for invalid practice data. |
| Restore blocked by MFA | Re-authenticate and complete TOTP to reach `aal2`. |
| Restore write fails | Check `admin-ops` logs and RLS migration state. |
| Restored data looks wrong | Restore the next older backup and keep both audit exports. |
| App shell deploy is wrong | `git revert --no-edit <sha>`, run `./tools/precommit.sh`, push `main`. |
