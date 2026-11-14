// Server Forge desktop app: a native window around the panel. It starts the panel service if it isn't running, logs in as the
// owner automatically (using the key the service writes to its data folder), and shows the same UI as the web version.
// Closing this window doesn't stop the panel service or any game servers.
import { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeImage, screen } from 'electron';
import { createDownloadMonitor } from './download-monitor.js';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync, openSync, statSync, mkdirSync, rmSync, createWriteStream, writeFileSync, mkdtempSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const LINUX = process.platform === 'linux';
const linuxApp = LINUX && app.isPackaged ? await import(pathToFileURL(path.join(root, 'dist', 'platform', 'linux-app.js')).href) : null;
const LINUX_INFO = { slug: 'server-forge', name: 'Server Forge', comment: 'A control panel for hosting and managing game servers', icon: path.join(here, 'icon.png') };
// Installed: data lives in the user's AppData, so updates and reinstalls never touch it.
// Development: data/ in the project folder.
function installedDataDir() {
  const current = path.join(app.getPath('userData'), 'data');
  // Before the rename to Tavern Host, data lived under "Game Server Panel". Keep using that folder if it exists, so an
  // update keeps every account, server and API key (and running game servers keep their log paths).
  const legacy = path.join(app.getPath('appData'), 'Game Server Panel', 'data');
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}
// Portable copy (a "portable.txt" file next to Tavern Host.exe): everything lives in a "data" folder beside it, so the
// whole folder can be moved or run from a USB stick without touching this system's AppData.
const exeDir = path.dirname(process.execPath);
const portable = app.isPackaged && existsSync(path.join(exeDir, 'portable.txt'));
// Development copy (run from the source folder): a separate app identity, window profile and single-instance lock,
// so it runs side by side with the installed release instead of focusing or replacing it.
const dev = !app.isPackaged;
app.setPath('userData', path.join(app.getPath('appData'), LINUX ? (dev ? 'Server Forge Dev' : 'Server Forge') : dev ? 'Tavern Host Dev' : 'Tavern Host')); // stable pre-rebrand profile
const dataDir = process.env.PANEL_DATA_DIR ?? (portable ? path.join(exeDir, 'data') : app.isPackaged ? installedDataDir() : path.join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
if (portable) app.setPath('userData', path.join(dataDir, 'desktop-app'));

function readConfig() {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
  } catch {
    return { port: 8190 };
  }
}
const PANEL_URL = `http://127.0.0.1:${readConfig().port ?? 8190}`;

// Draw everything in plain sRGB. With the monitor's colour profile applied, Chromium converted some screen areas
// differently from others, so flat dark colours showed as slightly different blocks ("phantom boxes") depending on
// the theme hue.
app.commandLine.appendSwitch('force-color-profile', 'srgb');

app.setAppUserModelId(dev ? 'TavernHost.Dev' : 'TavernHost');
app.setName(dev ? 'Server Forge Dev' : 'Server Forge');
const WINDOW_TITLE = dev ? 'Server Forge – Development Panel' : 'Server Forge';

// Linux, started from the AppImage: put the app in the home folder and the menu, then carry on from that copy (the
// background service and the server runners couldn't run from an AppImage, which disappears when it closes).
if (linuxApp?.runningFromAppImage()) {
  const run = await linuxApp.installFromAppImage({ ...LINUX_INFO, version: app.getVersion() }, process.execPath);
  linuxApp.startDetached(run);
  app.exit(0);
  await new Promise(() => {});
}
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

async function panelUp() {
  try {
    return (await fetch(`${PANEL_URL}/api/me`)).ok;
  } catch {
    return false;
  }
}

