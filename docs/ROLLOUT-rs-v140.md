# Rollout: rs-v140 (PR #22 audit fixes + rs-v136–v139)

Branch `merge/pr22-on-rs-v139` = PR #22 (fix/audit-rs-v136, ab5d0f2) merged with main
(rs-v139, 0c2dcfe). main is an ancestor, so main can fast-forward to this branch.
CI on the branch: Database Regression Tests (72 assertions, every migration replayed),
Staging Validation (144 Playwright tests, packaged), Security Scan and CodeQL all pass.

**Nothing here is applied yet. Every step below changes the live database or the live site
and is the owner's decision.**

## Rules that matter

1. **Never release the page (step 8) before migration 5 (step 6).** The new page leaves
   `chatMessages`/`chatPins` out of every whole-row save, so a page released first erases chat
   history from the schedule row before migration 5 can copy it out.
2. **Until step 6, do not sign in on any Vercel preview (`radsched-*.vercel.app`) of this
   branch or of PR #22.** Previews run the new page against the production database; one admin
   edit there strips chat from the live row. (Checked 2026-11-26 02:35 ET: the live row still
   holds its 2 chat messages and pins.)
3. **Supabase's GitHub integration acts on the production project when main is pushed.** The
   "Supabase Preview" check on main pushes reports *"Remote migration versions not found in
   local migrations directory"* against project tpbgwvisikbuqhmlqtky; PR #22 restores those
   six July versions, so a push of main could then find the five new migrations pending. Before
   step 8, open Supabase Dashboard → Integrations → GitHub and check "Deploy to production":
   turn it off for the rollout, or apply steps 1–6 with `supabase db push` so nothing is pending
   when main is pushed. If a migration goes in through the SQL editor, record it with
   `supabase migration repair --status applied <version>`.
4. Do steps 4–8 in one sitting: in between, rs-v139 tabs have no pre-bulk snapshots, restores
   return 400, chat looks empty and chat emails get 409.

## Step 0 — prechecks (read-only, SQL editor)

- (a) `supabase migration list`: only 20261125000300, 20261125060000, 20261125060100,
  20261125061000, 20261125120000 pending; the six July versions (20260720233544 … 20260731173416)
  already recorded remotely. If they are recorded under other numbers, do not `db push`.
