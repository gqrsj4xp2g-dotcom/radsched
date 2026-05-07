# RadScheduler

A radiology practice scheduler that runs as a single HTML file.

One page. One file. Real-time across devices, offline-capable, no build step.
Open `index.html` from any modern browser, sign in, schedule.

---

## What it does

- **Schedule DR + IR shifts** — daily, weekend, holiday call. Auto-assignment via greedy or min-cost-flow solver.
- **Manage physicians** — FTE, sub-specialty, site eligibility, custom rules, anchor sites, home/in-person preference.
- **Drive-time aware** — Google Maps round-trip times factor into auto-assignment so the closest physician fills the slot when fairness allows.
- **Live across devices** — Supabase Realtime keeps every laptop, phone, and iPad in sync. Multi-tab leader election ensures only one tab per browser holds the subscription.
- **Resilient** — daily backups with verify-after-write, optimistic concurrency, JWT-expiry recovery, schema-versioned migrations, stale-save warnings, undo/redo.
- **Offline-capable** — service worker caches the shell; the most recent state is readable without network.

---

## Quick start (operator)

1. **Fork this repo** (or clone and re-host).
2. **Create a Supabase project** at [supabase.com](https://supabase.com). From _Project Settings → API_, copy the **Project URL** and **anon public key**.
3. **Run the SQL setup** in the Supabase SQL editor — see [docs/DEPLOY.md](docs/DEPLOY.md) for the exact statements (tables, RLS policies, edge functions).
4. **Bake your credentials into `index.html`** — open it locally, log in once via the auth screen, click "Save & Connect" in Settings → Supabase. The app embeds the URL + anon key into the HTML on save.
5. **Deploy.** Drop the repo onto any static host:
   - **GitHub Pages**: push to `main`, enable Pages on the repo.
   - **Vercel / Netlify**: connect the repo; the included `vercel.json` / `_headers` are pre-configured.
   - **radsched.org / your-own-host**: copy `index.html` and `sw.js` to the same folder.
6. **First admin** — see [docs/DEPLOY.md](docs/DEPLOY.md#first-admin) for the bootstrap steps that promote your account to `role: admin` in JWT `app_metadata`.

---

## Quick start (developer)

```bash
git clone https://github.com/your-fork/radsched
cd radsched
# No build step — just open it.
open index.html
```

Edit `index.html`. The optional disk-watch autopush in `.git-autopush.sh` commits + pushes every change to GitHub on save (run via launchd; see [docs/DEPLOY.md](docs/DEPLOY.md#autopush)).

```bash
# Validate the inline JS parses cleanly:
python3 -c "
import re
html = open('index.html').read()
html = re.sub(r'<!--[\s\S]*?-->', '', html)
m = re.search(r'<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)</script>', html)
print(f'{len(m.group(1))} chars of inline JS')
" | osascript -l JavaScript - <<'JXA'
ObjC.import('Foundation');
const js = $.NSString.stringWithContentsOfFileEncodingError('/tmp/inline.js', 4, $());
new Function(js.js);
'PARSE OK';
JXA
```

---

## Repository layout

```
.
├── index.html               # The app — single file, all HTML/CSS/JS inline
├── sw.js                    # Service worker for offline shell caching
├── manifest.webmanifest     # PWA manifest (installable on iOS/Android/desktop)
├── 404.html                 # SPA fallback that redirects to /
├── robots.txt               # Tells search engines not to index private practice data
├── icons/                   # App icons (favicon, PWA, Apple touch)
├── docs/
│   ├── ARCHITECTURE.md      # State, persistence, solver, sync layer
│   ├── DEPLOY.md            # Hosting, Supabase setup, bootstrap admin
│   └── DESIGN.md            # Design philosophy & rationale
├── _headers                 # Netlify cache + security headers
├── vercel.json              # Vercel routing + headers
├── .github/workflows/
│   └── deploy.yml           # Auto-deploy to GitHub Pages on push
├── .git-autopush.sh         # macOS launchd-friendly disk-watch autopush
├── .gitignore
├── LICENSE                  # MIT
└── README.md                # this file
```

---

## Design

The product has one goal: a scheduler for a busy radiology practice should feel _calm_. Most of the day, you don't see the app doing anything — and that's the point. The interface gets out of the way.

A few principles, taken from the design tradition I admire:

- **Restraint over ornament.** Hairline dividers, generous whitespace, one accent color. Buttons that earn attention only when they need it.
- **Honest materials.** No fake glass, no skeuomorphism. Surfaces are flat with subtle shadows; type is the system stack so it inherits OS-grade rendering on every device.
- **Considered motion.** Every transition is 200ms with a single easing curve. Nothing bounces. Toasts slide in 4px from the right; cards fade in over 240ms.
- **Density that respects the work.** Schedules are dense by nature. The cells stay tight; the chrome around them stays loose. The eye moves to data, not borders.
- **Clarity at every scale.** Mobile drawer slides in cleanly, ESC closes it, body scroll locks. Touch targets are 40px minimum. Type scale steps by 1.125 from 11px caption to 15px body to 22px section title.

See [docs/DESIGN.md](docs/DESIGN.md) for the full rationale and the design tokens.

---

## Security

- **Supabase RLS** is the source of truth for who can read/write what. Client-side role checks are defense-in-depth.
- **Roles read from `app_metadata`** (admin-only managed) — never from `user_metadata` (user-editable). A user calling `supabase.auth.updateUser({data:{role:'admin'}})` cannot self-promote.
- **Content-Security-Policy** narrows script and connect sources to a known whitelist. `unsafe-inline` is currently required for the single-file architecture and is documented in the CSP comment.
- **XSS hardening** — every user-controlled field is escaped via `escHtml()` or rendered as `textContent`. Physician names, swap reasons, custom rule text, error messages, and chat content are all routed through the safe path.
- **Anon key is public-by-design** and embedded in the HTML. RLS gates every actual data operation.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security) for full threat model.

---

## Resilience

The scheduler is the operational backbone of a radiology practice. Losing a month of assignments is not an option. The robustness work that backs that promise:

- **Daily backups** to a dedicated `radscheduler_backups` table, with source validation and verify-after-write.
- **Restore UI** in Settings → Backups & Restore. Backups are listed by date with one-click restore (validated payload + confirm-with-stats before commit).
- **Optimistic concurrency** on save — we probe `savedAt` before pushing, refuse to clobber if a peer has written, and re-pull + re-arm.
- **Save watchdog** — if a push hangs (captive portal, dead socket), a 30 s timer force-clears the lock so the queue keeps moving.
- **JWT expiry** is detected and triggers an explicit `refreshSession()`; if refresh fails, the user is asked to sign back in instead of silently retrying forever.
- **Self-lockout guard** — removing a physician linked to admin accounts is refused with a list of affected admins.
- **Stale-save banner** — if unsaved changes have been pending > 5 min without a successful push, a red toolbar pill flags it.
- **Multi-tab leader election** — one tab per browser holds the realtime subscription; followers receive updates via BroadcastChannel.
- **Schema versioning** with forward-only migrations.
- **Deep-clone on remote apply** for `driveTimes` (object graph could otherwise share refs with future remote payloads).
- **Core-arrays invariant** — every `_applyRemoteData` ends with a normalization pass that guarantees core arrays are arrays and core objects are objects, so 200+ unguarded `.filter()` callsites can stay terse.

---

## License

MIT. See [LICENSE](LICENSE).