/** The running service's version and PID, or null if it's too old to report them (before 0.2.1). */
async function serviceVersion() {
  try {
    const res = await fetch(`${PANEL_URL}/api/version`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** PID of whatever is listening on the panel's local port (used to find services too old to report their PID). */
function listenerPid() {
  const port = new URL(PANEL_URL).port;
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8', windowsHide: true });
    const line = out.split(/\r?\n/).find((l) => new RegExp(`127\\.0\\.0\\.1:${port}\\s.*LISTENING`).test(l));
    return line ? Number(line.trim().split(/\s+/).pop()) : null;
  } catch {
    return null;
  }
}

/**
 * After an update, an old service can still be running (and would serve the old version). If the running service's
 * version doesn't match this app, stop it so the matching one starts. Game servers keep running and are re-attached.
 */
async function replaceOutdatedService() {
  if (!app.isPackaged) return;
  const running = await serviceVersion();
  if (running?.version === app.getVersion()) return;
  const pid = running?.pid ?? listenerPid();
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {}
  for (let i = 0; i < 40 && (await panelUp()); i++) await new Promise((r) => setTimeout(r, 250));
}

/** Starts the panel service in the background if needed (it keeps running after this window closes). */
async function ensurePanel() {
  if (await panelUp()) await replaceOutdatedService();
  if (await panelUp()) return;
  const out = openSync(path.join(dataDir, 'panel.log'), 'a');
  const err = openSync(path.join(dataDir, 'panel.err.log'), 'a');
  const env = { ...process.env, PANEL_DATA_DIR: dataDir };
  // Installed: run the compiled service with this app's own built-in Node, so Node.js doesn't need installing.
  const [cmd, args] = app.isPackaged
    ? [process.execPath, [path.join(root, 'dist', 'main.js')]]
    : ['node', ['src/main.ts']];
  if (app.isPackaged) env.ELECTRON_RUN_AS_NODE = '1';
  spawn(cmd, args, { cwd: root, detached: true, stdio: ['ignore', out, err], windowsHide: true, env }).unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await panelUp()) return;
  }
  throw new Error('The panel service did not start. See ' + path.join(dataDir, 'panel.err.log'));
}

/** Logs in as the owner with the desktop key and puts the session cookie into this window's browser session. */
async function desktopLogin(session) {
  const keyFile = path.join(dataDir, 'desktop.key');
  // The service writes a fresh key when it starts. Right after a (re)start the file may still hold the previous key,
  // so retry for a few seconds before falling back to the normal login screen.
  let res = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (existsSync(keyFile)) {
      const key = readFileSync(keyFile, 'utf-8').trim();
      res = await fetch(`${PANEL_URL}/api/desktop-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
        body: JSON.stringify({ key }),
      });
      if (res.ok) break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!res?.ok) return false; // falls back to the normal login screen
  let set = false;
  for (const header of res.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const [name, value] = pair.split('=');
    if (name === 'panel_session' && value) {
      await session.cookies.set({ url: PANEL_URL, name, value, httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 7 * 86400 });
      set = true;
    }
  }
  return set;
}

// The page asks for this when the panel answers "Please log in" while it's open (its login was signed out, e.g.
// pushed out by many other logins). Only the main window may ask, and at most every few seconds.
let lastRelogin = 0;
ipcMain.handle('relogin', async (e) => {
  if (!win || e.sender !== win.webContents || !e.sender.getURL().startsWith(PANEL_URL)) return false;
  if (Date.now() - lastRelogin < 5000) return false;
  lastRelogin = Date.now();
  try {
    return await desktopLogin(win.webContents.session);
  } catch {
    return false;
  }
});

/** Small orange dot shown on the development panel's taskbar button. */
function devBadge() {
  const size = 16;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const i = (y * size + x) * 4;
      const a = d <= 6.5 ? 255 : d <= 7.5 ? Math.round(255 * (7.5 - d)) : 0;
      // BGRA, premultiplied
      px[i] = Math.round(0x0b * a / 255);
      px[i + 1] = Math.round(0x9e * a / 255);
      px[i + 2] = Math.round(0xf5 * a / 255);
      px[i + 3] = a;
    }
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

function createWindow() {
  // Roomy enough that the server list and server page both fit, but never bigger than the screen it opens on.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1500, area.width),
    height: Math.min(950, area.height),
    minWidth: 900,
    minHeight: 600,
    title: WINDOW_TITLE,
    icon: path.join(here, 'icon.png'),
    backgroundColor: '#0d1219',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (dev) win.setOverlayIcon(devBadge(), 'Development panel');
  });
  // Keep our title, except for the panel's own names (Server Forge / Server Forge Master / Super Server Forge, set by the page from
  // what this panel manages).
  win.on('page-title-updated', (e, title) => {
    e.preventDefault();
    if (/^(Server Forge|Server Forge Master|Super Server Forge|Server Forge Node|Super Server Forge Node)( – Development Panel)?$/.test(title)) win.setTitle(title);
  });
  // The addon browser is a separate window; close it together with the panel.
  win.on('closed', () => {
    if (browser && !browser.isDestroyed()) browser.close();
  });

  // Keep the window on the panel; open any other links in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(PANEL_URL)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  return win;
}

ipcMain.handle('pick-folder', async (_e, startPath) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder',
    defaultPath: startPath,
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle('set-icon', async (_e, dataUrl) => {
  if (!win || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 2_000_000) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (!image.isEmpty()) win.setIcon(image);
});

ipcMain.handle('open-folder', async (_e, folder) => {
  if (path.isAbsolute(folder) && existsSync(folder) && statSync(folder).isDirectory()) await shell.openPath(folder);
});

// ---------- addon browser ----------
// A plain browser window for addon sites (MCPEDL, CurseForge's website...). Anything downloaded in it that looks like an
// addon is uploaded to the server's addon manager, exactly as if it had been dropped on the Addons tab.

let browser = null;
let browseTarget = null; // { serverId, accept: ['.mcaddon', ...], kind: 'addons' | 'plugins' }

async function uploadToPanel(serverId, file, filename, kind = 'addons') {
  const [cookie] = await win.webContents.session.cookies.get({ url: PANEL_URL, name: 'panel_session' });
  const res = await fetch(`${PANEL_URL}/api/servers/${encodeURIComponent(serverId)}/${kind === 'plugins' ? 'plugins' : 'addons'}/upload`, {
    method: 'POST',
    headers: {
      'X-Panel': '1',
      'X-Filename': encodeURIComponent(filename),
      'Content-Type': 'application/octet-stream',
      Cookie: cookie ? `panel_session=${cookie.value}` : '',
    },
    body: readFileSync(file),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
  return data;
}

/**
 * Hexium: "Install with Gale" (gale://install/hexium/<Author>/<Mod>/<version>) and "Download" buttons. The panel
 * installs the mod from Hexium with what it depends on.
 */
async function installHexium(pkg) {
  const target = browseTarget;
  if (!target) return;
  const filename = `${pkg.name} ${pkg.version ?? ''}`.trim();
  const { response } = await dialog.showMessageBox(browser && !browser.isDestroyed() ? browser : win, {
    type: 'question',
    title: 'Install on the server?',
    message: `Install ${pkg.name}${pkg.version ? ` ${pkg.version}` : ''} (by ${pkg.namespace}) from Hexium on "${target.serverName || 'the server'}"?`,
    detail: 'Server Forge downloads it and what it needs, and safety-checks everything first.',
    buttons: ['Cancel', 'Install'],
    defaultId: 1,
    cancelId: 0,
  });
  if (response !== 1) return;
  const finished = watchServerInstall(target, filename);
  try {
    const [cookie] = await win.webContents.session.cookies.get({ url: PANEL_URL, name: 'panel_session' });
    const res = await fetch(`${PANEL_URL}/api/servers/${encodeURIComponent(target.serverId)}/addons/hexium`, {
      method: 'POST',
      headers: { 'X-Panel': '1', 'Content-Type': 'application/json', Cookie: cookie ? `panel_session=${cookie.value}` : '' },
      body: JSON.stringify(pkg),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Install failed (HTTP ${res.status})`);
    finished();
    win?.webContents.send('addon-download', { serverId: target.serverId, filename, status: 'installed', result: data });
  } catch (err) {
    finished(err.message);
    win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'failed', error: err.message });
  }
}

