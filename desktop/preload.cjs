// Exposes a few desktop-only features to the panel page. The page gets these functions only, never Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  /** Opens the Windows folder picker; resolves to the chosen path or null. */
  pickFolder: (startPath) => ipcRenderer.invoke('pick-folder', typeof startPath === 'string' ? startPath : undefined),
  /** Opens a folder in File Explorer. */
  openFolder: (folder) => ipcRenderer.invoke('open-folder', String(folder)),
  /** Sets the window/taskbar icon from a PNG data URL (the colour-matched logo). */
  setIcon: (dataUrl) => ipcRenderer.invoke('set-icon', String(dataUrl)),
  /** Opens an addon site in a browser window; addon files downloaded there are installed on the given server. */
  browseAddons: (opts) =>
    ipcRenderer.invoke('browse-addons', { workshop: !!opts?.workshop, url: String(opts?.url), serverId: String(opts?.serverId), serverName: String(opts?.serverName ?? ''), accept: String(opts?.accept ?? ''), kind: opts?.kind === 'plugins' ? 'plugins' : 'addons' }),
  /** Called with { serverId, kind, filename, status: 'downloading'|'installed'|'failed', result?, error? }. */
  onAddonDownload: (fn) => ipcRenderer.on('addon-download', (_e, info) => fn(info)),
  onDownloads: (fn) => ipcRenderer.on('downloads', (_e, list) => fn(list)),
  cancelDownload: (id) => ipcRenderer.invoke('download-cancel', String(id)),
  dismissDownload: (id) => ipcRenderer.invoke('download-dismiss', String(id)),
  /** Lets the user pick a Tavern Host installer; resolves to its details (or null if cancelled). */
  pickInstaller: () => ipcRenderer.invoke('pick-installer'),
  /** Runs the installer picked last (silently), then this app closes; the new version starts by itself. */
  runInstaller: () => ipcRenderer.invoke('run-installer'),
  /** Downloads the latest Server Forge release from GitHub and installs it (this app closes; the new version starts). */
  installUpdate: () => ipcRenderer.invoke('install-update'),
  /** Called with { received, total, version } while the update downloads. */
  onUpdateProgress: (fn) => ipcRenderer.on('update-progress', (_e, p) => fn(p)),
});
