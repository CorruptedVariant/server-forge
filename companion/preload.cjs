// The page gets these functions only, never Node or Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

// This preload also runs in the Star Valor tab's Achilles frame (a page from Achilles' own 127.0.0.1 server): that
// frame gets only `desktop` (below), the app's page only `modsync`. main.js checks the calling frame as well.
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('modsync', {
  state: () => call('state'),
  /** Starts Achilles (Star Valor) if needed; the address for the Star Valor tab's frame. */
  achillesUrl: () => call('achilles-url'),
  addLink: (raw) => call('add-link', String(raw)),
  removeLink: (raw) => call('remove-link', String(raw)),
  /** Downloads and safety-checks every change; returns what the review screen shows. Installs nothing. */
  prepare: (game) => call('prepare', game === 'java' || game === 'palworld' ? game : 'valheim'),
  /** Minecraft: sets up the launcher for a followed server (loader, profile, server list); returns its status. */
  mcSetup: (raw) => call('mc-setup', String(raw)),
  mcOpenFolder: (raw) => call('mc-open-folder', String(raw)),
  /** Palworld: opens the folder the game reads mods from right now. */
  palOpenFolder: () => call('pal-open-folder'),
  /** Starts Palworld through Steam. */
  palLaunch: () => call('pal-launch'),
  /** Palworld: the player's own mods. Each add answers { done, warnings }. */
  palInstallFile: (file) => call('pal-install-file', webUtils.getPathForFile(file)),
  palPickFiles: () => call('pal-pick-files'),
  palToggle: (id, on) => call('pal-toggle', String(id), !!on),
  palRemove: (id) => call('pal-remove', String(id)),
  palBrowse: (site) => call('pal-browse', site === 'nexus' ? 'nexus' : 'curseforge'),
  /** Opens an allowed outside link (mod pages, loader installers, smmanager://). */
  openExternal: (url) => call('open-external', String(url)),
  /** Installs clean changes plus the ones approved (list of "Author-Mod@version"). */
  apply: (approveNow) => call('apply', Array.isArray(approveNow) ? approveNow.map(String) : []),
  cancel: () => call('cancel'),
  launch: () => call('launch'),
  pickFolder: () => call('pick-folder'),
  openFolder: (which) => call('open-folder', String(which)),
  setAuto: (on) => call('set-auto', !!on),
  installBepInEx: () => call('install-bepinex'),
  toggleMod: (full, on) => call('toggle-mod', String(full), !!on),
  removeMod: (full) => call('remove-mod', String(full)),
  installFile: (file) => call('install-file', webUtils.getPathForFile(file)),
  browse: () => call('browse'),
  browseNexus: () => call('browse-nexus'),
  browseHexium: () => call('browse-hexium'),
  /** Opens the file dialog for a new installer; returns { name, version, current } (or null if cancelled). */
  pickUpdate: () => call('pick-update'),
  runUpdate: () => call('run-update'),
  /** New version of this app on GitHub: { current, latest, available, notes, url, error, canInstall }. */
  appUpdate: (force) => call('app-update', !!force),
  /** Downloads the latest release and installs it (the app closes; the new version opens by itself). */
  installAppUpdate: () => call('install-app-update'),
  installHexium: (input) => call('install-hexium', String(input)),
  /** Newer versions of the player's own mods: { "Author-Mod": "1.2.3" }. */
  checkUpdates: () => call('check-updates'),
  updateMod: (full) => call('update-mod', String(full)),
  switchProfile: (id) => call('switch-profile', String(id)),
  createProfile: (name) => call('create-profile', String(name)),
  renameProfile: (id, name) => call('rename-profile', String(id), String(name)),
  deleteProfile: (id) => call('delete-profile', String(id)),
  /** Saves (after checking with Nexus Mods) or, with '', removes the Nexus API key. */
  setNexusKey: (key) => call('set-nexus-key', String(key)),
  installNexus: (input) => call('install-nexus', String(input)),
  /** Window/taskbar icon from a PNG data URL (the colour-matched logo). */
  setIcon: (dataUrl) => ipcRenderer.invoke('set-icon', String(dataUrl)),
  on: (channel, fn) => {
    if (['log', 'installed', 'auto-synced', 'state-changed', 'needs-review', 'update-progress'].includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});

// Achilles' page (the same functions it had as its own app).
if (location.protocol === 'http:' && location.hostname === '127.0.0.1') contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  /** Real path of a file dropped on the page. */
  getPathForFile: (file) => webUtils.getPathForFile(file),
  /** Opens the mod browser (Nexus Mods' Star Valor page); mod files downloaded there install through Achilles. */
  browseMods: () => ipcRenderer.invoke('achilles-browse-mods'),
  pickModFiles: () => ipcRenderer.invoke('achilles-pick-files'),
  /** { filename, status: 'downloading'|'ready'|'failed', sourcePath?, error? } for downloads in the mod browser. */
  onModDownload: (fn) => {
    ipcRenderer.invoke('achilles-subscribe');
    ipcRenderer.on('achilles-mod-download', (_e, info) => fn(info));
  },
  /** Nexus pages in the mod browser, anything else in the real browser. */
  openModPage: (url) => ipcRenderer.invoke('achilles-open-mod-page', url),
  openFolder: (folder) => ipcRenderer.invoke('achilles-open-folder', folder),
});