/** gale://install/hexium/<Author>/<Mod>/<version> -> the package, or null. */
function parseGale(url) {
  const m = /^gale:\/\/install\/hexium\/([\w.]+)\/([\w.]+)(?:\/(\d+\.\d+\.\d+))?/i.exec(url);
  return m ? { namespace: m[1], name: m[2], version: m[3] ?? null } : null;
}

/** Nexus Mods "Mod Manager Download" (nxm:// link): the panel downloads it with its Nexus API key and installs it. */
async function installNexusLink(link) {
  const target = browseTarget;
  const filename = 'Nexus Mods download';
  if (!target) return;
  const { response } = await dialog.showMessageBox(browser && !browser.isDestroyed() ? browser : win, {
    type: 'question',
    title: 'Install on the server?',
    message: `Install this Nexus Mods file on "${target.serverName || 'the server'}"?`,
    detail: 'Server Forge downloads it with your Nexus Mods API key (Settings → Integrations) and safety-checks it first.',
    buttons: ['Cancel', 'Install'],
    defaultId: 1,
    cancelId: 0,
  });
  if (response !== 1) return;
  const finished = watchServerInstall(target, filename);
  try {
    const [cookie] = await win.webContents.session.cookies.get({ url: PANEL_URL, name: 'panel_session' });
    const res = await fetch(`${PANEL_URL}/api/servers/${encodeURIComponent(target.serverId)}/addons/nexus`, {
      method: 'POST',
      headers: { 'X-Panel': '1', 'Content-Type': 'application/json', Cookie: cookie ? `panel_session=${cookie.value}` : '' },
      body: JSON.stringify({ input: link }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Install failed (HTTP ${res.status})`);
    finished();
    win?.webContents.send('addon-download', { serverId: target.serverId, filename, status: 'installed', result: data });
  } catch (err) {
    finished(err.message);
    win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'failed', error: err.message });
  }
}

/** The Workshop item a Steam page shows, or null. */
function workshopItemId(url) {
  return /^https:\/\/steamcommunity\.com\/(?:sharedfiles|workshop)\/filedetails\/?\?(?:[^#]*&)?id=(\d{6,12})\b/i.exec(url)?.[1] ?? null;
}

/** On a Workshop mod's page: an Install button (its link is caught by will-navigate, like nxm:// links). */
function showWorkshopButton() {
  if (!browser || browser.isDestroyed() || !browseTarget?.workshop) return;
  const show = !!workshopItemId(browser.webContents.getURL());
  const label = `⬇ Install on ${browseTarget.serverName || 'the server'}`;
  browser.webContents
    .executeJavaScript(
      `(() => {
        document.getElementById('sf-workshop-install')?.remove();
        if (!${show}) return;
        const b = document.createElement('a');
        b.id = 'sf-workshop-install';
        b.href = 'sf-workshop://install';
        b.textContent = ${JSON.stringify(label)};
        Object.assign(b.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: 2147483647, padding: '14px 22px', background: '#2563eb', color: '#fff', font: '600 16px sans-serif', borderRadius: '10px', textDecoration: 'none', boxShadow: '0 6px 24px rgba(0,0,0,.5)' });
        document.body.appendChild(b);
      })()`,
    )
    .catch(() => {});
}

/** The Install button: takes the ID from the page being viewed, and always asks first. */
async function installWorkshopItem() {
  const target = browseTarget;
  const id = browser && !browser.isDestroyed() ? workshopItemId(browser.webContents.getURL()) : null;
  if (!target?.workshop || !id) return;
  const title = browser.webContents.getTitle().replace(/^Steam (?:Community|Workshop)\s*::\s*/i, '').trim() || `Workshop item ${id}`;
  const { response } = await dialog.showMessageBox(browser, {
    type: 'question',
    title: 'Install on the server?',
    message: `Install "${title}" on "${target.serverName || 'the server'}"?`,
    detail: `Workshop item ${id}. Restart the server afterwards to load it.`,
    buttons: ['Cancel', 'Install'],
    defaultId: 1,
    cancelId: 0,
  });
  if (response !== 1) return;
  const finished = watchServerInstall(target, title);
  try {
    const [cookie] = await win.webContents.session.cookies.get({ url: PANEL_URL, name: 'panel_session' });
    const res = await fetch(`${PANEL_URL}/api/servers/${encodeURIComponent(target.serverId)}/addons/by-id`, {
      method: 'POST',
      headers: { 'X-Panel': '1', 'Content-Type': 'application/json', Cookie: cookie ? `panel_session=${cookie.value}` : '' },
      body: JSON.stringify({ input: id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Install failed (HTTP ${res.status})`);
    finished();
    win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename: title, status: 'installed', result: data });
  } catch (err) {
    finished(err.message);
    win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename: title, status: 'failed', error: err.message });
  }
}

