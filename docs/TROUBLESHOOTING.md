# RadScheduler — Troubleshooting

> First-aid guide for common issues. If your problem isn't here,
> attach the audit + error log and open an issue.

## I just deployed and the page won't load

1. Hard-reload (Cmd/Ctrl-Shift-R). Service worker cache might be
   stale.
2. DevTools → Application → Service Workers → "Unregister", then
   reload.
3. Check the host's deploy log — did the push actually succeed?
4. Verify the URL serves `index.html`: `curl -I https://your-url/`.

## "Sign-in failed"

- Wrong credentials → reset password in Supabase Auth.
- "Email not confirmed" → check spam, or admin-confirm in Supabase
  dashboard.
- "Network error" → check Supabase project is up (status page).
- 401 from Supabase → ANON_KEY in `index.html` doesn't match the
  project. Update and redeploy.

## "Another tab edited; reload?"

This is the optimistic-concurrency probe firing. Two tabs both saved
within the same window. The losing tab needs to reload to pull the
winning state. To prevent this:

- Use the leader-elected tab as the source of truth.
- Avoid editing the same record from two tabs simultaneously.

## "JWT expired" or 401 from edge function

Sign out + sign in again. If it persists:
- Check Supabase project URL hasn't changed.
- Verify `SUPABASE_URL` constant in `index.html` matches.
- Check the edge function is deployed: `supabase functions list`.

## Excel import shows "0 imported, 0 skipped"

The dedup is silently skipping everything because all records are
already in S. Use the **Replace** flow:

1. After previewing the import, click "Replace existing imports".
2. The app removes every record where `notes` matches `^Imported:`
   and re-runs the parse against fresh state.

If you hit this often, it means re-imports aren't being detected as
the same physician. Check the Levenshtein matcher's threshold
(currently 0.7) and the unmatched-names panel.

## Auto-assign produces unbalanced output

- Recovery days set too high → physicians can't be back-to-back.
- Sub-specialty needs too tight → no valid assignment exists.
- FTE targets summing past 100% → over-allocation.
- Anchor strictness too aggressive → forces re-assigns on weekends.

Run the **What-if simulator** (Tools page) on a single physician's
removal — that often surfaces the constraint that's binding.

## Push notifications not arriving

Check in order:
1. **Subscription**: Settings → Push → "Test" should fire a notif.
2. **VAPID**: public key in `S.cfg.vapidPublicKey` matches the
   server-side `VAPID_PUBLIC_KEY` secret.
3. **Edge function**: `supabase functions logs send-notification`
   shows the push delivery attempt.
4. **Browser permissions**: chrome://settings/content/notifications →
   ensure your domain isn't blocked.
5. **Service worker**: DevTools → Application → Service Workers →
   shows status "activated".

## Service worker won't update

- Bump `CACHE_VERSION` in `sw.js`.
- DevTools → Application → Service Workers → "Update on reload".
- Clear cache: Settings → Offline Support → "Re-check". This sends
  the `rs:clear-cache` message to the SW.

## Calendar renders empty

- Wrong month picker value → check the YYYY-MM input.
- `S.physicians` empty → import a roster first.
- JS error during render → check the error log (Tools → Error log).
- Filters too aggressive → reset filter chips.

## Realtime updates not arriving

- Only the leader tab subscribes. Open DevTools and look for
  `[RS] becoming leader` in console.
- If multiple tabs claim leader, `BroadcastChannel` may be
  unsupported (very old browser).
- Supabase Realtime may have hit its concurrent-connection limit.
  Check Supabase dashboard → Project → Reports.

## Audit log says "permission denied"

The user doesn't have the role the action requires. Check
`app_metadata.role` in Supabase Auth. If it's missing, an admin needs
to set it via:

```sql
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
WHERE id = 'user-uuid';
```

Then user signs out + back in to refresh the JWT.

## Performance is slow

- Open DevTools → Performance → record a calendar render.
- Memoization not working? → bump `_dateIdxVersion` after bulk ops.
- Too many records? Practice with 5 years of history may need
  archive-pruning. Use Tools → Power tools → "Prune old snapshots".
- Dev mode? Set `S.cfg.debug = false` to silence verbose logs.

## "Disk-watch autopush" stuck

The launchd agent in `~/Library/LaunchAgents/com.radscheduler.autopush.plist`
runs `~/RadApp/.git-autopush.sh` on file changes. If pushes hang:

```bash
launchctl unload ~/Library/LaunchAgents/com.radscheduler.autopush.plist
launchctl load   ~/Library/LaunchAgents/com.radscheduler.autopush.plist
tail -f /tmp/radscheduler-autopush.log
```

Common cause: SSH key prompt waiting for input. Use the dedicated key
`~/.ssh/id_radsched` and ensure it's added to `ssh-agent`.

## "409: index.html does not match SHA"

The in-browser GitHub deploy and the disk-watch autopush raced. The
in-browser flow auto-disables itself after a 409 if the local file
content matches what's already on origin. To re-enable:

```js
// Console:
S.cfg.inBrowserDeploy = true;
```

## My change isn't showing up

1. Hard reload.
2. Check the file was saved.
3. Run `./tools/parsecheck.sh` — a syntax error means the script
   block fails to evaluate; the previous DOM stays.
4. DevTools → Sources → search for your edit. If it's not there, the
   service worker is serving cached HTML.

## Where to look first

| Symptom | First place to look |
|---------|--------------------|
| Page won't load | Hosting deploy log |
| Action button does nothing | DevTools console for errors |
| Action ran but didn't persist | Audit log; Supabase Realtime status |
| User reports stale data | Service worker cache version |
| Edge function failure | `supabase functions logs <name>` |
| Auth failure | Supabase dashboard → Auth → Users |
| Performance regression | DevTools Performance tab + memo version |

When in doubt, capture:
- Browser + version
- Tools → Error log → Export
- Tools → Audit log → Export CSV (last 100 rows)
- Steps to reproduce
- Expected vs. actual
