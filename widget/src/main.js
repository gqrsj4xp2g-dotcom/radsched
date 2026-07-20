/* RadScheduler Widget — Electron main process.
 *
 * Hosts a small always-on-top window that displays the current
 * physician's daily expected wRVU, scheduled shifts, study count,
 * and drive-time credit. The window is borderless, draggable, and
 * resizable; closing the window quits the app on Windows but only
 * hides on macOS (per platform convention) — quit via the tray menu.
 *
 * Auth flow: the renderer pastes a pairing code on first launch.
 * The code is verified server-side (HMAC-SHA256 with a private,
 * per-practice signing key) and persisted via
 * Electron's safeStorage (OS keychain on mac/Win). Subsequent
 * launches read the stored code and skip the pairing screen.
 */

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, safeStorage, shell, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;

// ─── Auto-update — GitHub Releases poll ──────────────────────────
// Every 6 hours (and once on launch), the widget queries the public
// GitHub Releases API for the most recent widget release. If the tag
// version is greater than this app's package.json version AND a
// platform-appropriate asset exists, the renderer is notified — it
// shows a non-modal banner with a "Download update" button that opens
// the asset URL in the system browser.
//
// We deliberately use a release-page notification instead of in-process
// installation. Production artifacts are signed/notarized by CI, and the OS
// plus the user retain control of download and installation.

// Check every 15 minutes, on focus, and shortly after launch so users are
// promptly notified when a signed release is available.
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
// The repo + tag prefix have to match what publish-release.sh uses.
const UPDATE_REPO = 'gqrsj4xp2g-dotcom/radsched';
const UPDATE_TAG_PREFIX = 'widget-v';

let _lastUpdateCheck = 0;

function _versionCmp(a, b){
  const pa = String(a||'').split('.').map(n => +n || 0);
  const pb = String(b||'').split('.').map(n => +n || 0);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++){
    const da = pa[i] || 0, db = pb[i] || 0;
    if(da !== db) return da - db;
  }
  return 0;
}

