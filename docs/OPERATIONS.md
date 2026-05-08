# RadScheduler — Operations runbook

> Day-2 procedures: what you need when running RadScheduler in
> production. Aimed at IT/ops staff, not end users.

## Inventory

| Component | Location | Owner | SLA |
|-----------|----------|-------|-----|
| Static client | Hosting (GitHub Pages / Netlify / Vercel) | Eng | 99% |
| Database + Auth | Supabase project | Eng + Supabase | 99.9% |
| Edge functions | Supabase Edge Runtime | Eng + Supabase | 99% |
| Resend (email) | resend.com | Vendor | 99.9% |
| Twilio (SMS) | twilio.com | Vendor | 99.95% |
| VAPID (push) | self-managed key pair | Eng | n/a |

## Daily tasks

None. The app is hands-off.

## Weekly tasks

1. **Check the audit log** for unusual patterns. Filter on `error.*`
   to surface anything captured.
2. **Check Supabase usage** (Reports → Database / Auth / Realtime).
   If approaching free-tier limits, consider upgrading.
3. **Run the regression suite** (Tools → run-tests). Failures usually
   indicate environment drift (e.g. timezone change).

## Monthly tasks

1. **Review schema migrations** (Tools → Backups → SchemaVersion).
   Confirm production matches expected `_SCHEMA_VERSION`.
2. **Review error log** (Tools → Error log → Export). Investigate any
   recurring entries.
3. **Verify backups exist** (Settings → Backups → list). Daily backup
   should be ≤ 24 hours old.

## Quarterly tasks

1. **Rotate edge function secrets** if your security policy requires.
   See `docs/SECURITY.md` for the rotation procedure.
2. **Audit user access**: Supabase Dashboard → Auth → Users. Remove
   access for departed staff.
3. **Snapshot retention review**: Tools → Power tools → "Prune old
   snapshots". Default retention is 90 days; adjust via
   `S.cfg.snapshotRetainDays`.

## Annual tasks

1. **Backup an offline archive** for compliance / disaster recovery:
   - Tools → Power tools → "Export practice archive".
   - Save to a non-cloud, encrypted location.
2. **Review the threat model** (`docs/SECURITY.md`). Has the practice's
   risk profile changed?
3. **Refresh the cache version** if minor cleanup is overdue.

## Backup + restore

### Automatic backups

- **Supabase point-in-time recovery (PITR)**: enable on the Pro plan.
  Restores the entire DB to any second within 7 days.
- **Daily auto-snapshot**: the app saves a snapshot of `S` to
  `S.snapshots` once per day. Visible in Settings → Backups.

### Manual backup

Tools → Bulk operations → "Export practice archive" downloads a JSON
file containing the full persistent state. Store this in a separate
location.

### Restore from snapshot

Settings → Backups → pick a snapshot → "Restore". This replaces the
current state with the snapshot. Audit log records the restore.

### Restore from JSON archive

Tools → Bulk operations → "Import practice archive" → pick the JSON
file. Confirms before overwriting.

### Disaster recovery

If the live Supabase row is corrupted:

1. Pause writes: set every signed-in tab to read-only via
   `S.cfg.readOnly = true` in console.
2. Identify the last known good state from Supabase PITR or a JSON
   archive.
3. Restore via either path above.
4. Re-enable writes: `S.cfg.readOnly = false`.
5. Notify users to refresh.

## Monitoring

### What we capture

- Audit log: every admin mutation, capped at 500 entries.
- Error log: uncaught errors + render warnings, capped at 100.
- Supabase logs: query patterns, edge function invocations.
- Service worker logs: install/activate/fetch events (per-browser).

### What we don't capture

- Full text of error messages from end-users without their consent.
- Page-view analytics. (No GA, no Mixpanel.)
- Performance traces.

### Alerting

There is no automated alerting in the box. Set up your own:

- Supabase: configure Slack/email notifications in project settings
  for downtime + auth failures.
- Resend / Twilio: enable bounce / failure webhooks pointing to
  the `send-notification` edge function (`kind: 'webhook'`).
- Uptime: set up an external monitor (e.g. Better Uptime, UptimeRobot)
  pinging the app URL every 5 minutes.

## Capacity planning

Rough capacity per Supabase plan:

| Plan | Max practices | Max admins/practice | Max records/practice |
|------|---------------|---------------------|----------------------|
| Free | 1 | 5 | ~5k records (500 KB row) |
| Pro  | 5 | 20 | ~50k records (5 MB row) |

If you exceed Free: upgrade. If you exceed Pro: split into separate
projects (one practice per project).

## Cost

| Component | Free tier | Cost above |
|-----------|-----------|------------|
| Supabase | 500 MB DB, 50k auth users | $25/mo Pro |
| Hosting | Free (GH Pages, Netlify, Vercel) | $0 |
| Resend | 100/day, 3k/mo | $20/mo for 50k |
| Twilio | $0 | ~$0.0079/SMS US |
| VAPID | Free | n/a |

A typical 10-physician practice runs at ~$0/mo on Free + Resend Free.
Scale up when needed.

## On-call

If you have an on-call rotation, the on-call should know:

1. How to log in to Supabase Dashboard.
2. How to read `supabase functions logs send-notification`.
3. How to roll back: `git revert + git push`.
4. How to flip the kill switch: see `docs/INCIDENT.md`.
5. Vendor support contacts (Resend, Twilio).

## Compliance + audit

If your practice is under HIPAA / SOC 2 / similar, document:
- Who has admin access (Supabase + the host).
- When user access is reviewed.
- Where backups are stored + how often verified.
- Incident response plan.

This app records the audit log; your operational documentation is
what tells auditors how the audit log is reviewed.
