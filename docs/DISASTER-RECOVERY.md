# Disaster recovery runbook

## Targets

| Target | Default |
|---|---|
| RPO | 24 hours with app backups, lower with Supabase PITR on Pro |
| RTO | 60 minutes for app-level restore, longer for full platform outage |
| Restore authority | `superuser`, or `admin` for own practice with `aal2` |
| Evidence | Audit row, telemetry event, GitHub workflow run, operator notes |

## Backup sources

- `radscheduler_backups`: daily practice snapshots and pre-bulk snapshots.
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
   and records audit/telemetry evidence.
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
| Backup list is empty | Check Supabase RLS, `_BACKUP_TABLE`, and daily backup logs. |
| Restore blocked by MFA | Re-authenticate and complete TOTP to reach `aal2`. |
| Restore write fails | Check `admin-ops` logs and RLS migration state. |
| Restored data looks wrong | Restore the next older backup and keep both audit exports. |
| App shell deploy is wrong | `git revert --no-edit <sha>`, run `./tools/precommit.sh`, push `main`. |
