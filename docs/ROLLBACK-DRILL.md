# RadScheduler — Rollback drill

Use this when a release causes sync, login, service-worker, or schedule
behavior to regress.

## Dry-run

```bash
npm run test:rollback-drill
```

For a live marker check:

```bash
RS_PAGES_URL=https://gqrsj4xp2g-dotcom.github.io/radsched npm run test:rollback-drill
```

## Drill

1. Confirm the fault in **Tools → Logs & ops → System health**.
2. Export evidence: Error log, Audit log CSV, and a practice archive if
   schedule data might be involved.
3. If schedule data is wrong, restore data first:
   - **Tools → Logs & ops → Rollback timeline**, or
   - **Settings → Backups** and restore the last known-good snapshot.
4. If deployed code is wrong:

```bash
git revert --no-edit <bad_commit_sha>
./tools/precommit.sh
git push origin main
gh run watch <run_id> --exit-status
```

5. Verify the live deployment:

```bash
curl -fsSL https://gqrsj4xp2g-dotcom.github.io/radsched/sw.js | grep CACHE_VERSION
curl -fsSL https://gqrsj4xp2g-dotcom.github.io/radsched/index.html | grep _RS_HTML_BUILD
```

Then run **System health → Run health check** from a signed-in admin or
superuser session.