// Returns the asset object that matches this OS + arch from the latest
// release. Naming convention is whatever electron-builder produces:
//   • macOS arm64:  "RadScheduler Widget-1.0.1-arm64.dmg"
//   • macOS x64:    "RadScheduler Widget-1.0.1.dmg"
//   • Windows x64:  "RadScheduler Widget Setup 1.0.1.exe"
function _pickAssetForPlatform(assets){
  if(!Array.isArray(assets) || !assets.length) return null;
  const platform = process.platform;
  const arch = process.arch;
  if(platform === 'darwin'){
    // Prefer arch-matching .dmg; fall back to the first .dmg we find.
    const armish = assets.find(a => a.name.toLowerCase().includes('arm64') && a.name.toLowerCase().endsWith('.dmg'));
    if(arch === 'arm64' && armish) return armish;
    const intel = assets.find(a => /\.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
    if(arch !== 'arm64' && intel) return intel;
    return armish || intel || assets.find(a => /\.dmg$/i.test(a.name));
  }
  if(platform === 'win32'){
    return assets.find(a => /\.exe$/i.test(a.name));
  }
  // Linux / others: AppImage if present, otherwise nothing.
  return assets.find(a => /\.AppImage$/i.test(a.name));
}

// Parse an x.y.z version out of an electron-builder asset filename
// (e.g. "RadScheduler Widget-1.0.3-arm64.dmg" → "1.0.3").
function _parseVerFromName(name){
  const m = /(\d+\.\d+\.\d+)/.exec(String(name || ''));
  return m ? m[1] : null;
}

// Persistent guard against an auto-update RESTART LOOP. If a release is
// mis-published so its attached binary is NOT actually newer than what's
// installed (e.g. the tag says widget-v1.1.13 but a stale 1.0.3 dmg is
// attached — exactly the dist/ version skew this repo had), the tag-vs-running
// comparison "updates" forever: download → relaunch at the SAME version →
// re-detect the newer tag → download again. We remember the last target we
// offered and from which running version; if we keep being offered the same
// target while still stuck at the same version, we stop auto-updating.
let _loopGuardCountedThisRun = false;
function _updateStatePath(){ return path.join(app.getPath('userData'), 'rs-update-state.json'); }
function _readUpdateState(){
  try{ return JSON.parse(fs.readFileSync(_updateStatePath(), 'utf8')) || {}; }catch(_){ return {}; }
}
function _writeUpdateState(st){
  try{ fs.writeFileSync(_updateStatePath(), JSON.stringify(st || {})); }catch(_){}
}

async function checkForUpdates(opts){
  opts = opts || {};
  const interactive = !!opts.interactive;
  _lastUpdateCheck = Date.now();
  // Prevent rapid manual re-clicks from hammering the API; 10s cooldown.
  if(opts._fromInterval && Date.now() - (checkForUpdates._lastApiAt || 0) < 5000) return;
  checkForUpdates._lastApiAt = Date.now();
  return new Promise((resolve) => {
    const req = net.request({
      url: `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'RadScheduler-Widget' },
      redirect: 'follow',
    });
    let body = '';
    req.on('response', (resp) => {
      if(resp.statusCode === 404){
        // No releases yet — silently no-op unless the user clicked manually.
        if(interactive && mainWindow){
          mainWindow.webContents.send('rs:update-info', { kind:'no-release', currentVersion: app.getVersion() });
        }
        resolve(null); return;
      }
      if(resp.statusCode !== 200){
        if(interactive && mainWindow){
          mainWindow.webContents.send('rs:update-info', { kind:'error', detail: 'GitHub API returned ' + resp.statusCode });
        }
        resolve(null); return;
      }
      resp.on('data', (chunk) => body += chunk.toString());
      resp.on('end', () => {
        try{
          const release = JSON.parse(body);
          // Tag format: "widget-v1.0.1" → "1.0.1"
          const tag = release.tag_name || '';
          const m = new RegExp('^' + UPDATE_TAG_PREFIX.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&') + '?(\\d+\\.\\d+\\.\\d+)').exec(tag);
          const latestVer = m ? m[1] : null;
          const currentVer = app.getVersion();
          if(!latestVer){
            if(interactive && mainWindow){
              mainWindow.webContents.send('rs:update-info', { kind:'no-release', currentVersion: currentVer });
            }
            resolve(null); return;
          }
          if(_versionCmp(latestVer, currentVer) <= 0){
            // Already up to date.
            if(interactive && mainWindow){
              mainWindow.webContents.send('rs:update-info', { kind:'uptodate', currentVersion: currentVer });
            }
            resolve(null); return;
          }
          const asset = _pickAssetForPlatform(release.assets);
          if(!asset){
            if(interactive && mainWindow){
              mainWindow.webContents.send('rs:update-info', { kind:'no-asset', latestVersion: latestVer, releaseUrl: release.html_url });
            }
            resolve(null); return;
          }
          // ── Loop-breaker #1 (primary): the ASSET's own version must be newer
          // than what's installed. electron-builder always embeds the version
          // in the filename, so a mis-published release whose binary isn't
          // actually newer is caught here — we refuse to "update" into a loop.
          const assetVer = _parseVerFromName(asset.name);
          if(assetVer && _versionCmp(assetVer, currentVer) <= 0){
            console.warn('[update] suppressed: tag ' + latestVer + ' but asset "' + asset.name + '" (' + assetVer + ') is not newer than installed ' + currentVer);
            if(interactive && mainWindow){
              mainWindow.webContents.send('rs:update-info', { kind:'stale-asset', latestVersion: latestVer, assetVersion: assetVer, currentVersion: currentVer, releaseUrl: release.html_url });
            }
            resolve(null); return;
          }
          // ── Loop-breaker #2 (backstop, for assets with no parseable version):
          // if we keep being offered the same target while still stuck at the
          // same running version, a prior auto-update didn't advance us. Count
          // at most once per launch; stop after the second stuck cycle.
          const _st = _readUpdateState();
          if(_st.target === latestVer && _st.fromVer === currentVer){
            if(!_loopGuardCountedThisRun){ _st.attempts = (_st.attempts || 1) + 1; _loopGuardCountedThisRun = true; _writeUpdateState(_st); }
            if((_st.attempts || 1) >= 2){
              console.warn('[update] suppressed: update to ' + latestVer + ' from ' + currentVer + ' has not advanced after ' + _st.attempts + ' attempts');
              if(interactive && mainWindow){
                mainWindow.webContents.send('rs:update-info', { kind:'update-stuck', latestVersion: latestVer, currentVersion: currentVer, releaseUrl: release.html_url });
              }
              resolve(null); return;
            }
          } else if(!_loopGuardCountedThisRun){
            _writeUpdateState({ target: latestVer, fromVer: currentVer, attempts: 1 });
            _loopGuardCountedThisRun = true;
          }
          // Notify the renderer to show the update banner.
          if(mainWindow){
            mainWindow.webContents.send('rs:update-available', {
              currentVersion: currentVer,
              latestVersion: latestVer,
              downloadUrl: asset.browser_download_url,
              assetName: asset.name,
              assetSizeMB: Math.round((asset.size || 0) / 1024 / 1024),
              releaseUrl: `https://github.com/${UPDATE_REPO}/releases/tag/${encodeURIComponent(tag)}`,
              releaseNotes: (release.body || '').slice(0, 800),
            });
          }
          resolve(latestVer);
        } catch(e){
          console.warn('[update] parse failed:', e);
          if(interactive && mainWindow){
            mainWindow.webContents.send('rs:update-info', { kind:'error', detail: String(e.message || e) });
          }
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.warn('[update] request failed:', err);
      if(interactive && mainWindow){
        mainWindow.webContents.send('rs:update-info', { kind:'error', detail: String(err.message || err) });
      }
      resolve(null);
    });
    req.end();
  });
}

