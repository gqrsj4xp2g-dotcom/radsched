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

## Distribute the widget — recommended end-to-end flow

The cleanest physician onboarding takes 60 seconds and 3 clicks. Setup once on the admin side:

### Admin: one-time setup (~5 min)

1. **Build the widget locally** (you've already done this):
   ```bash
   cd ~/RadApp/widget && ./build-mac.sh
   ```
   Output: `widget/dist/RadScheduler Widget-1.0.0-arm64.dmg` (and Intel).
   Build the Windows installer on a Windows machine: `build-win.cmd`.

2. **Publish to GitHub Releases** so physicians can download from a stable URL:
   ```bash
   brew install gh           # one-time, if not installed
   gh auth login             # one-time, sign into GitHub
   ./publish-release.sh      # uploads dist/* to a new release
   ```
   The script prints the asset URLs. Copy them.

3. **Paste URLs into RadScheduler**:
   - Open RadScheduler → sidebar **🖥 Desktop Widget**
   - Top card "📦 Widget download URLs"
   - Paste the macOS URL and Windows URL → it auto-saves

You're done with setup. From here on, every install kit you send embeds these URLs.

### Admin: send install kit per physician (~30 sec each)

1. **🖥 Desktop Widget** page → "🚀 Send install kit" card
2. Pick physician, pick validity (default 30 days)
3. Click **🚀 Generate install kit**
4. Result panel shows:
   - 🍎 macOS download button + 🪟 Windows download button (auto-linked to your URLs)
   - The pairing code in a copyable box
   - **📧 Email install kit** button (mailto: pre-filled with everything)
5. Click **📧 Email install kit** → your mail client opens with a complete email containing OS-specific download links + step-by-step instructions + the pairing code
6. Send

### Physician: install + pair (~60 sec, 3 clicks)

The email they receive is self-contained. Their flow:

1. Click their OS-specific download link in the email → installer downloads
2. Install (drag .dmg to Applications, or run the .exe — first launch needs right-click → Open on macOS to bypass Gatekeeper)
3. **Copy the pairing code** from the email (one tap) → launch the widget
4. Widget detects the code on the clipboard → auto-pairs → done

No paste, no settings. The widget persists the code in the OS keychain so subsequent launches are instant.

### Re-pair / revoke

If a physician resets their machine, the code is gone — generate a new install kit and re-send. Old codes remain in the *Active pairings* table for audit; click **Revoke** to invalidate one (e.g., physician left the practice). The widget stops syncing on its next refresh.

---

## Older flow: manual pairing code only

If you don't want to host installer URLs (or you're testing in dev mode), use the **🔑 Pairing code only** button on the same page. It generates just the code without the install-kit panel; you hand it to the physician however you like, and they paste it into the widget's pairing screen manually.

---

## Auto-update (every release reaches every physician)

Once the widget is installed, it polls GitHub Releases every 6 hours (and once 30 seconds after launch) for newer published versions. When one is found, a banner appears at the top of the widget:

```
🚀 Update available: v1.0.2 (you have v1.0.1)    [⬇ Download (109 MB)] [Notes] [Later]
```

- **⬇ Download** opens the OS-appropriate `.dmg` or `.exe` in the system browser. The physician installs it the same way as the original (drag to Applications / run installer).
- **Notes** opens the GitHub Release page so they can see what changed.
- **Later** dismisses the banner for that specific version (it'll re-appear the next time you ship).

Physicians can also force a check anytime via the tray menu → **Check for updates…**.

### How to ship an update

For each new widget release:

1. Make your code changes in `widget/src/`
2. Bump the version in `widget/package.json`:
   ```jsonc
   { "version": "1.0.2" }   // was "1.0.1"
   ```
3. Rebuild + republish:
   ```bash
   cd ~/RadApp/widget
   ./build-mac.sh           # rebuilds dist/*.dmg
   # build-win.cmd on a Windows box if you ship Windows updates
   ./publish-release.sh     # uploads to GitHub Releases as widget-vX.Y.Z
   ```

Within 6 hours every physician's widget shows the update banner. If you want to push faster, ask them to use **Check for updates…** in the tray menu — fires the API request immediately.

### Why not "in-place" auto-update?

Electron supports full background download + auto-install via the `electron-updater` package, but it requires **code-signed builds** on macOS to satisfy Gatekeeper. We use the simpler "browser-download" pattern instead so:

- Unsigned builds work fine (typical for internal practice distribution)
- The physician sees the file size + can cancel mid-download
- One mechanism for both macOS and Windows

When you eventually obtain code-signing certs and want in-place updates, the swap is ~30 lines in `widget/src/main.js` (replace the `checkForUpdates()` body with `appUpdater.checkForUpdates()`).

### Configuring the update repo

The poll target is hardcoded at the top of `widget/src/main.js`:

```js
const UPDATE_REPO = 'gqrsj4xp2g-dotcom/radsched';
const UPDATE_TAG_PREFIX = 'widget-v';
```

Change those if you fork the repo or use a different tag scheme.

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
