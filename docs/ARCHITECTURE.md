# Architecture

A single HTML file is a constraint that forces good decisions. There is
no module graph to navigate, no build step to debug, no chunk splits to
fight. Everything is in one place, and one search ticks a question.

This document explains how that one place is organized.

---

## Overall shape

```
┌───────────────────────────────────────────────────┐
│              index.html (single file)             │
│ ┌───────────────────────────────────────────────┐ │
│ │ <head>                                        │ │
│ │   meta + CSP + manifest + favicon links       │ │
│ │   <style> design tokens, components, utils    │ │
│ │ </head>                                       │ │
│ │ <body>                                        │ │
│ │   <script src=cdnjs xlsx>                     │ │
│ │   <script src=jsdelivr supabase-js>           │ │
│ │   --- everything below is one inline script ---│ │
│ │   • State (S Proxy) + persistence manifest    │ │
│ │   • Save layer (Supabase + FS + GitHub)       │ │
│ │   • Realtime + leader election + poll fallback│ │
│ │   • Schema versioning + migrations            │ │
│ │   • Auth (login, hydrate from session)        │ │
│ │   • Domain logic (rules, solver, assigners)   │ │
│ │   • Render functions (renderDR, renderIR, ...)│ │
│ │   • Service worker registration               │ │
│ │ </body>                                       │ │
│ └───────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
   Supabase           Browser              Sibling
  (auth + DB +     (localStorage,         /sw.js +
   realtime +     IndexedDB, cache,    /manifest.webmanifest +
  edge funcs)      service worker)         /icons
```

---

## State

### The `S` object

A single Proxy-wrapped global. Every persisted field of the app is on
`S`. Mutations to `S` (or its arrays) trigger `triggerSave()` via the
Proxy `set` trap, which:

1. Sets `_hasUnsavedChanges = true`
2. Updates `S._lastLocalChange = Date.now()` (used by the stale-remote
   guard during remote applies)
3. Bumps `_dateIdxVersion` so the date-keyed shift index rebuilds
4. Pushes a snapshot to the undo ring (capped at 30 entries)
5. Schedules three independent debounced writes:
   - **Supabase** at 500ms
   - **File-System Access** (local file autosave) at 750ms
   - **GitHub Contents API** (deploy) at 3000ms

### Persistence manifest

The list of fields that round-trip is `_PERSISTED_KEYS`. Adding a new
field means adding an entry there — `_buildPersistedPayload()` and
`_applyRemoteData()` are both manifest-driven. Two side fields
(`users`, `savedAt`) are written directly, and a third
(`_schemaVersion`) is stamped on every push.

### Schema versioning

`_SCHEMA_VERSION` is the current shape number. Each push stamps it on the
payload. On every remote apply, `_runMigrations(d)` walks `_MIGRATIONS`
forward from `payload._schemaVersion` to the current. Migrations are
idempotent and forward-only; downgrades are not auto-handled.

### Core-arrays invariant

After every `_applyRemoteData()` ends, all 25 core arrays
(`physicians`, `sites`, `drShifts`, …) and 10 keyed-objects (`siteSlots`,
`driveTimes`, `cfg`, …) are normalized to `[]` / `{}` if missing or
wrong-typed. This lets the 200+ unguarded `.filter()` callsites stay
terse without exploding on a partial restore.

---

## Save layer

### Optimistic concurrency

Every push runs through `_pushToSupabase()`, which:

1. Captures `_baseRemoteSavedAt = S._remoteSavedAt`.
2. If our last successful push was > 30s ago, probes the remote
   `savedAt` first. If it differs from our baseline, abort the push,
   apply the remote, toast a conflict, re-arm a save in 1s.
3. Otherwise upserts the payload, stamps `S._remoteSavedAt = _stamp`.

### Save watchdog

`_saveWatchdog` force-clears `_isSaving` after 30s. Without it, a hung
fetch (captive portal, dead socket) would lock saves silently forever.

### JWT expiry recovery

A 401 / `PGRST301` / "jwt expired" message is detected and triggers an
explicit `supabase.auth.refreshSession()`. If that succeeds the queue
keeps moving; if it fails, the user is asked to re-sign-in instead of
the retry loop hammering Supabase.

### Stale-save banner

A red toolbar pill appears when `_hasUnsavedChanges` has been true for
> 5 min without a successful sync. Click it to force-retry.

### Daily backups

`_runDailyBackupIfDue()` reads the canonical state from Supabase, copies
it to `radscheduler_backups`, then **reads the backup row back** to
verify the write actually landed before marking the day "done" in
localStorage. A failed verify means tomorrow's run retries.

`restoreFromBackup(id)` pulls a backup, runs it through
`_validateRemotePayload`, shows a confirm-with-stats, then upserts.
The restored payload gets a fresh `savedAt` so peer devices on a poll
re-pull it.

---

## Realtime + leader election

Supabase Realtime delivers row updates over websocket. The 10s poll is a
fallback for missed events. Both are expensive when multiplied across
tabs.

