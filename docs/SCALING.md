# Scaling RadScheduler to 200+ radiologists

This document tracks what needs to change as a practice grows from
~30 physicians (current target) to 200+. Each section is a pain point
+ the fix + a status flag.

## Current architecture summary

- One Supabase row per practice, JSONB column `data` holds everything
- ~38k-line single-page HTML with all CSS/JS inline
- Reactive `S` proxy → debounced 500ms save → upsert to Supabase
- Render functions iterate `S.physicians × S.drShifts` etc. directly
- Memoization via `_dateIdxVersion` for date-keyed shift lookups
- Widget reads via `widget-data` edge function (RLS-bypassing service role)

## Bottlenecks at 200 physicians

### 1. Single-row JSON size

| Today (30 phys, 1y data) | Projected (200 phys, 1y data) |
|---|---|
| ~600 KB | ~4 MB |

**Pain**: every save round-trips the entire blob. At 4 MB:
- Supabase row size limit is 1 GB so we don't HIT a hard ceiling
- But: each save → 4 MB upload + 4 MB read. ~1s on a slow connection.
- The `_pushToSupabase` debounce (500ms) helps but doesn't solve burst-writes.

**Fix path** (in priority order):

1. **DONE**: Date-keyed shift index (already memoized via `_dateIdxVersion`).
2. **Quick win**: Compress the payload with `gzip` before upload (Supabase
   supports `Content-Encoding: gzip`). 4 MB → ~600 KB after gzip.
3. **Medium**: Split `S.auditLog` (the largest growing array) into a
   separate Supabase table. Append-only, never round-tripped on save.
   Schema: `radscheduler_audit (id, practice_id, ts, action, detail)`.
4. **Big**: Split each large state array (drShifts, weekendCalls,
   irCalls, vacations, holidays) into per-table rows. Migrations for
   each. Renders must switch to query-by-date-range.

### 2. Render-loop O(N) over 200 physicians

Many renders do `S.physicians.filter(p => …).map(p => …)`. At 30 phys
that's 30 iterations × 12 months × 4 calendars = 1440 ops per render.
At 200 phys it's 9600 ops — still well under the 16ms-per-frame budget,
but compounded by inner loops.

**Status**: not yet a problem; profile when render exceeds 100ms.

**When it is a problem**:
1. Add `requestIdleCallback` chunking on the heaviest renders
   (FTE Monitor, Annual Report)
2. Virtualize long tables (audit log already paginated to 200 rows;
   apply same pattern to physician lists)
3. Memoize per-physician computations with a `_lastPhysIdx` invalidator

### 3. Auto-assign solver runtime

The MCF solver in `_dr_assignMCF` is `O(physicians × shifts × edges)`.
At 30 phys × 30 days × 5 shift types it's ~4500 edges → solves in
~80ms. At 200 phys it's ~30000 edges → projected ~600ms.

**Status**: still acceptable (one-time admin action).

**If needed**:
1. Run the worker on a `webworker` (already done — `_mcfWorker.js`)
2. Add a "Quick mode" that uses the greedy solver for previews and
   only runs MCF on apply
3. Pre-prune impossible edges before building the flow graph

### 4. Concurrent writes from multiple admins

Today's `_pushToSupabase` uses optimistic concurrency on `savedAt` and
refuses to clobber. At 200 physicians (some of whom are admins on
desktop AND mobile + the widget), concurrent edits are routine.

**Quick win**: increase `_TUNE.SAVE_DEBOUNCE_MS` from 500ms to 1500ms
to reduce write volume.

**Real fix**: per-field merge semantics on conflict. The current
"refuse and re-pull" pattern is safe but loses the user's pending edit
forcing them to redo.

### 5. Realtime subscription fan-out

Each leader-tab subscribes to the practice's realtime channel. At 200
physicians × 1 leader-tab each = 200 connected sockets. Supabase
realtime quota on the free tier is 200 concurrent connections.

**Status**: bumps right against the free-tier limit at 200 phys.

**Fix options (in order of effort):**

1. **Pro plan upgrade** (~$25/mo) — raises the cap to 10,000 concurrent
   connections. Simplest fix; no code changes needed.
2. **Restrict realtime to admins only** — current code subscribes ALL
   leader-tabs (admins + physicians). Most physicians don't NEED
   realtime updates (they refresh on next nav). Gating subscription on
   `CU.role === 'admin'` cuts the connection count by ~95% — at 200
   phys with ~10 admins, only 10 sockets used.