function browserMenu(home) {
  const go = (fn) => () => browser && !browser.isDestroyed() && fn(browser.webContents);
  return Menu.buildFromTemplate([
    { label: '◀ Back', click: go((w) => w.navigationHistory.canGoBack() && w.navigationHistory.goBack()) },
    { label: 'Forward ▶', click: go((w) => w.navigationHistory.canGoForward() && w.navigationHistory.goForward()) },
    { label: '⟳ Reload', accelerator: 'F5', click: go((w) => w.reload()) },
    { label: '⌂ Home', click: go((w) => w.loadURL(home)) },
    { label: 'Open in my browser', click: go((w) => shell.openExternal(w.getURL())) },
  ]);
}

function openAddonBrowser({ url, serverId, serverName, accept, kind = 'addons', workshop = false }) {
  browseTarget = { serverId, serverName, accept, kind, workshop };
  if (browser && !browser.isDestroyed()) {
    browser.setMenu(browserMenu(url));
    browser.loadURL(url);
    browser.focus();
    return;
  }
  browser = new BrowserWindow({
    width: 1200,
    height: 850,
    // A normal window (not a child of the panel), so clicking the panel brings the panel to the front.
    title: 'Server Forge – addon browser',
    icon: path.join(here, 'icon.png'),
    // Separate cookie jar: the websites never see the panel session.
    webPreferences: { partition: 'persist:addon-browser', contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  browser.setMenu(browserMenu(url));
  monitor.attach(browser);
  const ses = browser.webContents.session;
  // Sites open download links in new tabs; keep them in this window instead of spawning pop-ups.
  browser.webContents.setWindowOpenHandler(({ url: next }) => {
    if (/^sf-workshop:/i.test(next)) installWorkshopItem();
    else if (/^nxm:\/\//i.test(next)) installNexusLink(next);
    else if (parseGale(next)) installHexium(parseGale(next));
    else if (/^https?:\/\//.test(next)) browser.loadURL(next);
    return { action: 'deny' };
  });
  // Nexus Mods' "Mod Manager Download" navigates to an nxm:// link; Hexium's "Install with Gale" to a gale:// one.
  const catchNxm = (e, next) => {
    if (/^sf-workshop:/i.test(next)) {
      e.preventDefault();
      installWorkshopItem();
    } else if (/^nxm:\/\//i.test(next)) {
      e.preventDefault();
      installNexusLink(next);
    } else if (parseGale(next)) {
      e.preventDefault();
      installHexium(parseGale(next));
    }
  };
  browser.webContents.on('did-finish-load', showWorkshopButton);
  browser.webContents.on('did-navigate-in-page', showWorkshopButton);
  browser.webContents.on('will-navigate', catchNxm);
  browser.webContents.on('will-frame-navigate', (e) => !e.isMainFrame && catchNxm(e, e.url));
  browser.on('page-title-updated', (e, title) => {
    e.preventDefault();
    browser.setTitle(`${title} – installing to ${browseTarget?.serverName ?? 'server'}`);
  });
  // The browser's session outlives the window (it's a persistent partition), so hook its downloads only once.
  // (Hooking it again on every open ran several handlers per download, and all but one looked for a file that
  // wasn't there.)
  if (!hookedSessions.has(ses)) {
    hookedSessions.add(ses);
    ses.on('will-download', handleAddonDownload);
  }
  browser.on('closed', () => {
    browser = null;
  });
  browser.loadURL(url);
}

const hookedSessions = new WeakSet();

const monitor = createDownloadMonitor({ onChange: (list) => win?.webContents.send('downloads', list) });
ipcMain.handle('download-cancel', (_e, id) => monitor.cancel(String(id)));
ipcMain.handle('download-dismiss', (_e, id) => monitor.dismiss(String(id)));

/**
 * Shows a server-side install in the panel while it runs: one row for the install, and one for each file the server is
 * downloading for it. Returns the function to call when it's over.
 */
function watchServerInstall(target, name) {
  const id = `install-${randomBytes(4).toString('hex')}`;
  const rows = new Set();
  monitor.set(id, { name, state: 'installing' });
  const url = `${PANEL_URL}/api/servers/${encodeURIComponent(target.serverId)}/mod-downloads`;
  const timer = setInterval(async () => {
    try {
      const [cookie] = await win.webContents.session.cookies.get({ url: PANEL_URL, name: 'panel_session' });
      const res = await fetch(url, { headers: { 'X-Panel': '1', Cookie: cookie ? `panel_session=${cookie.value}` : '' } });
      if (!res.ok) return;
      for (const d of (await res.json()).downloads ?? []) {
        if (d.state === 'downloading') {
          rows.add(d.id);
          monitor.set(`${id}-${d.id}`, { name: d.name, state: 'downloading', received: d.received, total: d.total });
        } else if (rows.delete(d.id)) monitor.remove(`${id}-${d.id}`);
      }
    } catch {}
  }, 700);
  return (error) => {
    clearInterval(timer);
    for (const r of rows) monitor.remove(`${id}-${r}`);
    monitor.set(id, error ? { state: 'failed', note: error } : { state: 'done' });
  };
}

/** Addon files downloaded in the addon browser: save to a temp file, ask, then install on the chosen server. */
function handleAddonDownload(_e, item) {
  const target = browseTarget;
  const filename = item.getFilename();
  // Hexium's "Download" gives just "<version>.zip": install it by name from the mod page being viewed instead.
  if (target && /^https:\/\/cdn\.hexium\.gg\//i.test(item.getURL())) {
    const page = /^https?:\/\/(?:valheim\.)?hexium\.gg\/mods\/([\w.]+)\/([\w.]+)/i.exec(browser && !browser.isDestroyed() ? browser.webContents.getURL() : '');
    if (page) {
      item.cancel();
      installHexium({ namespace: page[1], name: page[2], version: /^(\d+\.\d+\.\d+)\.zip$/i.exec(filename)?.[1] ?? null });
      return;
    }
  }
  const isAddon = target && target.accept.some((ext) => filename.toLowerCase().endsWith(ext));
  if (!isAddon) return; // anything else downloads normally (Electron asks where to save it)
  item.setSavePath(path.join(app.getPath('temp'), `tavernhost-dl-${Date.now()}-${randomBytes(4).toString('hex')}-${filename.replace(/[^\w.\- ]/g, '_')}`));
  const dlId = `file-${randomBytes(4).toString('hex')}`;
  monitor.set(dlId, { name: filename, state: 'downloading', total: item.getTotalBytes() }, () => item.cancel());
  item.on('updated', () => monitor.set(dlId, { state: 'downloading', received: item.getReceivedBytes(), total: item.getTotalBytes() }));
  item.once('done', async (_ev, state) => {
    // Wherever it actually ended up.
    const file = item.getSavePath();
    if (state !== 'completed') {
      rmSync(file, { force: true });
      if (state === 'cancelled') monitor.remove(dlId);
      else monitor.set(dlId, { state: 'failed', note: `Download ${state}.` });
      win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'failed', error: `Download ${state}.` });
      return;
    }
    monitor.set(dlId, { state: 'waiting' });
    // Websites can start downloads on their own: always ask before installing one on a server.
    const { response } = await dialog.showMessageBox(browser && !browser.isDestroyed() ? browser : win, {
      type: 'question',
      title: 'Install on the server?',
      message: `Install ${filename} on "${target.serverName || 'the server'}"?`,
      detail: 'It will be safety-checked first. Only install files from sources you trust.',
      buttons: ['Cancel', 'Install'],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) {
      rmSync(file, { force: true });
      monitor.remove(dlId);
      win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'failed', error: 'Not installed (cancelled).' });
      return;
    }
    monitor.set(dlId, { state: 'installing' });
    try {
      const result = await uploadToPanel(target.serverId, file, filename, target.kind);
      monitor.set(dlId, { state: 'done' });
      win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'installed', result });
    } catch (err) {
      monitor.set(dlId, { state: 'failed', note: err.message });
      win?.webContents.send('addon-download', { serverId: target.serverId, kind: target.kind, filename, status: 'failed', error: err.message });
    } finally {
      rmSync(file, { force: true });
    }
  });
}

