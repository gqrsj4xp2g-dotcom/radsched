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

const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, safeStorage, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;

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
  });
  app.on('window-all-closed', () => {
    if(process.platform !== 'darwin') app.quit();
  });
}
