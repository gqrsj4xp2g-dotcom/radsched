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

const UPDATE_CHECK_HOURS = 6;
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
// We use safeStorage when the OS supports it (mac/Win), falling back
// to a plain JSON file in userData when it doesn't (Linux without
// libsecret). The file path is stable across upgrades.
const STORE_PATH = () => path.join(app.getPath('userData'), 'pairing.bin');
function savePairing(codeStr){
  try{
    if(safeStorage.isEncryptionAvailable()){
      const enc = safeStorage.encryptString(codeStr);
      fs.writeFileSync(STORE_PATH(), enc);
    } else {
      fs.writeFileSync(STORE_PATH(), codeStr, 'utf8');
    }
  } catch(e){ console.error('savePairing failed:', e); }
}
function loadPairing(){
  try{
    if(!fs.existsSync(STORE_PATH())) return null;
    const buf = fs.readFileSync(STORE_PATH());
    if(safeStorage.isEncryptionAvailable()){
      try{ return safeStorage.decryptString(buf); }
      catch(_){ return buf.toString('utf8'); }  // legacy plain file
    }
    return buf.toString('utf8');
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
    // the dashboard has time to settle; then every UPDATE_CHECK_HOURS.
    // Both are silent — only fires the renderer event when an update
    // is actually available; "Check for updates…" in the tray menu is
    // the interactive path.
    setTimeout(() => { checkForUpdates({ _fromInterval: true }); }, 30 * 1000);
    setInterval(() => { checkForUpdates({ _fromInterval: true }); }, UPDATE_CHECK_HOURS * 60 * 60 * 1000);
  });
  app.on('window-all-closed', () => {
    if(process.platform !== 'darwin') app.quit();
  });
}