// ---------- update from a local installer file ----------

let pickedInstaller = null;

/** Game servers started by versions before the separate runner (their runner is Tavern Host.exe itself). */
function oldStyleRunners() {
  if (LINUX) return 0; // Linux never had them
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'Tavern Host.exe' -or $_.Name -eq 'Game Server Panel.exe') -and $_.CommandLine -like '*runner.js*' }).Count"],
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000 },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

ipcMain.handle('pick-installer', async () => {
  if (!app.isPackaged) return { error: "Updating from a file only works in the installed Server Forge. This is the development panel, and it would install over your release copy." };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose a Server Forge installer',
    filters: [{ name: 'Installer', extensions: LINUX ? ['AppImage', 'deb', 'rpm'] : ['exe'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const file = filePaths[0];
  let info = {};
  if (!LINUX) try {
    // What the file says it is (Tavern Host installers carry "Tavern Host" and their version).
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$v = (Get-Item -LiteralPath $env:TH_FILE).VersionInfo; @{ product = $v.ProductName; version = $v.ProductVersion; description = $v.FileDescription } | ConvertTo-Json -Compress'],
      { encoding: 'utf-8', windowsHide: true, timeout: 20_000, env: { ...process.env, TH_FILE: file } },
    );
    info = JSON.parse(out.trim() || '{}');
  } catch {}
  pickedInstaller = file;
  return { path: file, name: path.basename(file), product: info.product ?? '', version: info.version ?? '', description: info.description ?? '', current: app.getVersion(), oldRunners: oldStyleRunners() };
});

ipcMain.handle('run-installer', async () => {
  // Only the file the user just picked in the dialog above, never a path from the page.
  const file = pickedInstaller;
  pickedInstaller = null;
  if (!file || !existsSync(file)) throw new Error('Choose the installer again.');
  if (oldStyleRunners()) throw new Error('Some Java/Bedrock servers are still running under the old version. Stop them first.');
  // Silent install (/S), then start the new version (--force-run), behind a small "Updating…" window so it's clear
  // something is happening. The installer closes the background service itself; game servers keep running and the
  // new version re-attaches to them.
  let version = '';
  if (!LINUX) try {
    version = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:TH_FILE).VersionInfo.ProductVersion'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 20_000,
      env: { ...process.env, TH_FILE: file },
    }).trim();
  } catch {}
  runUpdateWithWindow(file, { product: 'Server Forge', version, note: 'Your game servers keep running.' });
  setTimeout(() => app.quit(), 800);
  return true;
});

