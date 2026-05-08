# RadScheduler — Release process

> A release is a `git push` of `index.html` to `main`. Everything else
> is automation.

## Cadence

No fixed schedule. Release when a feature is ready or a fix is needed.
Avoid releasing on Friday afternoon — if something breaks, the team
won't be there to fix it.

## Preflight checklist

Before pushing:

- [ ] In-app regression suite passes (Tools → run-tests).
- [ ] Parse check passes (`./tools/parsecheck.sh`).
- [ ] Manual smoke flow works (see `docs/TESTING.md`).
- [ ] Audit log shows expected entries for the new flows.
- [ ] No `console.error` in DevTools after a fresh load.
- [ ] No fetch failures in DevTools network tab.
- [ ] Service worker registered + active (DevTools → Application).
- [ ] PWA manifest still passes Lighthouse.
- [ ] Mobile rendering checked on at least one device.

## Bumping the cache version

When `index.html` changes, edit `sw.js`:

```js
const CACHE_VERSION = 'rs-v2';   // was 'rs-v1'
```

This evicts old shells on the next `activate` event so users get the
new HTML on their next load. Forgetting this means users see stale
cached content for ~24 hours.

## Edge function deploys

If `edge-functions/send-notification/index.ts` changes:

```bash
supabase functions deploy send-notification
```

Edge function deploys are independent of the main app deploy.
Coordinate them when a new client needs a new server feature.

## Schema changes

If you change the persisted state shape:

1. Add a migration in §8 of the script (`_MIGRATIONS` array).
2. Bump `_SCHEMA_VERSION`.
3. Test the migration against an old saved state by:
   - Export an archive (Tools → Export practice archive)
   - Switch to a clean database row
   - Import the archive
   - Verify the new fields populate correctly

Migrations are forward-only. Never modify an existing migration entry
once shipped — add a new one instead.

## Deploying

Pushes to `main` deploy automatically:

- **GitHub Pages**: via `.github/workflows/deploy.yml`.
- **Netlify**: via the Netlify GitHub app.
- **Vercel**: via the Vercel GitHub integration.

Manual deploy (rare):

```bash
git push origin main
# wait 30–60s for the host to pick up
# verify: curl -sI https://your-domain/ | grep last-modified
```

## Rolling back

```bash
git revert <bad commit SHA>
git push origin main
```

The rollback re-deploys via the same automation. Cache busts on the
next service worker activate. If users are stuck on a bad version
and the cache won't bust, push `sw.js` with a new `CACHE_VERSION`.

## Hotfix flow

For an urgent production-only fix:

```bash
git checkout main
git pull
git checkout -b hotfix/short-name
$EDITOR index.html
./tools/parsecheck.sh
git commit -am "fix: short description"
git push origin hotfix/short-name
gh pr create --fill --label urgent
# get one review, merge with squash
```

## Versioning

We don't tag releases (no semver). The git SHA is the version.
`Settings → About` shows the current SHA after a fresh load.

If you need to mark a milestone, tag it:
```bash
git tag -a v1.0 -m "Initial production deployment"
git push origin v1.0
```

## Communications

For user-facing releases, post to:
- Practice Slack/Teams channel: changelog summary
- In-app banner via `S.cfg.releaseNote = '…'` (transient)

Internal-only changes don't need a banner.

## Post-release

1. Watch the audit log for unexpected error entries.
2. Check the edge function logs (Supabase dashboard → Edge Functions →
   Logs) for new error patterns.
3. Verify Lighthouse PWA score didn't regress.
4. If something looks off, roll back rather than try to forward-fix
   under pressure.

## Disaster recovery

If the live site is broken and you can't push:

1. Manual restore: download the last good `index.html` from
   `git show <good-SHA>:index.html > index.html` and upload to the
   host's static control panel.
2. Restore from a snapshot: Settings → Backups → Restore from
   downloaded snapshot.
3. Roll back the Supabase row to a prior backup if the schema
   migration corrupted state.

## What we don't do

- ❌ Staging environment (single-tenant practice; testing is in dev).
- ❌ Feature flags (everything ships behind admin-only checks).
- ❌ Canary deploys (one URL serves all users).
- ❌ Blue-green (the host swaps DNS atomically).
