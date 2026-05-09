# RadScheduler Desktop Widget

A small always-on-top widget for macOS and Windows that shows each
physician's daily expected wRVU, scheduled shifts, drive-time credit,
and (later) PACS-fed real-time study count.

```
┌──────────────────────────────┐
│ ⚕ RadScheduler          ↻ 📌 │
├──────────────────────────────┤
│  ┌─┐  Dr. Smith              │
│  │S│  Tue, May 12 · On call  │
│  └─┘                          │
│                               │
│        ●●●●●●●○○○             │
│         42 / 65               │
│      studies / wRVU goal      │
│                               │
│  wRVU goal: 65   Drive: 4.2   │
│                               │
│  Today's shifts:              │
│   1st · CHE              30   │
│   IR daily call           28  │
│                               │
│  Refreshed 09:14   ⚠         │
└──────────────────────────────┘
```

## What it shows

Every 5 minutes it pulls the practice's shared state from Supabase
(read-only) and computes for the paired physician's day:

| Field | Source |
|---|---|
| **wRVU goal** | Per-shift `wRVUGoal` override → physician's `wRVUMultiplier` × `cfg.wRVUDefaults[shiftType]` → 0 |
| **Studies** | Placeholder `0` until the PACS plugin (see *Future work*) |
| **Drive-time credit** | `cfg.driveTimeWRVUPerHour × driveTimes[physId][site] / 60` |
| **Today's shifts** | DR/IR shifts, IR call, weekend call, holidays whose date matches today |

The widget is **read-only** — it never mutates state. Everything is
derived client-side from the practice JSON.

## Build

```bash
cd widget
npm install
npm run build:mac     # → dist/RadScheduler-Widget-1.0.0.dmg + .zip
npm run build:win     # → dist/RadScheduler-Widget Setup 1.0.0.exe
npm run build:all     # → both (only on platforms that can cross-compile)
```

`npm start` runs the widget in dev mode without packaging.

### Code signing

Distribution-quality builds need code signing. `electron-builder`
auto-detects certs from your environment:

- **macOS**: set `CSC_LINK` (path to a `.p12` file) and `CSC_KEY_PASSWORD`,
  plus `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` for
  notarization.
- **Windows**: set `CSC_LINK` to a `.pfx`/EV token + `CSC_KEY_PASSWORD`.

Without signing the apps still run, but users see "unidentified
developer" warnings on first launch.

### Icons

Drop a 512×512 (or larger) PNG at `build/icon.png` before building.
`electron-builder` will derive the platform-specific icon files
(`.icns`, `.ico`) automatically.

## Pair the widget to a physician

1. **Admin**: open RadScheduler → *Desktop Widget* → pick the physician → *Generate pairing code*.
2. **Admin**: copy or email the code to the physician.
3. **Physician**: launch the widget → paste the code → click *Pair widget*.

The code is base64-encoded JSON containing:
- Practice ID
- Physician ID
- Supabase URL + anon key (public-by-design; RLS gates real access)
- Issued-at timestamp
- Expiration timestamp (default 30 days)
- HMAC-SHA256 signature over the rest using the anon key as the
  shared secret (proves the code was issued by an admin who had
  access to the practice's Supabase config).

The widget validates the signature before trusting any field, then
persists the code via Electron's `safeStorage` (OS keychain on mac/win).
Re-pairing is one click in the tray menu.

## Architecture

```
widget/
├── package.json           electron + electron-builder config
├── src/
│   ├── main.js            Electron main: window + tray + IPC + safeStorage
│   ├── preload.js         narrow contextBridge (read pairing, save pairing, …)
│   ├── renderer.html      borderless 320×460 window UI
│   └── renderer.js        decode code, fetch Supabase, compute digest, render
└── build/
    ├── icon.png           your 512×512 app icon
    └── entitlements.mac.plist   network + JIT permissions for sandboxed mac builds
```

The renderer runs sandboxed with `contextIsolation` on; it has no Node
access. All persistence + shell hooks go through the preload bridge.

## Future work — PACS integration

The widget displays five PACS-derived metrics today as **stub zeros**:

| Field | Where shown |
|---|---|
| `studiesCompletedToday` | Today tab — ring numerator + status bar fill |
| `wRVUEarnedToday` | (reserved for future use; currently same as studies) |
| `debulkingToday` | Debulking tab — "Today" counter |
| `debulkingThisWeek` | Debulking tab — "Week" counter |
| `debulkingThisMonth` | Debulking tab — "Month" counter |

All five flow through a single function: **`fetchPACSStats(physId, dateISO)`** in `src/renderer.js`. Replace its body with a real fetch and the UI lights up automatically — both the status bar and the Debulking counters consume these fields.

Today's stub:

```js
async function fetchPACSStats(physId, dateISO){
  return {
    pacsConnected: false,           // when true the UI hides the "waiting" pill
    studiesCompletedToday: 0,
    wRVUEarnedToday: 0,
    debulkingToday: 0,
    debulkingThisWeek: 0,
    debulkingThisMonth: 0,
  };
}
```

What you need to replace it with:

```js
async function fetchPACSStats(physId, dateISO){
  const url = `http://localhost:7711/stats?physId=${physId}&date=${dateISO}`;
  const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PACS_TOKEN } });
  if(!resp.ok) throw new Error('PACS broker ' + resp.status);
  const j = await resp.json();
  return {
    pacsConnected: true,
    studiesCompletedToday: j.studies_today ?? 0,
    wRVUEarnedToday:       j.wrvu_today    ?? 0,
    debulkingToday:        j.debulk_today  ?? 0,
    debulkingThisWeek:     j.debulk_week   ?? 0,
    debulkingThisMonth:    j.debulk_month  ?? 0,
  };
}
```

### Two recommended PACS broker patterns

**1. Per-physician local broker** (recommended for distribution)

Each physician runs a small auth'd HTTP proxy on `localhost:7711` that
queries the PACS for "studies signed by user X today". The widget
hits `http://localhost:7711/stats?physId=X&date=Y`. Pros: no central
infra, each physician's PACS auth stays local. Cons: every physician
needs the broker installed.

**2. Practice-wide PACS proxy**

A central server in the radiology network exposes a single endpoint
keyed by physician ID; the widget passes the paired physician ID in
the request, with a shared bearer token. Pros: single deployment, easy
audit. Cons: needs hosting + a service account on PACS.

### CSP update before shipping

The current Content-Security-Policy in `src/renderer.html` allows only
`https://*.supabase.*`. Before wiring PACS, add your broker URL:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self';
  style-src 'self' 'unsafe-inline'; script-src 'self';
  connect-src https://*.supabase.co https://*.supabase.in https://*.supabase.net
              http://localhost:7711                 ← per-physician broker
              https://pacs-proxy.your-practice.org">  ← practice-wide proxy
```

### What `pacsConnected: true` does

When the PACS broker returns `pacsConnected: true`:

- The "Waiting for PACS" pill on the status bar disappears
- The status bar's color reflects pace (red/amber/green/gradient) based on actual progress
- The Debulking tab's counter cards show real numbers
- The Debulking tab's "PACS not connected" notice disappears

When `pacsConnected: false` (the default stub state):

- All counts show as 0
- A subtle "Waiting for PACS" pill explains why
- Eligibility checking still works (it's RadScheduler-driven, not PACS-driven)

## License

MIT — same as RadScheduler.
