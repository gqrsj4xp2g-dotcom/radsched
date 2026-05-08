# RadScheduler — Incident response

> When something is on fire. Read top-to-bottom — first sections are
> the most likely action.

## 0. Severity scale

| Sev | Definition | Examples |
|-----|------------|----------|
| 1 | Total outage; no one can use it | Page won't load, auth broken, DB down |
| 2 | Partial outage; major function broken | Auto-assign throws, calendar blank |
| 3 | Degraded; minor function broken | Push delivery flaky, an export fails |
| 4 | Cosmetic / non-blocking | Toast misaligned, color off |

## 1. First five minutes

- [ ] Verify it's real: try a different browser / device.
- [ ] Capture: URL, browser, what the user did, exact error message.
- [ ] Tools → Error log → Export. Attach to incident notes.
- [ ] Status check:
  - [ ] Supabase: https://status.supabase.com
  - [ ] Hosting (Netlify/Vercel/GH Pages): respective status pages.
  - [ ] Resend, Twilio: their status pages if push/email/SMS involved.

## 2. Quick triage

```
Symptom                          → Likely cause           → First check
─────────────────────────────────────────────────────────────────────
Page won't load                  → SW cache poison        → SW unregister + reload
Auth fails                       → Supabase outage        → Status page
"JWT expired"                    → Token refresh broken   → Sign out + back in
Push not arriving                → VAPID mismatch         → Settings → Push → Test
Edge function 500                → Secret rotation needed → supabase functions logs
Auto-assign infinite-loops       → Bad input data         → Audit log; revert recent edits
Calendar blank                   → Render error           → Error log; check S.physicians
Save fails silently              → RLS policy mismatch    → Supabase Dashboard → Auth
Realtime not propagating         → Concurrent connection cap → Supabase reports
```

## 3. Kill switches

If you need to stop the app from making any further mutations:

```js
// Console — current tab only:
S.cfg.readOnly = true;

// All tabs at once (broadcast):
new BroadcastChannel('rs-control').postMessage('readonly');
```

To stop edge function delivery:
```bash
# Pause the function so it returns 503:
supabase functions delete send-notification
```

To take the entire app offline:
- GitHub Pages: rename `index.html` → `index.html.disabled` and push.
- Netlify: Pause the site (Site settings → Build & deploy).
- Vercel: Pause deployments (Project settings).

## 4. Rollback

```bash
# Identify the last known good commit:
git log --oneline -20

# Revert specific commit:
git revert <bad SHA>
git push origin main

# Or hard reset to a known good state (destructive):
git reset --hard <good SHA>
git push --force-with-lease origin main
```

After rollback:
- [ ] Bump `CACHE_VERSION` in `sw.js` so users actually get the
      rolled-back code.
- [ ] Verify Audit log entries match the pre-incident state.
- [ ] Notify users to hard-reload.

## 5. Common incidents + fixes

### "Auto-assigner produces no schedule"
1. Open the audit log; filter by `aa.preview`.
2. Look for "no feasible flow" — overlapping vacations or hard
   constraints that can't all be satisfied.
3. Run the **What-if simulator** to identify which constraint is
   binding.
4. Relax the constraint (recovery days, sub-specialty needs).
5. Re-run preview.

### "Realtime delivers stale data"
1. The leader tab might be stuck. Refresh it.
2. The Supabase Realtime connection may have dropped silently.
   Re-subscribe by reloading the page.
3. If it persists, check Supabase logs for connection-quota errors.

### "User sees other practice's data"
**Stop. This is a data leak.**
1. Pause writes immediately: `S.cfg.readOnly = true` in every tab.
2. Verify `_ROW_ID` matches the user's expected practice ID.
3. Check `app_metadata.practice_id` on their Supabase user.
4. Check RLS policies — they should restrict by `practice_id`.
5. Force sign-out for affected users.
6. Treat as a security incident: document, report, fix the policy,
   re-enable.

### "Service worker stuck on old version"
1. DevTools → Application → Service Workers → "Unregister".
2. Reload twice (first load registers the new SW; second uses it).
3. If it persists, bump `CACHE_VERSION` and push.

### "Edge function returns 401 for valid users"
1. Check token validity: Supabase Dashboard → Auth → Users → that user.
2. Check the function's auth call:
   `supabase.auth.getUser(jwt)` — if this returns null, token is
   invalid or expired.
3. Verify the JWT secret hasn't been rotated mid-session.
4. Check the Edge runtime version in Supabase project settings.

### "Excel import shows wrong year"
This is usually correct — the file is named after the publish year
but the dates inside resolve to the previous year. Verify the source
data; the parser is correct. To force a year shift, use Tools →
Excel parser → Year override.

## 6. Communications

If users are affected, send a short status note:

```
[STATUS] RadScheduler is currently experiencing
<describe symptom>. We are investigating. Will update at <time>.
```

Channel: practice Slack/Teams + in-app banner via
`S.cfg.releaseNote = '⚠ Service degraded — <details>'`.

After resolution:

```
[RESOLVED] RadScheduler is back to normal as of <time>.
Cause: <one sentence>. We are following up with <action>.
```

## 7. Postmortem

After a Sev 1 or 2:

1. Write a brief postmortem in `docs/postmortems/YYYY-MM-DD-name.md`:
   - Timeline (UTC times)
   - Root cause
   - Detection
   - Resolution
   - Action items (with owners)
2. Track action items to completion.
3. Update this runbook if the incident wasn't covered.

## 8. Vendor contacts

| Vendor | Support URL | Severity 1 |
|--------|-------------|------------|
| Supabase | https://supabase.com/support | enterprise tier ticket |
| Resend | help@resend.com | response within 24h |
| Twilio | https://www.twilio.com/help/contact | 24/7 paid |
| Netlify | https://www.netlify.com/support/ | community + paid |
| Vercel | https://vercel.com/help | community + paid |

## 9. Useful commands

```bash
# Watch edge function logs:
supabase functions logs send-notification --tail

# Get recent commits on main:
git log --oneline -20 main

# Check what shipped in the last deploy:
gh run list --workflow=deploy.yml --limit=5

# Tail service worker activity:
# DevTools → Application → Service Workers → "Show cache" + "Show all"

# Check Supabase row size:
# Dashboard → SQL editor:
#   SELECT pg_column_size(state) FROM your_table WHERE id = 'practice-id';
```

## 10. After every incident

- [ ] Update the changelog (commit message body).
- [ ] Add a regression test for the bug if possible.
- [ ] Add a note to the relevant runbook section.
- [ ] Tell the team what we learned.