// ---------- update from GitHub releases ----------
// The panel shows "update available" (the service checks GitHub); this downloads the installer and runs it. The release
// is looked up here, never taken from the page, and only a Tavern Host installer from that release is accepted.

const RELEASES = 'CorruptedVariant/server-forge';
const LINUX_KIND = linuxApp ? linuxApp.installKind(process.execPath) : 'appimage';
const LINUX_ASSET = { appimage: /^Server-Forge-(\d+\.\d+\.\d+)-x86_64\.AppImage$/, deb: /^Server-Forge-(\d+\.\d+\.\d+)-amd64\.deb$/, rpm: /^Server-Forge-(\d+\.\d+\.\d+)-x86_64\.rpm$/ };
const INSTALLER_ASSET = LINUX ? (LINUX_ASSET[LINUX_KIND] ?? LINUX_ASSET.appimage) : /^(?:Server-Forge|Tavern-Host)-Setup-(\d+\.\d+\.\d+)\.exe$/;

function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Downloads the latest release's installer to a temp folder, checking its size and (when GitHub lists it) its SHA-256. */
async function downloadLatestInstaller(repo, assetRe, onProgress) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': app.getName() } });
  if (res.status === 404) throw new Error('No release has been published yet.');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
  const release = await res.json();
  const asset = (release.assets ?? []).find((a) => assetRe.test(a.name));
  if (!asset) throw new Error("The latest release doesn't have an installer.");
  const version = assetRe.exec(asset.name)[1];
  if (!isNewer(version, app.getVersion())) throw new Error(`You already have the latest version (${app.getVersion()}).`);
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': app.getName() } });
  if (!dl.ok || !dl.body) throw new Error(`The download failed (${dl.status}).`);
  const total = Number(dl.headers.get('content-length')) || asset.size || 0;
  const dir = path.join(app.getPath('temp'), `tavern-update-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name);
  const hash = createHash('sha256');
  const out = createWriteStream(file);
  let received = 0;
  let lastSent = 0;
  for await (const chunk of dl.body) {
    hash.update(chunk);
    received += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - lastSent > 200) {
      lastSent = Date.now();
      onProgress?.({ received, total, version });
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (asset.size && received !== asset.size) throw new Error('The download was incomplete. Try again.');
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
  if (digest && digest[1].toLowerCase() !== hash.digest('hex')) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error("The downloaded installer doesn't match the release's checksum, so it wasn't run.");
  }
  onProgress?.({ received, total, version });
  return { file, version, notes: release.body ?? '' };
}

let updating = false;
ipcMain.handle('install-update', async () => {
  if (!app.isPackaged) throw new Error('Updates install only in the installed Server Forge (this is the development panel).');
  if (updating) throw new Error('The update is already downloading.');
  if (oldStyleRunners()) throw new Error('Some Java/Bedrock servers are still running under the old version. Stop them first, or update from a file.');
  updating = true;
  try {
    updateLog('downloading the latest release from GitHub');
    const { file, version } = await downloadLatestInstaller(RELEASES, INSTALLER_ASSET, (p) => win?.webContents.send('update-progress', p)).catch((err) => {
      updateLog(`download failed: ${err.message}`);
      throw err;
    });
    updateLog(`downloaded ${version} (checksum matched): ${file}`);
    // The download folder is removed once the installer has finished.
    runUpdateWithWindow(file, { product: 'Server Forge', version, note: 'Your game servers keep running.', cleanup: path.dirname(file) });
    setTimeout(() => app.quit(), 800);
    return { version };
  } finally {
    updating = false;
  }
});

/**
 * Runs an installer silently behind a small "Updating…" window: it waits for this app to close, runs the installer
 * (/S --force-run starts the new version when it's done), and shows each step (closing → installing → done, or the
 * error). Same helper in the Tavern Client Mod Manager (companion/main.js).
 */
function runUpdateWithWindow(installer, { product, version, note = '', cleanup = null }) {
  if (LINUX) return linuxApp.applyUpdate(installer, process.pid, LINUX_KIND === 'appimage' ? path.join(app.getPath('home'), '.local', 'share', LINUX_INFO.slug, 'run.sh') : process.execPath);
  updateLog(`starting the update helper for ${product} ${version || '(unknown version)'}: ${installer}`);
  const script = [
    'function Log($m) { if ($env:TH_LOG) { Add-Content -LiteralPath $env:TH_LOG -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  helper: " + $m) -ErrorAction SilentlyContinue } }',
    'Log "started; waiting for the app to close"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$nl = [Environment]::NewLine',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = "Updating " + $env:TH_PRODUCT',
    '$form.ClientSize = New-Object System.Drawing.Size(470, 134)',
    "$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false; $form.MinimizeBox = $false",
    "$form.StartPosition = 'CenterScreen'; $form.TopMost = $true",
    '$label = New-Object System.Windows.Forms.Label',
    '$label.SetBounds(18, 14, 434, 62)',
    "$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)",
    '$label.Text = "Closing " + $env:TH_PRODUCT + "..."',
    '$bar = New-Object System.Windows.Forms.ProgressBar',
    '$bar.SetBounds(18, 90, 434, 20)',
    "$bar.Style = 'Marquee'; $bar.MarqueeAnimationSpeed = 25",
    '$form.Controls.Add($label); $form.Controls.Add($bar)',
    "$script:state = 'closing'; $script:proc = $null; $script:started = Get-Date",
    '$timer = New-Object System.Windows.Forms.Timer',
    '$timer.Interval = 400',
    '$timer.Add_Tick({',
    "  if ($script:state -eq 'closing') {",
    '    $alive = Get-Process -Id ([int]$env:TH_WAIT_PID) -ErrorAction SilentlyContinue',
    '    if (-not $alive -or ((Get-Date) - $script:started).TotalSeconds -gt 20) {',
    '      $label.Text = "Installing " + $env:TH_PRODUCT + " " + $env:TH_VERSION + "..." + $nl + "This takes a minute and it starts again by itself. " + $env:TH_NOTE',
    '      Log ("app closed: " + (-not $alive) + "; running the installer")',
    "      $script:proc = Start-Process -FilePath $env:TH_INSTALLER -ArgumentList '/S','--force-run' -PassThru",
    '      $null = $script:proc.Handle',
    "      $script:state = 'installing'",
    '    }',
    "  } elseif ($script:state -eq 'installing' -and $script:proc.HasExited) {",
    '    $timer.Stop()',
    "    $bar.Style = 'Continuous'; $bar.Value = 100",
    '    Log ("installer finished, exit code " + $script:proc.ExitCode)',
    '    if ($script:proc.ExitCode -eq 0) {',
    '      $label.Text = $env:TH_PRODUCT + " " + $env:TH_VERSION + " is installed. Starting it..."',
    '      if ($env:TH_CLEANUP) { Remove-Item -LiteralPath $env:TH_CLEANUP -Recurse -Force -ErrorAction SilentlyContinue }',
    '      $close = New-Object System.Windows.Forms.Timer; $close.Interval = 4000; $close.Add_Tick({ $form.Close() }); $close.Start()',
    '    } else {',
    '      $label.Text = "The update did not finish (installer exit code " + $script:proc.ExitCode + ")." + $nl + "Run the installer yourself: " + $env:TH_INSTALLER',
    '    }',
    '  }',
    '})',
    '$timer.Start()',
    '[void]$form.ShowDialog()',
  ].join('\n');
  // The script goes in a file next to the download, started through "cmd /c start": that gives PowerShell a console of
  // its own (hidden by -WindowStyle). Launched straight from this app (detached, no console) PowerShell quit at once
  // without running anything, so the app closed and nothing was installed.
  const dir = cleanup ?? mkdtempSync(path.join(app.getPath('temp'), 'tavern-updater-'));
  const ps1 = path.join(dir, 'update.ps1');
  writeFileSync(ps1, `﻿${script}`, 'utf-8');
  spawn('cmd.exe', ['/d', '/s', '/c', `"start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}""`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: { ...process.env, TH_INSTALLER: installer, TH_PRODUCT: product, TH_VERSION: version || 'the new version', TH_NOTE: note, TH_WAIT_PID: String(process.pid), TH_CLEANUP: cleanup ?? '', TH_LOG: UPDATE_LOG },
  }).unref();
}