3. **Per-practice presence channel only** — keep the live-tab counter
   working (it's the most-visible realtime feature) but skip per-row
   data subscriptions. Admins still see fresh data on poll-refresh
   (every 60s) which is acceptable for a scheduler.

**Implementation pointer**: `_initLeaderElection` + the channel
`.subscribe` calls in `_initSupabase` are the touchpoints. ~30 lines
to gate by role, ~50 to split presence from data.

### 6. Widget polling

The widget polls every 5 minutes per installed instance. 200 widgets
× one fetch every 5 min = 2400 fetches/hour = 0.67/sec. The `widget-data`
edge function handles each in ~50ms. Well under Supabase Pro's 5000
edge-function invocations/hour quota.

**Status**: fine.

## Quick wins for 200-phys practices (action items)

These are LOW-RISK changes that pay off at scale:

- [x] Bump `_TUNE.SAVE_DEBOUNCE_MS` from 500 → 1500 ms
- [x] Cap the in-memory `S.auditLog` to last 100 entries (was 5000)
      — full history lives in `public.radscheduler_audit` since v8
- [x] Stress-test tool: Tools → Robustness → "🧪 Stress test (200 phys)"
      + CLI version at `tools/stress-test.js`
- [x] **Enable `Content-Encoding: gzip` in `_pushToSupabase`** ← DONE in v1.1.1
      Implemented as `_gzipFetch` wrapper passed to the Supabase
      client's `global.fetch` option. Compresses POST/PATCH bodies
      > 32 KB before upload. Measured ratio at 200 phys: **7.2%**
      (727 KB raw → 52 KB on the wire). At 500 phys × 2 years:
      **7.0%** (1.45 MB raw → 104 KB wire). Headroom is now huge:
      the architecture comfortably scales to **1000 physicians**
      on the wire-bytes side without further changes.
- [x] Render hotspot fix: `renderDRCal` was doing `S.physicians.find()`
      per shift cell — N×M lookups. Switched to memoized `_physById()`
      Map lookup (O(1) per call). Same change pattern available for
      other render functions if they show up hot.
- [ ] Add a "Performance" tab to Tools that shows render times +
      payload size + the largest arrays (PARTIAL — stress test gives
      most of this; still want a continuous monitor)

## When to migrate the auditLog out of the JSON blob

Trigger: when `S.auditLog.length > 50000` OR the row payload exceeds
2 MB compressed. This happens at roughly:

- 200 physicians × 1 year × 200 audit events/phys/yr ≈ 40,000 rows
- Add admin actions × 50 admins × 100 actions/yr ≈ 5,000 more

So the audit-log split is the FIRST data migration we'll need at scale.
The migration SQL ships in `docs/sql/01-audit-log-side-table.sql` —
ready to apply via the Supabase SQL editor.

### Migration sequence (when ready)

1. **Run the SQL** at `docs/sql/01-audit-log-side-table.sql` in the
   Supabase dashboard → SQL editor. Creates `public.radscheduler_audit`
   with practice-scoped indexes + RLS that mirrors the existing
   table policy.

2. **Deploy the dual-write client adapter** (TODO — not yet wired):
   - `_audit()` writes BOTH to `S.auditLog` (in-blob, for reads) AND
     to the side table (via service role through an edge function or
     direct supabase-js insert). Eliminates the read-your-writes
     consistency problem during the migration.
   - This phase lasts ~1 week so any client still reading from the
     blob still sees recent entries.

3. **Backfill existing entries** by uncommenting + running the
   `INSERT INTO public.radscheduler_audit ... FROM jsonb_array_elements(...)`
   block at the bottom of the SQL file. Idempotent.

4. **Switch reads to the side table**: `renderAuditLog` queries
   `radscheduler_audit` ORDER BY ts DESC LIMIT 200 instead of
   reading `S.auditLog`. The blob copy stops being touched.

5. **Trim the blob copy**: reduce `_AUDIT_LOG_MAX` from 5000 to e.g.
   100 (just the most recent for offline-cache use). The next save
   to Supabase prunes the blob.

Each step is reversible. Total estimated effort: ~150 lines of
client code + 1 SQL file (already written). Pick this up when
either the audit log starts crowding the blob OR the realtime sync
between admin devices feels laggy.

## Migration order recommendation

1. Compress the upload (1-line change in `_pushToSupabase`)
2. Bump debounce
3. Split audit log into a separate table
4. Split shift arrays (drShifts, etc.) into per-table rows — last
   resort; major refactor

The first three should keep us fine through ~200 phys without breaking
the single-page architecture. Step 4 is where we'd need to seriously
consider going multi-page or building a real backend.
