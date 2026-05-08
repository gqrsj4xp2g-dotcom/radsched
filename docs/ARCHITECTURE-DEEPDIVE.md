# RadScheduler — Architecture deep-dive

> Audience: engineers + IT staff who need to modify, deploy, or operate
> RadScheduler. This is the long-form companion to `ARCHITECTURE.md`
> (which is the 5-minute summary). Read this when something needs to be
> changed and you want to know what else it affects.

---

## 1. Single-file deployment, on purpose

The entire client lives in `index.html`. CSS and JavaScript are inlined
into `<style>` and `<script>` blocks, not loaded from external bundles.
Why:

1. **One artifact**. CDN cache invalidation is a single etag flip. No
   stale-bundle / stale-shell mismatch failure modes.
2. **Hosting agnostic**. The file works on GitHub Pages, Netlify,
   Vercel, S3 + CloudFront, an intranet share, or `file://` for local
   debugging. No build step is required to run it.
3. **Auditability**. Hospital IT teams can read the full client by
   opening one file in any text editor. There is no minified bundle
   hiding behavior.
4. **Atomic deploy**. `git push` of `index.html` is the whole release.
   Rollback is `git revert` of one commit.

Trade-off: the file is large (~1.9 MB). The service worker
(`sw.js`) caches it after first load, and the inline `<style>` /
`<script>` reduces the round-trip count to one.

---

## 2. The script is one ordered block

The `<script>` tag near the bottom of `index.html` contains the entire
client runtime as a single block of top-level statements (no IIFE
wrapper, no module system). Functions are hoisted by the parser, so
declaration order is mostly invisible at call time — but the
**initialization order matters**:

```
1. Global error handler           (catches errors during the rest of init)
2. Persistence: Supabase client   (creates `supabase` global)
3. Schema versioning + migrations (runs on first state load)
4. Reactive Proxy (S)             (everything below mutates S)
5. Render functions               (read S, write to DOM)
6. Top-level boot                 (calls the first renderXxx)
7. Diagnostic wrappers            (installed last; need globals defined)
```

There is a module table-of-contents at the top of the script tag with
line numbers and section dependencies. When you add a new section,
update the TOC and pick a number that fits the dependency order.

---

## 3. Reactive state via Proxy

```js
const _Sraw = { physicians: [], drShifts: [], … };
const S = new Proxy(_Sraw, {
  set(t, k, v) {
    t[k] = v;
    triggerSave();
    return true;
  },
});
```

Every direct property write on `S` schedules a debounced save through
`triggerSave()`. The save pushes the persisted slice to the active
Supabase row. Reads pass through unchanged.

**Bulk operations**: when you mutate nested arrays (`S.physicians.push(...)`),
the Proxy's `set` trap doesn't fire because the mutation is on the
inner array. Either reassign (`S.physicians = […S.physicians, p]`) or
call `triggerSave()` explicitly at the end of the block. The codebase
uses both patterns; reassignment is cleaner but slower for big arrays.

**Memoization**: `_dateIdxVersion` is an integer that gets incremented
whenever the dated lists change. Hot per-(physId, ym) counters cache
their last result keyed on `_dateIdxVersion`; if the version is the
same on the next call, the cached value is returned. This is a
~20× speedup on the FTE monitor and large schedule renders.

---

## 4. Persistence: shared row, optimistic concurrency

The full persistent state is one row in Supabase, keyed by `_ROW_ID`
(the practice ID). Every save is:

1. Read `state` field of current row → `serverState`.
2. Compare `serverState.savedAt` to our `lastFetchedSavedAt`.
3. If different, the server changed since we read it: refresh and
   prompt "another tab edited; reload?".
4. Otherwise, set `serverState.savedAt = Date.now()` and write back.

This is **optimistic concurrency** — no locks, no transactions, just a
probe. It works because the practice has a small number of admins and
collisions are rare.

**Realtime fanout**: Supabase Realtime broadcasts row updates to all
connected clients. The non-leader tabs receive the broadcast and
re-render without making their own request. The leader tab is the
only one that initiates auto-saves; followers buffer their writes and
flush through the leader via BroadcastChannel.

---

## 5. Multi-tab leader election

A `BroadcastChannel('rs-leader')` lets tabs coordinate:

```
on tab open:
  send "claim?" → if no response in 200ms, become leader
  else listen for leader's "ack"
on leader close (visibilitychange + beforeunload):
  send "release" → next tab claims
```

The leader subscribes to Supabase Realtime; followers do not. This
prevents N tabs from each opening their own websocket and burning
through the project's concurrent-connection quota.

When the leader gets a Supabase row update, it broadcasts the new
state on the same channel. Followers replace their `S._raw` with the
broadcast snapshot and re-render. Followers' own writes go through
`postMessage('rs-write', payload)` to the leader, which performs the
optimistic-concurrency push.

---

## 6. Auto-assigner: min-cost-flow in a Web Worker

The DR / IR auto-assigners express a scheduling period as a min-cost
flow problem:

```
source → physicians  (capacity = FTE-derived target)
physicians → slots   (cost = penalty for that pairing)
slots → sink         (capacity = 1 per slot)
```

