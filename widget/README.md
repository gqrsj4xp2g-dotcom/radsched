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

The `studyCount` field is currently a placeholder (always 0). The
intended integration is a tiny local broker that talks to your PACS
(via DICOM C-FIND or the PACS vendor's REST API) and exposes a JSON
endpoint the widget polls. Two patterns are supported:

### 1. Per-physician local broker
Each physician runs a small auth'd HTTP proxy on `localhost:7711` that
queries the PACS for "studies signed by user X today". The widget
hits `http://localhost:7711/today` and merges the result into the
digest.

### 2. Practice-wide PACS proxy
A central server (in the radiology network) exposes a single endpoint
keyed by physician ID and the widget passes the paired physician ID
in the request. Auth via a shared bearer token stored alongside the
pairing code.

Both approaches need a CSP whitelist update in `renderer.html`; today
the policy allows only `https://*.supabase.*`. Add `http://localhost:*`
or your PACS proxy host before shipping.

`src/renderer.js#fetchPracticeData()` is the natural place to fan out
a second `fetch('/pacs/today/' + physId)` and merge the result into
the `digest` object. The dashboard already renders `digest.studyCount`
so the UI requires zero changes.

## License

MIT — same as RadScheduler.
