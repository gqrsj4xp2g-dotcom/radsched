/* RadScheduler Widget — preload bridge.
 * Exposes a narrow, typed surface to the renderer. Renderer itself
 * has no direct Node access (sandbox + contextIsolation enforced in
 * main.js). All persistence + shell hooks go through these channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rsWidget', {
  getPairing:      () => ipcRenderer.invoke('rs:get-pairing'),
  savePairing:     (code) => ipcRenderer.invoke('rs:save-pairing', code),
  clearPairing:    () => ipcRenderer.invoke('rs:clear-pairing'),
  openExternal:    (url) => ipcRenderer.invoke('rs:open-external', url),
  setAlwaysOnTop:  (on) => ipcRenderer.invoke('rs:set-always-on-top', !!on),
  // Reads the OS clipboard. Used for one-click pairing: physician copies
  // the code from their email, launches the widget, the widget grabs
  // the code from the clipboard and self-pairs.
  readClipboard:   () => ipcRenderer.invoke('rs:read-clipboard'),
  // Auto-update bridges — main polls GitHub Releases and pushes
  // events back here when a new version is available.
  checkUpdates:    () => ipcRenderer.invoke('rs:check-updates'),
  getVersion:      () => ipcRenderer.invoke('rs:get-version'),
  onUpdateAvailable: (cb) => ipcRenderer.on('rs:update-available', (_, data) => cb(data)),
  onUpdateInfo:    (cb) => ipcRenderer.on('rs:update-info', (_, data) => cb(data)),
  // Aggressive update path: download the asset to ~/Downloads and
  // open the installer (DMG / NSIS .exe). The renderer fires this
  // when the user clicks "Update now" on the sticky banner.
  downloadAndInstall: ({ url, name }) => ipcRenderer.invoke('rs:download-and-install', { url, name }),
  // ZERO-CLICK update path: download, swap the .app/exe in place,
  // relaunch automatically. User sees the widget restart ~3-5 sec
  // after an update is detected. No installer prompts, no Gatekeeper
  // re-challenge (ad-hoc signature carries through), no clicks.
  silentUpdate:       ({ url, name }) => ipcRenderer.invoke('rs:silent-update', { url, name }),
  onUpdateProgress:   (cb) => ipcRenderer.on('rs:update-download-progress', (_, data) => cb(data)),
  onResetPairing:  (cb) => ipcRenderer.on('rs:reset-pairing', cb),
});
