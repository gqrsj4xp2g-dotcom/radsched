# Installing & deploying the desktop widget

Step-by-step guide for first-time setup. Allow ~10 minutes for the very first build (Node download + 200MB of npm dependencies); subsequent builds take ~30 seconds.

---

## Build the widget on macOS

You only do this **once per release**. The output `.dmg` file is what you distribute to physicians.

```bash
cd ~/RadApp/widget
./build-mac.sh
```

That script:

1. Installs Node.js via Homebrew if you don't already have it
2. Runs `npm install` (one-time, ~2 min)
3. Generates a placeholder icon (replace `widget/build/icon.png` with your real 512×512 PNG before distribution)
4. Builds an unsigned `.dmg` and `.zip` into `widget/dist/`
5. Opens the dist folder in Finder

The output file you distribute is `widget/dist/RadScheduler-Widget-1.0.0.dmg` (or the `-arm64` variant for Apple Silicon).

### "I get an unidentified developer warning"

That's expected for unsigned builds. First-time launch instructions for physicians:

1. Right-click the app → **Open**
2. Click **Open** in the warning dialog
3. From now on, double-click works normally

To eliminate the warning entirely, see *Code signing* below.

---

## Build the widget on Windows

```cmd
cd C:\path\to\RadApp\widget
build-win.cmd
```

That script does the same thing as the mac script but produces `widget\dist\RadScheduler-Widget Setup 1.0.0.exe`.

**Prerequisite**: install Node.js LTS from https://nodejs.org/en/download (the script will tell you if it's missing).

### "SmartScreen says unrecognized app"

Same situation as macOS. First-time launch:

1. Click **More info** in the SmartScreen warning
2. Click **Run anyway**

To eliminate it, see *Code signing* below.

---

## Code signing (optional, for distribution-quality builds)

If you want installers that don't trigger OS warnings, you need code-signing certs:

### macOS

You need an **Apple Developer Program** membership ($99/year) and a **Developer ID Application** certificate exported as a `.p12` file. Then before building:

```bash
export CSC_LINK="/path/to/your/cert.p12"
export CSC_KEY_PASSWORD="your-cert-password"
export APPLE_ID="your@apple.id"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"  # generated at appleid.apple.com
export APPLE_TEAM_ID="XXXXXXXXXX"
./build-mac.sh
```

`electron-builder` will sign + notarize automatically.

### Windows

You need an **EV code-signing certificate** from Sectigo, DigiCert, or similar (~$300/year for organizations). It usually arrives as a `.pfx` file or on a hardware token. Then before building:

```cmd
set CSC_LINK=C:\path\to\cert.pfx
set CSC_KEY_PASSWORD=your-cert-password
build-win.cmd
```

For a hardware token (most EV certs), you'll need extra config — see https://www.electron.build/code-signing.

---

## Replace the placeholder icon

The build script generates a temporary gradient icon so the build succeeds. Replace it before distributing:

1. Create a 512×512 (or larger) PNG of your icon
2. Save as `widget/build/icon.png` (overwrite the placeholder)
3. Re-run `./build-mac.sh` or `build-win.cmd`

`electron-builder` will derive the platform-specific formats (`.icns` for macOS, `.ico` for Windows) automatically.

---

## Set wRVU goals before issuing widgets

Physicians won't see meaningful goals until you configure defaults:

1. Open RadScheduler in your browser
2. **Settings** → "📊 wRVU goals by shift type"
3. Punch in the wRVU expectation for each shift type your practice uses:
   - 1st shift (typical: 25–35)
   - 2nd shift (typical: 18–25)
   - 3rd shift (typical: 12–20)
   - Home, IR daily, IR weekend, Weekend Call, Holiday
4. Optionally set **Drive-time wRVU credit** if your practice gives drive-time productivity credit

For per-physician scaling (e.g., a 0.7 FTE physician should get 0.7× the goal), edit each physician's profile and set their **wRVU multiplier** (1.0 = standard).

For a per-shift override (e.g., one specific Tuesday is a half-day), edit that shift in the calendar and set its **wRVU goal** field directly.

The widget reads these values via the resolution chain:

```
shift.wRVUGoal  →  physician.wRVUMultiplier × cfg.wRVUDefaults[shiftType]  →  cfg.wRVUDefaults[shiftType]  →  0
```

---

## Issue your first pairing code

Once a physician installs the widget, they need a pairing code to link it to their RadScheduler profile.

1. Open RadScheduler (admin view) → sidebar **🖥 Desktop Widget**
2. Pick the physician from the dropdown
3. Set **Code valid for** (default 30 days)
4. Click **🔑 Generate pairing code**
5. The code appears as a long base64 string. Either:
   - Click **📋 Copy code** and paste into Slack / email manually
   - Click **📧 Email to physician** (opens your default mail app pre-filled)
6. The physician launches the widget, pastes the code into the input field, clicks **Pair widget**. The widget fetches their day's schedule and persists the code in their OS keychain.

If a physician resets their machine or the code expires, generate a new one — old codes stay in the *Active pairings* table for audit but the physician simply pastes the new one over.

To revoke a code (e.g., physician left the practice), use the **Revoke** button in the *Active pairings* table.

---

## Verify before distribution: dev-mode test

Before building the installer, you can run the widget in dev mode to confirm everything works:

```bash
cd widget
npm install      # if you haven't already
npm start
```

This launches the widget without packaging. Test the full flow:

1. Generate a pairing code in RadScheduler for any physician (use yourself if linked)
2. Paste into the dev widget's pairing screen
3. Verify the widget shows that physician's day
4. Click the refresh button (↻) → it should re-fetch and update

If it works, kill the dev session (`Cmd+Q` or close the window) and run `./build-mac.sh` for the production installer.

---

## What the widget does NOT do (yet)

- **PACS integration**: the `Studies` count is a placeholder until you wire up your PACS system. The README inside `widget/` documents two recommended patterns (per-physician local broker or practice-wide proxy).
- **Multi-day view**: the widget shows TODAY only. By design — it's a glanceable widget, not a calendar.
- **Mutations**: the widget is read-only. To swap, request time off, etc. physicians use the main RadScheduler app on their phone or laptop.
- **Cross-account viewing**: each pairing code links the widget to ONE physician. Admins who want to see everyone's day use the main app's *Today's Coverage* dashboard widget.