- (b) `select r.id from public.radscheduler r where r.data::jsonb ?| array['chatMessages','chatPins'] and not exists (select 1 from public.practices p where p.id = r.id);`
  → 0 rows (otherwise migration 5's foreign key aborts it).
- (c) `select count(*) from public.radscheduler_audit where entry_hash is null or actor_hash is null;`
  → 0. If above 0 and trigger `radscheduler_audit_prevent_update_trg` exists, migration 2 aborts.
- (d) Save the output of
  `select tablename, policyname, qual from pg_policies where schemaname='public' and cmd='SELECT' and qual like '%radscheduler_non_admin_same_practice(%';`
  and `select pg_get_functiondef('public.radscheduler_non_admin_same_practice(text)'::regprocedure);`
  — migration 3's undo record.
- (e) `select 1 from pg_extension where extname='pg_cron';` (if absent, migration 4 creates it).
- (f) `select id, jsonb_array_length(coalesce(data::jsonb->'chatMessages','[]')) from public.radscheduler;`
  — note the chat count; if it is unexpectedly 0, chat was already stripped.
- (g) Fresh database backup/export; a quiet time (migration 5 holds saves while it runs).

## The five new migrations (in this order)

| # | File | What it does | Undo | Needed by the page? |
|---|---|---|---|---|
| 1 | 20261125000300_peer_membership | Peer reviews check current membership (`rs_peer_can_access`: account not deleted/banned, stored and session practiceId match); policies rewritten; trigger `rs_peer_keep_assignment` allows only score/comments/status/updated_at changes; `rs_peer_my_scorecard` replaced | Yes | No — before or after |
| 2 | 20261125060000_rs_immutable_audit_chain | radscheduler_audit becomes append-only and hash-chained (columns, sequence, per-practice lock; UPDATE/DELETE/TRUNCATE blocked for every role); backfills missing hashes | Partly (drop the triggers) | No — before or after |
| 3 | 20261125060100_rs_same_practice_read | Reads need only practice membership; writes by admins need MFA (aal2) again | Yes, with precheck (d) | No — before or after |
| 4 | 20261125061000_rs_practice_backups | Backups move server-side: hourly pg_cron job `rs-daily-practice-backups` (one per practice per UTC day, keeps 6 days), `rs_capture_practice_backup`, transactional `rs_restore_practice_backup` (service role), `rs_restore_receipts`; browsers lose write access to radscheduler_backups | Mostly | Yes — before the page |
| 5 | 20261125120000_private_chat | Chat moves out of the schedule row into `rs_chat_messages` (participant-only reads), archived first in `rs_chat_legacy_archive`; trigger `rs_scrub_chat` strips chat from every row/backup save; chat RPCs replaced; realtime publication | **No (forward-fix only)** | **Yes — immediately before the page** |

## Steps

1. Apply migration 1. Check: `select proname from pg_proc where proname in ('rs_peer_can_access','rs_peer_keep_assignment');` → 2 rows. Peer Review tab lists reviews; a grade saves.
2. Apply migration 2. Check: `select tgname from pg_trigger where tgrelid='public.radscheduler_audit'::regclass and not tgisinternal;` lists the hash and prevent triggers; after one edit the newest audit row has chain_order, prev_hash, entry_hash.
3. Apply migration 3. Check: precheck (d) query returns 0 rows; an MFA admin's edits save; a physician's swap request / vacation pick saves.
4. Apply migration 4. Check: `select jobname, schedule, active from cron.job where jobname='rs-daily-practice-backups';` → `15 * * * *`, active; `select has_table_privilege('authenticated','public.radscheduler_backups','INSERT');` → false.
5. Deploy admin-ops: `supabase functions deploy admin-ops --no-verify-jwt` (restore = one transaction, needs requestId + expectedSavedAt). From here until step 8, restores from rs-v139 tabs fail with 400.
6. Apply migration 5. Check: `select count(*) from public.radscheduler where data::jsonb ?| array['chatMessages','chatPins'];` → 0; `select practice_id, count(*), count(pinned_at) from public.rs_chat_messages group by 1;` ≈ the archive count; `select tgname from pg_trigger where tgname='rs_scrub_chat';` → 2 rows; rs_chat_messages in pg_publication_tables for supabase_realtime.
7. Deploy send-notification: `supabase functions deploy send-notification --no-verify-jwt` (chat emails need the stored messageId; generic "Sign in to read" text).
8. Release the page: confirm origin/main is still 0c2dcfe (merge again if it moved), then fast-forward main to `merge/pr22-on-rs-v139`. Check: `curl -fsSL https://radsched.org/sw.js | grep CACHE_VERSION` and `curl -fsSL https://radsched.org/ | grep _RS_HTML_BUILD` show rs-v140; signed in as an MFA admin: dashboard loads, one edit saves once, chat shows the migrated messages and sends/pins, Peer Review loads, Settings → Backups lists today's server snapshot, an Excel import preview loads SheetJS, DR Auto-Assign preview builds.

## Known after the merge (not blocking)

- Pre-existing on both sides: undo history is not cleared on practice switch or sign-out, so after a superuser switches practice, Undo could restore the previous practice's state into the new one and save it.
- New in PR #22 (low): hiding the tab or coming back online while a save is on the wire sends the same whole row once more; a save from another device that lands while this tab's own save is on the wire shows up at the next 10 s poll instead of at once.
- New in PR #22 (low): the service worker's offline fallback fails on Vercel for URLs with a query string (the cached index.html is a 308 redirect).
- Server-side pre-operation and safety snapshots never expire, so radscheduler_backups will grow.
- Migration 5's scrub trigger parses the whole row on every save (more database CPU once the 2027 DR schedule makes the row ~3 MB).
