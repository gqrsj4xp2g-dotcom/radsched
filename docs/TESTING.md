# RadScheduler — Testing
## Enterprise guardrails

Run these before release or after changing auth, RLS, deployment, or
security headers:

```bash
npm run test:security-headers
npm run test:environment
npm run test:rbac
npm run test:migration-drift
npm run test:load
```

`test:security-headers` validates CSP/header drift, `test:environment`
guards staging/production separation, `test:rbac` keeps the role matrix in
sync with app/edge/SQL gates, and `test:load` profiles the offline 200
physician scale case.
> One-file deployment means most testing happens in the browser. This
> doc maps what's covered, what isn't, and how to add coverage.

## Test layers

| Layer | Where | Coverage |
|-------|-------|----------|
| Parse check | CLI (`tools/parsecheck.sh`) | Syntax + simple structural checks |
| Shell smoke check | CLI (`tools/smoke-check.js`) | PWA assets, build/SW version sync, edge source links, privileged gate drift |
| Regression suite | In-app (Tools → run-tests) | Pure-function correctness |
| Playwright E2E | CLI / CI (`npm run test:e2e`) | Auth shell, role gates, system health, mobile layout, service worker, mocked sync |
| Migration drift | CLI / CI (`npm run test:migration-drift`) | Required RLS policies and hardening objects are still present |
| Edge monitor | CLI / scheduled GitHub Actions (`npm run test:edge-monitor`) | Public reachability probes for deployed Supabase edge functions |
| Manual smoke | Checklist below | UI/UX + end-to-end flows |
| Integration | Manual against staging Supabase | Auth + persistence + Realtime |

There is no full automated end-to-end test framework yet. The single-file
deployment makes browser-based assertion harder than usual; the shell
smoke check covers deploy-critical wiring, Playwright covers the critical
app-shell journeys, and the in-app regression suite covers the deterministic
parts.

## Parse check

The script tag is extracted and run through a JS engine to verify
syntactic validity. Run via:

```bash
./tools/parsecheck.sh
```

This catches typos, missing brackets, malformed templates, and
invalid escape sequences. It runs in CI (see `.github/workflows`).

## Shell smoke check

The smoke check catches issues that parse-check cannot see:

```bash
node tools/smoke-check.js
```

It verifies:

- `index.html` build markers match `sw.js` cache version.
- Manifest and service-worker assets exist.
- The setup panels load edge function source from repo files.
- Known privileged surfaces still treat `superuser` as privileged.
- Superuser mutation protections remain in `create-user`.
- Sidebar and manifest shortcut targets resolve to real pages.
- No injected Cloudflare email-decoder script is present.

This runs in CI before every GitHub Pages deploy.

## In-app regression suite

Open the app, sign in, navigate to **Tools → Run regression tests**.
The suite covers:

- Date math (`addDays`, `parseDateLocal`, `_toMonday`)
- Block math (Sat-to-Sun 9-day windows)
- FTE counters (per-physician per-month/year)
- MCF auto-assigner (small inputs vs. expected output)
- Snapshot serialize/deserialize round-trip
- Schema migration (v0 → vN forward path)
- Excel parser (mock rows → expected counts)
- Field validators (`_validatePhysician`, `_validateDateRecord`)
- Levenshtein matcher (known pairs + thresholds)

The suite is intentionally pure — no DOM, no fetch, no Supabase.
Adding a new pure helper? Add a test alongside it. The runner is
in §44 of the script.

```js
// Pattern for adding a test:
_addTest('descriptive name', () => {
  const result = myFunction(input);
  if(result !== expected) throw new Error(`got ${result}, expected ${expected}`);
});
```

## Playwright E2E

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

The default tests are synthetic and read-only: they mock Supabase network
paths and exercise app-shell behavior without writing production data.

For a real authenticated health check:

```bash
RAD_E2E_LIVE=1 \
RAD_E2E_EMAIL='admin@example.com' \
RAD_E2E_PASSWORD='...' \
npm run test:e2e:live
```

For launch-day infrastructure checks:

```bash
npm run test:migration-drift
npm run test:edge-monitor
```

The same edge monitor runs every 30 minutes from
`.github/workflows/ops-monitor.yml`.

## Manual smoke checklist

Run before any release. ~10 minutes.

### Authentication
- [ ] Sign-in with valid creds works.
- [ ] Sign-in with bad creds shows clear error.
- [ ] Sign-out clears session + reloads.
- [ ] Refresh after 60+ minutes still works (token refreshed).
- [ ] Two browsers signed in to the same user → both update on changes.

### Calendar
- [ ] DR / IR calendars render the current month.
- [ ] Click an empty cell → quick-assign popover opens.
- [ ] Today's date is visually highlighted.
- [ ] Print preview renders cleanly.

### Auto-assign
- [ ] Preview shows expected counts.
- [ ] Apply records to audit log.
- [ ] Worker doesn't freeze the UI on a 6-month preview.
- [ ] Constraint settings (recovery, holiday gap) round-trip via reload.

### Excel import
- [ ] Pick a known file → preview shows correct categorized counts.
- [ ] Apply commits to S + audit log.
- [ ] Re-importing the same file → "Replace" path works.
- [ ] Unmatched names → manual mapping panel works.

### Multi-tab
- [ ] Open tab A and tab B; edit in A.
- [ ] B receives the change without manual refresh.
- [ ] Close A; B becomes the leader.

### Operations
- [ ] Tools → Logs & ops → System health quick check is all green.
- [ ] Deep check reports service worker, manifest, icon, Supabase, and
  edge-function reachability without unexpected failures.
- [ ] Rollback timeline opens and shows recent snapshots when available.
- [ ] `npm run test:rollback-drill` passes before a release.

### Mobile
- [ ] iOS Safari: viewport correct, no horizontal scroll.
- [ ] Touch targets ≥ 44×44.
- [ ] PWA install prompt appears (after the 30s heuristic).
- [ ] Push notification opt-in works.

### Edge function
- [ ] Test SMS via curl (see `edge-functions/README.md`).
- [ ] Test email via Tools → Test integration.
- [ ] Digest run trigger works.

## Adding new tests

Pure functions only — anything that touches DOM, fetch, or `S` state
needs to be exercised manually.

```js
// In §44 (Built-in regression suite):
_addTest('my-new-function: basic case', () => {
  const out = myNewFunction(2, 3);
  if(out !== 5) throw new Error(`got ${out}`);
});
_addTest('my-new-function: edge case', () => {
  const out = myNewFunction(0, 0);
  if(out !== 0) throw new Error(`got ${out}`);
});
```

The runner reports `<n> passed, <m> failed` and surfaces failure
details in a modal.

## Coverage gaps

Acknowledged + tracked:

- DOM render functions (renderDR, renderIR, etc.) — exercised by
  manual smoke only.
- Realtime fanout — exercised by multi-tab smoke only.
- Edge function behavior — exercised by curl + Supabase logs only.
- Visual regression (CSS, layout) — none. Lighthouse + manual.
- Service worker — manual via DevTools.

Future work: add Playwright or Puppeteer for end-to-end runs.
Hold off until the core features stabilize.

## Continuous integration

`.github/workflows/deploy.yml` runs:
1. Parse check
2. TOC check
3. Manifest JSON validation
4. Shell smoke check
5. Edge Function TypeScript bundle validation

Failures block the deploy. See the workflow file for current state.

## Pre-commit hook (optional)

Install via:
```bash
ln -s ../../tools/precommit.sh .git/hooks/pre-commit
chmod +x tools/precommit.sh
```

Runs parse and shell smoke checks before allowing the commit when the
deployable shell, managed source parts, or edge functions are staged.