// Every step of an update (download, hand-off, the helper's progress, the installer's result) goes in data\update.log,
// so a failed update can be traced. Kept small: past 200 KB only the newer half is kept.
const UPDATE_LOG = path.join(dataDir, 'update.log');
function updateLog(line) {
  try {
    if (existsSync(UPDATE_LOG) && statSync(UPDATE_LOG).size > 200_000) {
      const text = readFileSync(UPDATE_LOG, 'utf-8');
      writeFileSync(UPDATE_LOG, text.slice(text.length / 2));
    }
    appendFileSync(UPDATE_LOG, `${new Date().toLocaleString('sv')}  app ${app.getVersion()}: ${line}\r\n`);
  } catch {}
}

ipcMain.handle('browse-addons', async (_e, opts) => {
  const url = String(opts?.url ?? '');
  if (!/^https:\/\//.test(url)) return;
  const accept = String(opts?.accept ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^\.\w+$/.test(s));
  // Which manager downloads go to: addons, or plugins (Endstone servers have both).
  const kind = opts?.kind === 'plugins' ? 'plugins' : 'addons';
  openAddonBrowser({ url, serverId: String(opts?.serverId ?? ''), serverName: String(opts?.serverName ?? ''), accept, kind, workshop: !!opts?.workshop });
});

app.whenReady().then(async () => {
  const w = createWindow();
  try {
    await ensurePanel();
    await desktopLogin(w.webContents.session);
    await w.loadURL(PANEL_URL);
  } catch (err) {
    dialog.showErrorBox('Server Forge', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