### BroadcastChannel-based leader election

When the app is opened in multiple tabs of the same browser, only one —
the **leader** — runs the realtime subscription and the poll loop.
Followers receive remote updates via `BroadcastChannel.postMessage()`
forwarded by the leader.

- Election rule: oldest launch ms wins; random-id tiebreaker.
- Heartbeats every 3s; followers prune stale tabs at 8s.
- `pagehide` broadcasts `goodbye` so peers re-elect immediately.
- Falls back to per-tab subscription on browsers without
  BroadcastChannel — no regression.

`switchPractice` tears down the channel and re-inits, since the channel
name is keyed on `_ROW_ID`.

---

## Solver

Two modes, selectable in Settings:

### Greedy (default)

`_irsaSolveGreedy()` walks days in order, picking the eligible physician
with the lowest "score" (a combination of running shift count, fairness
delta, drive time, and rule pressure). Fast, predictable, slightly
sub-optimal at the boundaries.

### Min-cost-flow (`MCF`)

`_irsaSolveMCF()` builds a bipartite graph of (physician slots) →
(date-site pairs), prices each edge by score, and runs Bellman-Ford
successive-shortest-paths via `_mcfSolve()`. Optimal across the whole
window, slower (~1-3s for 6 months on 30 physicians).

Both go through the same eligibility gate (`_gatherManualRuleViolations`)
so a rule that blocks one blocks the other.

### Unfillable diagnostic

When a slot can't be filled, `_diagnoseSlotUnfillable()` walks every
IR-FTE physician through every gate and records the specific reasons
each was excluded. The result drives the "Unfillable Slots" tab so an
admin sees concrete reasons (vacation, site rule, quota exhausted) and
can intervene.

---

## Security <a id="security"></a>

### Trust boundary

- **Server-side (RLS)** is the source of truth for who can read/write
  what. Client checks (`_isAdminOrSU`, `_adminOnly`) are
  defense-in-depth.
- **Roles read from `app_metadata`** (admin-only managed) — never from
  `user_metadata` (user-editable through `auth.updateUser()`).

### Threat model

| Vector                              | Mitigation                                      |
|-------------------------------------|-------------------------------------------------|
| XSS via physician name / chat / etc.| `escHtml` on every interpolation; `pnameHtml` for HTML contexts; `textContent` for plain text |
| Self-promotion to admin             | Role read from `app_metadata` only; RLS uses same |
| Concurrent overwrite                | Optimistic-concurrency probe before push        |
| Save-loop hang                      | 30s watchdog clears `_isSaving`                 |
| JWT expiry mid-action               | Explicit `refreshSession()` then re-sign-in    |
| Self-lockout on physician delete    | Refused if linked admin would lose access       |
| Backup divergence                   | Verify-after-write before marking day done      |
| Cross-tab race                      | BroadcastChannel leader election                |
| `localStorage` quota exhausted      | Try/catch with explicit error message           |
| Service worker stale shell          | Bump `CACHE_VERSION` in `sw.js` to evict        |
| Embedded credentials                | Anon key only; RLS gates all writes             |

### Content-Security-Policy

A `<meta http-equiv="Content-Security-Policy">` in `<head>` narrows
sources:

- `script-src` to the existing CDNs + `unsafe-inline` (unavoidable in a
  single-file architecture).
- `connect-src` to `*.supabase.co`/`.in` (HTTPS + WSS),
  `maps.googleapis.com`, `api.github.com`, `raw.githubusercontent.com`.
- `worker-src` and `child-src` allow `blob:` (used by sw.js
  registration when the user generates and downloads the file).
- `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`.

`frame-ancestors` is set on the host (`X-Frame-Options: DENY` in
`_headers` and `vercel.json`) since meta-tag CSP cannot set it.

---

## Layout summary

| Range (lines)         | What lives there                                         |
|-----------------------|----------------------------------------------------------|
| 1 – 50                | DOCTYPE, head meta, CSP, manifest links                  |
| 50 – 380              | `<style>` — design tokens, components, utilities         |
| 380 – 3360            | `<body>` — page templates (one `<div class="page">` each)|
| 3360 – 28000+         | The single inline `<script>`                             |
| 28000 – end           | Closing tags                                              |

Within the script, broad regions:

- **3500 – 4500**: persistence manifest, error log, audit log, undo ring
- **4500 – 5000**: file-system autosave, GitHub deploy, build-save HTML
- **5000 – 6000**: auth (login, doLogin, refreshes, hydrate session)
- **6000 – 7000**: state init, _applyRemoteData, leader election, SW
- **7000 – 12000**: physician / vacation / site / config CRUD
- **12000 – 16000**: DR / IR / weekend / holiday / call assignment
- **16000 – 20000**: rules engine (site, sequence, conditions, natlang)
- **20000 – 24000**: calendar render, builders, auto-assigners
- **24000 – 26000**: rebalance, holiday auto-assign
- **26000 – 27000**: open shifts, swaps
- **27000 – end**: Supabase init, push/pull, save UI, settings render