// ─── Pairing-code persistence ─────────────────────────────────────
// Pairing codes are bearer credentials and are encrypted at rest with
// Electron safeStorage (Keychain on macOS, DPAPI on Windows). Existing
// plaintext files are accepted once and immediately re-encrypted.
// Primary pairing store: Electron's user-data dir. Survives most
// updates, but on rare occasions macOS clears app data when an
// installer "replaces" a bundle, OR a productName change between
// builds points the new widget at a different userData dir.
const STORE_PATH = () => path.join(app.getPath('userData'), 'pairing.bin');

// Backup pairing store: ~/.radscheduler-widget-pairing — a stable
// path that does NOT depend on app.getName(), productName, or any
// bundle metadata. Survives every update path we know about:
//   • Manual drag-to-Applications replace
//   • Silent in-place .app swap (our update flow)
//   • macOS DMG installer replace
//   • Windows NSIS silent install + reinstall
//   • productName / appId changes between builds
//
// We dual-write the encrypted bytes on every savePairing(). On load, if
// STORE_PATH is missing or corrupt, we restore from the encrypted backup.
const os = require('os');
const BACKUP_STORE_PATH = () => path.join(os.homedir(), '.radscheduler-widget-pairing');

function _isPlainPairingText(s){
  // A valid pairing code is base64url-encoded JSON of >= ~150 chars.
  // Quick shape test: starts with an ASCII printable char, no NUL,
  // length within bounds. Saves us from invoking safeStorage every
  // boot just to see if we're already on plaintext.
  if(!s || typeof s !== 'string') return false;
  if(s.length < 80 || s.length > 8192) return false;
  if(s.indexOf('\0') !== -1) return false;
  return /^[A-Za-z0-9_\-+=\/]+$/.test(s.trim());
}

function _writePairingFile(p, codeStr){
  try{
    if(!safeStorage || !safeStorage.isEncryptionAvailable()){
      throw new Error('OS credential encryption is unavailable; refusing to persist bearer credential');
    }
    const encrypted = safeStorage.encryptString(String(codeStr || ''));
    fs.writeFileSync(p, encrypted, { mode: 0o600 });
    try{ fs.chmodSync(p, 0o600); }catch(_){}
    return true;
  }catch(e){ console.error('[pairing] write failed for', p, e.message); return false; }
}

function savePairing(codeStr){
  // Make sure the userData dir exists — first-launch on some platforms
  // may not have it yet.
  try{ fs.mkdirSync(path.dirname(STORE_PATH()), { recursive: true }); }catch(_){}
  const primaryOk = _writePairingFile(STORE_PATH(), codeStr);
  const backupOk  = _writePairingFile(BACKUP_STORE_PATH(), codeStr);
  if(!primaryOk && !backupOk){
    console.error('[pairing] BOTH primary and backup writes failed!');
  } else if(!primaryOk){
    console.warn('[pairing] primary write failed, backup OK — pairing will be restored on next launch');
  }
  return primaryOk || backupOk;
}