Run successive shortest-paths (Bellman-Ford) until no augmenting
flow remains; the resulting flow is the assignment. Penalties encode
soft preferences (sub-specialty match, recency, drive time, vacation
proximity). Hard exclusions (vacations, conflicts, post-call recovery)
are encoded as forbidden edges.

**Why a worker**: a 30-day period with 12 physicians × 5 sites × 3
shifts is ~5400 nodes. Bellman-Ford on that takes 200–800ms — long
enough to freeze the UI. The worker is constructed from a Blob URL so
no separate JS file ships.

---

## 7. Edge functions: Deno on Supabase

`edge-functions/send-notification/index.ts` is the only edge function.
It serves five `kind`s (email/sms/push/webhook/digest-run) because they
share auth + rate limiting. Each `kind` has its own handler block.

Auth model: every request requires `Authorization: Bearer <Supabase
JWT>`. The function calls `supabase.auth.getUser(jwt)` and rejects
401 if the token is invalid or expired. Without this, the function
URL would be an open relay for anyone with the API URL.

Secrets are managed via `supabase secrets set` — they're scoped to the
project and never appear in the source. The deploy README lists every
secret the function expects.

---

## 8. Service worker

`sw.js` does two things:

1. **App-shell caching** — stale-while-revalidate for same-origin GETs.
   Live data (Supabase API, websockets, Maps) bypasses the cache.
   `CACHE_VERSION` is bumped when `index.html` changes; old shells are
   evicted on the next `activate` event.
2. **Push notification handling** — receives the browser's `push`
   event, parses the JSON payload (`{title, body, url, tag}`), and
   surfaces a native `showNotification`. `notificationclick` routes
   to either the focused tab or a new window.

VAPID keys: server-side push requires a key pair. Generate via
`npx web-push generate-vapid-keys`, set the public key as both an
edge function secret AND in `S.cfg.vapidPublicKey` (Settings →
Practice → Push notifications). The private key never leaves the
server.

---

## 9. Excel pick-sheet parser

`_parsePickWorkbook(rows, prevEl, sheetName)` walks the rows of a
SheetJS-extracted matrix and classifies each cell:

```
"2nd shift - LastName"       → 2nd shift assignment
"3rd shift - LastName"       → 3rd shift assignment
"Off - LastName"             → vacation
"LastName - BB1"             → BB pick
"LastName - 5"               → vacation pick (week #5)
```

Header row is the Sunday of a 9-day Sat-to-Sun block. The parser walks
back one day to get Saturday; the block ends 8 days after the header
(next Sunday). This convention is set by the practice and matches how
the office laminates the schedule.

Fuzzy physician matching uses Levenshtein distance with a 0.7
similarity threshold. Below 0.85 is "low confidence" and shows a
manual mapping panel before commit. Below 0.7 is "unmatched" and
must be mapped manually before import.

**Dedup vs. replace**: importing the same file twice would re-add
every record without dedup. The parser dedups against existing
records by (physId, start) for vacations and (physId, date, shift)
for shifts. If the dedup skips everything, the UI offers a "Replace
existing imports" flow that purges every record with `notes`
matching `^Imported:` and re-runs the parse.

---

## 10. The audit log + error log + undo ring

Three ring buffers all live in `S`:

| Ring | Capacity | Persists | Purpose |
|------|----------|----------|---------|
| `S.auditLog` | 500 | Yes | Every admin mutation |
| `_errorLog`  | 100 | No  | Uncaught errors + warnings |
| `_undoStack` | 30  | No  | Undo destructive ops |

The audit log is **the** support tool. Filter by action prefix
(`drShift`, `swap`, `irRebalance`, `import`, etc.) and click a row to
expand the JSON detail. CSV export goes to the analyst.

The error log feeds the bug-report email — Tools → Error log → Export.

The undo ring is per-tab, so it's not affected by Realtime updates
from other tabs. It only covers single-shot destructive operations
(delete a shift, remove a physician, etc.). For multi-step undo see
§54 in the script.

---

## 11. Where to add a new feature

| Type | Location |
|------|----------|
| New page | Add `<div id="page-X">` block in HTML; add `nav('X')` route in §33 |
| New tool/utility | §31 Tools page renderer + section card in HTML |
| Edge-function delivery channel | New `kind` handler in `send-notification/index.ts` |
| New AI tool | `TOOLS` array in §22; matching execution branch |
| New import format | New parser block alongside §61 |

Update the module TOC at the top of the script when you add a section.

---

## 12. What lives outside `index.html`

```
edge-functions/send-notification/index.ts   Server-side delivery
sw.js                                        Service worker (offline + push)
manifest.webmanifest                         PWA install metadata
icons/                                       App icons (192, 512, favicon)
404.html                                     Static 404 (e.g. for GitHub Pages)
.github/workflows/deploy.yml                 CI/CD (if used)
.git-autopush.sh                             Local disk-watch autopush
_headers                                     Netlify cache headers
vercel.json                                  Vercel rewrite + caching
docs/*.md                                    Long-form documentation
```

Everything else is generated at runtime or persisted to Supabase.
