/* RadScheduler Widget — Electron main process.
 *
 * Hosts a small always-on-top window that displays the current
 * physician's daily expected wRVU, scheduled shifts, study count,
 * and drive-time credit. The window is borderless, draggable, and
 * resizable; closing the window quits the app on Windows but only
 * hides on macOS (per platform convention) — quit via the tray menu.
 *
 * Auth flow: the renderer pastes a pairing code on first launch.
 * The code is verified (HMAC-SHA256 over the payload using the
 * Supabase anon key as the shared secret) and persisted via
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
// We deliberately use the "open the download in the browser" pattern
// instead of in-process auto-installation:
//   • Works for unsigned + ad-hoc-signed builds (no Squirrel.Mac
//     code-signing requirement)
//   • The user remains in control (sees the file size, can cancel)
//   • One mechanism for both macOS + Windows
// When you eventually code-sign for production distribution, switching
// to electron-updater for in-place auto-install is a 30-line change
// — wrap this and call appUpdater.checkForUpdates() instead.

// Aggressive update polling — was 6h, now 15min plus on-focus +
// on-launch. Combined with the sticky banner + auto-download in the
// renderer, this means a new release rolls out to every active widget
// within ~15 min of the GH tag landing (modulo the user accepting the
// "Open installer?" macOS / Windows prompt).
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
          // Notify the renderer to show the update banner.
          if(mainWindow){
            mainWindow.webContents.send('rs:update-available', {
              currentVersion: currentVer,
              latestVersion: latestVer,
              downloadUrl: asset.browser_download_url,
              assetName: asset.name,
              assetSizeMB: Math.round((asset.size || 0) / 1024 / 1024),
              releaseUrl: release.html_url,
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
// As of v1.0.3 we store the pairing code as a plain text file with
// 0600 permissions (only the current user can read it). Previously
// we used Electron's safeStorage which encrypts via macOS Keychain
// — but since we ad-hoc sign our builds (no Apple Developer ID),
// every release has a different code signature and macOS prompts
// for the Keychain password on each install.
//
// Threat-model note: the pairing code contains the practice's
// Supabase anon key (which is PUBLIC by design — RLS gates access)
// + an HMAC-signed payload identifying the physician. An attacker
// with filesystem access on the user's Mac could read the pairing
// and view that physician's read-only schedule, but they could
// equally just install the widget themselves and request a fresh
// pairing — the encryption-at-rest provided marginal security.
//
// Migration: on first run after upgrading from a safeStorage build
// (1.0.0–1.0.2), we'll see an encrypted file. Try a single
// safeStorage decrypt (one final Keychain prompt for upgraders);
// on success, immediately rewrite as plain text. From then on,
// no more Keychain access.
const STORE_PATH = () => path.join(app.getPath('userData'), 'pairing.bin');

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

function savePairing(codeStr){
  try{
    fs.writeFileSync(STORE_PATH(), codeStr, { encoding: 'utf8', mode: 0o600 });
    // chmod again in case the file already existed with broader perms.
    try{ fs.chmodSync(STORE_PATH(), 0o600); } catch(_){}
  } catch(e){ console.error('savePairing failed:', e); }
}

function loadPairing(){
  try{
    if(!fs.existsSync(STORE_PATH())) return null;
    const buf = fs.readFileSync(STORE_PATH());
    // Try plaintext first — the common case post-1.0.3.
    const asText = buf.toString('utf8');
    if(_isPlainPairingText(asText)) return asText.trim();
    // Otherwise the file is encrypted (legacy 1.0.0–1.0.2 install).
    // Decrypt once via safeStorage (this triggers one Keychain
    // prompt), then rewrite the file as plaintext so the next launch
    // never asks again.
    if(safeStorage.isEncryptionAvailable()){
      try{
        const decrypted = safeStorage.decryptString(buf);
        if(decrypted){
          console.log('[pairing] migrating encrypted file → plaintext (one-time)');
          savePairing(decrypted);
          return decrypted;
        }
      } catch(e){
        console.warn('[pairing] safeStorage decrypt failed:', e.message);
      }
    }
    // Last-ditch: maybe the file IS plaintext but in a different
    // encoding. Trust it.
    return asText;
  } catch(e){ console.error('loadPairing failed:', e); return null; }
}

function clearPairing(){
  try{ if(fs.existsSync(STORE_PATH())) fs.unlinkSync(STORE_PATH()); }
  catch(e){ console.error('clearPairing failed:', e); }
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
        // Shows a system dialog with the file path, exists flag, size,
        // mtime, and the decoded practice/physician (if any). Helps
        // distinguish "file not written" from "load logic broken" from
        // "file fine but signature mismatched" without devtools.
        const { dialog } = require('electron');
        const p = STORE_PATH();
        let info = 'Path: ' + p + '\n\n';
        try{
          if(!fs.existsSync(p)){
            info += 'STATUS: NOT FOUND — the widget has nothing stored yet.\nIf you JUST paired and quit, that means savePairing failed silently. Check console with View → Toggle Developer Tools.';
          } else {
            const st = fs.statSync(p);
            info += 'Exists: yes\nSize: ' + st.size + ' bytes\nLast modified: ' + st.mtime.toISOString() + '\nPermissions: ' + (st.mode & 0o777).toString(8) + '\n\n';
            const code = loadPairing();
            if(!code){
              info += 'STATUS: LOAD RETURNED EMPTY — the file exists but loadPairing() returned null. Check the format / regex.';
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
                  info += '\nSTATUS: ✓ PAIRING IS VALID — the widget should auto-load on launch. If it asks for the code again, check the dev console for errors.';
                }
              }catch(e){
                info += '\nDECODE FAILED: ' + e.message + '\nThe file is present but not parseable. Re-pair to fix.';
              }
            }
          }
        }catch(e){
          info += 'INSPECTION ERROR: ' + e.message;
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
ipcMain.handle('rs:save-pairing', (_, code) => { savePairing(code); return true; });
ipcMain.handle('rs:clear-pairing', () => { clearPairing(); return true; });
ipcMain.handle('rs:open-external', (_, url) => shell.openExternal(url));
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

// ─── Auto-download + open installer ────────────────────────────────
// "Aggressive update" path: instead of opening the GitHub release in
// the browser and asking the user to download + drag-to-Applications,
// we download the asset to a temp dir then `shell.openPath()` to
// launch the installer (DMG mounts on macOS, exe runs setup on
// Windows). The user only has to confirm the OS-level installer
// prompt and the new binary takes over.
//
// We send progress back to the renderer so the banner shows a
// determinate progress bar instead of a spinner.
ipcMain.handle('rs:download-and-install', async (_evt, { url, name }) => {
  if(!url || !name){ return { ok:false, error:'missing url or name' }; }
  const downloadsDir = app.getPath('downloads');
  const target = path.join(downloadsDir, name);
  return new Promise((resolve) => {
    try{
      const file = fs.createWriteStream(target);
      const req = net.request({ url, redirect: 'follow' });
      let total = 0, received = 0;
      req.on('response', (resp) => {
        if(resp.statusCode !== 200){
          file.close();
          try{ fs.unlinkSync(target); }catch(_){}
          resolve({ ok:false, error: 'HTTP ' + resp.statusCode });
          return;
        }
        total = +(resp.headers['content-length'] || 0);
        resp.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if(mainWindow && total){
            const pct = Math.min(100, Math.round((received / total) * 100));
            mainWindow.webContents.send('rs:update-download-progress', { pct, received, total });
          }
        });
        resp.on('end', () => {
          file.end();
          file.on('finish', async () => {
            try{
              // Open the installer. On macOS this mounts the DMG and
              // opens the volume so the user can drag to Applications.
              // On Windows this runs the NSIS installer.
              await shell.openPath(target);
              resolve({ ok:true, path: target });
            }catch(e){ resolve({ ok:false, error: String(e.message || e) }); }
          });
        });
        resp.on('error', (err) => {
          file.close();
          try{ fs.unlinkSync(target); }catch(_){}
          resolve({ ok:false, error: String(err.message || err) });
        });
      });
      req.on('error', (err) => {
        file.close();
        try{ fs.unlinkSync(target); }catch(_){}
        resolve({ ok:false, error: String(err.message || err) });
      });
      req.end();
    }catch(e){
      resolve({ ok:false, error: String(e.message || e) });
    }
  });
});

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
    // signal to verify they're current. With the renderer's sticky
    // banner + auto-download, this means new releases roll out to
    // every active widget within ~15 min of the GH tag landing.
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