function _readPairingFromFile(p){
  // Returns the decrypted pairing code, or a legacy plaintext code that
  // loadPairing() will immediately migrate back to encrypted storage.
  try{
    if(!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if(safeStorage && safeStorage.isEncryptionAvailable()){
      try{
        const decrypted = safeStorage.decryptString(buf);
        if(decrypted && _isPlainPairingText(decrypted)){
          return decrypted;
        }
      }catch(e){
        console.warn('[pairing] safeStorage decrypt failed for', p, ':', e.message);
      }
    }
    // One-time compatibility for versions that wrote plaintext with 0600.
    const asText = buf.toString('utf8');
    if(_isPlainPairingText(asText)) console.warn('[pairing] migrating legacy plaintext credential to safeStorage');
    return _isPlainPairingText(asText.trim()) ? asText.trim() : null;
  }catch(e){
    console.error('[pairing] read failed for', p, ':', e.message);
    return null;
  }
}

function loadPairing(){
  // Try the primary store first.
  let code = _readPairingFromFile(STORE_PATH());
  if(code){
    // Always rewrite both copies. This migrates plaintext and refreshes a
    // missing/stale backup without retaining readable bearer credentials.
    _writePairingFile(STORE_PATH(), code);
    _writePairingFile(BACKUP_STORE_PATH(), code);
    return code;
  }
  // Primary missing or corrupt — restore from backup (the update
  // recovery path).
  code = _readPairingFromFile(BACKUP_STORE_PATH());
  if(code){
    console.log('[pairing] primary missing — restored from backup at ' + BACKUP_STORE_PATH());
    // Re-populate the primary so subsequent loads use the fast path.
    try{ fs.mkdirSync(path.dirname(STORE_PATH()), { recursive: true }); }catch(_){}
    _writePairingFile(STORE_PATH(), code);
    return code;
  }
  return null;
}

function clearPairing(){
  // Clear BOTH stores. Re-pair regenerates them on save.
  for(const p of [STORE_PATH(), BACKUP_STORE_PATH()]){
    try{ if(fs.existsSync(p)) fs.unlinkSync(p); }
    catch(e){ console.error('[pairing] clear failed for', p, ':', e.message); }
  }
}

// ─── Window management ────────────────────────────────────────────
function createWindow(){
  mainWindow = new BrowserWindow({
    width: 340,
    height: 560,
    minWidth: 300,
    minHeight: 440,
    maxWidth: 520,
    title: 'RadScheduler',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    frame: false,            // borderless
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const localPage = new URL('file://' + path.join(__dirname, 'renderer.html')).href;
    if(targetUrl !== localPage) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray(){
  // Tray icon. If the asset is missing (dev mode pre-build), fall back
  // to the system menu without an icon so the app is still controllable.
  let icon;
  try{
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  } catch(_){ icon = nativeImage.createEmpty(); }
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show widget', click: () => { if(mainWindow) mainWindow.show(); else createWindow(); } },
    { label: 'Re-pair…', click: () => { clearPairing(); if(mainWindow){ mainWindow.webContents.send('rs:reset-pairing'); mainWindow.show(); } } },
    { label: 'Pairing storage info…', click: () => {
        // Diagnostic for "the widget keeps asking for the code" reports.
        // Shows a system dialog with both storage paths, exists flags,
        // sizes, and the decoded practice/physician (if any).
        const { dialog } = require('electron');
        let info = '';
        for(const [label, p] of [['PRIMARY', STORE_PATH()], ['BACKUP ', BACKUP_STORE_PATH()]]){
          info += label + ': ' + p + '\n';
          try{
            if(!fs.existsSync(p)){
              info += '  not found\n';
            } else {
              const st = fs.statSync(p);
              info += '  size ' + st.size + ' bytes · modified ' + st.mtime.toISOString() + ' · mode ' + (st.mode & 0o777).toString(8) + '\n';
            }
          }catch(e){ info += '  inspection error: ' + e.message + '\n'; }
        }
        info += '\n';
        const code = loadPairing();
        if(!code){
          info += 'STATUS: NO PAIRING — both stores empty or unreadable.\n';
          info += 'Re-pair from the main window to fix.';
        } else {
          info += 'Code length: ' + code.length + ' chars\n';
          try{
            const padded = code.replace(/-/g,'+').replace(/_/g,'/');
            let p64 = padded; while(p64.length % 4) p64 += '=';
            const decoded = JSON.parse(Buffer.from(p64, 'base64').toString('utf8'));
            info += 'Practice: ' + (decoded.practiceId || '?') + '\n';
            info += 'Physician: ' + (decoded.physFirst || '') + ' ' + (decoded.physLast || '') + ' (id ' + decoded.physId + ')\n';
            info += 'Issued: ' + (decoded.issuedAt || '?') + '\n';
            info += 'Expires: ' + (decoded.exp || 'never') + '\n';
            if(decoded.exp && new Date(decoded.exp).getTime() < Date.now()){
              info += '\n⚠ THIS PAIRING IS EXPIRED — request a fresh code from your admin.';
            } else {
              info += '\nSTATUS: ✓ PAIRING IS VALID — the widget should auto-load on launch.';
            }
          }catch(e){
            info += '\nDECODE FAILED: ' + e.message + '\nThe code is present but not parseable. Re-pair to fix.';
          }
        }
        dialog.showMessageBox(mainWindow, {
          type: 'info', title: 'Pairing storage', message: 'Pairing storage status', detail: info, buttons: ['OK'],
        });
      } },
    { type: 'separator' },
    { label: 'Check for updates…', click: () => { if(mainWindow) mainWindow.show(); checkForUpdates({ interactive: true }); } },
    { label: 'About RadScheduler Widget', click: () => shell.openExternal('https://github.com/gqrsj4xp2g-dotcom/radsched') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip('RadScheduler Widget');
  tray.on('click', () => { if(mainWindow){ mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show(); } else createWindow(); });
}

// ─── IPC handlers ────────────────────────────────────────────────
ipcMain.handle('rs:get-pairing', () => loadPairing());
ipcMain.handle('rs:save-pairing', (_, code) => savePairing(code));
ipcMain.handle('rs:clear-pairing', () => { clearPairing(); return true; });
ipcMain.handle('rs:open-external', (_, url) => {
  // The widget only needs to open this project's release/repository pages.
  // Keep the bridge host-scoped so a renderer bug cannot launch arbitrary
  // websites, custom URL schemes, or local files.
  let parsed;
  try{ parsed = new URL(String(url || '')); }catch(_){ parsed = null; }
  const allowed = parsed && parsed.protocol === 'https:' && parsed.hostname === 'github.com'
    && (parsed.pathname === `/${UPDATE_REPO}` || parsed.pathname.startsWith(`/${UPDATE_REPO}/`));
  if(!allowed){
    console.warn('[security] refusing unapproved external URL:', url);
    return false;
  }
  shell.openExternal(parsed.toString());
  return true;
});
// Read the OS clipboard for the auto-pair flow on first launch.
ipcMain.handle('rs:read-clipboard', () => {
  try{ return clipboard.readText(); } catch(_){ return ''; }
});
ipcMain.handle('rs:set-always-on-top', (_, on) => {
  if(mainWindow) mainWindow.setAlwaysOnTop(!!on);
  return !!on;
});
// Renderer-triggered manual update check (from the "Check now" link
// inside the update banner).
ipcMain.handle('rs:check-updates', () => checkForUpdates({ interactive: true }));
// Returns the running app's version so the renderer can display
// "v1.0.1 → v1.0.2" deltas.
ipcMain.handle('rs:get-version', () => app.getVersion());

// ─── App lifecycle ───────────────────────────────────────────────
// Single-instance lock so a second launch focuses the existing window
// instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  app.quit();
} else {
  app.on('second-instance', () => {
    if(mainWindow){ if(mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    createTray();
    app.on('activate', () => {
      if(BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    // Schedule update checks. First check fires 30s after launch so
    // the dashboard has time to settle; then every 15 min. We also
    // re-check whenever the window regains focus — most widgets sit in
    // the background for hours, so "user just looked at it" is a great
    // signal to verify they're current. The renderer keeps a visible
    // release-page notification until the user chooses to update.
    setTimeout(() => { checkForUpdates({ _fromInterval: true }); }, 30 * 1000);
    setInterval(() => { checkForUpdates({ _fromInterval: true }); }, UPDATE_CHECK_INTERVAL_MS);
    if(mainWindow){
      mainWindow.on('focus', () => {
        // Throttle: don't check more than once a minute even on rapid focus.
        if(Date.now() - _lastUpdateCheck < 60 * 1000) return;
        checkForUpdates({ _fromInterval: true });
      });
    }
  });
  app.on('window-all-closed', () => {
    if(process.platform !== 'darwin') app.quit();
  });
}
