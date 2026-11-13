import { showRebrandAnnouncement } from './rebrand-announcement.js';
import { serverIcon } from './icons.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  games: [],
  servers: new Map(), // id -> snapshot
  selected: null,
  detail: null, // full detail of the selected server
  tab: 'overview',
  list: null, // selected access list id
  events: null,
};

// ---------- helpers ----------

async function api(method, url, body) {
  // Mod installs that download on the server show in the progress panel for as long as they run.
  const install = method === 'POST' ? MOD_INSTALL.exec(url) : null;
  if (install) return watchModInstall(decodeURIComponent(install[1]), () => apiCall(method, url, body));
  return apiCall(method, url, body);
}

async function apiCall(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Panel': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ---------- mod downloads panel ----------
// Rows: installs started from this page (asking the server what it's downloading while they run), and what the desktop
// app reports from its mod browser window.
const MOD_INSTALL = /^\/api\/servers\/([^/]+)\/(?:addons|plugins)\/(?:curseforge|by-id|nexus|hexium|setup|[^/]+\/(?:update|curseforge))$/;
const pageInstalls = new Map();
let serverDownloads = [];
let appDownloads = [];
let downloadPoll = null;

async function pollServerDownloads() {
  const found = [];
  for (const server of new Set([...pageInstalls.values()].filter((i) => i.state === 'installing').map((i) => i.server))) {
    const r = await apiCall('GET', `/api/servers/${encodeURIComponent(server)}/mod-downloads`).catch(() => null); // a node on an older version
    if (r) found.push(...r.downloads.filter((d) => d.state === 'downloading'));
  }
  serverDownloads = found;
  renderDownloads();
}

async function watchModInstall(server, run) {
  const id = `i${Date.now()}${Math.random()}`;
  pageInstalls.set(id, { id, server, name: 'Mod install', state: 'installing' });
  renderDownloads();
  downloadPoll ??= setInterval(pollServerDownloads, 700);
  const finish = (patch, keepMs) => {
    pageInstalls.set(id, { ...pageInstalls.get(id), ...patch });
    if (![...pageInstalls.values()].some((i) => i.state === 'installing')) {
      clearInterval(downloadPoll);
      downloadPoll = null;
      serverDownloads = [];
    }
    renderDownloads();
    setTimeout(() => {
      pageInstalls.delete(id);
      renderDownloads();
    }, keepMs);
  };
  try {
    const out = await run();
    finish({ state: 'done' }, 4000);
    return out;
  } catch (err) {
    finish({ state: 'failed', note: err.message }, 15_000);
    throw err;
  }
}

function renderDownloads() {
  const tray = $('downloadTray');
  if (!tray) return;
  // While the server is fetching a file, its row says more than the install's own row does.
  const installs = [...pageInstalls.values()].filter((i) => i.state !== 'installing' || !serverDownloads.length);
  const rows = [...appDownloads, ...serverDownloads, ...installs];
  tray.hidden = !rows.length;
  tray.textContent = '';
  if (!rows.length) return;
  tray.appendChild(el('h4', null, 'Mod downloads'));
  const mb = (n) => (n / 1048576).toFixed(n < 104857600 ? 1 : 0);
  for (const d of rows) {
    const row = el('div', `download-row ${d.state}`);
    const top = el('div', 'download-top');
    const name = el('span', 'download-name', d.name);
    name.title = d.name;
    top.appendChild(name);
    if (d.canCancel) {
      const cancel = el('button', 'small ghost', 'Cancel');
      cancel.addEventListener('click', () => window.desktop?.cancelDownload?.(d.id));
      top.appendChild(cancel);
    } else if (d.state === 'failed' && appDownloads.includes(d)) {
      const dismiss = el('button', 'small ghost', 'Dismiss');
      dismiss.addEventListener('click', () => window.desktop?.dismissDownload?.(d.id));
      top.appendChild(dismiss);
    }
    row.appendChild(top);
    if (d.state === 'downloading' || d.state === 'installing') {
      const known = d.state === 'downloading' && d.total > 0;
      const bar = el('div', `download-bar${known ? '' : ' busy'}`);
      const fill = el('i');
      if (known) fill.style.width = `${Math.min(100, (d.received / d.total) * 100)}%`;
      bar.appendChild(fill);
      row.appendChild(bar);
    }
    const note =
      d.state === 'downloading' ? (d.total ? `${Math.floor((d.received / d.total) * 100)}%  ·  ${mb(d.received)} of ${mb(d.total)} MB` : d.received ? `${mb(d.received)} MB so far` : 'Downloading…')
      : d.state === 'waiting' ? 'Downloaded. Confirm the install in the browser window.'
      : d.state === 'installing' ? d.note || 'Downloading, checking and installing…'
      : d.state === 'done' ? 'Installed' : d.note || 'Failed';
    row.appendChild(el('div', 'download-note', note));
    tray.appendChild(row);
  }
}
window.desktop?.onDownloads?.((list) => {
  appDownloads = list;
  renderDownloads();
});

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3000);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const STATUS_LABEL = { running: 'Running', starting: 'Starting…', stopping: 'Stopping…', stopped: 'Stopped', crashed: 'Crashed', installing: 'Installing…', unknown: 'System offline' };
const isOwner = () => state.user?.role === 'owner';
/** Whether the current user has a permission on the selected server (sent by the server with its details). */
const hasPerm = (perm) => isOwner() || !!state.detail?.permissions?.includes(perm);
const hasGlobal = (perm) => isOwner() || !!state.global?.includes(perm);

/**
 * Hides elements the account can't use: data-perm="a|b" needs any of those permissions on the open server,
 * data-global="a|b" needs any of those panel-wide permissions.
 */
function applyPermVisibility(root = document) {
  for (const node of root.querySelectorAll('[data-perm]')) node.classList.toggle('no-perm', !node.dataset.perm.split('|').some((x) => hasPerm(x)));
  for (const node of root.querySelectorAll('[data-global]')) node.classList.toggle('no-global', !node.dataset.global.split('|').some((x) => hasGlobal(x)));
}

/**
 * Asks for a line of text in a small dialog; resolves to the text, or null if cancelled. Used instead of prompt(),
 * which the desktop app (Electron) doesn't support: there it throws, so the button silently did nothing.
 */
function ask(message, value = '') {
  return new Promise((resolve) => {
    const dialog = $('askDialog');
    $('askMessage').textContent = message;
    $('askInput').value = value;
    let answer = null;
    const done = () => {
      $('askForm').onsubmit = null;
      $('askCancel').onclick = null;
      dialog.removeEventListener('close', done);
      resolve(answer);
    };
    $('askForm').onsubmit = (e) => {
      e.preventDefault();
      answer = $('askInput').value;
      dialog.close();
    };
    $('askCancel').onclick = () => dialog.close();
    dialog.addEventListener('close', done);
    dialog.showModal();
    $('askInput').select();
  });
}

/**
 * Asks yes/no in the panel's own dialog; resolves to true for OK. Used instead of confirm(): in the desktop app
 * (Electron on Windows) the page often stopped taking clicks after a native confirm box closed, until Server Forge was
 * reopened.
 */
function confirmBox(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dialog = $('confirmDialog');
    $('confirmMessage').textContent = message;
    $('confirmOk').textContent = okLabel;
    let answer = false;
    const done = () => {
      $('confirmForm').onsubmit = null;
      $('confirmCancel').onclick = null;
      dialog.removeEventListener('close', done);
      resolve(answer);
    };
    $('confirmForm').onsubmit = (e) => {
      e.preventDefault();
      answer = true;
      dialog.close();
    };
    $('confirmCancel').onclick = () => dialog.close();
    dialog.addEventListener('close', done);
    dialog.showModal();
    $('confirmOk').focus();
  });
}

/** A message with just an OK button (the confirm dialog without Cancel). */
async function noticeBox(message) {
  $('confirmCancel').hidden = true;
  try {
    await confirmBox(message);
  } finally {
    $('confirmCancel').hidden = false;
  }
}

function show(view) {
  for (const v of ['viewSetup', 'viewLogin', 'viewApp']) $(v).hidden = v !== view;
}

/**
 * The panel's name follows what it does: "Server Forge", "Server Forge Master" (only manages other systems) or "Super Server Forge"
 * (manages other systems and has its own servers or storage). Sent by the service with /api/me and the storage summary.
 */
function applyPanelName(panel) {
  if (panel) state.panel = panel;
  const name = state.panel?.name ?? 'Server Forge';
  const brand = document.querySelector('.brand > span');
  if (brand) brand.textContent = name;
  document.querySelectorAll('.auth-brand span').forEach((s) => (s.textContent = name));
  document.title = state.dev ? `${name} – Development Panel` : name;
  if (brand)
    brand.title =
      {
        master: 'Server Forge Master: this panel manages other systems (nodes) and has no game servers or storage of its own.',
        super: 'Super Server Forge: this panel manages other systems (nodes) and has its own game servers or storage too.',
        node: 'Server Forge Node: a main panel on another system manages this one.',
        supernode: 'Super Server Forge Node: a main panel on another system manages this one, and Tavern Vault is here too.',
      }[state.panel?.role] ?? '';
}

/** Asks the service again (after nodes or servers change). */
async function refreshPanelName() {
  try {
    applyPanelName((await api('GET', '/api/me')).panel);
  } catch {}
}

/** Labels the development (test) build so it can't be confused with the installed one. Every build is on the beta
 *  channel until 1.0.0, so there's no Release pill yet. */
function showBuild(build) {
  const dev = build === 'development';
  if (dev) {
    const badge = el('span', 'build-badge dev', 'Development');
    badge.title = 'Test panel running from the source code. Not for live servers.';
    $('appVersion').appendChild(badge);
  }
  const beta = el('span', 'build-badge beta', 'Beta');
  beta.title = 'Server Forge is in beta: it is actively being worked on and updates are frequent.';
  $('appVersion').appendChild(beta);
  document.body.classList.toggle('dev-build', dev);
  state.dev = dev;
  applyPanelName(state.panel);
  if (dev && !$('devBanner')) {
    const bar = el('div', 'dev-banner', 'DEVELOPMENT PANEL · test copy running from source · your live servers are on the release panel');
    bar.id = 'devBanner';
    document.body.prepend(bar);
  }
}

// ---------- auth ----------

async function boot() {
  const me = await api('GET', '/api/me');
  applyMe(me);
  if (me.needsSetup) return show('viewSetup');
  if (!me.user) return show('viewLogin');
  await enterApp(me.user);
}

/** What /api/me says about this system. Before login it leaves out the version, platform and folders, so it runs again after. */
function applyMe(me) {
  $('appVersion').textContent = me.version ? `v${me.version}` : '';
  state.panel = me.panel ?? null;
  showBuild(me.build);
  state.build = me.build;
  state.version = me.version;
  state.updatedFrom = me.updatedFrom;
  // Where new servers go by default (the development panel keeps its own folder).
  state.platform = me.platform;
  if (me.platform === 'linux') {
    $('btnFirewall').textContent = 'Allow through the firewall…';
    $('btnFirewall').nextElementSibling.textContent = 'Only if this system runs a firewall (ufw or firewalld); it asks for admin permission. Needed once so other devices can connect.';
    $('browseNative').textContent = 'System folder picker…';
    $('newFolder').placeholder = `${me.serverRoot}/My Valheim server`;
    $('addInstall').placeholder = `${me.serverRoot}/My server`;
  }
  state.serverRoot = me.serverRoot ?? (me.build === 'development' ? 'C:\\GameServers\\Dev' : 'C:\\GameServers');
  // The container's web page is always on (it's the only way in), and its ports are set where the container is.
  state.container = !!me.container;
  $('loginContainerHint').hidden = !me.container;
  $('remoteControls').hidden = !!me.container;
  $('remoteContainerHelp').hidden = !me.container;
  $('remoteFirewallRow').hidden = !!me.container;
}

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('setupPass').value !== $('setupPass2').value) return ($('setupError').textContent = 'Passwords do not match.');
  try {
    const { user } = await api('POST', '/api/setup', { username: $('setupUser').value, password: $('setupPass').value });
    await enterApp(user);
  } catch (err) {
    $('setupError').textContent = err.message;
  }
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('POST', '/api/login', { username: $('loginUser').value, password: $('loginPass').value });
    $('loginPass').value = '';
    await enterApp(user);
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

$('btnLogout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.events?.close();
  location.reload();
});

const ROLE_NAMES = { owner: 'Owner', admin: 'Admin', operator: 'Moderator', viewer: 'Viewer', custom: 'Custom' };

async function enterApp(user) {
  state.user = user;
  const owner = user.role === 'owner';
  document.body.classList.toggle('is-owner', owner);
  $('whoami').textContent = `${user.username} (${ROLE_NAMES[user.role] ?? user.role})`;
  // An account flagged "must change password" can only do that first.
  if (user.mustChangePassword) {
    show('viewApp');
    openPasswordDialog(true);
    return;
  }
  const me = await api('GET', '/api/me');
  applyMe(me);
  // The container's starting password is in its log, where anyone who can read that sees it: choose your own first.
  if (me.initialPassword) {
    show('viewApp');
    openPasswordDialog(true, "Choose your own password first. The starting one is in the app's log, where others can see it.");
    return;
  }
  state.global = me.global ?? [];
  applyPermVisibility();
  show('viewApp');
  state.games = await api('GET', '/api/games');
  $('addGame').innerHTML = '';
  for (const g of state.games) $('addGame').add(new Option(g.name, g.id));
  for (const s of await api('GET', '/api/servers')) state.servers.set(s.id, s);
  renderSidebar();
  connectEvents();
  loadAlerts();
  // The rename and release notes share one notice; later versions use normal notes.
  // Linux installs are all newer than the rename, so there's no old name to explain.
  const announce = state.platform === 'linux' ? async () => false : showRebrandAnnouncement;
  void announce({
    version: state.version,
    development: state.build === 'development',
    loadNotes: version => api('GET', `/api/changelog?version=${encodeURIComponent(version)}`),
    renderNotes,
  }).then(shown => { if (!shown) showWhatsNew(); }).then(showChannelNotice);
  if (hasGlobal('panel.settings')) {
    loadAppUpdate(false);
    // The service checks GitHub every 6 hours; asking it hourly just picks that up.
    setInterval(() => loadAppUpdate(false), 3600_000);
  }
  await loadVaultSummary();
  const first = location.hash.slice(1) || [...state.servers.keys()][0];
  if (first?.startsWith('storage:') && hasGlobal('storage.view')) showStorage(first.slice(8));
  else if (first && state.servers.has(first)) selectServer(first);
}

// ---------- live updates ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  state.events = es;
  es.addEventListener('server', (e) => {
    const snap = JSON.parse(e.data);
    state.servers.set(snap.id, snap);
    renderSidebar();
    if (snap.id === state.selected) {
      state.detail = { ...state.detail, ...snap };
      renderHeader();
      if (state.tab === 'overview') renderOverview();
    }
  });
  es.addEventListener('line', (e) => {
    const { id, line } = JSON.parse(e.data);
    if (id !== state.selected || !state.detail) return;
    state.detail.console.push(line);
    if (state.detail.console.length > 2000) state.detail.console.shift();
    appendConsoleLine(line);
  });
  es.addEventListener('alert', () => loadAlerts());
  es.addEventListener('world-check', (e) => {
    const w = JSON.parse(e.data);
    if (w.serverId !== state.selected || state.tab !== 'backups') return;
    if (w.phase === 'progress') renderWorldCheckProgress(w.done, w.total);
    else loadBackups();
  });
  es.addEventListener('nodes', () => {
    if (!$('settingsView').hidden) loadNodes();
    refreshPanelName();
  });
  es.addEventListener('chat', (e) => {
    const { id, message } = JSON.parse(e.data);
    if (id === state.selected && state.tab === 'chat') addChatMessage(message, true);
  });
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    state.servers.delete(id);
    renderSidebar();
    if (id === state.selected) {
      state.selected = null;
      $('serverView').hidden = true;
      $('emptyState').hidden = false;
    }
  });
  es.addEventListener('error', () => {
    // EventSource reconnects by itself; if our session expired, go back to login.
    api('GET', '/api/me').then((me) => !me.user && location.reload()).catch(() => {});
  });
}

// ---------- sidebar ----------

// Collapsed game sections in the sidebar (per browser, just a convenience).
function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('th-collapsed-games') ?? '[]'));
  } catch {
    return new Set();
  }
}
const collapsedGames = loadCollapsed();
function saveCollapsed() {
  try {
    localStorage.setItem('th-collapsed-games', JSON.stringify([...collapsedGames]));
  } catch {}
}

const JAVA_FLAVOR_NAMES = { paper: 'Paper', vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', spigot: 'Spigot', sponge: 'SpongeVanilla', bungeecord: 'BungeeCord' };

// ---------- sidebar mini CPU/RAM ----------

let sidebarStats = {};

function fillMiniStats(box, st) {
  box.innerHTML = '';
  const item = (label, text, fraction) => {
    const span = el('span', 'mini-item');
    span.append(el('span', 'mini-label', label));
    const bar = el('span', 'mini-bar');
    const fill = el('span');
    const f = Math.max(0, Math.min(1, fraction ?? 0));
    fill.style.width = `${(f * 100).toFixed(0)}%`;
    fill.className = f > 0.9 ? 'hot' : f > 0.75 ? 'warm' : '';
    bar.appendChild(fill);
    span.append(bar, el('span', 'mini-val', text));
    return span;
  };
  const ready = st && st.cpu != null;
  box.append(
    item('CPU', ready ? `${st.cpu < 10 ? st.cpu.toFixed(1) : Math.round(st.cpu)}%` : '…', ready ? st.cpu / 100 : 0),
    item('RAM', ready ? `${fmtMem(st.mem)} / ${fmtMem(st.limit)}` : '…', ready ? st.mem / st.limit : 0),
  );
}

// Each system's own CPU and RAM (this one and every node), shown under its name in the sidebar.
let systemStats = null;

/** A system's CPU/RAM under its name. Hidden when it has none (offline, or a node too old to report them). */
function fillSystemStats(box, st) {
  box.hidden = !st;
  if (!st) return;
  fillMiniStats(box, { cpu: st.cpu ?? 0, mem: st.mem.used, limit: st.mem.total });
  const cache = st.mem.zfsCache > 0 ? `, plus ${fmtMem(st.mem.zfsCache)} ZFS cache (TrueNAS frees it when programs need it)` : '';
  box.title = `Whole system: ${st.cores} CPU threads; ${fmtMem(st.mem.used)} of ${fmtMem(st.mem.total)} RAM in use${cache}.`;
}

let systemStatsLoading = false;
async function updateSystemStats(first = false) {
  if (document.hidden || systemStatsLoading || !state.user) return;
  systemStatsLoading = true;
  const before = Object.keys(systemStats?.nodes ?? {}).filter((id) => systemStats.nodes[id]).join();
  try {
    systemStats = await api('GET', '/api/system-stats');
  } catch {
    return;
  } finally {
    systemStatsLoading = false;
  }
  // A system came or went (e.g. a node with no servers went offline): redraw the list; otherwise just the numbers.
  const now = Object.keys(systemStats.nodes ?? {}).filter((id) => systemStats.nodes[id]).join();
  if (state.detail) $('btnMove').hidden = !hasGlobal('servers.create') || !moveTargets(state.detail).length;
  if (first || now !== before) return renderSidebar();
  for (const box of document.querySelectorAll('#serverList .node-res')) fillSystemStats(box, box.dataset.node === 'local' ? systemStats.local : systemStats.nodes?.[box.dataset.node]);
}
setInterval(updateSystemStats, 5000);

async function updateSidebarStats() {
  if (!state.servers?.size || document.hidden) return;
  try {
    sidebarStats = await api('GET', '/api/stats');
  } catch {
    return;
  }
  for (const box of document.querySelectorAll('#serverList .mini-res')) fillMiniStats(box, sidebarStats[box.dataset.server]);
}
setInterval(updateSidebarStats, 3000);

// Servers grouped by game (one section each), in the saved order inside a section (drag to change it). Sections are
// ordered by where their first server sits in the saved list, so dragging a section moves its servers as a block.
// BungeeCord networks: which Server Forge servers each proxy's config.yml points at (matched by address), worked out on
// every sidebar redraw. proxyLinks: server id -> { proxy, name, address }; proxyChildren: proxy id -> [{ server, name }].
let proxyLinks = new Map();
let proxyChildren = new Map();
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|::1|\[::1\])$/i;

function linkProxies() {
  proxyLinks = new Map();
  proxyChildren = new Map();
  const all = [...state.servers.values()];
  for (const p of all) {
    if (!p.proxyBackends?.length) continue;
    for (const b of p.proxyBackends) {
      const m = /^(.*):(\d+)$/.exec(b.address);
      if (!m) continue;
      const [, host, port] = m;
      // 127.0.0.1 / localhost: a server on the proxy's own system. Otherwise a server whose system has that address.
      const hit = all.find(
        (s) =>
          s.id !== p.id &&
          !s.proxyBackends &&
          !proxyLinks.has(s.id) &&
          String(s.connection?.port) === port &&
          (LOOPBACK.test(host) || host === p.connection?.ip ? nodeKey(s) === nodeKey(p) : s.connection?.ip === host),
      );
      if (!hit) continue;
      proxyLinks.set(hit.id, { proxy: p, name: b.name, address: b.address });
      if (!proxyChildren.has(p.id)) proxyChildren.set(p.id, []);
      proxyChildren.get(p.id).push({ server: hit, name: b.name });
    }
  }
}

function renderSidebar() {
  // Redrawing mid-drag would cancel the drag; catch up when it ends.
  if (dragging) return void (sidebarPending = true);
  sidebarPending = false;
  linkProxies();
  const nav = $('serverList');
  nav.innerHTML = '';
  if (!state.servers.size) nav.appendChild(el('p', 'muted small-text', 'No servers yet.'));
  // With nodes (other systems), servers are grouped by system first ("This system", then each node), then by game.
  const byNode = new Map();
  for (const s of state.servers.values()) {
    const nk = nodeKey(s);
    if (!byNode.has(nk)) byNode.set(nk, { name: s.node?.name ?? 'This System', servers: [] });
    byNode.get(nk).servers.push(s);
  }
  // Storage (Tavern Vault): only when it's turned on in Settings, and only on systems where Tavern Vault is connected.
  // A system with storage but no servers still gets a section.
  const storageOn = hasGlobal('storage.view') && !!state.vault?.enabled;
  const hasStorage = (nk) => storageOn && vaultFor(nk)?.state === 'ok';
  if (hasStorage('local') && !byNode.has('local')) byNode.set('local', { name: 'This System', servers: [] });
  for (const n of state.vault?.nodes ?? []) if (hasStorage(n.id) && !byNode.has(n.id)) byNode.set(n.id, { name: n.name, servers: [] });
  // Connected systems with no servers yet still show, with their CPU/RAM.
  for (const [id, st] of Object.entries(systemStats?.nodes ?? {})) if (st && !byNode.has(id)) byNode.set(id, { name: st.name, servers: [] });
  const multi = byNode.size > 1 || (byNode.size === 1 && !byNode.has('local'));
  const nodesInOrder = [...byNode].sort((a, b) => (a[0] === 'local' ? -1 : b[0] === 'local' ? 1 : a[1].name.localeCompare(b[1].name)));
  for (const [nk, info] of nodesInOrder) {
    if (multi) {
      const head = el('div', 'node-head');
      const offline = info.servers.some((s) => s.nodeOffline);
      head.append(el('span', `node-dot${offline ? ' off' : ''}`), el('span', null, info.name));
      if (offline) head.appendChild(el('span', 'node-state', 'offline'));
      nav.appendChild(head);
      // The whole system's CPU and RAM, under its name.
      const res = el('div', 'node-res');
      res.dataset.node = nk;
      fillSystemStats(res, nk === 'local' ? systemStats?.local : systemStats?.nodes?.[nk]);
      nav.appendChild(res);
    }
    if (hasStorage(nk)) nav.appendChild(storageLink(nk, info.name));
    renderGameGroups(nav, info.servers, nk);
  }
  if (!systemStats) updateSystemStats(true);
}

// ---------- storage (Tavern Vault) ----------

const STORAGE_STATE_TEXT = {
  missing: 'Needs Tavern Vault',
  off: 'Tavern Vault: node mode is off',
  nokey: 'Tavern Vault is starting…',
  down: 'Tavern Vault is not answering',
  old: 'Update Server Forge there (0.5.0+)',
  unreachable: 'System not reachable',
};
const vaultFor = (nk) => (nk === 'local' ? state.vault?.local : state.vault?.nodes?.find((n) => n.id === nk));

/** The "Storage" entry at the top of a system's section in the sidebar. */
function storageLink(nk, systemName) {
  const v = vaultFor(nk);
  const lvl = v?.state === 'ok' ? v.level : 'none';
  const a = el('a', `storage-link lvl-${lvl}${state.storage === nk ? ' active' : ''}`);
  a.href = `#storage:${nk}`;
  const icon = el('span', 'srv-icon side', '🗄');
  icon.appendChild(el('span', 'dot'));
  a.appendChild(icon);
  const text = el('div');
  text.appendChild(el('div', null, 'Storage'));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sub = !v ? 'Tavern Vault' : v.state === 'ok' ? `${plural(v.pools, 'pool')} · ${plural(v.arrays, 'array')}${v.problems ? ` · ${plural(v.problems, 'problem')}` : ''}${v.practice ? ' · practice' : ''}` : STORAGE_STATE_TEXT[v.state] ?? 'Tavern Vault';
  text.appendChild(el('div', 'sub', sub));
  a.appendChild(text);
  a.title = `${systemName}: drive pools, SnapRAID and drive health (Tavern Vault)`;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    showStorage(nk);
  });
  return a;
}

async function loadVaultSummary() {
  if (!hasGlobal('storage.view') && !hasGlobal('panel.settings')) return;
  try {
    state.vault = await api('GET', '/api/vault/summary');
    applyPanelName(state.vault.panel);
    renderSidebar();
    if (!$('settingsView').hidden) renderStorageSettings();
  } catch {}
}

const STORAGE_DOT = { ok: '🟢', warn: '🟠', crit: '🔴' };

/** Settings → Storage (Tavern Vault): the switch, and each system's state (with what's missing where it isn't ready). */
function renderStorageSettings() {
  const v = state.vault;
  if (!v) return;
  $('storageToggle').checked = !!v.enabled;
  $('storageToggle').disabled = !hasGlobal('panel.settings');
  const list = $('storageSystems');
  list.innerHTML = '';
  const row = (name, s) => {
    const div = el('div', `storage-sys${s.state === 'ok' ? ' ok' : ' warn'}`);
    div.appendChild(el('b', null, name));
    div.appendChild(
      el(
        'span',
        null,
        s.state === 'ok'
          ? `${STORAGE_DOT[s.level] ?? '🟢'} Tavern Vault connected · ${s.pools} pool${s.pools === 1 ? '' : 's'}, ${s.arrays} SnapRAID array${s.arrays === 1 ? '' : 's'}${s.problems ? ` · ${s.problems} problem${s.problems === 1 ? '' : 's'}` : ''}${v.enabled ? '' : ' (shows once Storage is on)'}`
          : `⚠ ${s.message}`,
      ),
    );
    list.appendChild(div);
  };
  if (v.local) row('This system', v.local);
  for (const n of v.nodes ?? []) row(n.name, n);
  if (v.enabled && !v.nodes?.length && v.local?.state !== 'ok') list.appendChild(el('p', 'muted small-text', 'Nothing to show in the list on the left yet: no system here has Tavern Vault connected.'));
}

$('storageToggle').addEventListener('change', async (e) => {
  try {
    await api('PUT', '/api/settings/storage', { enabled: e.target.checked });
    toast(e.target.checked ? 'Storage on: systems with Tavern Vault show it in the list on the left.' : 'Storage off.');
    if (!e.target.checked && state.storage) hideStorage();
    await loadVaultSummary();
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});
setInterval(() => !document.hidden && loadVaultSummary(), 30_000);
// The name also changes when this system's own servers come or go.
setInterval(() => !document.hidden && state.user && refreshPanelName(), 60_000);

/** Shows a system's storage: Tavern Vault's own page in a frame, or what's needed to get it. */
async function showStorage(nk) {
  state.storage = nk;
  state.selected = null;
  history.replaceState(null, '', `#storage:${nk}`);
  $('emptyState').hidden = true;
  $('settingsView').hidden = true;
  $('serverView').hidden = true;
  $('storageView').hidden = false;
  const name = nk === 'local' ? 'This System' : (state.vault?.nodes?.find((n) => n.id === nk)?.name ?? 'Node');
  $('storageTitle').textContent = `Storage · ${name}`;
  $('storageSub').textContent = 'Tavern Vault';
  renderSidebar();
  let v;
  try {
    v = await api('GET', nk === 'local' ? '/api/vault' : `/api/nodes/${encodeURIComponent(nk)}/vault`);
  } catch (err) {
    v = { state: 'unreachable', message: err.message };
  }
  if (state.storage !== nk) return;
  const frame = $('storageFrame');
  const need = $('storageNeed');
  if (v.state === 'ok') {
    need.hidden = true;
    const src = `/vault-ui/${nk === 'local' ? 'local' : `n-${nk}`}/`;
    if (frame.getAttribute('src') !== src) frame.src = src;
    frame.hidden = false;
    $('storageSub').textContent = `Tavern Vault ${v.status.version} on ${v.status.host}${v.status.practice ? ' · practice mode (changes are shown, not made)' : ''}`;
    return;
  }
  frame.hidden = true;
  frame.removeAttribute('src');
  need.innerHTML = '';
  need.hidden = false;
  const title = v.state === 'missing' ? `Storage on ${name} needs Tavern Vault` : v.state === 'old' ? `${name} needs a newer Server Forge` : v.state === 'unreachable' ? `Can't reach ${name}` : `Tavern Vault on ${name} isn't connected yet`;
  need.appendChild(el('h3', null, title));
  need.appendChild(el('p', null, v.message));
  if (v.state === 'missing' || v.state === 'off') {
    const ol = el('ol');
    if (v.state === 'missing') ol.appendChild(el('li', null, `Install Tavern Vault on ${name} (the system that has the drives).`));
    ol.appendChild(el('li', null, 'Open Tavern Vault → Settings → Node mode (show in Server Forge) and turn it on.'));
    ol.appendChild(el('li', null, 'Come back here: pools, drives and SnapRAID show up within a minute, with everything Tavern Vault can do.'));
    need.appendChild(ol);
    need.appendChild(
      el(
        'p',
        'muted small-text',
        nk === 'local'
          ? 'Tavern Vault is a separate app; Server Forge only shows it. Systems you manage as nodes are linked already (Settings → Nodes), so they need no extra code.'
          : `${name} is already linked to this panel as a node, so no new code is needed: its storage comes through the same link.`,
      ),
    );
  }
}

$('btnStorageReload').addEventListener('click', () => {
  const nk = state.storage;
  if (!nk) return;
  $('storageFrame').removeAttribute('src');
  loadVaultSummary();
  showStorage(nk);
});

/** Leaves the storage view (when a server or settings opens). */
function hideStorage() {
  state.storage = null;
  $('storageView').hidden = true;
}

/** "local" for this system's servers, the node id for servers on other systems. */
const nodeKey = (s) => s.node?.id ?? 'local';
/** The sidebar section a server is in: its system and its game. */
const sectionKey = (s) => `${nodeKey(s)}|${s.game}`;

function renderGameGroups(nav, servers, nk) {
  const groups = new Map();
  for (const s of servers) {
    const key = sectionKey(s);
    if (!groups.has(key)) groups.set(key, { name: s.gameName, servers: [] });
    groups.get(key).servers.push(s);
  }
  const firstPos = (g) => Math.min(...g.servers.map((s) => s.position ?? 0));
  const ordered = [...groups].sort((a, b) => firstPos(a[1]) - firstPos(b[1]));
  // Moving whole sections re-slots every server on that system, so it needs "change settings" on all of them.
  const canMoveGroups = ordered.length > 1 && servers.every((s) => s.permissions?.includes('settings.edit'));
  for (const [game, group] of ordered) {
    const section = el('div', 'server-group');
    // Keep the selected server visible even if its section was collapsed.
    const collapsed = collapsedGames.has(game) && !group.servers.some((s) => s.id === state.selected);
    const running = group.servers.filter((s) => ['running', 'starting'].includes(s.status)).length;
    const head = el('button', `group-head${collapsed ? ' collapsed' : ''}`);
    head.type = 'button';
    head.append(el('span', 'chevron', '▾'), el('span', 'group-name', group.name));
    head.append(el('span', 'group-count', running ? `${running}/${group.servers.length} on` : `${group.servers.length}`));
    head.title = `${collapsed ? 'Show these servers' : 'Hide these servers'}${canMoveGroups ? ' · drag to move this section' : ''}`;
    head.addEventListener('click', () => {
      if (collapsedGames.has(game)) collapsedGames.delete(game);
      else collapsedGames.add(game);
      saveCollapsed();
      renderSidebar();
    });
    if (canMoveGroups) enableGroupDrag(head, game, ordered.map(([g]) => g), nk);
    section.appendChild(head);
    if (!collapsed) {
      const inOrder = group.servers.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      // Servers behind a BungeeCord proxy in this section are listed under it instead of on their own.
      const here = new Set(group.servers.map((s) => s.id));
      const nested = (s) => here.has(proxyLinks.get(s.id)?.proxy.id);
      for (const s of inOrder) {
        if (nested(s)) continue;
        section.appendChild(serverLink(s, game));
        const kids = (proxyChildren.get(s.id) ?? []).filter((k) => here.has(k.server.id));
        if (!kids.length) continue;
        const box = el('div', 'proxy-children');
        for (const k of kids) box.appendChild(serverLink(k.server, game, { proxy: s, name: k.name }));
        section.appendChild(box);
      }
    }
    nav.appendChild(section);
  }
}

/** Drag a section header onto another one to move that game's servers (as a block) above or below it. */
function enableGroupDrag(head, game, groupOrder, nk) {
  head.draggable = true;
  head.addEventListener('dragstart', (e) => {
    dragging = { group: game };
    head.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', game);
  });
  head.addEventListener('dragend', () => {
    dragging = null;
    head.classList.remove('dragging');
    clearDropMarks();
    if (sidebarPending) renderSidebar();
  });
  head.addEventListener('dragover', (e) => {
    if (!dragging?.group || dragging.group === game) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = head.getBoundingClientRect();
    clearDropMarks();
    head.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop-before', 'drop-after'));
  head.addEventListener('drop', async (e) => {
    if (!dragging?.group || dragging.group === game) return;
    e.preventDefault();
    const after = head.classList.contains('drop-after');
    const moved = dragging.group;
    dragging = null;
    clearDropMarks();
    const order = groupOrder.filter((g) => g !== moved);
    order.splice(order.indexOf(game) + (after ? 1 : 0), 0, moved);
    // Every server on this system, section by section, keeping each section's own order.
    const byPos = [...state.servers.values()].filter((s) => nodeKey(s) === nk).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const ids = order.flatMap((g) => byPos.filter((s) => sectionKey(s) === g).map((s) => s.id));
    ids.forEach((id, n) => (state.servers.get(id).position = n));
    renderSidebar();
    try {
      await api('PUT', '/api/server-order', { ids });
    } catch (err) {
      toast(err.message, true);
      for (const x of await api('GET', '/api/servers')) state.servers.set(x.id, x);
      renderSidebar();
    }
  });
}

// ---------- drag to reorder (within a game's section) ----------

let dragging = null; // { id, game }
let sidebarPending = false;

function clearDropMarks() {
  for (const n of document.querySelectorAll('#serverList .drop-before, #serverList .drop-after')) n.classList.remove('drop-before', 'drop-after');
}

function enableDrag(a, s, game) {
  a.draggable = true;
  a.title = 'Drag to change the order';
  a.addEventListener('dragstart', (e) => {
    dragging = { id: s.id, game };
    a.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', s.id);
  });
  a.addEventListener('dragend', () => {
    dragging = null;
    a.classList.remove('dragging');
    clearDropMarks();
    if (sidebarPending) renderSidebar();
  });
  a.addEventListener('dragover', (e) => {
    if (!dragging || dragging.game !== game || dragging.id === s.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = a.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    a.classList.add(after ? 'drop-after' : 'drop-before');
  });
  a.addEventListener('dragleave', () => a.classList.remove('drop-before', 'drop-after'));
  a.addEventListener('drop', async (e) => {
    if (!dragging || dragging.game !== game || dragging.id === s.id) return;
    e.preventDefault();
    const after = a.classList.contains('drop-after');
    const moved = dragging.id;
    dragging = null;
    clearDropMarks();
    const ids = [...state.servers.values()]
      .filter((x) => sectionKey(x) === game)
      .sort((x, y) => (x.position ?? 0) - (y.position ?? 0))
      .map((x) => x.id)
      .filter((id) => id !== moved);
    ids.splice(ids.indexOf(s.id) + (after ? 1 : 0), 0, moved);
    // Show the new order straight away; the panel confirms it over the live stream.
    const slots = ids.map((id) => state.servers.get(id).position ?? 0).sort((x, y) => x - y);
    ids.forEach((id, n) => (state.servers.get(id).position = slots[n]));
    renderSidebar();
    try {
      await api('PUT', '/api/server-order', { ids });
    } catch (err) {
      toast(err.message, true);
      for (const x of await api('GET', '/api/servers')) state.servers.set(x.id, x);
      renderSidebar();
    }
  });
}

/** `child`: shown under its BungeeCord proxy ({ proxy, name } = the proxy and its name for this server there). */
function serverLink(s, game, child = null) {
  const a = el('a');
  a.href = `#${s.id}`;
  a.className = `s-${s.status}${s.id === state.selected ? ' active' : ''}${child ? ' proxy-child' : ''}`;
  // Servers under a proxy follow it; the order is changed by dragging the proxy.
  if (!child && s.permissions?.includes('settings.edit')) enableDrag(a, s, game);
  // Type icon with the status dot on its corner.
  const icon = serverIcon(s, 'srv-icon side');
  icon.appendChild(el('span', 'dot'));
  a.appendChild(icon);
  const text = el('div');
  text.appendChild(el('div', null, s.name));
  const players = s.status === 'running' ? ` · ${s.live.playerCount ?? 0} online` : '';
  // Server type: the Java flavour (Paper, Fabric...) or the game.
  const kind =
    s.game === 'java'
      ? `Java · ${JAVA_FLAVOR_NAMES[s.settings?.flavor] ?? 'Custom jar'}`
      : `${s.gameName.replace(/^Minecraft /, '')}${s.modded ? ' · Modded' : ''}${s.game === 'bedrock' && s.settings?.software === 'endstone' ? ' · Endstone' : ''}`;
  // Behind a proxy: its name in the proxy, or (when shown elsewhere, e.g. on another system) which proxy.
  const linked = proxyLinks.get(s.id);
  const via = child ? ` · "${child.name}"` : linked ? ` · via ${linked.proxy.name}` : '';
  const backends = proxyChildren.get(s.id)?.length;
  const count = backends ? ` · ${backends} server${backends === 1 ? '' : 's'}` : '';
  text.appendChild(el('div', 'sub', `${kind}${count}${via} · ${STATUS_LABEL[s.status]}${players}`));
  if (linked) a.title = `Behind BungeeCord "${linked.proxy.name}" as "${linked.name}" (${linked.address})`;
  // Mini CPU/RAM view (filled in by updateSidebarStats) for servers that are running.
  if (['running', 'starting', 'stopping'].includes(s.status)) {
    const mini = el('div', 'mini-res');
    mini.dataset.server = s.id;
    fillMiniStats(mini, sidebarStats[s.id]);
    text.appendChild(mini);
  }
  a.appendChild(text);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    selectServer(s.id);
  });
  return a;
}

async function selectServer(id) {
  state.selected = id;
  history.replaceState(null, '', `#${id}`);
  state.detail = await api('GET', `/api/servers/${id}`);
  state.list = null;
  hideStorage();
  $('emptyState').hidden = true;
  $('settingsView').hidden = true;
  $('serverView').hidden = false;
  applyPermVisibility($('serverView'));
  $('tabBtnProperties').hidden = !state.detail.hasProperties;
  $('tabBtnProperties').textContent = state.detail.propertiesLabel ?? 'Properties';
  $('tabBtnBackups').hidden = !state.detail.canBackup;
  if (state.tab === 'backups' && !state.detail.canBackup) state.tab = 'overview';
  $('tabBtnAddons').hidden = !state.detail.hasAddons;
  $('tabBtnAddons').textContent = state.detail.addonsTab ?? 'Addons';
  if (state.tab === 'addons' && !state.detail.hasAddons) state.tab = 'overview';
  $('tabBtnPlugins').hidden = !state.detail.hasPlugins;
  if (state.tab === 'plugins' && !state.detail.hasPlugins) state.tab = 'overview';
  if (state.tab === 'console' && !hasPerm('console.view')) state.tab = 'overview';
  if (state.tab === 'properties' && !state.detail.hasProperties) state.tab = 'overview';
  if (state.tab === 'files' && !hasPerm('files.view')) state.tab = 'overview';
  $('tabBtnWorld').hidden = !state.detail.hasWorld;
  if (state.tab === 'world' && !state.detail.hasWorld) state.tab = 'overview';
  $('tabBtnWorlds').hidden = !state.detail.hasWorlds;
  if (state.tab === 'worlds' && !state.detail.hasWorlds) state.tab = 'overview';
  $('tabBtnChat').hidden = !state.detail.hasChat;
  if (state.tab === 'chat' && !state.detail.hasChat) state.tab = 'overview';
  if (sf.server !== id) Object.assign(sf, { server: id, path: '' });
  renderSidebar();
  renderHeader();
  setTab(state.tab);
}

// ---------- header + controls ----------

function renderHeader() {
  const d = state.detail;
  $('svName').textContent = d.name;
  $('svGame').textContent = `${d.game === 'java' ? `Java · ${JAVA_FLAVOR_NAMES[d.settings?.flavor] ?? 'Custom jar'}` : `${d.gameName}${d.modded ? ' · Modded' : ''}`}${d.node ? ` · on ${d.node.name}` : ''}`;
  $('svGame').classList.toggle('modded', !!d.modded);
  const iconKeyNow = `${d.id}:${d.settings?.flavor ?? ''}`;
  if ($('svIcon').dataset.key !== iconKeyNow) {
    $('svIcon').replaceChildren(serverIcon(d, 'srv-icon big'));
    $('svIcon').dataset.key = iconKeyNow;
  }
  renderConnStrip();
  const pill = $('svStatus');
  pill.className = `pill s-${d.status}`;
  pill.textContent = STATUS_LABEL[d.status];
  const meta = [];
  if (d.startedAt && d.status !== 'stopped') meta.push(`up ${duration(Date.now() - d.startedAt)}`);
  if (d.pid) meta.push(`PID ${d.pid}`);
  meta.push(d.installDir);
  $('svMeta').textContent = meta.join(' · ');
  const conflict = d.folderConflict
    ? `Shared folder: ${d.folderConflict}. This panel won't start, update or delete this server. Give it its own folder, or remove it from this panel (without deleting files).`
    : '';
  $('svError').hidden = !d.lastError && !conflict;
  $('svError').textContent = [conflict, d.lastError].filter(Boolean).join('\n');
  const busy = d.status === 'starting' || d.status === 'stopping' || d.status === 'installing';
  const running = d.status === 'running' || d.status === 'starting';
  $('btnStart').disabled = busy || running;
  $('btnStop').disabled = ['stopped', 'crashed', 'stopping', 'installing'].includes(d.status);
  $('btnRestart').disabled = busy;
  $('btnCountdown').hidden = !d.canCommand;
  // Moving needs somewhere to move to: another system that can take it (see moveTargets).
  $('btnMove').hidden = !hasGlobal('servers.create') || !moveTargets(d).length;
  $('btnCountdown').disabled = busy || !running || !!d.countdown;
  renderCountdown();
}

for (const action of ['start', 'stop', 'restart']) {
  $(`btn${action[0].toUpperCase()}${action.slice(1)}`).addEventListener('click', async () => {
    const go = (body) => api('POST', `/api/servers/${state.selected}/${action}`, body);
    try {
      try {
        await go();
      } catch (err) {
        // 428: a check before starting found a problem (world database damaged, or the server already running from
        // another program). Starting anyway is possible, but it's the owner's call.
        if (err.status !== 428) throw err;
        if (!await confirmBox(`${err.message}\n\nStart anyway?`)) return;
        await go({ force: true });
      }
      toast(action === 'stop' ? 'Stopping (the world is saved first)…' : `${action[0].toUpperCase()}${action.slice(1)}ing…`);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// Countdown: warn players, then restart/stop (Minecraft servers; Valheim has no way to message players).
$('btnCountdown').addEventListener('click', () => {
  $('countdownForm').reset();
  $('cdMinutes').value = '5';
  $('countdownDialog').showModal();
});
$('cdCancel').addEventListener('click', () => $('countdownDialog').close());
$('countdownForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const action = $('cdAction').value;
  try {
    await api('POST', `/api/servers/${state.selected}/${action}`, { countdownMinutes: Number($('cdMinutes').value), message: $('cdMessage').value.trim() || undefined });
    $('countdownDialog').close();
    toast(`${action === 'restart' ? 'Restart' : 'Stop'} in ${$('cdMinutes').selectedOptions[0].textContent}; players are being warned.`);
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnCancelCountdown').addEventListener('click', async () => {
  try {
    await api('POST', `/api/servers/${state.selected}/countdown/cancel`);
    toast('Countdown cancelled');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderCountdown() {
  const c = state.detail?.countdown;
  $('svCountdown').hidden = !c;
  if (!c) return;
  const left = Math.max(0, Math.round((c.endsAt - Date.now()) / 1000));
  $('svCountdownText').textContent = `${c.action === 'restart' ? 'Restarting' : 'Stopping'} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${c.reason ? ` · ${c.reason}` : ''} · players are being warned`;
}

setInterval(() => state.detail && renderHeader(), 1000);

// Address, players and uptime under the server name (visible on every tab).
function renderConnStrip() {
  const d = state.detail;
  const strip = $('svConn');
  strip.innerHTML = '';
  const c = d.connection;
  // IP and port as separate chips; click either to copy it.
  const copyChip = (label, value, title) => {
    const chip = el('button', 'conn-chip copy');
    chip.type = 'button';
    chip.title = title;
    chip.append(el('span', 'chip-label', label), document.createTextNode(String(value)));
    chip.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(value));
        toast(`Copied ${value}`);
      } catch {
        toast(String(value));
      }
    });
    return chip;
  };
  if (c?.port) {
    const crossplay = d.game === 'valheim' && (d.settings?.crossplay === true || d.settings?.crossplay === 'true');
    strip.appendChild(
      copyChip(
        'IP:',
        c.ip,
        crossplay
          ? "This system's address on your network. With crossplay on, Valheim can't be joined by this address, even on your own network: use the join code or your public IP (or turn crossplay off). Click to copy."
          : "This system's address on your network. Click to copy. Players outside your network need your public IP and a port forward.",
      ),
    );
    strip.appendChild(copyChip('Port:', c.port, `${c.protocol} port. Click to copy.`));
  }
  const running = d.status === 'running';
  const count = running ? d.live.playerCount ?? 0 : 0;
  strip.appendChild(el('span', 'conn-chip', `👥 ${running ? count : '–'}${c?.maxPlayers ? ` / ${c.maxPlayers}` : ''} online`));
  if (d.startedAt && ['running', 'starting'].includes(d.status)) strip.appendChild(el('span', 'conn-chip', `⏱ up ${duration(Date.now() - d.startedAt)}`));
  if (d.live?.extra?.joinCode && running) strip.appendChild(el('span', 'conn-chip', `🔑 join code ${d.live.extra.joinCode}`));
  if (c?.port) {
    const help = el('button', 'conn-chip copy', '🌐 Port forwarding');
    help.type = 'button';
    help.title = 'Which ports to forward on your router so players outside your network can join';
    help.addEventListener('click', () => openPortsHelp(d.id));
    strip.appendChild(help);
  }
}

// ---------- port forwarding help ----------

async function openPortsHelp(id) {
  const body = $('portsBody');
  body.innerHTML = '';
  body.appendChild(el('p', 'muted', 'Loading…'));
  $('portsDialog').showModal();
  let h;
  try {
    h = await api('GET', `/api/servers/${id}/ports`);
  } catch (err) {
    body.innerHTML = '';
    return body.appendChild(el('p', 'error', err.message));
  }
  body.innerHTML = '';
  for (const p of h.problems) {
    const row = el('div', 'warn-banner');
    row.appendChild(el('div', null, p.text));
    if (p.fix && hasPerm('properties.edit')) {
      const b = el('button', 'small primary', p.fix.label);
      b.style.marginTop = '8px';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await api('PUT', `/api/servers/${id}/properties`, { values: { [p.fix.key]: p.fix.value } });
          toast(state.servers.get(id)?.status === 'running' ? 'Saved. Restart the server to use it.' : 'Saved.');
          openPortsHelp(id);
        } catch (err) {
          b.disabled = false;
          toast(err.message, true);
        }
      });
      row.appendChild(b);
    }
    body.appendChild(row);
  }
  const table = el('table', 'table');
  const head = el('tr');
  for (const t of ['Protocol', 'Outside port(s)', 'Forward to', 'What for']) head.appendChild(el('th', null, t));
  const thead = el('thead');
  thead.appendChild(head);
  const tbody = el('tbody');
  for (const f of h.forwards) {
    const tr = el('tr');
    tr.append(el('td', null, f.protocol), el('td', 'mono', f.ports), el('td', 'mono', `${h.lanIp} (same ports)`), el('td', 'muted', f.why));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  body.appendChild(el('h4', 'section-label', 'Forward these on your router'));
  body.appendChild(table);
  const facts = el('div', 'ports-facts');
  facts.appendChild(el('div', null, `This system on your network: ${h.lanIp}`));
  facts.appendChild(el('div', null, h.publicIp ? `Your public IP: ${h.publicIp}` : "Your public IP: couldn't look it up right now"));
  if (h.joinAddress) facts.appendChild(el('div', null, `Players outside your network join: ${h.joinAddress}`));
  body.appendChild(facts);
  const tips = [
    ...h.notes,
    'Give this system a fixed address on your network (a "DHCP reservation" in the router), or the forward stops working when its address changes.',
    'Your public IP can change now and then. Server Forge warns you when it does.',
    'Test from outside your network (e.g. a phone on mobile data), not from this system.',
  ];
  const ul = el('ul', 'muted small-text');
  for (const t of tips) ul.appendChild(el('li', null, t));
  body.appendChild(ul);
}
$('portsClose').addEventListener('click', () => $('portsDialog').close());

// ---------- tabs ----------

$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

function setTab(tab) {
  state.tab = tab;
  for (const b of $('tabs').children) b.classList.toggle('active', b.dataset.tab === tab);
  if (tab === 'players') renderPlayersTab();
  if (tab === 'tasks') loadTasks();
  // The Plugins tab (Endstone) uses the Addons panel with the plugins manager.
  const panel = tab === 'plugins' ? 'addons' : tab;
  for (const t of ['overview', 'players', 'tasks', 'console', 'chat', 'settings', 'properties', 'backups', 'addons', 'world', 'worlds', 'access', 'files']) $(`tab-${t}`).hidden = t !== panel;
  if (tab === 'worlds') loadWorlds();
  if (tab === 'world') loadWorld();
  if (tab === 'chat') loadChat();
  if (tab === 'files') openServerFiles();
  if (tab === 'backups') loadBackups();
  if (tab === 'addons' || tab === 'plugins') {
    addonKind = tab;
    loadAddons();
  }
  if (tab === 'overview') renderOverview();
  if (tab === 'console') renderConsole();
  if (tab === 'settings') renderSettings();
  if (tab === 'properties') loadProperties();
  if (tab === 'access') renderAccess();
}

// ---------- overview ----------

function renderJob() {
  const job = state.detail?.job;
  // Show a running job, or a failed one so the error stays visible; hide finished ones after a moment.
  const show = job && (job.status !== 'done' || Date.now() - (job.finishedAt ?? 0) < 15_000);
  $('jobCard').hidden = !show;
  if (!show) return;
  $('jobTitle').textContent = job.status === 'failed' ? `${job.title} failed` : job.status === 'done' ? `${job.title}: done` : job.title;
  const known = job.progress != null;
  $('jobPercent').textContent = known && job.status === 'running' ? `${Math.round(job.progress)}%` : '';
  $('jobBar').parentElement.classList.toggle('indeterminate', job.status === 'running' && !known);
  $('jobBar').style.width = job.status === 'done' ? '100%' : known ? `${job.progress}%` : '';
  $('jobStep').textContent = job.status === 'done' ? 'Ready. Press Start when you want to run it.' : job.step;
  $('jobError').textContent = job.status === 'failed' ? `${job.error} You can try again from Settings → Update server software.` : '';
}

let detailsRefreshed = 0;
// ---------- resources (CPU / RAM on the Overview tab) ----------

function fmtMem(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Time scales for the graphs (seconds).
const RANGES = [
  [30, '30s'],
  [60, '1m'],
  [300, '5m'],
  [900, '15m'],
  [1800, '30m'],
  [3600, '1h'],
  [10800, '3h'],
  [28800, '8h'],
  [86400, '24h'],
];
let statsRange = (() => {
  try {
    return Number(localStorage.getItem('th-stats-range')) || 300;
  } catch {
    return 300;
  }
})();

// The same time scale is used on the Overview and Players tabs.
function renderRangePicker(boxId = 'resRange', onChange = renderResources) {
  const box = $(boxId);
  if (!box.childElementCount) {
    for (const [secs, label] of RANGES) {
      const b = el('button', 'small', label);
      b.type = 'button';
      b.dataset.range = secs;
      b.addEventListener('click', () => {
        statsRange = secs;
        try {
          localStorage.setItem('th-stats-range', String(secs));
        } catch {}
        renderRangePicker(boxId, onChange);
        onChange();
      });
      box.appendChild(b);
    }
  }
  for (const b of box.children) b.classList.toggle('active', Number(b.dataset.range) === statsRange);
}

// ---------- Players tab ----------

function playerHead(game, p) {
  // Java: real skin heads. Mojang UUIDs are version 4; offline-mode servers make up version-3 UUIDs, so use the name.
  if (game === 'java') {
    const img = el('img', 'head');
    img.alt = '';
    img.loading = 'lazy';
    const id = p.id && /^[0-9a-f]{8}-?[0-9a-f]{4}-?4/i.test(p.id) ? p.id.replace(/-/g, '') : encodeURIComponent(p.name);
    img.src = `https://mc-heads.net/avatar/${id}/40`;
    img.addEventListener('error', () => img.replaceWith(letterHead(p.name)), { once: true });
    return img;
  }
  return letterHead(p.name);
}

function letterHead(name) {
  const span = el('span', 'head letter', (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase());
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  span.style.background = `hsl(${h} 45% 38%)`;
  return span;
}

function fmtAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  return `${duration(Date.now() - t)} ago`;
}

function fmtPlaytime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function renderPlayersTab() {
  if (state.tab !== 'players' || !state.selected) return;
  renderRangePicker('plRange', renderPlayersTab);
  let data;
  let st;
  try {
    [data, st] = await Promise.all([api('GET', `/api/servers/${state.selected}/players`), api('GET', `/api/servers/${state.selected}/stats?range=${statsRange}`)]);
  } catch (err) {
    return toast(err.message, true);
  }
  const online = data.players.filter((p) => p.online);
  $('plNow').textContent = data.running ? `${online.length}${data.maxPlayers ? ` / ${data.maxPlayers}` : ''} now` : '(server not running)';
  const peak = Math.max(0, ...st.history.map((h) => h.players ?? 0));
  drawGraph($('plGraph'), st.history.map((h) => ({ t: h.t, v: h.players })), Math.max(data.maxPlayers ?? 0, peak, 1), st.range, st.step, true);
  const rangeLabel = RANGES.find(([s]) => s === st.range)?.[1] ?? '';
  $('plAxisL').textContent = `${rangeLabel} ago`;
  $('plPeak').textContent = `peak ${peak}`;

  $('plCount').textContent = data.players.length ? `${data.players.length}` : '';
  $('plHelp').textContent =
    data.game === 'java'
      ? 'Everyone who has joined since Server Forge started tracking. Heads come from mc-heads.net.'
      : data.game === 'bedrock'
        ? "Everyone who has joined since Server Forge started tracking. Bedrock doesn't share player skins, so players are shown by name."
        : 'Everyone who has joined since Server Forge started tracking. Use Actions to make someone an admin (F5 console in-game), ban them or put them on the allow list: no IDs to look up.';
  const list = $('plList');
  list.innerHTML = '';
  if (!data.players.length) list.appendChild(el('p', 'muted', 'Nobody has joined yet.'));
  const showHeads = data.game !== 'valheim';
  // Several names on one account ID (Valheim: one Steam/Xbox account playing several characters). Valheim's admin,
  // ban and allow lists hold account IDs, so those actions apply to all of that account's characters.
  const byId = new Map();
  for (const p of data.players) if (p.id) byId.set(p.id, [...(byId.get(p.id) ?? []), p.name]);
  const others = (p) => (p.id ? byId.get(p.id).filter((n) => n !== p.name) : []);
  for (const p of data.players) {
    const row = el('div', `player-row${p.online ? ' online' : ''}`);
    if (showHeads) row.appendChild(playerHead(data.game, p));
    const who = el('div', 'who');
    const nameLine = el('b', null, p.name);
    if (p.muted) nameLine.appendChild(el('span', 'type-badge bad', 'Muted'));
    // Valheim list files
    if (p.admin) nameLine.appendChild(el('span', 'type-badge role-admin', 'Admin'));
    if (p.banned) nameLine.appendChild(el('span', 'type-badge bad', 'Banned'));
    if (p.permitted && p.allowListOn) nameLine.appendChild(el('span', 'type-badge', 'Allowed'));
    who.appendChild(nameLine);
    if (p.id) who.appendChild(el('span', 'muted small-text mono', p.id));
    if (others(p).length) who.appendChild(el('span', 'pl-shared small-text', `Same ${accountKind(p.id)} account as ${others(p).join(', ')}`));
    if (p.note) who.appendChild(el('span', 'pl-note', `📝 ${p.note}`));
    row.appendChild(who);
    row.appendChild(el('span', `pl-status${p.online ? ' on' : ''}`, p.online ? `● online${p.joinedAt ? ` · ${duration(Date.now() - p.joinedAt)}` : ''}` : `last seen ${fmtAgo(p.lastSeen)}`));
    row.appendChild(el('span', 'muted small-text', `${p.joins} join${p.joins === 1 ? '' : 's'} · ${fmtPlaytime(p.playSeconds)} played`));
    row.appendChild(el('span', 'muted small-text', `first seen ${new Date(p.firstSeen).toLocaleDateString()}`));
    if (data.canManage) row.appendChild(playerActionMenu(p, data, others(p)));
    list.appendChild(row);
  }
}

/** "Steam" for "Steam_7656…", "Xbox" for "Xbox_…" (Valheim's platform IDs); "game" otherwise. */
function accountKind(id) {
  return /^(Steam|Xbox|PlayStation)_/.exec(id ?? '')?.[1] ?? 'game';
}

const PLAYER_ACTION_LABELS = {
  kick: 'Kick…',
  op: 'Make operator',
  deop: 'Remove operator',
  'allowlist-add': 'Add to allowlist',
  'allowlist-remove': 'Remove from allowlist',
  'whitelist-add': 'Add to whitelist',
  'whitelist-remove': 'Remove from whitelist',
  ban: 'Ban…',
  pardon: 'Unban (pardon)',
  mute: 'Mute in chat',
  unmute: 'Unmute',
  note: 'Edit note…',
  // Valheim (list files: work whether or not the server is running)
  'admin-add': 'Make admin',
  'admin-remove': 'Remove admin',
  'list-ban': 'Ban',
  'list-unban': 'Unban',
  'permit-add': 'Add to allow list',
  'permit-remove': 'Remove from allow list',
};
const LIST_ACTIONS = new Set(['admin-add', 'admin-remove', 'list-ban', 'list-unban', 'permit-add', 'permit-remove']);

/** "Actions" dropdown for one player: only what this game and this player's state allow. */
function playerActionMenu(p, data, sameAccount = []) {
  const sel = el('select', 'pl-actions');
  sel.appendChild(new Option('Actions…', ''));
  for (const a of data.actions) {
    if (a === 'kick' && !p.online) continue;
    if (a === 'mute' && p.muted) continue;
    if (a === 'unmute' && !p.muted) continue;
    // Valheim list actions: only the one that changes something for this player.
    if ((a === 'admin-add' && p.admin) || (a === 'admin-remove' && !p.admin)) continue;
    if ((a === 'list-ban' && p.banned) || (a === 'list-unban' && !p.banned)) continue;
    if ((a === 'permit-add' && p.permitted) || (a === 'permit-remove' && !p.permitted)) continue;
    // Console commands need the server running; notes, mutes and Valheim's list files can be changed any time.
    const needsRunning = !['note', 'mute', 'unmute'].includes(a) && !LIST_ACTIONS.has(a);
    const opt = new Option(PLAYER_ACTION_LABELS[a] ?? a, a);
    if (needsRunning && !data.running) opt.disabled = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', async () => {
    const a = sel.value;
    sel.value = '';
    if (!a) return;
    const body = { action: a };
    if (a === 'kick' || a === 'ban') {
      const reason = await ask(`${a === 'kick' ? 'Kick' : 'Ban'} ${p.name}. Reason (optional, shown to them):`, '');
      if (reason === null) return;
      body.reason = reason;
    } else if (a === 'note') {
      const note = await ask(`Note about ${p.name} (only admins see this; empty to clear):`, p.note ?? '');
      if (note === null) return;
      body.note = note;
    } else if (!['mute', 'unmute'].includes(a) && !(await confirmBox(playerActionQuestion(a, p, sameAccount), PLAYER_ACTION_LABELS[a].replace('…', '')))) return;
    try {
      const r = await api('POST', `/api/servers/${state.selected}/players/${encodeURIComponent(p.name)}/action`, body);
      toast(r?.message ?? (a === 'note' ? 'Note saved' : a === 'mute' ? `${p.name} is muted (their messages are held back)` : `${PLAYER_ACTION_LABELS[a].replace('…', '')}: ${p.name}`));
      renderPlayersTab();
    } catch (err) {
      toast(err.message, true);
    }
  });
  return sel;
}

// What a Valheim list action also does to the account's other characters (the lists hold account IDs, not names).
// [one other character, several]
const LIST_ACTION_TOO = {
  'admin-add': ['becomes an admin too', 'become admins too'],
  'admin-remove': ['stops being an admin too', 'stop being admins too'],
  'list-ban': ['is banned too', 'are banned too'],
  'list-unban': ['is unbanned too', 'are unbanned too'],
  'permit-add': ['goes on the allow list too', 'go on the allow list too'],
  'permit-remove': ['comes off the allow list too', 'come off the allow list too'],
};

function playerActionQuestion(a, p, sameAccount) {
  const q = `${PLAYER_ACTION_LABELS[a].replace('…', '')}: ${p.name}?`;
  if (!LIST_ACTION_TOO[a] || !sameAccount.length) return q;
  const [one, several] = LIST_ACTION_TOO[a];
  const names = sameAccount.length > 1 ? `${sameAccount.slice(0, -1).join(', ')} and ${sameAccount.at(-1)}` : sameAccount[0];
  const who = sameAccount.length > 1 ? `they ${several}` : `that character ${one}`;
  return `${q}\n\nValheim's lists work by ${accountKind(p.id)} account, not by character. This account (${p.id}) also plays as ${names}: ${who}.`;
}

// Live refresh, except while someone is using an Actions menu or answering a dialog (rebuilding the list would close
// the open menu, or act on a list that changed under them).
setInterval(() => {
  if (state.tab !== 'players' || document.hidden) return;
  if (document.activeElement?.matches?.('#plList select') || document.querySelector('dialog[open]')) return;
  renderPlayersTab();
}, 5000);

/**
 * Draws a time-based line graph: x = time over the chosen range (now at the right), y = value / max.
 * Points further apart than a few steps are gaps (the server was off), so the line breaks there.
 */
function drawGraph(svg, points, max, rangeSec, stepSec, stepped = false) {
  svg.innerHTML = '';
  const W = 1000;
  const now = Date.now();
  const x = (t) => W - ((now - t) / (rangeSec * 1000)) * W;
  const y = (v) => 40 - Math.min(1, v / (max || 1)) * 37 - 1.5;
  const ns = 'http://www.w3.org/2000/svg';
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p.v == null) continue;
    if (run.length && p.t - run[run.length - 1].t > stepSec * 1000 * 3.5) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    let coords = [];
    for (const [i, p] of r.entries()) {
      if (stepped && i > 0) coords.push([x(p.t), y(r[i - 1].v)]);
      coords.push([x(p.t), y(p.v)]);
    }
    if (coords.length === 1) coords = [[coords[0][0] - 3, coords[0][1]], coords[0]];
    const line = coords.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', `${coords[0][0].toFixed(1)},40 ${line} ${coords[coords.length - 1][0].toFixed(1)},40`);
    area.setAttribute('class', 'area');
    const poly = document.createElementNS(ns, 'polyline');
    poly.setAttribute('points', line);
    poly.setAttribute('class', 'line');
    svg.append(area, poly);
  }
}

/** Online/offline band for the uptime card. */
function drawUptimeStrip(box, points, rangeSec, stepSec) {
  box.innerHTML = '';
  const now = Date.now();
  const start = now - rangeSec * 1000;
  let segStart = null;
  let prev = null;
  const segs = [];
  for (const p of points) {
    if (prev && p.t - prev > stepSec * 1000 * 3.5) {
      segs.push([segStart, prev]);
      segStart = null;
    }
    if (segStart == null) segStart = p.t - stepSec * 1000;
    prev = p.t;
  }
  if (segStart != null) segs.push([segStart, prev]);
  for (const [a, b] of segs) {
    const seg = el('span');
    const left = Math.max(0, (a - start) / (rangeSec * 1000));
    const right = Math.min(1, (b - start) / (rangeSec * 1000));
    seg.style.left = `${(left * 100).toFixed(2)}%`;
    seg.style.width = `${Math.max(0.3, (right - left) * 100).toFixed(2)}%`;
    box.appendChild(seg);
  }
  const online = segs.reduce((a, [s, e]) => a + (Math.min(e, now) - Math.max(s, start)), 0);
  return Math.max(0, Math.min(1, online / (rangeSec * 1000)));
}

function setBar(bar, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  bar.style.width = `${(f * 100).toFixed(1)}%`;
  bar.className = f > 0.9 ? 'hot' : f > 0.75 ? 'warm' : '';
}

async function renderResources() {
  if (!state.selected || state.tab !== 'overview') return;
  renderRangePicker();
  let st;
  try {
    st = await api('GET', `/api/servers/${state.selected}/stats?range=${statsRange}`);
  } catch {
    return;
  }
  const on = st.running && st.cpu != null;
  const rangeLabel = RANGES.find(([s]) => s === st.range)?.[1] ?? '';
  $('resNote').textContent = st.running ? (st.cpu == null ? 'measuring…' : `live, every ${st.intervalSeconds} s`) : '(server not running)';
  const hist = st.history;
  const graph = (id, key, max, stepped) => drawGraph($(id), hist.map((h) => ({ t: h.t, v: h[key] })), max, st.range, st.step, stepped);

  // Uptime
  $('resUptime').textContent = st.running && st.startedAt ? duration(Date.now() - st.startedAt) : 'offline';
  const share = drawUptimeStrip($('resUptimeStrip'), hist, st.range, st.step);
  $('resUptimeSub').textContent = `Online ${Math.round(share * 100)}% of the last ${rangeLabel}.`;
  $('resAxisL').textContent = `${rangeLabel} ago`;

  // Players
  const peak = Math.max(0, ...hist.map((h) => h.players ?? 0));
  $('resPlayers').textContent = st.running ? `${st.players ?? 0}${st.maxPlayers ? ` / ${st.maxPlayers}` : ''}` : '–';
  graph('resPlayersGraph', 'players', Math.max(st.maxPlayers ?? 0, peak, 1), true);
  $('resPlayersSub').textContent = `Peak ${peak} in the last ${rangeLabel}.`;

  // CPU
  $('resCpu').textContent = on ? `${st.cpu.toFixed(1)}%` : '–';
  setBar($('resCpuBar'), on ? st.cpu / 100 : 0);
  $('resCpuSub').textContent = `Share of the whole system (${st.cores} logical cores).${st.range > 3600 ? ' Longer ranges show 1-minute averages.' : ''}`;
  graph('resCpuGraph', 'cpu', Math.max(10, ...hist.map((h) => h.cpu)));

  // RAM
  const limitBytes = st.limit?.bytes ?? st.systemMem;
  $('resMem').textContent = on ? `${fmtMem(st.mem)} / ${fmtMem(limitBytes)}` : `– / ${fmtMem(limitBytes)}`;
  setBar($('resMemBar'), on ? st.mem / limitBytes : 0);
  $('resMemSub').textContent = st.limit ? `Limit: ${st.limit.label} (${fmtMem(st.limit.bytes)}). ${st.limit.note}` : st.noLimitNote;
  graph('resMemGraph', 'mem', limitBytes);
}
setInterval(renderResources, 3000);

// ---------- crash checker (Java, Bedrock) ----------

let diagShownAt = null;
function renderDiagnosis() {
  const d = state.detail;
  $('btnDiagnoseConsole').hidden = !d.canDiagnose;
  const diag = d.diagnosis;
  $('ovDiagCard').hidden = !d.canDiagnose || !diag;
  if (!diag || diagShownAt === diag.at) return;
  diagShownAt = diag.at;
  $('diagWhen').textContent = `${new Date(diag.at).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}${diag.sources.length ? ` · read ${diag.sources.join(', ')}` : ''}`;
  const box = $('diagList');
  box.innerHTML = '';
  if (diag.description) box.appendChild(el('p', 'muted small-text', `Crash report: "${diag.description}"`));
  for (const f of diag.findings) {
    const item = el('div', `diag ${f.severity}`);
    item.appendChild(el('div', 'diag-title', `${f.severity === 'error' ? '⛔' : f.severity === 'warn' ? '⚠' : 'ℹ'} ${f.title}`));
    item.appendChild(el('div', 'diag-detail', f.detail));
    item.appendChild(el('div', 'diag-fix', `Fix: ${f.fix}`));
    if (f.evidence?.length) {
      const det = el('details');
      det.appendChild(el('summary', 'muted small-text', 'Log lines'));
      det.appendChild(el('pre', 'diag-evidence', f.evidence.join('\n')));
      item.appendChild(det);
    }
    if (f.actions?.length && hasPerm('settings.edit')) {
      const row = el('div', 'diag-actions');
      for (const a of f.actions) {
        const b = el('button', 'small primary', a.label);
        b.addEventListener('click', () => runDiagAction(a, b));
        row.appendChild(b);
      }
      item.appendChild(row);
    }
    box.appendChild(item);
  }
}

async function runDiagAction(a, btn) {
  const id = state.selected;
  try {
    btn.disabled = true;
    if (a.type === 'disable-content') {
      await api('POST', `/api/servers/${id}/addons/${encodeURIComponent(a.id)}/enabled`, { enabled: false });
      toast('Switched off. Start the server again to see if that fixed it.');
    } else if (a.type === 'set-java') {
      const snap = await api('PUT', `/api/servers/${id}`, { settings: { ...state.detail.settings, javaVersion: a.version } });
      state.detail = { ...state.detail, ...snap };
      toast(`Now using Java ${a.version}. Start the server again.`);
    } else if (a.type === 'accept-eula') {
      await api('POST', `/api/servers/${id}/eula`);
      toast('EULA accepted. Start the server again.');
    } else if (a.type === 'install-vcredist') {
      const where = state.detail.node?.name ?? 'this PC';
      if (!(await confirmBox(`Install the Microsoft Visual C++ Redistributable (x64) on ${where}?\n\nServer Forge downloads Microsoft's installer and runs it quietly. Windows will ask for admin rights on ${where}, so someone needs to be there to click Yes. It takes a minute or two.`, 'Install'))) {
        btn.disabled = false;
        return;
      }
      btn.textContent = 'Installing… (answer the Windows prompt)';
      const r = await api('POST', `/api/servers/${id}/vcredist`);
      toast(r.message);
    } else if (a.type === 'open-tab') {
      setTab(a.tab);
    }
    btn.textContent = '✔ Done';
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
}

async function runDiagnose() {
  try {
    const diag = await api('POST', `/api/servers/${state.selected}/diagnose`);
    state.detail.diagnosis = diag;
    diagShownAt = null;
    if (state.tab !== 'overview') setTab('overview');
    else renderDiagnosis();
    const errors = diag.findings.filter((f) => f.severity === 'error').length;
    toast(errors ? `Found ${errors} problem${errors === 1 ? '' : 's'}` : 'No known problems found');
  } catch (err) {
    toast(err.message, true);
  }
}
$('btnDiagnose').addEventListener('click', runDiagnose);
$('btnDiagnoseConsole').addEventListener('click', runDiagnose);
$('btnDiagDismiss').addEventListener('click', async () => {
  await api('DELETE', `/api/servers/${state.selected}/diagnose`).catch(() => {});
  state.detail.diagnosis = null;
  renderDiagnosis();
});

async function renderOverview() {
  renderResources();
  renderDiagnosis();
  const d = state.detail;
  const live = d.live;
  renderJob();

  $('ovPlayerCount').textContent = d.status === 'running' ? `${live.playerCount ?? 0} online` : '';
  const list = $('ovPlayers');
  list.innerHTML = '';
  if (d.status !== 'running') list.appendChild(el('p', 'muted', 'Server is not running.'));
  else if (!live.players.length) list.appendChild(el('p', 'muted', live.playerCount ? `${live.playerCount} online (names not reported yet)` : 'Nobody online.'));
  for (const p of live.players) {
    const row = el('div', 'player');
    row.appendChild(el('span', 'name', p.name));
    if (p.platformId) row.appendChild(el('span', 'pid', p.platformId));
    if (p.joinedAt) row.appendChild(el('span', 'since', `on for ${duration(Date.now() - p.joinedAt)}`));
    list.appendChild(row);
  }

  const s = d.settings;
  // Games can supply their own facts (e.g. Bedrock reads them from server.properties); Valheim uses its settings.
  const facts = d.facts
    ? [['Running version', live.version], ...d.facts]
    : [
        ['Version', live.version],
        ['Server name', s.serverName],
        ['World', s.world],
        ['Port', s.port],
        ['Crossplay', s.crossplay ? 'On' : 'Off'],
        ['Join code', live.extra?.joinCode],
        ['Public address', live.extra?.publicAddress],
        ['Last save', live.lastSave ? `${duration(Date.now() - live.lastSave)} ago` : null],
      ];
  const dl = $('ovFacts');
  dl.innerHTML = '';
  for (const [k, v] of facts) {
    if (v == null || v === '') continue;
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, String(v)));
  }

  // World/boss info comes from the full detail endpoint; refresh it now and then.
  if (Date.now() - detailsRefreshed > 30_000) {
    detailsRefreshed = Date.now();
    const fresh = await api('GET', `/api/servers/${d.id}`).catch(() => null);
    if (fresh && fresh.id === state.selected) state.detail = { ...fresh, console: state.detail.console };
  }
  const world = state.detail.world;
  $('ovBossesCard').hidden = !world;
  if (world) {
    const done = world.bosses.filter((b) => b.defeated).length;
    $('ovBossCount').textContent = `${done} / ${world.bosses.length}`;
    const box = $('ovBosses');
    box.innerHTML = '';
    for (const b of world.bosses) {
      const pill = el('div', `boss${b.defeated ? ' done' : b.unsure ? ' unsure' : ''}`, b.unsure ? `${b.name} ?` : b.name);
      if (b.unsure) {
        pill.title = `Can't tell yet. This world has a defeat marker Server Forge doesn't recognise (${world.unknownKeys.join(', ')}). It may be ${b.name}'s, or come from a mod or an older Valheim version.`;
      }
      box.appendChild(pill);
    }
  }
}

// ---------- console ----------

function lineClass(line) {
  if (line.startsWith('> ')) return 'typed';
  if (line.startsWith('[panel]')) return 'panel';
  if (line.startsWith('[install]')) return 'install';
  if (line.startsWith('[backup]') || line.startsWith('[restore]')) return 'backup';
  if (/Got character ZDOID|Player joined|Got connection/.test(line)) return 'join';
  if (/error|exception|failed/i.test(line)) return 'warn';
  return '';
}

function matchesFilter(line) {
  const f = $('consoleFilter').value.trim().toLowerCase();
  return !f || line.toLowerCase().includes(f);
}

function renderConsole() {
  const box = $('console');
  box.innerHTML = '';
  for (const line of state.detail.console) if (matchesFilter(line)) box.appendChild(el('div', lineClass(line), line));
  if ($('consoleScroll').checked) box.scrollTop = box.scrollHeight;
  const canType = state.detail.canCommand;
  $('cmdForm').hidden = !canType;
  $('cmdInput').disabled = state.detail.status !== 'running';
  $('cmdInput').placeholder = state.detail.status === 'running' ? 'Type a command, e.g. say Hello or list' : 'Start the server to send commands';
  $('consoleNote').textContent = canType
    ? 'Commands go straight to the server console (no leading / needed). Up/Down arrows repeat earlier commands.'
    : 'This game does not accept typed console commands; admin commands are used in-game (Valheim: F5).';
}

const cmdHistory = [];
let cmdPos = 0;
$('cmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const command = $('cmdInput').value.trim();
  if (!command) return;
  cmdHistory.push(command);
  cmdPos = cmdHistory.length;
  $('cmdInput').value = '';
  try {
    await api('POST', `/api/servers/${state.selected}/command`, { command });
  } catch (err) {
    toast(err.message, true);
  }
});
$('cmdInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && cmdPos > 0) $('cmdInput').value = cmdHistory[--cmdPos];
  else if (e.key === 'ArrowDown') $('cmdInput').value = cmdHistory[++cmdPos] ?? ((cmdPos = cmdHistory.length), '');
  else return;
  e.preventDefault();
});

// ---------- properties (server.properties editor) ----------

let props = { entries: [], problems: [], file: '' };
const propChanges = {};

async function loadProperties() {
  for (const k of Object.keys(propChanges)) delete propChanges[k];
  try {
    props = await api('GET', `/api/servers/${state.selected}/properties`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  renderProperties();
}

function renderProperties() {
  const running = ['running', 'starting'].includes(state.detail.status);
  const problems = $('propProblems');
  problems.innerHTML = '';
  for (const p of props.problems) problems.appendChild(el('div', 'warn-banner', p));
  $('btnRepairProps').hidden = !props.problems.some((p) => /Repair file/.test(p));
  $('propFile').textContent = `${props.file}${running ? ' · changes apply when the server restarts' : ''}`;

  const filter = $('propFilter').value.trim().toLowerCase();
  const showAdvanced = $('propAdvanced').checked;
  const list = $('propList');
  list.innerHTML = '';
  const editable = hasPerm('properties.edit');
  let section = null;
  for (const entry of props.entries) {
    const inFile = entry.value !== null;
    if ((entry.advanced || (entry.optional && !inFile)) && !showAdvanced && !filter) continue;
    if (filter && !entry.key.toLowerCase().includes(filter) && !(entry.label ?? '').toLowerCase().includes(filter) && !entry.description.toLowerCase().includes(filter)) continue;
    if (entry.section && entry.section !== section) {
      section = entry.section;
      list.appendChild(el('h4', 'section-label', section));
    }

    const current = propChanges[entry.key] ?? entry.value ?? entry.defaultValue ?? '';
    const row = el('div', `prop${entry.key in propChanges ? ' changed' : ''}${entry.known ? '' : ' unknown'}`);
    const key = el('div', entry.label ? 'key named' : 'key', entry.label ?? entry.key);
    key.appendChild(el('small', null, !entry.known ? 'Not a setting this server uses' : !inFile ? `Not in file (default: ${entry.defaultValue || 'empty'})` : entry.label ? entry.key : ''));
    row.appendChild(key);

    let input;
    if (entry.type === 'boolean') {
      input = el('input');
      input.type = 'checkbox';
      input.checked = current === 'true';
    } else if (entry.type === 'select') {
      input = el('select');
      for (const o of entry.options) input.add(new Option(o, o));
      if (!entry.options.includes(current)) input.add(new Option(current, current));
      input.value = current;
    } else {
      input = el('input');
      input.type = entry.type === 'number' ? 'number' : 'text';
      if (entry.type === 'number') input.step = 'any';
      input.value = current;
    }
    input.disabled = !editable || !entry.known;
    input.addEventListener('change', () => {
      const value = entry.type === 'boolean' ? String(input.checked) : input.value;
      if (value === (entry.value ?? entry.defaultValue ?? '') && inFile) delete propChanges[entry.key];
      else propChanges[entry.key] = value;
      row.classList.toggle('changed', entry.key in propChanges);
      $('btnSaveProps').textContent = Object.keys(propChanges).length ? `Save ${Object.keys(propChanges).length} change(s)` : 'Save changes';
    });
    row.appendChild(input);
    row.appendChild(el('div', 'desc', entry.description.replace(/^Allowed values:.*$/gim, '').trim()));
    list.appendChild(row);
  }
  $('btnSaveProps').textContent = Object.keys(propChanges).length ? `Save ${Object.keys(propChanges).length} change(s)` : 'Save changes';
}

$('propFilter').addEventListener('input', renderProperties);
$('propAdvanced').addEventListener('change', renderProperties);
$('btnSaveProps').addEventListener('click', async () => {
  if (!Object.keys(propChanges).length) return toast('Nothing to save yet.');
  try {
    props = await api('PUT', `/api/servers/${state.selected}/properties`, { values: { ...propChanges } });
    for (const k of Object.keys(propChanges)) delete propChanges[k];
    renderProperties();
    const running = ['running', 'starting'].includes(state.detail.status);
    toast(running ? 'Saved. Restart the server to apply.' : 'Saved.');
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnRepairProps').addEventListener('click', async () => {
  if (!await confirmBox('Rebuild server.properties from the official template, keeping your current values? A backup copy is saved next to it.')) return;
  try {
    const result = await api('POST', `/api/servers/${state.selected}/properties/repair`);
    props = result;
    renderProperties();
    toast('File repaired');
    $('propFile').textContent = result.note;
  } catch (err) {
    toast(err.message, true);
  }
});

function appendConsoleLine(line) {
  if (state.tab !== 'console' || !matchesFilter(line)) return;
  const box = $('console');
  box.appendChild(el('div', lineClass(line), line));
  while (box.childElementCount > 2000) box.firstChild.remove();
  if ($('consoleScroll').checked) box.scrollTop = box.scrollHeight;
}

$('consoleFilter').addEventListener('input', renderConsole);

// ---------- settings ----------

// ---------- BungeeCord: the servers behind the proxy ----------

let networkState = null;
async function loadNetwork() {
  const d = state.detail;
  const isProxy = d.game === 'java' && d.settings?.flavor === 'bungeecord';
  $('networkCard').hidden = !isProxy;
  if (!isProxy) return;
  try {
    networkState = await api('GET', `/api/servers/${d.id}/network`);
  } catch (err) {
    $('networkList').replaceChildren(el('p', 'error', err.message));
    return;
  }
  renderNetwork();
}

function renderNetwork() {
  const n = networkState;
  const list = $('networkList');
  list.innerHTML = '';
  if (n.error) list.appendChild(el('p', 'warn-banner', n.error));
  $('networkCount').textContent = n.servers.length ? String(n.servers.length) : '';
  const first = n.priorities[0];
  for (const s of n.servers) {
    const row = el('div', 'node-row');
    const info = el('div', 'node-info');
    // Which Server Forge server this is: same address (and the same name, when two servers share an address).
    const match = n.candidates.find((c) => c.address === s.address && c.suggested === s.name) ?? n.candidates.find((c) => c.address === s.address);
    const title = el('b', null, s.name);
    info.appendChild(title);
    if (s.name === first) info.appendChild(el('span', 'type-badge loc-server', 'Players land here'));
    info.appendChild(el('div', 'muted small-text', [s.address, match ? `Server Forge: ${match.name}${match.node ? ` (on ${match.node})` : ''}` : null, s.restricted ? 'restricted' : null].filter(Boolean).join(' · ')));
    row.appendChild(info);
    if (hasPerm('properties.edit')) {
      const actions = el('div', 'actions');
      if (s.name !== first) {
        const def = el('button', 'small ghost', 'Land here first');
        def.addEventListener('click', async () => {
          try {
            networkState = { ...networkState, ...(await api('PUT', `/api/servers/${state.detail.id}/network/default`, { name: s.name })) };
            renderNetwork();
            toast(`Players now land on ${s.name}. Restart the proxy to apply.`);
          } catch (err) {
            toast(err.message, true);
          }
        });
        actions.appendChild(def);
      }
      const rm = el('button', 'small red ghost', 'Remove');
      rm.addEventListener('click', async () => {
        if (!await confirmBox(`Remove ${s.name} from the proxy's server list? (The server itself is not touched.)`)) return;
        try {
          networkState = { ...networkState, ...(await api('DELETE', `/api/servers/${state.detail.id}/network/${encodeURIComponent(s.name)}`)) };
          renderNetwork();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.appendChild(rm);
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
  if (!n.servers.length && !n.error) list.appendChild(el('p', 'muted', 'No servers yet.'));
  // The picker: Server Forge's Java servers (address filled in), or "Another server" for anything else.
  const pick = $('networkPick');
  pick.innerHTML = '';
  pick.add(new Option('Another server (type its address)', ''));
  for (const c of n.candidates) pick.add(new Option(`${c.name}${c.node ? ` (on ${c.node})` : ''} · ${c.address}`, c.id));
  syncNetworkPick();
}

function syncNetworkPick() {
  const c = networkState?.candidates.find((x) => x.id === $('networkPick').value);
  $('networkAddress').disabled = !!c;
  $('networkAddress').value = c ? c.address : '';
  if (c) $('networkName').value = c.suggested;
  $('networkPrepareRow').hidden = !c?.canPrepare;
  if (!c?.canPrepare) $('networkPrepare').checked = false;
  $('networkPrepareWarn').hidden = !$('networkPrepare').checked;
}
$('networkPick').addEventListener('change', syncNetworkPick);
$('networkPrepare').addEventListener('change', () => ($('networkPrepareWarn').hidden = !$('networkPrepare').checked));
$('networkAdd').addEventListener('click', async () => {
  const serverId = $('networkPick').value || undefined;
  try {
    const r = await api('POST', `/api/servers/${state.detail.id}/network`, {
      serverId,
      name: $('networkName').value.trim(),
      address: serverId ? undefined : $('networkAddress').value.trim(),
      first: $('networkFirst').checked,
      prepare: $('networkPrepare').checked,
    });
    networkState = { ...networkState, ...r };
    renderNetwork();
    $('networkName').value = '';
    $('networkFirst').checked = false;
    toast(r.notes?.length ? r.notes.join(' ') : 'Added.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderSettings() {
  loadNetwork();
  const d = state.detail;
  const game = state.games.find((g) => g.id === d.game);
  $('sName').value = d.name;
  $('sInstall').value = d.installDir;
  $('sAutoRestart').checked = d.autoRestart;
  $('settingsStatus').textContent = '';
  const box = $('gameFields');
  box.innerHTML = '';
  // Games whose settings live in their own file (Bedrock: Properties tab) have no panel fields.
  box.closest('.card').hidden = !game.fields.length;
  let section = null;
  for (const f of game.fields) {
    // Fields can be grouped under a heading (e.g. Valheim's world modifiers).
    if (f.section && f.section !== section) {
      section = f.section;
      const head = el('div', 'full field-section');
      head.appendChild(el('h4', 'section-label', f.section));
      if (f.sectionHelp) head.appendChild(el('p', 'muted small-text', f.sectionHelp));
      box.appendChild(head);
    }
    const wrap = el('div', f.type === 'boolean' || f.type === 'folder' ? 'full' : '');
    const id = `f_${f.key}`;
    if (f.type === 'boolean') {
      const lab = el('label', 'toggle');
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = !!d.settings[f.key];
      lab.appendChild(input);
      lab.appendChild(document.createTextNode(` ${f.label}`));
      wrap.appendChild(lab);
    } else if (f.type === 'select') {
      const lab = el('label', null, f.label);
      lab.htmlFor = id;
      const select = el('select');
      select.id = id;
      for (const o of f.options ?? []) select.add(new Option(o.label, o.value));
      select.value = String(d.settings[f.key] ?? '');
      select.disabled = !hasPerm('settings.edit');
      wrap.append(lab, select);
    } else {
      const lab = el('label', null, f.label);
      lab.htmlFor = id;
      const input = el('input');
      input.id = id;
      input.type = f.type === 'number' ? 'number' : 'text';
      if (f.type === 'password') input.autocomplete = 'off';
      input.value = d.settings[f.key] ?? '';
      wrap.appendChild(lab);
      if (f.type === 'folder') {
        const row = el('div', 'with-button');
        const browse = el('button', null, 'Browse…');
        browse.hidden = !hasGlobal('files.browse') || !hasPerm('settings.edit');
        browse.type = 'button';
        browse.dataset.browse = id;
        row.append(input, browse);
        wrap.appendChild(row);
      } else {
        wrap.appendChild(input);
      }
    }
    if (f.help) wrap.appendChild(el('div', 'field-help', f.help));
    box.appendChild(wrap);
  }
  for (const input of $('settingsForm').querySelectorAll('input')) input.disabled = !hasPerm('settings.edit');
  loadDifficulty();
  loadDiscord();
  $('profilesCard').hidden = d.game !== 'valheim';
  if (d.game === 'valheim') loadProfiles();
  $('updateCard').hidden = !d.canInstall;
  $('btnUpdateSoftware').disabled = !['stopped', 'crashed'].includes(d.status);
  $('btnUpdateSoftware').title = $('btnUpdateSoftware').disabled ? 'Stop the server first' : '';
  // Bedrock and Valheim: version check, "Update now" (works while running, with a countdown) and automatic updates.
  const checked = UPDATE_GAMES[d.game];
  $('bedrockUpdate').hidden = !checked;
  $('btnUpdateSoftware').hidden = !!checked;
  if (checked) {
    $('buAutoHelp').textContent = checked.autoHelp;
    $('buForceHelp').textContent = checked.forceHelp;
    $('btnBuForce').title = checked.forceHelp;
    loadBedrockUpdate(false);
  }
}

// ---------- Valheim profiles (world + mods) ----------

let profiles = null;
let editingProfile = null; // null = new profile

async function loadProfiles() {
  const id = state.selected;
  try {
    profiles = await api('GET', `/api/servers/${id}/profiles`);
  } catch {
    return;
  }
  if (id !== state.selected) return;
  renderProfiles();
}

function renderProfiles() {
  const box = $('profileList');
  box.innerHTML = '';
  const canEdit = hasPerm('settings.edit');
  if (!profiles.profiles.length) return; // every server gets "Main" automatically
  for (const p of profiles.profiles) {
    const active = p.id === profiles.active;
    const row = el('div', `profile-row${active ? ' active' : ''}`);
    const info = el('div');
    info.appendChild(el('b', null, `${active ? '● ' : ''}${p.name}`));
    info.appendChild(el('div', 'muted small-text', `World: ${p.world}${profiles.worlds.includes(p.world) ? '' : ' (new: created on first start)'} · ${p.vanilla ? 'vanilla (mods off)' : p.modsOff ? `${p.modsOff} mod${p.modsOff === 1 ? '' : 's'} off` : 'all mods on'}`));
    row.appendChild(info);
    const actions = el('div', 'actions');
    if (!active && canEdit) {
      const sw = el('button', 'small primary', 'Switch');
      sw.addEventListener('click', () => switchProfile(p));
      actions.appendChild(sw);
    }
    if (canEdit) {
      const edit = el('button', 'small ghost', 'Edit');
      edit.addEventListener('click', () => openProfileForm(p));
      actions.appendChild(edit);
      if (!active) {
        const del = el('button', 'small red ghost', 'Delete');
        del.addEventListener('click', async () => {
          if (!await confirmBox(`Delete the profile "${p.name}"? Its world and mods stay on the server.`)) return;
          try {
            profiles = await api('DELETE', `/api/servers/${state.selected}/profiles/${p.id}`);
            renderProfiles();
          } catch (err) {
            toast(err.message, true);
          }
        });
        actions.appendChild(del);
      }
    }
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function switchProfile(p) {
  const running = ['running', 'starting'].includes(state.detail.status);
  if (running && !await confirmBox(`Switch to "${p.name}"?\n\nThe server restarts (players are disconnected) and starts world "${p.world}"${p.vanilla ? ' without mods' : ''}.`)) return;
  try {
    profiles = await api('POST', `/api/servers/${state.selected}/profiles/${p.id}/activate`, { restart: running });
    toast(`Switched to ${p.name}${running ? '; the server is restarting' : ''}`);
    renderProfiles();
  } catch (err) {
    toast(err.message, true);
  }
}

function openProfileForm(p) {
  editingProfile = p ?? null;
  $('profileForm').hidden = false;
  $('pfName').value = p?.name ?? '';
  const sel = $('pfWorld');
  sel.innerHTML = '';
  for (const w of profiles.worlds) sel.add(new Option(w, w));
  sel.add(new Option('New world…', '__new'));
  const world = p?.world ?? state.detail.settings.world;
  sel.value = profiles.worlds.includes(world) ? world : '__new';
  $('pfWorldNew').hidden = sel.value !== '__new';
  $('pfWorldNew').value = profiles.worlds.includes(world) ? '' : (world ?? '');
  $('pfVanilla').checked = !!p?.vanilla;
  $('pfVanilla').disabled = !profiles.modded;
  $('pfSave').textContent = p ? 'Save' : 'Create';
  $('pfName').focus();
}
$('pfWorld').addEventListener('change', () => ($('pfWorldNew').hidden = $('pfWorld').value !== '__new'));
$('btnNewProfile').addEventListener('click', () => openProfileForm(null));
$('pfCancel').addEventListener('click', () => ($('profileForm').hidden = true));
// Enter in the profile fields saves the profile (not the Settings form around it).
for (const id of ['pfName', 'pfWorldNew']) {
  $(id).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('pfSave').click();
  });
}
$('pfSave').addEventListener('click', async () => {
  const world = $('pfWorld').value === '__new' ? $('pfWorldNew').value.trim() : $('pfWorld').value;
  const body = { name: $('pfName').value.trim(), world, vanilla: $('pfVanilla').checked };
  try {
    profiles = editingProfile
      ? await api('PUT', `/api/servers/${state.selected}/profiles/${editingProfile.id}`, body)
      : await api('POST', `/api/servers/${state.selected}/profiles`, body);
    $('profileForm').hidden = true;
    toast(editingProfile ? 'Profile saved' : `Profile "${body.name}" added. Press Switch to use it.`);
    renderProfiles();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- difficulty (every server type) ----------

// ---------- Discord notifications (Settings tab) ----------

async function loadDiscord() {
  const id = state.selected;
  $('discordCard').hidden = !hasPerm('settings.edit');
  if (!hasPerm('settings.edit')) return;
  let d;
  try {
    d = await api('GET', `/api/servers/${id}/discord`);
  } catch {
    // A node running an older Server Forge doesn't have this.
    $('discordCard').hidden = true;
    return;
  }
  if (id !== state.selected) return;
  $('discordUrl').value = d.url;
  const box = $('discordEvents');
  box.innerHTML = '';
  for (const [key, label] of Object.entries(d.labels)) {
    const lab = el('label', 'toggle small-text');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.event = key;
    cb.checked = !!d.events[key];
    lab.append(cb, document.createTextNode(` ${label}`));
    box.appendChild(lab);
  }
  $('discordStatus').textContent = d.url ? 'On: notifications go to that channel.' : 'Off. Paste a webhook address to turn it on.';
}

function discordBody() {
  const events = {};
  for (const cb of $('discordEvents').querySelectorAll('input[data-event]')) events[cb.dataset.event] = cb.checked;
  return { url: $('discordUrl').value.trim(), events };
}

$('discordSave').addEventListener('click', async () => {
  try {
    const d = await api('PUT', `/api/servers/${state.selected}/discord`, discordBody());
    toast(d.url ? 'Discord notifications saved' : 'Discord notifications turned off');
    loadDiscord();
  } catch (err) {
    toast(err.message, true);
  }
});
$('discordTest').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('POST', `/api/servers/${state.selected}/discord/test`, { url: $('discordUrl').value.trim() });
    toast('Test message sent: check the Discord channel');
  } catch (err) {
    toast(err.message, true);
  }
  btn.disabled = false;
});

let difficulty = null;
async function loadDifficulty() {
  const id = state.selected;
  try {
    difficulty = await api('GET', `/api/servers/${id}/difficulty`);
  } catch {
    difficulty = null;
  }
  if (id !== state.selected) return;
  renderDifficulty();
}

function renderDifficulty() {
  const d = difficulty;
  $('difficultyCard').hidden = !d?.supported;
  if (!d?.supported) return;
  const select = $('difficultySelect');
  select.innerHTML = '';
  for (const o of d.options) select.add(new Option(o.label, o.value));
  select.value = d.value ?? '';
  select.disabled = !hasPerm('settings.edit');
  const running = ['running', 'starting'].includes(state.detail.status);
  $('difficultyApplies').textContent = d.applies === 'now' ? 'Changes apply right away.' : running ? 'Changes apply when the server restarts.' : 'Applies when the server starts.';
  $('difficultyHelp').textContent = d.options.find((o) => o.value === select.value)?.help ?? '';
  $('difficultyNote').hidden = !d.note;
  $('difficultyNote').textContent = d.note ?? '';
}

$('difficultySelect').addEventListener('change', async () => {
  const value = $('difficultySelect').value;
  const label = difficulty?.options.find((o) => o.value === value)?.label ?? value;
  try {
    difficulty = await api('PUT', `/api/servers/${state.selected}/difficulty`, { value });
    toast(difficulty.applies === 'now' ? `Difficulty is now ${label}` : `Difficulty set to ${label}. It applies when the server ${['running', 'starting'].includes(state.detail.status) ? 'restarts' : 'starts'}.`);
  } catch (err) {
    toast(err.message, true);
  }
  renderDifficulty();
});

const UPDATE_GAMES = {
  bedrock: {
    source: 'Mojang',
    autoHelp: 'Automatic updates: players get a 5-minute countdown, the world is backed up, the new version is installed, and the server starts again. Addons stay switched on (most keep working across Bedrock versions). New versions are checked every 30 minutes, and right away when you turn automatic updates on.',
    forceHelp: 'Force update: checks Mojang right now and installs the latest version even if this server already looks up to date (for example when an update just came out). Same steps: countdown, backup, install, start.',
  },
  valheim: {
    source: 'Steam',
    autoHelp: "Automatic updates: when Steam has a new Valheim server build, Server Forge waits until nobody is online (at most an hour; Valheim can't message players), backs up the world, lets Steam install the update and starts the server again. Mods (BepInEx) are kept, but a big game update can break some until their authors update them. Checked every 30 minutes. Players' games must be on the same version (Steam updates them).",
    forceHelp: 'Force update: asks Steam right now and re-runs the update with a full file check, even if this server already looks up to date. Same steps: backup, update, start.',
  },
  satisfactory: {
    source: 'Steam',
    autoHelp: "Automatic updates: when Steam has a new Satisfactory server build, Server Forge waits until nobody is online (at most an hour; Satisfactory can't message players), saves and backs up, lets Steam install the update and starts the server again. Players' games must be on the same version (Steam updates them). Mods may need updating in Satisfactory Mod Manager after a big game update. Checked every 30 minutes.",
    forceHelp: 'Force update: asks Steam right now and re-runs the update with a full file check, even if this server already looks up to date.',
  },
  spaceengineers: {
    source: 'Steam',
    autoHelp: "Automatic updates: when Steam has a new Space Engineers server build, players get a 5-minute countdown in chat, the world is backed up, Steam installs the update and the server starts again. Players' games must be on the same version (Steam updates them). Checked every 30 minutes.",
    forceHelp: 'Force update: asks Steam right now and re-runs the update with a full file check, even if this server already looks up to date.',
  },
  factorio: {
    source: 'factorio.com',
    autoHelp: "Automatic updates: when factorio.com has a new stable version, players get a 5-minute countdown in chat, the game is saved and backed up, the new version is downloaded (with your factorio.com login) and the server starts again. Players' games must be on the same version (Steam updates them). Servers on Experimental versions are updated with Force update. Checked every 30 minutes.",
    forceHelp: 'Force update: downloads the newest version for this server (Stable or Experimental, as set in Settings) right now, even if it already looks up to date. Also use it after switching Space Age on or off.',
  },
  ...Object.fromEntries(
    [
      ['palworld', 'Palworld', 'players get a 5-minute countdown in chat'],
      ['enshrouded', 'Enshrouded', "Server Forge waits until nobody is online (at most an hour; Enshrouded can't message players)"],
      ['sevendays', '7 Days to Die', 'players get a 5-minute countdown in chat'],
      ['zomboid', 'Project Zomboid', 'players get a 5-minute countdown in chat'],
      ['vrising', 'V Rising', 'players get a 5-minute countdown in chat'],
    ].map(([id, name, warn]) => [
      id,
      {
        source: 'Steam',
        autoHelp: `Automatic updates: when Steam has a new ${name} server build, ${warn}, the world is saved and backed up, Steam installs the update and the server starts again. Players' games must be on the same version (Steam updates them). Checked every 30 minutes.`,
        forceHelp: 'Force update: asks Steam right now and re-runs the update with a full file check, even if this server already looks up to date.',
      },
    ]),
  ),
  'terraria-vanilla': {
    source: 'terraria.org',
    autoHelp: "Automatic updates: when terraria.org has a new dedicated server, players get a 5-minute countdown in chat, the world is backed up, the new version is installed and the server starts again. Players' games must be on the same version (Steam updates them). Checked every 30 minutes.",
    forceHelp: 'Force update: reinstalls the latest Terraria server right now, even if this one already looks up to date.',
  },
  terraria: {
    source: 'GitHub (tModLoader releases)',
    autoHelp: "Automatic updates: when tModLoader releases a new version, players get a 5-minute countdown in chat, the world is backed up, the new version is installed and the server starts again. Players' tModLoader must be on the same version (Steam updates it). Checked every 30 minutes.",
    forceHelp: 'Force update: reinstalls the latest tModLoader right now, even if this server already looks up to date. Same steps: countdown, backup, install, start.',
  },
};

async function loadBedrockUpdate(check) {
  const id = state.selected;
  $('buChecked').textContent = check ? 'Checking…' : '';
  let u;
  try {
    u = await api('GET', `/api/servers/${id}/game-update${check ? '?check=1' : ''}`);
  } catch (err) {
    $('buChecked').textContent = err.message;
    return;
  }
  if (id !== state.selected) return;
  const build = (v) => (u.game === 'valheim' && v ? `build ${v}` : v);
  $('buCurrent').textContent = u.current ? `${build(u.current)}${u.currentLabel ? ` (${u.currentLabel})` : ''}` : 'unknown';
  $('buLatest').textContent = u.latest ? `${build(u.latest)}${u.latestLabel ? ` (${u.latestLabel})` : ''}` : '?';
  $('buChecked').textContent = u.error
    ? `Couldn't check: ${u.error}`
    : u.updating
      ? 'Updating now…'
      : u.available && !u.current
        ? "The installed version isn't known yet: one update makes it known."
        : u.available
          ? 'A new version is available.'
          : u.latest
            ? 'Up to date.'
            : '';
  $('btnBuUpdate').hidden = !u.available || u.updating;
  $('btnBuForce').hidden = u.updating;
  $('btnBuForce').disabled = !hasPerm('server.update');
  $('buAuto').checked = u.auto;
  $('buAuto').disabled = !hasPerm('server.update');
}
$('btnBuCheck').addEventListener('click', () => loadBedrockUpdate(true));
$('buAuto').addEventListener('change', async () => {
  try {
    await api('PUT', `/api/servers/${state.selected}`, { autoUpdate: $('buAuto').checked });
    toast($('buAuto').checked ? 'Automatic updates on. Checking for a new version now; if there is one it installs by itself.' : 'Automatic updates off: you\'ll be asked first.');
    if ($('buAuto').checked) setTimeout(() => loadBedrockUpdate(false), 4000);
  } catch (err) {
    toast(err.message, true);
    $('buAuto').checked = !$('buAuto').checked;
  }
});
$('btnBuUpdate').addEventListener('click', async () => {
  const running = ['running', 'starting'].includes(state.detail.status);
  let minutes = 0;
  if (running) {
    const answer = await ask('The server is running. Warn players for how many minutes before it stops to update? (0 = right away)', '5');
    if (answer === null) return;
    minutes = Math.max(0, Math.min(Number(answer) || 0, 60));
  } else if (!await confirmBox('Update to the latest version? The world is backed up first.')) return;
  try {
    await api('POST', `/api/servers/${state.selected}/game-update`, { countdownMinutes: minutes });
    toast(running ? `Updating after a ${minutes}-minute countdown. Progress in the console.` : 'Updating… progress in the console.');
    $('btnBuUpdate').hidden = true;
    $('buChecked').textContent = 'Updating now…';
  } catch (err) {
    toast(err.message, true);
  }
});

// Force: ask Mojang now and install the latest version even if the server looks up to date.
$('btnBuForce').addEventListener('click', async () => {
  const running = ['running', 'starting'].includes(state.detail.status);
  const src = UPDATE_GAMES[state.detail.game]?.source ?? 'for updates';
  let minutes = 0;
  if (running) {
    const answer = await ask(`Force update: Server Forge checks ${src} right now and installs the latest server, even if this one looks up to date.\n\nThe server is running. Warn players for how many minutes before it stops? (0 = right away)`, '5');
    if (answer === null) return;
    minutes = Math.max(0, Math.min(Number(answer) || 0, 60));
  } else if (!await confirmBox(`Force update: check ${src} right now and install the latest server, even if this one looks up to date?\n\nThe world is backed up first; worlds and settings are kept.`)) return;
  $('btnBuForce').disabled = true;
  $('buChecked').textContent = `Checking ${src}…`;
  try {
    const r = await api('POST', `/api/servers/${state.selected}/game-update`, { countdownMinutes: minutes, force: true });
    const to = r.latest ? (state.detail.game === 'valheim' ? `build ${r.latest}` : `Bedrock ${r.latest}`) : 'the latest version';
    toast(running ? `Forcing the update to ${to} after a ${minutes}-minute countdown. Progress in the console.` : `Forcing the update to ${to}… progress in the console.`);
    $('btnBuUpdate').hidden = true;
    $('btnBuForce').hidden = true;
    $('buLatest').textContent = r.latest ?? '?';
    $('buChecked').textContent = 'Updating now…';
  } catch (err) {
    toast(err.message, true);
    loadBedrockUpdate(false);
  } finally {
    $('btnBuForce').disabled = !hasPerm('server.update');
  }
});

$('btnUpdateSoftware').addEventListener('click', async () => {
  try {
    await api('POST', `/api/servers/${state.selected}/update`);
    toast('Updating. Progress is shown on the Overview tab.');
    setTab('overview');
  } catch (err) {
    toast(err.message, true);
  }
});

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const game = state.games.find((g) => g.id === state.detail.game);
  const settings = {};
  for (const f of game.fields) {
    const input = $(`f_${f.key}`);
    if (!input) continue;
    settings[f.key] = f.type === 'boolean' ? input.checked : f.type === 'number' ? Number(input.value) : input.value;
  }
  try {
    const snap = await api('PUT', `/api/servers/${state.selected}`, {
      name: $('sName').value,
      installDir: $('sInstall').value,
      autoRestart: $('sAutoRestart').checked,
      settings,
    });
    state.detail = { ...state.detail, ...snap };
    const running = snap.status === 'running' || snap.status === 'starting';
    $('settingsStatus').textContent = running ? 'Saved. Restart the server to apply.' : 'Saved.';
    toast('Settings saved');
  } catch (err) {
    toast(err.message, true);
  }
});

// Make a copy (clone) of this server.
$('btnClone').addEventListener('click', () => {
  const d = state.detail;
  $('cloneSource').textContent = `"${d.name}"`;
  $('cloneName').value = `${d.name} (test copy)`.slice(0, 60);
  const parent = d.installDir.replace(/[\\/][^\\/]+$/, '');
  $('cloneFolder').value = joinPath(parent, slug(`${d.name} test copy`));
  $('cloneError').textContent = '';
  $('cloneDialog').showModal();
});
$('cloneCancel').addEventListener('click', () => $('cloneDialog').close());
$('cloneForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', `/api/servers/${state.selected}/clone`, { name: $('cloneName').value.trim(), installDir: $('cloneFolder').value.trim() });
    $('cloneDialog').close();
    toast('Copying… the copy appears in the server list when it\'s done.');
  } catch (err) {
    $('cloneError').textContent = err.message;
  }
});

// Move this server to another system (this one or a node): everything goes, and the old copy is removed afterwards.

/** Systems this server could move to: this one and every node that reports its CPU/RAM (so it's online and new enough). */
function moveTargets(d) {
  const here = d.node?.id ?? 'local';
  const list = [];
  if (here !== 'local' && systemStats?.local) list.push({ id: 'local', name: 'This System', st: systemStats.local });
  for (const [id, st] of Object.entries(systemStats?.nodes ?? {})) if (st && id !== here) list.push({ id, name: st.name, st });
  return list;
}

let moveWatch = null;
$('btnMove').addEventListener('click', () => {
  const d = state.detail;
  $('moveSource').textContent = `"${d.name}"`;
  const select = $('moveTarget');
  select.innerHTML = '';
  for (const t of moveTargets(d)) {
    const free = t.st.mem.total - t.st.mem.used - (t.st.mem.zfsCache ?? 0);
    select.appendChild(new Option(`${t.name} (${fmtMem(Math.max(0, free))} RAM free of ${fmtMem(t.st.mem.total)})`, t.id));
  }
  $('moveKeepOld').checked = false;
  $('moveSetup').hidden = false;
  $('moveProgress').hidden = true;
  $('moveNotes').innerHTML = '';
  $('moveError').textContent = '';
  $('moveSubmit').hidden = false;
  $('moveSubmit').disabled = false;
  $('moveSubmit').textContent = 'Move server';
  $('moveClose').textContent = 'Cancel';
  $('moveDialog').showModal();
});

function showMove(m) {
  $('moveBarBox').classList.toggle('indeterminate', m.status === 'running' && m.progress == null);
  $('moveBar').style.width = `${m.progress ?? 0}%`;
  $('moveStep').textContent = m.step;
  $('moveError').textContent = m.error ?? '';
  $('moveNotes').innerHTML = '';
  for (const n of m.notes) $('moveNotes').appendChild(el('li', null, n));
  if (m.status === 'running') return;
  clearInterval(moveWatch);
  moveWatch = null;
  $('moveClose').textContent = 'Close';
  // Done: offer to open the server in its new place.
  if (m.status === 'done' && m.newServerId) {
    $('moveSubmit').hidden = false;
    $('moveSubmit').disabled = false;
    $('moveSubmit').textContent = 'Open it';
    $('moveSubmit').dataset.open = m.newServerId;
  }
}

$('moveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const open = $('moveSubmit').dataset.open;
  if (open) {
    delete $('moveSubmit').dataset.open;
    $('moveDialog').close();
    if (state.servers.has(open)) selectServer(open);
    return;
  }
  $('moveSubmit').disabled = true;
  $('moveError').textContent = '';
  try {
    const m = await api('POST', '/api/moves', { serverId: state.selected, to: $('moveTarget').value, keepOld: $('moveKeepOld').checked });
    $('moveSetup').hidden = true;
    $('moveProgress').hidden = false;
    $('moveSubmit').hidden = true;
    $('moveClose').textContent = 'Hide';
    showMove(m);
    moveWatch = setInterval(async () => {
      try {
        showMove(await api('GET', `/api/moves/${m.id}`));
      } catch (err) {
        clearInterval(moveWatch);
        $('moveError').textContent = err.message;
      }
    }, 1500);
  } catch (err) {
    $('moveError').textContent = err.message;
    $('moveSubmit').disabled = false;
  }
});
// Hiding the dialog doesn't stop the move; it carries on in Server Forge.
$('moveClose').addEventListener('click', () => $('moveDialog').close());
$('moveDialog').addEventListener('close', () => {
  if (moveWatch) toast('The move carries on in the background; the server shows in its new place when it\'s done.');
  clearInterval(moveWatch);
  moveWatch = null;
});

// Delete: remove from the panel, optionally sending the folder and/or backups to the Recycle Bin (Trash on Linux).
function updateDeleteDialog() {
  const files = $('delFiles').checked;
  const backups = $('delBackups').checked;
  const destructive = files || backups;
  $('delConfirmBox').hidden = !destructive;
  $('delSubmit').textContent = files && backups ? 'Delete server, files and backups' : files ? 'Delete server and files' : backups ? 'Delete server and backups' : 'Remove from Server Forge';
  $('delSubmit').disabled = destructive && $('delConfirm').value.trim() !== state.detail.name.trim();
}
$('btnDelete').addEventListener('click', async () => {
  const d = state.detail;
  $('deleteForm').reset();
  $('delName').textContent = `"${d.name}"`;
  $('delFolder').textContent = d.installDir;
  $('delBackupInfo').textContent = '';
  $('deleteError').textContent = d.status !== 'stopped' && d.status !== 'crashed' ? 'Stop the server first.' : '';
  updateDeleteDialog();
  $('deleteDialog').showModal();
  try {
    const list = await api('GET', `/api/servers/${d.id}/backups`);
    const n = (list.backups ?? list).length ?? 0;
    $('delBackupInfo').textContent = n ? `${n} backup${n === 1 ? '' : 's'}` : 'No backups';
  } catch {}
});
for (const id of ['delFiles', 'delBackups']) $(id).addEventListener('change', updateDeleteDialog);
$('delConfirm').addEventListener('input', updateDeleteDialog);
$('deleteCancel').addEventListener('click', () => $('deleteDialog').close());
$('deleteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = $('delFiles').checked;
  const backups = $('delBackups').checked;
  $('delSubmit').disabled = true;
  $('deleteError').textContent = files ? 'Deleting… (moving files to the Recycle Bin or Trash can take a while)' : '';
  try {
    await api('DELETE', `/api/servers/${state.selected}?files=${files ? 1 : 0}&backups=${backups ? 1 : 0}`);
    $('deleteDialog').close();
    toast(files ? 'Server deleted (files are in the Recycle Bin or Trash)' : 'Server removed');
  } catch (err) {
    $('deleteError').textContent = err.message;
    updateDeleteDialog();
  }
});

// ---------- access lists ----------

let listData = { entries: [], knownPlayers: {} };

async function renderAccess() {
  const game = state.games.find((g) => g.id === state.detail.game);
  const lists = game.accessLists;
  state.list ??= lists[0]?.id;
  const tabs = $('listTabs');
  tabs.innerHTML = '';
  for (const l of lists) {
    const b = el('button', l.id === state.list ? 'active' : '', l.label);
    b.addEventListener('click', () => {
      state.list = l.id;
      renderAccess();
    });
    tabs.appendChild(b);
  }
  const current = lists.find((l) => l.id === state.list);
  $('listHelp').textContent = current?.help ?? '';
  $('listAddInput').placeholder = current?.entryLabel ?? 'Player ID, e.g. Steam_76561198000000000';
  listData = await api('GET', `/api/servers/${state.selected}/lists/${state.list}`);
  listData.byName = /gamertag/i.test(current?.entryLabel ?? '');
  renderEntries();
}

function renderEntries() {
  const box = $('listEntries');
  box.innerHTML = '';
  if (!listData.entries.length) box.appendChild(el('p', 'muted', 'Nobody on this list.'));
  for (const id of listData.entries) {
    const row = el('div', 'entry');
    const who = listData.knownPlayers[id] ?? listData.knownPlayers[`Steam_${id}`];
    if (who) row.appendChild(el('span', 'who', who));
    row.appendChild(el('span', 'id', id));
    if (hasPerm('access.edit')) {
      const rm = el('button', 'small red ghost', 'Remove');
      rm.addEventListener('click', () => saveList(listData.entries.filter((e) => e !== id)));
      row.appendChild(rm);
    }
    box.appendChild(row);
  }
  // Suggestions: players who have joined before. Lists keyed by gamertag suggest names, others suggest IDs.
  const dl = $('knownPlayerIds');
  dl.innerHTML = '';
  for (const [id, name] of Object.entries(listData.knownPlayers)) dl.appendChild(listData.byName ? new Option(id, name) : new Option(name, id));
}

async function saveList(entries) {
  try {
    const result = await api('PUT', `/api/servers/${state.selected}/lists/${state.list}`, { entries });
    listData = { ...listData, ...result };
    renderEntries();
    toast(result.reloaded ? 'List saved and reloaded on the running server' : 'List saved');
  } catch (err) {
    toast(err.message, true);
  }
}

$('listAddForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('listAddInput').value.trim();
  if (!id) return;
  $('listAddInput').value = '';
  saveList([...listData.entries, id]);
});

// ---------- file browser ----------

const browser = { path: '', selected: '', target: null, entries: [] };

function fmtSize(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

async function openBrowser(inputId, title = 'Choose a folder') {
  browser.target = inputId;
  $('browseTitle').textContent = title;
  $('browseNative').hidden = !window.desktop?.pickFolder;
  $('browseDialog').showModal();
  const current = $(inputId).value.trim();
  // Start at the current value, or the nearest folder above it that exists.
  await browseTo(current || 'C:\\').catch(() => browseTo(current.replace(/[\\/][^\\/]*$/, '')).catch(() => browseTo('')));
}

async function browseTo(p) {
  const data = await api('GET', `/api/files?path=${encodeURIComponent(p)}`);
  browser.path = data.path;
  browser.parent = data.parent;
  browser.entries = data.entries;
  browser.selected = data.path;
  renderBrowser();
}

function renderBrowser() {
  $('browsePath').value = browser.path;
  $('browseUp').disabled = browser.parent === null;
  $('browseNew').disabled = !browser.path;
  $('browseSelect').disabled = !browser.selected;
  $('browseSelected').textContent = browser.selected ? `Selected: ${browser.selected}` : 'Pick a drive to open it';
  const dirs = browser.entries.filter((e) => e.type === 'dir').length;
  $('browseInfo').textContent = browser.path ? `${dirs} folder${dirs === 1 ? '' : 's'}, ${browser.entries.length - dirs} file${browser.entries.length - dirs === 1 ? '' : 's'}` : '';

  const list = $('browseList');
  list.innerHTML = '';
  if (!browser.entries.length) list.appendChild(el('p', 'muted small-text', 'This folder is empty.'));
  for (const entry of browser.entries) list.appendChild(browseRow(entry));
}

/** A path on the server's system: its paths say which kind it is ("/" on Linux, "\\" on Windows). */
function joinPath(dir, name) {
  return dir ? `${dir.replace(/[\\/]+$/, '')}${dir.startsWith('/') ? '/' : '\\'}${name}` : name;
}

function browseRow(entry) {
  const full = joinPath(browser.path, entry.name);
  const row = el('div', `browse-row ${entry.type}`);
  row.appendChild(el('span', 'icon', entry.type === 'dir' ? '📁' : '📄'));
  const name = el('span', 'name', entry.name);
  row.appendChild(name);
  row.appendChild(el('span', 'meta', entry.type === 'file' ? fmtSize(entry.size) : entry.modified ? new Date(entry.modified).toLocaleDateString() : ''));

  if (browser.path) {
    const actions = el('span', 'row-actions');
    const ren = el('button', 'small', 'Rename');
    ren.addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(row, name, entry, full);
    });
    const del = el('button', 'small red ghost', 'Delete');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const what = entry.type === 'dir' ? `the folder "${entry.name}" and everything in it` : `"${entry.name}"`;
      if (!await confirmBox(`Delete ${what}?\n\nIt goes to the Recycle Bin or Trash (on network and other drives it may be deleted permanently).`)) return;
      try {
        await api('POST', '/api/files/delete', { path: full });
        toast('Deleted');
        await browseTo(browser.path);
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(ren, del);
    row.appendChild(actions);
  }

  if (entry.type === 'dir') {
    row.addEventListener('click', () => {
      browser.selected = full;
      for (const r of $('browseList').children) r.style.background = '';
      row.style.background = 'var(--panel-2)';
      $('browseSelected').textContent = `Selected: ${full}`;
      $('browseSelect').disabled = false;
    });
    row.addEventListener('dblclick', () => browseTo(full).catch((err) => toast(err.message, true)));
  }
  return row;
}

function inlineNameInput(initial, onCommit, onCancel = renderBrowser) {
  const input = el('input');
  input.value = initial;
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim() && input.value.trim() !== initial) await onCommit(input.value.trim());
    else onCancel();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  return input;
}

function startRename(row, nameEl, entry, full) {
  const input = inlineNameInput(entry.name, async (newName) => {
    try {
      await api('POST', '/api/files/rename', { path: full, name: newName });
      toast('Renamed');
    } catch (err) {
      toast(err.message, true);
    }
    await browseTo(browser.path);
  });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

$('browseNew').addEventListener('click', () => {
  const row = el('div', 'browse-row dir');
  row.appendChild(el('span', 'icon', '📁'));
  const input = inlineNameInput('', async (name) => {
    try {
      const { path: created } = await api('POST', '/api/files/mkdir', { parent: browser.path, name });
      await browseTo(browser.path);
      browser.selected = created;
      renderBrowser();
      toast('Folder created');
    } catch (err) {
      toast(err.message, true);
      renderBrowser();
    }
  });
  input.placeholder = 'New folder name';
  row.appendChild(input);
  $('browseList').prepend(row);
  input.focus();
});

$('browseUp').addEventListener('click', () => browser.parent !== null && browseTo(browser.parent).catch((err) => toast(err.message, true)));
$('browseGo').addEventListener('click', () => browseTo($('browsePath').value.trim()).catch((err) => toast(err.message, true)));
$('browsePath').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('browseGo').click();
  }
});
$('browseCancel').addEventListener('click', () => $('browseDialog').close());
$('browseSelect').addEventListener('click', () => {
  $(browser.target).value = browser.selected;
  $('browseDialog').close();
});
$('browseNative').addEventListener('click', async () => {
  const picked = await window.desktop.pickFolder(browser.path || undefined);
  if (picked) {
    $(browser.target).value = picked;
    $('browseDialog').close();
  }
});

// ---------- task scheduler (Tasks tab) ----------

let taskData = { tasks: [], canCommand: false, canBackup: false };
let editingTask = null; // task id being edited, or null for a new one
let draftJobs = [];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const JOB_TYPES = {
  command: { label: 'Run commands', needsCommand: true },
  say: { label: 'Message players', needsCommand: true },
  restart: { label: 'Restart' },
  stop: { label: 'Stop' },
  start: { label: 'Start' },
  backup: { label: 'Back up', needsBackup: true },
  wait: { label: 'Wait' },
  kill: { label: 'Kill (no save)' },
};

async function loadTasks() {
  try {
    taskData = await api('GET', `/api/servers/${state.selected}/tasks`);
  } catch (err) {
    return toast(err.message, true);
  }
  renderTasks();
}

function describeTrigger(t) {
  if (t.type === 'manual') return 'Only when run by hand';
  if (t.type === 'interval') {
    const m = t.everyMinutes;
    return m % 1440 === 0 ? `Every ${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `Every ${m / 60} hour${m === 60 ? '' : 's'}` : `Every ${m} minute${m === 1 ? '' : 's'}`;
  }
  const days = t.days.length && t.days.length < 7 ? ` on ${t.days.map((d) => DAY_NAMES[d]).join(', ')}` : ' every day';
  return `At ${t.times.join(', ')}${days}`;
}

function describeJob(j) {
  switch (j.type) {
    case 'command':
      return `Run: ${j.commands.join(' · ')}`;
    case 'say':
      return `Say "${j.message}"`;
    case 'stop':
    case 'restart':
      return `${j.type === 'restart' ? 'Restart' : 'Stop'}${j.warnMinutes?.length ? ` (warn players ${j.warnMinutes.join(', ')} min before)` : ''}`;
    case 'wait':
      return `Wait ${j.seconds} s`;
    default:
      return JOB_TYPES[j.type]?.label ?? j.type;
  }
}

function fmtTaskTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderTasks() {
  const list = $('taskList');
  list.innerHTML = '';
  $('taskCount').textContent = taskData.tasks.length ? `${taskData.tasks.length}` : '';
  if (!taskData.tasks.length) list.appendChild(el('p', 'muted', 'No tasks yet. Use "Quick add" for common ones, or "New task" to build your own.'));
  const canEdit = hasPerm('tasks.edit');
  for (const t of taskData.tasks) {
    const row = el('div', `task${t.enabled ? '' : ' off'}`);
    const info = el('div');
    const title = el('div', 'name', t.name);
    if (t.running) title.appendChild(el('span', 'type-badge loc-world', 'running now'));
    info.appendChild(title);
    info.appendChild(el('div', 'sub', `${describeTrigger(t.trigger)}${t.onlyWhenRunning ? ' · only while running' : ''}`));
    info.appendChild(el('div', 'sub muted', t.jobs.map(describeJob).join('  →  ')));
    const status = [`Next: ${t.enabled ? fmtTaskTime(t.nextRun) : 'disabled'}`];
    if (t.lastRun) status.push(`Last: ${fmtTaskTime(t.lastRun)}`);
    info.appendChild(el('div', 'sub', status.join(' · ')));
    if (t.lastResult) info.appendChild(el('div', `sub ${t.lastOk === false ? 'error-text' : 'muted'}`, t.lastResult));
    row.appendChild(info);
    const actions = el('div', 'actions');
    if (hasPerm('tasks.run')) {
      const run = el('button', 'small', '▶ Run now');
      run.disabled = t.running;
      run.addEventListener('click', async () => {
        if (!await confirmBox(`Run "${t.name}" now?\n\n${t.jobs.map(describeJob).join('\n')}`)) return;
        try {
          await api('POST', `/api/servers/${state.selected}/tasks/${t.id}/run`);
          toast(`Running "${t.name}"`);
          setTimeout(loadTasks, 800);
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.appendChild(run);
    }
    if (canEdit) {
      const lab = el('label', 'toggle');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = t.enabled;
      cb.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/servers/${state.selected}/tasks/${t.id}`, { ...t, enabled: cb.checked });
          loadTasks();
        } catch (err) {
          toast(err.message, true);
        }
      });
      lab.append(cb, document.createTextNode(' On'));
      const edit = el('button', 'small', 'Edit');
      edit.addEventListener('click', () => openTaskDialog(t));
      const del = el('button', 'small red ghost', 'Delete');
      del.addEventListener('click', async () => {
        if (!await confirmBox(`Delete the task "${t.name}"?`)) return;
        try {
          await api('DELETE', `/api/servers/${state.selected}/tasks/${t.id}`);
          loadTasks();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.append(lab, edit, del);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}
setInterval(() => state.tab === 'tasks' && !document.hidden && !$('taskDialog').open && loadTasks(), 10_000);

// Task editor
function setWhen(type) {
  for (const b of $('taskWhen').children) b.classList.toggle('active', b.dataset.when === type);
  $('whenInterval').hidden = type !== 'interval';
  $('whenDaily').hidden = type !== 'daily';
  $('taskWhen').dataset.value = type;
}
for (const b of $('taskWhen').children) b.addEventListener('click', () => setWhen(b.dataset.when));

function renderDraftJobs() {
  const box = $('taskJobs');
  box.innerHTML = '';
  if (!draftJobs.length) box.appendChild(el('p', 'muted small-text', 'No jobs yet: add one below.'));
  draftJobs.forEach((j, i) => {
    const row = el('div', 'job-row');
    row.appendChild(el('span', 'job-num', String(i + 1)));
    const body = el('div', 'job-body');
    body.appendChild(el('b', null, JOB_TYPES[j.type].label));
    const field = (input) => {
      body.appendChild(input);
      return input;
    };
    if (j.type === 'command') {
      const ta = field(el('textarea'));
      ta.rows = Math.max(2, j.commands.length);
      ta.placeholder = 'One command per line, e.g.\nsave-all\nweather clear';
      ta.value = j.commands.join('\n');
      ta.addEventListener('input', () => (j.commands = ta.value.split('\n')));
    } else if (j.type === 'say') {
      const inp = field(el('input'));
      inp.placeholder = 'Message shown to everyone in-game';
      inp.value = j.message;
      inp.addEventListener('input', () => (j.message = inp.value));
    } else if (j.type === 'wait') {
      const inp = field(el('input'));
      inp.type = 'number';
      inp.min = 1;
      inp.max = 3600;
      inp.value = j.seconds;
      inp.className = 'port-input';
      inp.addEventListener('input', () => (j.seconds = Number(inp.value)));
      body.appendChild(el('span', 'muted small-text', ' seconds'));
    } else if ((j.type === 'restart' || j.type === 'stop') && taskData.canCommand) {
      const line = el('div', 'muted small-text');
      line.append('Warn players ');
      const inp = el('input');
      inp.value = (j.warnMinutes ?? []).join(', ');
      inp.placeholder = '5, 1';
      inp.className = 'short-input';
      inp.addEventListener('input', () => (j.warnMinutes = inp.value.split(/[ ,]+/).map(Number).filter((n) => n > 0)));
      line.append(inp, ' minutes before (empty = no warning)');
      body.appendChild(line);
    }
    row.appendChild(body);
    const tools = el('div', 'job-tools');
    const up = el('button', 'small ghost', '↑');
    up.type = 'button';
    up.disabled = i === 0;
    up.addEventListener('click', () => {
      [draftJobs[i - 1], draftJobs[i]] = [draftJobs[i], draftJobs[i - 1]];
      renderDraftJobs();
    });
    const down = el('button', 'small ghost', '↓');
    down.type = 'button';
    down.disabled = i === draftJobs.length - 1;
    down.addEventListener('click', () => {
      [draftJobs[i + 1], draftJobs[i]] = [draftJobs[i], draftJobs[i + 1]];
      renderDraftJobs();
    });
    const rm = el('button', 'small red ghost', '✕');
    rm.type = 'button';
    rm.addEventListener('click', () => {
      draftJobs.splice(i, 1);
      renderDraftJobs();
    });
    tools.append(up, down, rm);
    row.appendChild(tools);
    box.appendChild(row);
  });
}

function newJob(type) {
  return { command: { type, commands: [''] }, say: { type, message: '' }, wait: { type, seconds: 30 }, restart: { type, warnMinutes: taskData.canCommand ? [5, 1] : [] }, stop: { type, warnMinutes: taskData.canCommand ? [5, 1] : [] } }[type] ?? { type };
}

function renderJobAdd() {
  const box = $('taskJobAdd');
  box.innerHTML = '';
  box.appendChild(el('span', 'muted small-text', 'Add: '));
  for (const [type, def] of Object.entries(JOB_TYPES)) {
    if (def.needsCommand && !taskData.canCommand) continue;
    if (def.needsBackup && !taskData.canBackup) continue;
    const b = el('button', 'small', `+ ${def.label}`);
    b.type = 'button';
    b.addEventListener('click', () => {
      draftJobs.push(newJob(type));
      renderDraftJobs();
    });
    box.appendChild(b);
  }
}

function openTaskDialog(task = null, preset = null) {
  editingTask = task?.id ?? null;
  const t = task ?? preset;
  $('taskDialogTitle').textContent = task ? 'Edit task' : 'New task';
  $('taskName').value = t?.name ?? '';
  $('taskEnabled').checked = t?.enabled ?? true;
  $('taskOnlyRunning').checked = t?.onlyWhenRunning ?? false;
  const trig = t?.trigger ?? { type: 'daily', times: ['04:00'], days: [] };
  setWhen(trig.type);
  const every = trig.type === 'interval' ? trig.everyMinutes : 60;
  const unit = every % 1440 === 0 ? 1440 : every % 60 === 0 ? 60 : 1;
  $('taskEvery').value = every / unit;
  $('taskEveryUnit').value = String(unit);
  $('taskTimes').value = trig.type === 'daily' ? trig.times.join(', ') : '04:00';
  const days = $('taskDays');
  days.innerHTML = '';
  DAY_NAMES.forEach((name, d) => {
    const lab = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = d;
    cb.checked = trig.type === 'daily' && trig.days.includes(d);
    lab.append(cb, document.createTextNode(` ${name}`));
    days.appendChild(lab);
  });
  draftJobs = structuredClone(t?.jobs ?? []);
  renderDraftJobs();
  renderJobAdd();
  $('taskError').textContent = '';
  $('taskDialog').showModal();
}

const TASK_PRESETS = {
  restart: { name: 'Daily restart', trigger: { type: 'daily', times: ['04:00'], days: [] }, onlyWhenRunning: true, jobs: [{ type: 'restart', warnMinutes: [5, 1] }] },
  backup: { name: 'Backup every 6 hours', trigger: { type: 'interval', everyMinutes: 360 }, onlyWhenRunning: false, jobs: [{ type: 'backup' }] },
  announce: { name: 'Announcement', trigger: { type: 'interval', everyMinutes: 30 }, onlyWhenRunning: true, jobs: [{ type: 'say', message: 'Welcome! Be nice and have fun.' }] },
  save: { name: 'Save the world', trigger: { type: 'interval', everyMinutes: 15 }, onlyWhenRunning: true, jobs: [{ type: 'command', commands: ['save-all'] }] },
};

$('btnNewTask').addEventListener('click', () => openTaskDialog());
$('taskPreset').addEventListener('change', () => {
  const p = TASK_PRESETS[$('taskPreset').value];
  $('taskPreset').dataset.last = $('taskPreset').value;
  $('taskPreset').value = '';
  if (!p) return;
  const preset = structuredClone(p);
  // Bedrock has no "save-all" (it saves by itself); Valheim can't take commands or warnings.
  if (state.detail.game === 'bedrock' && $('taskPreset').dataset.last === 'save') return toast('Bedrock saves the world by itself; no task needed.', true);
  if (!taskData.canCommand) preset.jobs = preset.jobs.filter((j) => !['command', 'say'].includes(j.type)).map((j) => ({ ...j, warnMinutes: [] }));
  if (!preset.jobs.length) return toast("This server can't run that kind of task.", true);
  openTaskDialog(null, preset);
});
$('taskCancel').addEventListener('click', () => $('taskDialog').close());
$('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = $('taskWhen').dataset.value;
  const trigger =
    type === 'interval'
      ? { type, everyMinutes: Number($('taskEvery').value) * Number($('taskEveryUnit').value) }
      : type === 'daily'
        ? { type, times: $('taskTimes').value.split(/[ ,]+/).filter(Boolean), days: [...$('taskDays').querySelectorAll('input:checked')].map((c) => Number(c.value)) }
        : { type: 'manual' };
  const body = {
    name: $('taskName').value,
    enabled: $('taskEnabled').checked,
    onlyWhenRunning: $('taskOnlyRunning').checked,
    trigger,
    jobs: draftJobs.map((j) => (j.type === 'command' ? { ...j, commands: j.commands.filter((c) => c.trim()) } : j)),
  };
  try {
    if (editingTask) await api('PUT', `/api/servers/${state.selected}/tasks/${editingTask}`, body);
    else await api('POST', `/api/servers/${state.selected}/tasks`, body);
    $('taskDialog').close();
    toast('Task saved');
    loadTasks();
  } catch (err) {
    $('taskError').textContent = err.message;
  }
});

// ---------- world settings (Bedrock: cheats + experiments) ----------

let worldData = null;
let worldUnlocked = false; // advanced: allow turning experiments off
let cheatValues = {}; // current (edited) cheat setting values

async function loadWorld() {
  try {
    worldData = await api('GET', `/api/servers/${state.selected}/world`);
  } catch (err) {
    return toast(err.message, true);
  }
  worldUnlocked = false;
  renderWorld();
}

function renderWorld() {
  const w = worldData;
  const canEdit = hasPerm('properties.edit');
  $('worldMissing').hidden = w.exists;
  $('worldName').textContent = w.world ? `(${w.world})` : '';
  $('worldCheats').checked = w.cheats;
  $('worldCheats').disabled = !canEdit;
  cheatValues = Object.fromEntries(w.cheatSettings.map((s) => [s.key, s.value]));
  renderCheatSettings();

  const box = $('worldExps');
  box.innerHTML = '';
  for (const e of w.experiments) {
    const lab = el('label', `toggle world-toggle${e.locked && !worldUnlocked ? ' locked' : ''}`);
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.key = e.key;
    cb.checked = e.enabled;
    cb.disabled = !canEdit || !w.exists || (e.locked && !worldUnlocked);
    cb.addEventListener('change', worldDirty);
    const text = el('span');
    text.append(el('b', null, `${e.locked && !worldUnlocked ? '🔒 ' : ''}${e.label}`), document.createElement('br'), el('span', 'muted small-text', e.help));
    lab.append(cb, text);
    box.appendChild(lab);
  }
  $('worldEverUsed').hidden = !w.experiments.some((e) => e.locked) || worldUnlocked;
  worldDirty();
}

// Cheat settings, laid out like the game's world settings screen.
function renderCheatSettings() {
  const w = worldData;
  const enabled = hasPerm('properties.edit') && w.exists && $('worldCheats').checked;
  $('cheatSettingsOff').hidden = !w.exists || $('worldCheats').checked;
  const box = $('cheatSettings');
  box.innerHTML = '';
  for (const s of w.cheatSettings) {
    const value = cheatValues[s.key];
    const row = el('div', `cheat-row cheat-${s.kind}${enabled ? '' : ' disabled'}`);
    const text = el('div', 'cheat-text');
    text.append(el('b', null, s.label));
    if (s.kind === 'choice') {
      const seg = el('div', 'segmented');
      for (const o of s.options) {
        const b = el('button', value === o.value ? 'active' : '', o.label);
        b.type = 'button';
        b.disabled = !enabled;
        b.addEventListener('click', () => {
          cheatValues[s.key] = o.value;
          renderCheatSettings();
          worldDirty();
        });
        seg.appendChild(b);
      }
      text.append(seg, el('div', 'muted small-text', s.options.find((o) => o.value === value)?.help ?? ''));
      row.appendChild(text);
    } else if (s.kind === 'int') {
      text.append(el('div', 'muted small-text', s.help));
      const line = el('div', 'with-button');
      const input = el('input');
      input.type = 'number';
      input.min = s.min;
      input.max = s.max;
      input.value = value;
      input.disabled = !enabled;
      input.addEventListener('input', () => {
        cheatValues[s.key] = input.value === '' ? '' : Number(input.value);
        worldDirty();
      });
      const reset = el('button', 'small', 'Reset');
      reset.type = 'button';
      reset.disabled = !enabled;
      reset.addEventListener('click', () => {
        cheatValues[s.key] = s.def;
        input.value = s.def;
        worldDirty();
      });
      line.append(input, reset);
      text.appendChild(line);
      row.appendChild(text);
    } else {
      text.append(el('div', 'muted small-text', s.help));
      const sw = el('input', 'switch');
      sw.type = 'checkbox';
      sw.checked = !!value;
      sw.disabled = !enabled;
      sw.addEventListener('change', () => {
        cheatValues[s.key] = sw.checked;
        worldDirty();
      });
      row.append(text, sw);
    }
    box.appendChild(row);
  }
}

function worldChanges() {
  const changes = {};
  if ($('worldCheats').checked !== worldData.cheats) changes.cheats = $('worldCheats').checked;
  const exps = {};
  for (const cb of $('worldExps').querySelectorAll('input[data-key]')) {
    const was = worldData.experiments.find((e) => e.key === cb.dataset.key)?.enabled;
    if (cb.checked !== was) exps[cb.dataset.key] = cb.checked;
  }
  if (Object.keys(exps).length) changes.experiments = exps;
  const cheatSettings = {};
  for (const s of worldData.cheatSettings) if (cheatValues[s.key] !== s.value) cheatSettings[s.key] = cheatValues[s.key];
  if (Object.keys(cheatSettings).length) changes.cheatSettings = cheatSettings;
  if (worldUnlocked && Object.values(exps).some((v) => !v)) changes.force = true;
  return changes;
}

function worldDirty() {
  const changes = worldChanges();
  const dirty = Object.keys(changes).length > 0;
  const running = ['running', 'starting'].includes(state.detail.status);
  $('worldSave').disabled = !dirty;
  $('worldReset').disabled = !dirty;
  $('worldSave').textContent = running ? 'Save and restart' : 'Save';
  $('worldStatus').textContent = !dirty
    ? ''
    : running
      ? 'The server is running: saving stops it (the world is saved first), applies the changes and starts it again.'
      : 'Changes take effect the next time the server starts.';
}

$('worldCheats').addEventListener('change', () => {
  renderCheatSettings();
  worldDirty();
});
$('worldUnlock').addEventListener('click', async (e) => {
  e.preventDefault();
  const ok = await confirmBox(
    'Unlock experiments?\n\nThe game never lets you turn experiments off, because the world may contain experimental blocks, items or data that break without them (missing blocks, lost items, or a world that won\'t load).\n\nServer Forge keeps a copy of the world settings file (level.dat.tavernhost-bak), but make a backup on the Backups tab first to be safe.',
  );
  if (!ok) return;
  worldUnlocked = true;
  renderWorld();
});
$('worldReset').addEventListener('click', renderWorld);
$('worldSave').addEventListener('click', async () => {
  const running = ['running', 'starting'].includes(state.detail.status);
  if (running && !await confirmBox('Restart the server now to apply these world settings? Players will be disconnected for a moment.')) return;
  $('worldSave').disabled = true;
  $('worldStatus').textContent = running ? 'Stopping the server, applying, starting again…' : 'Saving…';
  try {
    const result = await api('PUT', `/api/servers/${state.selected}/world`, { ...worldChanges(), restart: running });
    worldData = result;
    worldUnlocked = false;
    renderWorld();
    toast(result.notes.length ? `${result.notes.join(', ')}${result.restarted ? ' · restarting' : ''}` : 'Nothing changed');
  } catch (err) {
    toast(err.message, true);
    worldDirty();
  }
});

// ---------- server files (Files tab) ----------
// Paths here are relative to the server's folder; the service refuses anything outside it.

const sf = { server: null, path: '', parent: null, entries: [] };
const sfUrl = (what, rel) => `/api/servers/${state.selected}/files${what}?path=${encodeURIComponent(rel)}`;
const sfJoin = (dir, name) => (dir ? `${dir}/${name}` : name);

async function openServerFiles(rel = sf.path) {
  try {
    const data = await api('GET', sfUrl('', rel));
    Object.assign(sf, { server: state.selected, path: data.path, parent: data.parent, entries: data.entries });
  } catch (err) {
    if (rel) return openServerFiles(''); // folder vanished: go back to the top
    return toast(err.message, true);
  }
  renderServerFiles();
}

function renderServerFiles() {
  $('sfUp').disabled = sf.parent === null;
  $('sfExplorer').hidden = !window.desktop?.openFolder;
  const crumbs = $('sfCrumbs');
  crumbs.innerHTML = '';
  const parts = sf.path ? sf.path.split('/') : [];
  const rootBtn = el('button', 'crumb', state.detail.name);
  rootBtn.addEventListener('click', () => openServerFiles(''));
  crumbs.appendChild(rootBtn);
  parts.forEach((part, i) => {
    crumbs.appendChild(el('span', 'muted', '/'));
    const b = el('button', 'crumb', part);
    b.addEventListener('click', () => openServerFiles(parts.slice(0, i + 1).join('/')));
    crumbs.appendChild(b);
  });
  const dirs = sf.entries.filter((e) => e.type === 'dir').length;
  $('sfInfo').textContent = `${dirs} folder${dirs === 1 ? '' : 's'}, ${sf.entries.length - dirs} file${sf.entries.length - dirs === 1 ? '' : 's'}`;
  const list = $('sfList');
  list.innerHTML = '';
  if (!sf.entries.length) list.appendChild(el('p', 'muted small-text', 'This folder is empty.'));
  for (const entry of sf.entries) list.appendChild(serverFileRow(entry));
}

function serverFileRow(entry) {
  const rel = sfJoin(sf.path, entry.name);
  const row = el('div', `browse-row ${entry.type}`);
  row.appendChild(el('span', 'icon', entry.type === 'dir' ? '📁' : entry.editable ? '📝' : '📄'));
  const name = el('span', 'name', entry.name);
  row.appendChild(name);
  const meta = [entry.type === 'file' ? fmtSize(entry.size) : '', entry.modified ? new Date(entry.modified).toLocaleString() : ''].filter(Boolean).join(' · ');
  row.appendChild(el('span', 'meta', meta));
  const actions = el('span', 'row-actions');
  const canWrite = hasPerm('files.edit');
  if (entry.type === 'file') {
    if (entry.editable) {
      // Without "Edit files" the editor opens read-only (see editServerFile).
      const edit = el('button', 'small', canWrite ? 'Edit' : 'View');
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        editServerFile(rel);
      });
      actions.appendChild(edit);
    }
    const dl = el('a', 'small button-like', 'Download');
    dl.href = sfUrl('/download', rel);
    dl.download = entry.name;
    dl.addEventListener('click', (e) => e.stopPropagation());
    actions.appendChild(dl);
  }
  const ren = el('button', 'small', 'Rename');
  ren.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = inlineNameInput(entry.name, async (newName) => {
      try {
        await api('POST', `/api/servers/${state.selected}/files/rename`, { path: rel, name: newName });
        toast('Renamed');
      } catch (err) {
        toast(err.message, true);
      }
      openServerFiles();
    }, renderServerFiles);
    name.replaceWith(input);
    input.focus();
    input.select();
  });
  const del = el('button', 'small red ghost', 'Delete');
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    const what = entry.type === 'dir' ? `the folder "${entry.name}" and everything in it` : `"${entry.name}"`;
    if (!await confirmBox(`Delete ${what}?\n\nIt goes to the Recycle Bin or Trash (on network and other drives it may be deleted permanently).`)) return;
    try {
      await api('POST', `/api/servers/${state.selected}/files/delete`, { path: rel });
      toast('Deleted');
    } catch (err) {
      toast(err.message, true);
    }
    openServerFiles();
  });
  if (canWrite) actions.append(ren, del);
  row.appendChild(actions);
  if (entry.type === 'dir') row.addEventListener('click', () => openServerFiles(rel));
  else if (entry.editable) row.addEventListener('dblclick', () => editServerFile(rel));
  return row;
}

function sfNewEntry(isFile) {
  const row = el('div', `browse-row ${isFile ? 'file' : 'dir'}`);
  row.appendChild(el('span', 'icon', isFile ? '📝' : '📁'));
  const input = inlineNameInput('', async (name) => {
    try {
      const { path: created } = await api('POST', `/api/servers/${state.selected}/files/mkdir`, { path: sf.path, name, file: isFile });
      await openServerFiles();
      if (isFile) editServerFile(created);
    } catch (err) {
      toast(err.message, true);
      renderServerFiles();
    }
  }, renderServerFiles);
  input.placeholder = isFile ? 'New file name, e.g. notes.txt' : 'New folder name';
  row.appendChild(input);
  $('sfList').prepend(row);
  input.focus();
}

async function sfUploadFiles(fileList) {
  for (const file of fileList) {
    toast(`Uploading ${file.name}…`);
    try {
      const res = await fetch(sfUrl('/upload', sf.path), {
        method: 'POST',
        headers: { 'X-Panel': '1', 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
  toast(fileList.length === 1 ? 'Uploaded' : `Uploaded ${fileList.length} files`);
  openServerFiles();
}

$('btnServerFiles').addEventListener('click', () => setTab('files'));
$('sfUp').addEventListener('click', () => sf.parent !== null && openServerFiles(sf.parent));
$('sfRefresh').addEventListener('click', () => openServerFiles());
$('sfNewFolder').addEventListener('click', () => sfNewEntry(false));
$('sfNewFile').addEventListener('click', () => sfNewEntry(true));
$('sfExplorer').addEventListener('click', () => {
  const base = state.detail.installDir.replace(/[\\/]+$/, '');
  window.desktop?.openFolder?.(sf.path ? joinPath(base, base.startsWith('/') ? sf.path : sf.path.replaceAll('/', '\\')) : base);
});
$('sfUpload').addEventListener('change', () => {
  sfUploadFiles([...$('sfUpload').files]);
  $('sfUpload').value = '';
});
for (const evt of ['dragenter', 'dragover']) {
  $('sfList').addEventListener(evt, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    $('sfList').classList.add('over');
  });
}
for (const evt of ['dragleave', 'drop']) $('sfList').addEventListener(evt, () => $('sfList').classList.remove('over'));
$('sfList').addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  sfUploadFiles([...e.dataTransfer.files]);
});

// Text editor
const editor = { path: null, bom: false, modified: null, original: '' };

async function editServerFile(rel) {
  try {
    const data = await api('GET', sfUrl('/content', rel));
    Object.assign(editor, { path: data.path, bom: data.bom, modified: data.modified, original: data.content });
    $('editTitle').textContent = data.path.split('/').pop();
    $('editInfo').textContent = `${state.detail.name} / ${data.path} · ${fmtSize(data.size)}`;
    $('editText').value = data.content;
    // Read-only without "Edit files".
    $('editText').readOnly = !hasPerm('files.edit');
    $('editSave').hidden = !hasPerm('files.edit');
    $('editDialog').showModal();
    $('editText').focus();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveServerFile() {
  try {
    const { modified, running } = await api('PUT', sfUrl('/content', editor.path).split('?')[0], {
      path: editor.path,
      content: $('editText').value,
      bom: editor.bom,
      modified: editor.modified,
    });
    editor.modified = modified;
    editor.original = $('editText').value;
    toast(running ? 'Saved. Restart the server if it only reads this file at startup.' : 'Saved');
    if (state.tab === 'files') openServerFiles();
  } catch (err) {
    toast(err.message, true);
  }
}

$('editSave').addEventListener('click', saveServerFile);
$('editText').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveServerFile();
  } else if (e.key === 'Tab') {
    // Insert a real tab instead of moving focus.
    e.preventDefault();
    const t = e.target;
    const [a, b] = [t.selectionStart, t.selectionEnd];
    t.setRangeText('  ', a, b, 'end');
  }
});
async function closeEditor(e) {
  if ($('editText').value !== editor.original) {
    // Esc (the dialog's cancel event) has to be stopped now; the dialog closes below if they confirm.
    e?.preventDefault();
    if (!(await confirmBox('Close without saving your changes?', 'Close'))) return;
  }
  $('editDialog').close();
}
$('editClose').addEventListener('click', () => closeEditor());
$('editDialog').addEventListener('cancel', (e) => closeEditor(e));

// Any button with data-browse="<inputId>" opens the browser for that input.
document.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-browse]');
  if (b) openBrowser(b.dataset.browse).catch((err) => toast(err.message, true));
});

// ---------- new server (Server Forge downloads the software) ----------

function slug(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

let newFolderTouched = false;

// New / Import on another system (a node): its own games list and versions, and the request goes through this panel.
let newTarget = ''; // node id, or '' for this system
let newGames = null; // the node's games (null = this system's state.games)
const dialogGames = () => newGames ?? state.games;
const gamesApi = () => (newTarget ? `/api/nodes/${encodeURIComponent(newTarget)}` : '/api');

/** Fills a System picker (this system + nodes); hidden when there are no nodes. Resolves to whether it's shown. */
async function fillSystemPicker(select, wrap) {
  select.innerHTML = '';
  select.add(new Option('This system', ''));
  let nodes = [];
  if (hasGlobal('servers.create')) nodes = (await api('GET', '/api/node-targets').catch(() => ({ nodes: [] }))).nodes;
  for (const n of nodes) {
    const opt = new Option(`${n.name}${n.online ? '' : ' (offline)'}`, n.id);
    opt.disabled = !n.online;
    select.add(opt);
  }
  wrap.hidden = !nodes.length;
}

/** Switches the New/Import dialog to a system: loads that node's games (or this system's). */
async function useSystem(nodeId) {
  newTarget = nodeId;
  newGames = null;
  if (nodeId) {
    try {
      newGames = await api('GET', `/api/nodes/${encodeURIComponent(nodeId)}/games`);
    } catch (err) {
      toast(err.message, true);
      newTarget = '';
    }
  }
  // Browsing a node's folders isn't available from here: type the path on that system.
  for (const b of document.querySelectorAll('[data-browse="newFolder"], [data-browse="addInstall"]')) {
    b.disabled = !!newTarget;
    b.title = newTarget ? 'Type the folder path on that system' : '';
  }
}

function renderNewFields() {
  const game = dialogGames().find((g) => g.id === $('newGame').value);
  const box = $('newFields');
  box.innerHTML = '';
  $('newEulaWrap').hidden = !game?.eula;
  if (game?.eula) {
    $('newEulaLabel').textContent = game.eula.label;
    $('newEulaLink').href = game.eula.url;
    $('newEula').checked = false;
  }
  if (!game) return;
  const defaults = {
    port: game.id === 'hytale' ? '5520' : game.id === 'java' ? '25565' : '2456',
    world: 'Dedicated',
    memoryMb: '4096',
    'prop:server-port': '19132',
    'prop:level-name': 'Bedrock level',
    'prop:gamemode': 'survival',
    'prop:difficulty': 'easy',
    'prop:max-players': '10',
  };
  for (const f of game.newFields) {
    const key = f.key;
    if (f.type === 'select') {
      box.appendChild(selectField(game, f, `nf_${key}`, defaults[key]));
      continue;
    }
    const wrap = el('div', f.type === 'boolean' ? 'full' : '');
    const id = `nf_${f.key}`;
    if (f.type === 'boolean') {
      const lab = el('label', 'toggle');
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      lab.append(input, document.createTextNode(` ${f.label}`));
      wrap.appendChild(lab);
    } else {
      const lab = el('label', null, f.label);
      lab.htmlFor = id;
      const input = el('input');
      input.id = id;
      input.type = f.type === 'number' ? 'number' : 'text';
      input.value = defaults[key] ?? '';
      wrap.append(lab, input);
    }
    if (f.help) wrap.appendChild(el('div', 'field-help', f.help));
    box.appendChild(wrap);
  }
}

/**
 * A dropdown for a game field. Fields with `optionsFrom` (e.g. Minecraft version, from the server type) load their
 * choices from the server whenever the field they depend on changes.
 */
function selectField(game, f, id, initial) {
  const wrap = el('div');
  const lab = el('label', null, f.label);
  lab.htmlFor = id;
  const select = el('select');
  select.id = id;
  select.dataset.key = f.key;
  const help = el('div', 'field-help');
  wrap.append(lab, select, help);

  const showHelp = () => {
    const opt = f.options?.find((o) => o.value === select.value);
    help.textContent = opt?.help ?? f.help ?? '';
  };

  if (f.options) {
    for (const o of f.options) select.add(new Option(o.label, o.value));
    if (initial) select.value = initial;
    select.addEventListener('change', showHelp);
    showHelp();
  }

  if (f.optionsFrom) {
    const load = async () => {
      const source = document.querySelector(`#${CSS.escape(`nf_${f.optionsFrom}`)}`);
      if (!source) return;
      select.innerHTML = '';
      select.add(new Option('Loading versions…', ''));
      select.disabled = true;
      try {
        const { versions } = await api('GET', `${gamesApi()}/games/${game.id}/versions?from=${encodeURIComponent(source.value)}`);
        select.innerHTML = '';
        for (const v of versions) select.add(new Option(v === 'latest' ? 'Latest' : v, v));
        help.textContent = versions.length ? `Newest first. ${versions.length} available.` : 'No versions available.';
      } catch (err) {
        select.innerHTML = '';
        help.textContent = `Couldn't load versions: ${err.message}`;
      } finally {
        select.disabled = false;
      }
      // BungeeCord is a proxy: its default port differs.
      const port = $('nf_port');
      if (port && !port.dataset.touched) port.value = source.value === 'bungeecord' ? '25577' : '25565';
    };
    // Wait until the source field exists in the form, then follow its changes.
    setTimeout(() => {
      document.querySelector(`#${CSS.escape(`nf_${f.optionsFrom}`)}`)?.addEventListener('change', load);
      load();
    });
  }
  return wrap;
}

// Big game buttons in the New server dialog (they set the hidden #newGame select the rest of the form reads).
const GAME_BLURBS = {
  valheim: 'Viking survival co-op. Vanilla or modded (BepInEx).',
  bedrock: 'Minecraft for Windows, consoles and phones. Addons and crossplay.',
  java: 'Minecraft Java Edition: Vanilla, Paper, Fabric, Forge, NeoForge and more.',
  'terraria-vanilla': 'The official Terraria server, no mods. Players join with the normal game.',
  terraria: 'Terraria with tModLoader mods. Players need tModLoader (free on Steam); it downloads the server’s mods by itself.',
  satisfactory: 'Factory building co-op. Works with the in-game Server Manager; mods through Satisfactory Mod Manager.',
  spaceengineers: 'Build ships and stations in space. Steam Workshop mods download to players by themselves.',
  hytale: 'Explore and build in Hytale. Downloads need a Hytale account: follow the login link in Console. Java 25 is installed automatically. Uses UDP port 5520.',
  factorio: 'Build and automate factories, with or without Space Age. Needs your factorio.com login (Settings → Integrations); mods from the mod portal.',
  palworld: 'Catch Pals, build bases, survive together. Players, announcements and clean stops through its REST API.',
  enshrouded: 'Survival and base building in a foggy world. Up to 16 players, with password-protected roles.',
  sevendays: 'Zombie survival crafting: build by day, defend at night. Console through its telnet admin port.',
  zomboid: 'Project Zomboid: survive the zombie apocalypse together. Console commands, admins and Steam Workshop mods in its settings.',
  vrising: 'Vampire survival: build a castle, hunt, rise. PvE or PvP.',
};
function renderGamePicks() {
  const box = $('newGamePicks');
  box.innerHTML = '';
  for (const g of dialogGames().filter((x) => x.canCreate)) {
    const b = el('button', `game-pick${$('newGame').value === g.id ? ' active' : ''}`);
    b.type = 'button';
    b.appendChild(serverIcon({ game: g.id, settings: { flavor: 'vanilla' } }, 'srv-icon pick'));
    const text = el('span', 'game-pick-text');
    // A Linux system downloads Factorio's free headless server, with no factorio.com login.
    const blurb = g.id === 'factorio' && g.serverRoot?.startsWith('/') ? 'Build and automate factories, with or without Space Age. Free Linux server; mods from the mod portal need your factorio.com login.' : GAME_BLURBS[g.id] ?? '';
    text.append(el('b', null, g.name), el('span', 'muted small-text', `${blurb}${g.needsWine ? ' Runs through Wine on this system.' : ''}`));
    b.appendChild(text);
    b.addEventListener('click', () => {
      if ($('newGame').value === g.id) return;
      $('newGame').value = g.id;
      renderGamePicks();
      renderNewFields();
    });
    box.appendChild(b);
  }
}

/** Fills the New dialog's game list for the chosen system and redraws it. */
function resetNewGames() {
  const creatable = dialogGames().filter((g) => g.canCreate);
  const keep = $('newGame').value;
  $('newGame').innerHTML = '';
  for (const g of creatable) $('newGame').add(new Option(g.name, g.id));
  $('newGame').value = creatable.some((g) => g.id === keep) ? keep : (creatable[0]?.id ?? '');
  renderGamePicks();
  renderNewFields();
}
const serverRoot = () => (newTarget ? (dialogGames()[0]?.serverRoot ?? 'C:\\GameServers') : (state.serverRoot ?? 'C:\\GameServers'));

$('btnNewServer').addEventListener('click', async () => {
  $('newForm').reset();
  newFolderTouched = false;
  $('newError').textContent = '';
  await useSystem('');
  resetNewGames();
  $('newDialog').showModal();
  await fillSystemPicker($('newSystem'), $('newSystemWrap'));
});
$('newSystem').addEventListener('change', async () => {
  await useSystem($('newSystem').value);
  $('newSystem').value = newTarget;
  resetNewGames();
  if (!newFolderTouched) $('newFolder').value = $('newName').value.trim() ? joinPath(serverRoot(), slug($('newName').value)) : '';
});
$('newGame').addEventListener('change', renderNewFields);
$('newName').addEventListener('input', () => {
  if (!newFolderTouched) $('newFolder').value = $('newName').value.trim() ? joinPath(serverRoot(), slug($('newName').value)) : '';
  const serverName = $('nf_serverName') ?? $('nf_prop:server-name');
  if (serverName && !serverName.dataset.touched) serverName.value = $('newName').value;
});
$('newFolder').addEventListener('input', () => (newFolderTouched = true));
$('newFields').addEventListener('input', (e) => (e.target.dataset.touched = '1'));
$('newCancel').addEventListener('click', () => $('newDialog').close());
$('newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const game = dialogGames().find((g) => g.id === $('newGame').value);
  if (!game) return;
  const settings = {};
  for (const f of game.newFields) {
    const input = $(`nf_${f.key}`);
    if (!input) continue;
    settings[f.key] = f.type === 'boolean' ? input.checked : f.type === 'number' ? Number(input.value) : input.value;
  }
  if ('mcVersion' in settings && !settings.mcVersion) {
    $('newError').textContent = 'Pick a Minecraft version (wait for the list to load).';
    return;
  }
  if (game.eula && !$('newEula').checked) {
    $('newError').textContent = 'Tick the box to accept the Minecraft EULA first.';
    return;
  }
  $('newSubmit').disabled = true;
  try {
    const snap = await api('POST', newTarget ? `/api/nodes/${encodeURIComponent(newTarget)}/servers/new` : '/api/servers/new', {
      game: game.id,
      name: $('newName').value,
      installDir: $('newFolder').value,
      settings,
      acceptEula: game.eula ? $('newEula').checked : undefined,
    });
    state.servers.set(snap.id, snap);
    $('newDialog').close();
    state.tab = 'overview';
    renderSidebar();
    await selectServer(snap.id);
    toast(snap.node ? `Creating your server on ${snap.node.name}. Download progress is shown below.` : 'Creating your server. Download progress is shown below.');
  } catch (err) {
    $('newError').textContent = err.message;
  } finally {
    $('newSubmit').disabled = false;
  }
});
// Browsing for the folder counts as choosing it yourself.
$('newDialog').addEventListener('click', (e) => {
  if (e.target.closest('[data-browse="newFolder"]')) newFolderTouched = true;
});

// ---------- import server ----------

/** The Import dialog's game list for the chosen system. */
function resetAddGames() {
  const keep = $('addGame').value;
  $('addGame').innerHTML = '';
  for (const g of dialogGames()) $('addGame').add(new Option(g.name, g.id));
  if (dialogGames().some((g) => g.id === keep)) $('addGame').value = keep;
}
$('btnAddServer').addEventListener('click', async () => {
  $('addError').textContent = '';
  await useSystem('');
  resetAddGames();
  $('addEndstoneHelp').hidden = $('addGame').value !== 'bedrock';
  $('addDialog').showModal();
  await fillSystemPicker($('addSystem'), $('addSystemWrap'));
});
$('addSystem').addEventListener('change', async () => {
  await useSystem($('addSystem').value);
  $('addSystem').value = newTarget;
  resetAddGames();
});
$('addCancel').addEventListener('click', () => $('addDialog').close());
$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Importing an Endstone server can take a while (it looks for its Python and brings plugins in).
  $('addSubmit').disabled = true;
  $('addSubmit').textContent = 'Adding…';
  try {
    const snap = await api('POST', newTarget ? `/api/nodes/${encodeURIComponent(newTarget)}/servers` : '/api/servers', { game: $('addGame').value, name: $('addName').value, installDir: $('addInstall').value });
    state.servers.set(snap.id, snap);
    $('addDialog').close();
    $('addForm').reset();
    state.tab = 'settings';
    renderSidebar();
    await selectServer(snap.id);
    toast(snap.node ? `Server added on ${snap.node.name}. Check its settings, then press Start.` : 'Server added. Check its settings, then press Start.');
    // What came along (Endstone: its addons, and plugins brought in from its old Python).
    if (snap.importNotes?.length) await noticeBox(`"${snap.name}" was added.\n\n${snap.importNotes.map((n) => `• ${n}`).join('\n')}`);
  } catch (err) {
    $('addError').textContent = err.message;
  } finally {
    $('addSubmit').disabled = false;
    $('addSubmit').textContent = 'Add server';
  }
});
// Endstone servers: the folder Endstone was run in works too (the server is in its bedrock_server folder).
$('addGame').addEventListener('change', () => ($('addEndstoneHelp').hidden = $('addGame').value !== 'bedrock'));

// ---------- panel settings (owner) ----------

function fmtWhen(ms) {
  return ms ? `${duration(Date.now() - ms)} ago` : 'never';
}

$('btnSettings').addEventListener('click', openSettings);
$('btnCloseSettings').addEventListener('click', () => {
  $('settingsView').hidden = true;
  if (state.selected) $('serverView').hidden = false;
  else $('emptyState').hidden = false;
});

async function openSettings() {
  hideStorage();
  renderSidebar();
  $('serverView').hidden = true;
  $('emptyState').hidden = true;
  $('settingsView').hidden = false;
  if (hasGlobal('storage.view') || hasGlobal('panel.settings')) {
    renderStorageSettings();
    loadVaultSummary();
  }
  // Updating from a file runs the installer on this system: installed desktop app only (not the web page, not dev).
  const canRunInstallers = !!window.desktop?.pickInstaller && state.build !== 'development';
  $('btnUpdateFile').hidden = !canRunInstallers;
  $('updateFileHelp').hidden = !canRunInstallers;
  if (hasGlobal('panel.settings')) loadAppUpdate(false);
  $('apiBase').textContent = location.origin;
  applyPermVisibility($('settingsView'));
  const jobs = [];
  if (hasGlobal('panel.settings')) jobs.push(loadRemote(), loadIntegrations(), loadBackupCopy(), loadNodes());
  if (hasGlobal('users.manage')) jobs.push(loadUsers(), loadKeys());
  if (hasGlobal('audit.view')) jobs.push(loadActivity());
  await Promise.all(jobs).catch((err) => toast(err.message, true));
}

// Remote access

function renderRemote(r) {
  $('remoteEnabled').checked = r.enabled;
  $('remotePort').value = r.port;
  const box = $('remoteStatus');
  box.innerHTML = '';
  if (!r.enabled) return box.appendChild(el('p', 'muted', 'Remote access is off. Only this system can use the panel.'));
  if (r.error) return box.appendChild(el('p', 'error', `Not running: ${r.error}`));
  box.appendChild(el('p', null, r.listening ? 'Remote access is on. Other devices can open:' : 'Starting…'));
  for (const addr of [r.hostname, ...r.addresses]) box.appendChild(el('div', 'addr', addr));
  box.appendChild(el('p', 'muted small-text', 'For access over the internet, forward this port on your router to this system, then use your public IP.'));
}

async function loadRemote() {
  renderRemote(await api('GET', '/api/settings/remote'));
}

$('btnRemoteSave').addEventListener('click', async () => {
  $('btnRemoteSave').disabled = true;
  try {
    renderRemote(await api('PUT', '/api/settings/remote', { enabled: $('remoteEnabled').checked, port: Number($('remotePort').value) }));
    toast($('remoteEnabled').checked ? 'Remote access is on' : 'Remote access is off');
  } catch (err) {
    toast(err.message, true);
    loadRemote();
  } finally {
    $('btnRemoteSave').disabled = false;
  }
});

$('btnFirewall').addEventListener('click', async () => {
  try {
    toast(state.platform === 'linux' ? 'Approve the admin prompt if one appears…' : 'Approve the Windows admin prompt…');
    await api('POST', '/api/settings/remote/firewall');
    toast('Firewall rule added');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- nodes (Settings) ----------

async function loadNodes() {
  let data;
  try {
    data = await api('GET', '/api/nodes');
  } catch {
    return;
  }
  const list = $('nodeList');
  list.innerHTML = '';
  $('nodeCount').textContent = data.nodes.length ? String(data.nodes.length) : '';
  if (!data.nodes.length) list.appendChild(el('p', 'muted small-text', 'No nodes yet.'));
  for (const n of data.nodes) {
    const row = el('div', 'node-row');
    row.appendChild(el('span', `node-dot${n.online ? '' : ' off'}`));
    const info = el('div', 'node-info');
    info.appendChild(el('b', null, n.name));
    const what = n.kind === 'vault' ? `Tavern Vault only (storage)${n.version ? ` · Tavern Vault v${n.version}` : ''}` : `${n.servers} server${n.servers === 1 ? '' : 's'}${n.version ? ` · v${n.version}` : ''}`;
    info.appendChild(el('div', 'muted small-text', `${n.host}:${n.port} · ${n.online ? `online · ${what}` : n.restarting ? 'restarting (update)…' : `offline${n.error ? `: ${n.error}` : ''}`}`));
    row.appendChild(info);
    const rename = el('button', 'small ghost', 'Rename');
    rename.addEventListener('click', async () => {
      const name = await ask('Name for this system:', n.name);
      if (!name) return;
      await api('PUT', `/api/nodes/${n.id}`, { name }).catch((err) => toast(err.message, true));
      loadNodes();
    });
    const remove = el('button', 'small red ghost', 'Remove');
    remove.addEventListener('click', async () => {
      if (!await confirmBox(`Remove "${n.name}"? Its servers disappear from this panel (they keep running on that system). You can add it again with a new code.`)) return;
      await api('DELETE', `/api/nodes/${n.id}`).catch((err) => toast(err.message, true));
      refreshPanelName();
      loadNodes();
    });
    row.append(rename, remove);
    list.appendChild(row);
  }
}
$('btnAddNode').addEventListener('click', async () => {
  const code = $('nodeCode').value.trim();
  if (!code) return;
  $('btnAddNode').disabled = true;
  try {
    await api('POST', '/api/nodes', { code });
    $('nodeCode').value = '';
    toast('Node added. Its servers appear in the list on the left.');
    refreshPanelName();
    loadNodes();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('btnAddNode').disabled = false;
  }
});
$('btnNodeCode').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/node-code', {});
    $('nodeCodeValue').value = r.code;
    $('nodeCodeBox').hidden = false;
    $('nodeCodeStatus').textContent = 'Paste this into the main panel (Settings → Nodes). It isn\'t shown again.';
  } catch (err) {
    $('nodeCodeStatus').textContent = err.message;
  }
});
$('btnCopyClientUrl').addEventListener('click', async () => {
  const url = $('clientDownloadUrl').textContent;
  try {
    await navigator.clipboard.writeText(url);
    toast('Download link copied: send it to your players');
  } catch {
    toast(url);
  }
});
$('btnCopyNodeCode').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('nodeCodeValue').value);
    toast('Copied');
  } catch {
    $('nodeCodeValue').select();
    toast('Press Ctrl+C to copy');
  }
});

// ---------- backup copies (Settings) ----------

async function loadBackupCopy() {
  try {
    const s = await api('GET', '/api/settings/backup-copy');
    $('bcEnabled').checked = s.enabled;
    $('bcFolder').value = s.folder;
    $('bcKeep').value = s.keepDays;
    $('btnBcSync').disabled = !s.enabled;
    $('bcStatus').textContent = s.enabled ? `On: copying to ${s.folder}` : 'Off';
  } catch {}
}
$('btnBcSave').addEventListener('click', async () => {
  try {
    const s = await api('PUT', '/api/settings/backup-copy', { enabled: $('bcEnabled').checked, folder: $('bcFolder').value.trim(), keepDays: Number($('bcKeep').value) });
    toast(s.enabled ? 'Backup copies on' : 'Backup copies off');
    loadBackupCopy();
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnBcTest').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/settings/backup-copy/test', { folder: $('bcFolder').value.trim() });
    $('bcStatus').textContent = `Folder works${r.free != null ? ` (${fmtSize(r.free)} free)` : ''}.`;
  } catch (err) {
    $('bcStatus').textContent = err.message;
  }
});
$('btnBcSync').addEventListener('click', async () => {
  try {
    await api('POST', '/api/settings/backup-copy/sync');
    toast('Copying existing backups in the background…');
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- health warnings (top bar) ----------

let alerts = [];

async function loadAlerts() {
  try {
    alerts = (await api('GET', '/api/alerts')).alerts;
  } catch {
    return;
  }
  const open = alerts.filter((a) => !a.dismissed);
  $('btnAlerts').hidden = !alerts.length;
  $('alertCount').textContent = String(open.length);
  $('btnAlerts').classList.toggle('has-error', open.some((a) => a.level === 'error'));
  $('btnAlerts').classList.toggle('quiet', !open.length);
  if (!$('alertsPop').hidden) renderAlerts();
}

function renderAlerts() {
  const pop = $('alertsPop');
  pop.innerHTML = '';
  pop.appendChild(el('div', 'alerts-head', 'Health warnings'));
  if (!alerts.length) pop.appendChild(el('p', 'muted small-text', 'Everything looks fine.'));
  for (const a of alerts) {
    const item = el('div', `alert-item ${a.level}${a.dismissed ? ' dismissed' : ''}`);
    item.appendChild(el('b', null, `${a.level === 'error' ? '⛔' : '⚠'} ${a.title}`));
    item.appendChild(el('div', 'small-text', a.detail));
    const row = el('div', 'alert-actions');
    row.appendChild(el('span', 'muted small-text', `since ${fmtAgo(a.since)}`));
    if (a.serverId && state.servers.has(a.serverId)) {
      const go = el('button', 'small ghost', 'Open server');
      go.addEventListener('click', () => {
        pop.hidden = true;
        selectServer(a.serverId);
      });
      row.appendChild(go);
    }
    if (!a.dismissed) {
      const dis = el('button', 'small ghost', 'Dismiss');
      dis.title = 'Hide until it happens again';
      dis.addEventListener('click', async () => {
        await api('POST', `/api/alerts/${encodeURIComponent(a.id)}/dismiss`).catch(() => {});
        loadAlerts();
      });
      row.appendChild(dis);
    }
    item.appendChild(row);
    pop.appendChild(item);
  }
}

$('btnAlerts').addEventListener('click', (e) => {
  e.stopPropagation();
  $('alertsPop').hidden = !$('alertsPop').hidden;
  if (!$('alertsPop').hidden) renderAlerts();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.alerts-wrap')) $('alertsPop').hidden = true;
});

// ---------- worlds (Bedrock / Java) ----------

async function loadWorlds(data) {
  const id = state.selected;
  if (!data) {
    $('worldsStatus').textContent = 'Reading worlds…';
    try {
      data = await api('GET', `/api/servers/${id}/worlds`);
    } catch (err) {
      $('worldsStatus').textContent = '';
      return toast(err.message, true);
    }
  }
  if (id !== state.selected) return;
  $('worldsStatus').textContent = '';
  const bedrock = state.detail.game === 'bedrock';
  $('worldImportFile').accept = bedrock ? '.mcworld,.zip' : '.zip';
  $('worldCount').textContent = data.worlds.length ? String(data.worlds.length) : '';
  const body = $('worldRows');
  body.innerHTML = '';
  if (!data.worlds.length) {
    const td = el('td', 'muted', 'No worlds yet. Start the server once to create one, or import one.');
    td.colSpan = 5;
    const tr = el('tr');
    tr.appendChild(td);
    body.appendChild(tr);
  }
  for (const w of data.worlds) {
    const tr = el('tr');
    const nameTd = el('td');
    nameTd.appendChild(el('b', null, w.name));
    if (w.active) nameTd.appendChild(el('span', 'type-badge loc-world', data.running ? 'Active · loaded' : 'Active'));
    tr.appendChild(nameTd);
    tr.appendChild(el('td', 'mono small-text', w.folder));
    tr.appendChild(el('td', null, fmtSize(w.size)));
    tr.appendChild(el('td', null, new Date(w.modified).toLocaleString()));
    const actions = el('td', 'actions');
    if (!w.active && hasPerm('properties.edit')) {
      const use = el('button', 'small', 'Make active');
      use.title = 'Load this world instead (at the next start)';
      use.addEventListener('click', async () => {
        try {
          const r = await api('POST', `/api/servers/${id}/worlds/${encodeURIComponent(w.folder)}/activate`);
          toast(r.restartNeeded ? `"${w.name}" is now active. Restart the server to load it.` : `"${w.name}" is now active.`);
          loadWorlds(r);
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.appendChild(use);
    }
    if (hasPerm('files.view')) {
      const exp = el('a', 'button-like small', 'Export');
      exp.href = `/api/servers/${id}/worlds/${encodeURIComponent(w.folder)}/export`;
      exp.title = bedrock ? 'Download as .mcworld (opens in Minecraft)' : 'Download as .zip';
      exp.addEventListener('click', () => toast('Packing the world… the download starts when it\'s ready.'));
      actions.appendChild(exp);
    }
    if (!w.active && hasPerm('files.edit')) {
      const del = el('button', 'small red ghost', 'Delete');
      del.addEventListener('click', async () => {
        if (!await confirmBox(`Delete the world "${w.name}"? It goes to the Recycle Bin or Trash.`)) return;
        try {
          loadWorlds(await api('DELETE', `/api/servers/${id}/worlds/${encodeURIComponent(w.folder)}`));
          toast('World moved to the Recycle Bin or Trash');
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.appendChild(del);
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

$('worldImportFile').addEventListener('change', async () => {
  const file = $('worldImportFile').files[0];
  $('worldImportFile').value = '';
  if (!file) return;
  const name = await ask('Name for the imported world (leave empty to use the name inside the file):', '');
  if (name === null) return;
  const activate = hasPerm('properties.edit') && await confirmBox('Make it the active world (loaded at the next start)?');
  $('worldsStatus').textContent = `Importing ${file.name}…`;
  try {
    const res = await fetch(`/api/servers/${state.selected}/worlds/import?name=${encodeURIComponent(name)}&activate=${activate ? 1 : 0}`, {
      method: 'POST',
      headers: { 'X-Panel': '1', 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
    toast(`Imported as "${data.folder}"${data.restartNeeded ? '. Restart the server to load it.' : ''}`);
    loadWorlds(data);
  } catch (err) {
    $('worldsStatus').textContent = '';
    toast(err.message, true);
  }
});

// ---------- in-game chat (Bedrock, through the chat relay pack) ----------

let chatState = null;

async function loadChat() {
  const id = state.selected;
  try {
    chatState = await api('GET', `/api/servers/${id}/chat`);
  } catch (err) {
    return toast(err.message, true);
  }
  if (id !== state.selected) return;
  renderChatRelay();
  $('chatLog').innerHTML = '';
  if (!chatState.messages.length) $('chatLog').appendChild(el('p', 'muted chat-empty', chatState.relay.on ? 'No chat yet.' : 'Turn on the chat relay to see what players say.'));
  for (const m of chatState.messages) addChatMessage(m, false);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function renderChatRelay() {
  const r = chatState.relay;
  $('chatRelayState').textContent = r.on ? 'On' : 'Off';
  $('chatRelayState').className = `pill-mini ${r.on ? 'on' : 'off'}`;
  $('btnChatRelay').textContent = r.on ? 'Turn off' : 'Turn on';
  $('btnChatRelay').className = r.on ? 'ghost red' : 'primary';
  $('chatModuleVersion').value = r.on ? (r.moduleVersion ?? '') : r.suggestedVersion;
  $('chatVersionHint').textContent = r.on
    ? `Using scripting version ${r.moduleVersion}. If chat stops after a Bedrock update, change the version and press Update.`
    : `Scripting version ${r.suggestedVersion} (${r.suggestedFrom}). It must match this Bedrock version (Minecraft 26.51 uses 2.11.x-beta).`;
  $('chatBetaWarn').hidden = r.betaApis !== false;
  // Older relays were turned on before Server Forge also set this; pressing Update fixes it.
  $('chatBetaWarn').textContent = r.betaApis === false ? 'This world doesn\'t have "Beta APIs" turned on (World tab). The chat relay needs it.' : '';
  if (r.on && r.outdated) {
    $('chatBetaWarn').hidden = false;
    $('chatBetaWarn').textContent = 'This chat relay was made by an older Server Forge (no mute support). Press Update, then restart the server.';
  }
  if (r.on && !r.contentLog) {
    $('chatBetaWarn').hidden = false;
    $('chatBetaWarn').textContent = 'Script output isn\'t printed to the console on this server (content-log-console-output-enabled is off), so chat can\'t reach the panel. Press Update to fix it, then restart the server.';
  }
  $('chatNote').textContent = chatState.running
    ? r.on
      ? 'Messages you send show in the game as "[Panel] your name: message".'
      : 'You can send messages now; to see players\' chat, turn on the relay and restart the server.'
    : 'Start the server to send messages.';
  // Changing the version of a relay that's on: offer "Update" next to "Turn off".
  let upd = $('btnChatUpdate');
  if (r.on && !upd) {
    upd = el('button', 'small', 'Update');
    upd.id = 'btnChatUpdate';
    upd.type = 'button';
    upd.addEventListener('click', () => setChatRelay(true));
    $('btnChatRelay').before(upd);
  } else if (!r.on && upd) upd.remove();
}

function addChatMessage(m, live) {
  const log = $('chatLog');
  log.querySelector('.chat-empty')?.remove();
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const row = el('div', `chat-msg ${m.from}`);
  row.appendChild(el('span', 'chat-time', new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  if (m.from === 'panel') row.appendChild(el('span', 'chat-via', m.via || 'Panel'));
  row.appendChild(el('span', 'chat-name', m.name));
  // Minecraft colour codes (§a...) aren't shown as text.
  row.appendChild(el('span', 'chat-text', m.text.replace(/§./g, '')));
  if (m.muted) {
    row.classList.add('held');
    row.appendChild(el('span', 'chat-via held', 'muted: not shown in game'));
  }
  log.appendChild(row);
  while (log.childElementCount > 500) log.firstElementChild.remove();
  if (!live || stick) log.scrollTop = log.scrollHeight;
}

async function setChatRelay(on) {
  $('btnChatRelay').disabled = true;
  try {
    const r = await api('POST', `/api/servers/${state.selected}/chat/relay`, { enabled: on, moduleVersion: $('chatModuleVersion').value.trim() || undefined });
    chatState.relay = r.relay;
    renderChatRelay();
    toast(on ? (r.running ? 'Chat relay installed. Restart the server to start relaying chat.' : 'Chat relay installed. It starts with the server.') : 'Chat relay removed.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('btnChatRelay').disabled = false;
  }
}
$('btnChatRelay').addEventListener('click', () => setChatRelay(!chatState?.relay.on));

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  try {
    await api('POST', `/api/servers/${state.selected}/chat`, { message: text });
    $('chatInput').value = '';
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- update from a local installer file (desktop app) ----------

/** Asks the server to stop and waits until it has (up to 3 minutes). */
async function stopAndWait(s) {
  if (['stopped', 'crashed'].includes(state.servers.get(s.id)?.status)) return;
  await api('POST', `/api/servers/${s.id}/stop`);
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (['stopped', 'crashed'].includes(state.servers.get(s.id)?.status)) return;
  }
  throw new Error(`"${s.name}" didn't stop within 3 minutes.`);
}

// ---------- Server Forge updates (GitHub releases) ----------

async function loadAppUpdate(force) {
  try {
    state.appUpdate = await api('GET', `/api/app-update${force ? '?check=1' : ''}`);
  } catch (err) {
    if (force) toast(err.message, true);
    return;
  }
  renderAppUpdate();
}

function renderAppUpdate() {
  const u = state.appUpdate;
  if (!u) return;
  $('btnAppUpdate').hidden = !u.available;
  const box = $('appUpdateInfo');
  box.innerHTML = '';
  // The installer runs on the system Tavern Host is on, so only the installed desktop app can install it.
  const canInstall = !!window.desktop?.installUpdate && state.build !== 'development';
  $('btnInstallUpdate').hidden = !(u.available && canInstall);
  if (u.available) {
    box.appendChild(el('p', 'good-banner', `Server Forge ${u.latest} is available. You have ${u.current}.`));
    if (u.notes) {
      const d = el('details', 'release-notes');
      d.append(el('summary', null, "What's new"), el('pre', null, u.notes));
      box.appendChild(d);
    }
    if (!canInstall) {
      const how = state.container
        ? 'This Server Forge runs in a container: update it by replacing the container image (TrueNAS: update the server-forge app). Game servers are saved and started again by themselves.'
        : state.build === 'development'
          ? 'This is the development panel: update the installed Server Forge instead.'
          : 'Install it from the Server Forge app on the system it runs on, or download it from GitHub.';
      box.appendChild(el('p', 'muted small-text', how));
    }
  } else if (u.error) {
    box.appendChild(el('p', 'muted', `Couldn't check for updates: ${u.error}`));
  } else if (!u.latest) {
    box.appendChild(el('p', 'muted', `You have ${u.current}. No releases have been published yet.`));
  } else {
    box.appendChild(el('p', 'muted', `You have the latest version (${u.current}).`));
  }
  if (u.checkedAt) box.appendChild(el('p', 'muted small-text', `Last checked ${new Date(u.checkedAt).toLocaleString()}.`));
}

$('btnCheckUpdate').addEventListener('click', async () => {
  $('btnCheckUpdate').disabled = true;
  await loadAppUpdate(true);
  $('btnCheckUpdate').disabled = false;
});

$('btnAppUpdate').addEventListener('click', async () => {
  await openSettings();
  $('panelUpdateCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

window.desktop?.onUpdateProgress?.((p) => {
  const mb = (n) => (n / 1048576).toFixed(1);
  $('updateStatus').textContent = p.total ? `Downloading ${p.version}: ${mb(p.received)} of ${mb(p.total)} MB…` : `Downloading ${p.version}: ${mb(p.received)} MB…`;
});

$('btnInstallUpdate').addEventListener('click', async () => {
  const u = state.appUpdate;
  if (!u?.available) return;
  if (!await confirmBox(`Install Server Forge ${u.latest}?\n\nIt downloads from GitHub, then Server Forge closes and opens again by itself. Game servers keep running.`)) return;
  $('btnInstallUpdate').disabled = true;
  $('updateStatus').textContent = 'Starting the download…';
  try {
    // Tell connected clients (Watcher, other browsers) this is a planned restart, not an outage.
    await api('POST', '/api/panel/restarting', { reason: 'update' }).catch(() => {});
    await window.desktop.installUpdate();
    $('updateStatus').textContent = 'Installing… Server Forge will close and reopen.';
  } catch (err) {
    $('updateStatus').textContent = '';
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    $('btnInstallUpdate').disabled = false;
  }
});

// ---------- "Server Forge was updated" (once per browser, after a version change) ----------

const versionNewer = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** CHANGELOG text ("**New**" headings, "- " items, **bold**) as headings and lists. */
function renderNotes(box, text) {
  box.innerHTML = '';
  let list = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const plain = line.replace(/\*\*/g, '').replace(/`/g, '');
    if (/^\*\*[^*]+\*\*$/.test(line)) {
      box.appendChild(el('h4', 'section-label', plain));
      list = null;
    } else if (line.startsWith('- ')) {
      list ??= box.appendChild(el('ul'));
      list.appendChild(el('li', null, plain.slice(2)));
    } else {
      box.appendChild(el('p', null, plain));
      list = null;
    }
  }
}

async function showWhatsNew() {
  // The service says which version it was updated from (null = no update since it was installed). Each browser shows
  // the box once per version, and only within two weeks of the update.
  const current = state.version;
  const u = state.updatedFrom;
  if (!current || !u || (u.from && !versionNewer(current, u.from)) || Date.now() - u.at > 14 * 86400_000) return;
  try {
    if (localStorage.getItem('th-seen-update') === current) return;
    localStorage.setItem('th-seen-update', current);
  } catch {
    return;
  }
  const last = u.from;
  const r = await api('GET', `/api/changelog?version=${encodeURIComponent(current)}`).catch(() => null);
  $('whatsNewTitle').textContent = `Server Forge was updated to ${current}`;
  if (r?.notes) renderNotes($('whatsNewBody'), r.notes);
  else $('whatsNewBody').replaceChildren(el('p', 'muted', last ? `You were on ${last} before.` : 'See the release notes for what changed.'));
  $('whatsNewDialog').showModal();
}
$('whatsNewClose').addEventListener('click', () => $('whatsNewDialog').close());

/** Once per device: explains why the Release pill went away. Only for copies that were updated from a version that
 *  still had it (0.9.6 or older) and the dev build; fresh installs never saw it. */
async function showChannelNotice() {
  const KEY = 'th-seen-channel-notice';
  const from = state.updatedFrom?.from;
  if (state.build !== 'development' && !(from && !versionNewer(from, '0.9.6'))) return;
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  // After the update notes (or the rename notice) are closed, so it never opens on top of them.
  while (document.querySelector('dialog[open]')) await new Promise((r) => setTimeout(r, 500));
  try {
    localStorage.setItem(KEY, '1');
  } catch {}
  $('channelNoticeDialog').showModal();
}
$('channelNoticeClose').addEventListener('click', () => $('channelNoticeDialog').close());

// ---------- About / Help ----------

$('btnHelp').addEventListener('click', () => {
  const v = state.appUpdate?.current ?? $('appVersion').firstChild?.textContent?.replace(/^v/, '') ?? '';
  $('aboutVersion').textContent = v ? `v${v}` : '';
  // The bug report form fills in the version by itself.
  $('aboutReport').href = `https://github.com/CorruptedVariant/server-forge/issues/new?template=bug_report.yml&version=${encodeURIComponent(v)}`;
  $('aboutDialog').showModal();
});
$('aboutClose').addEventListener('click', () => $('aboutDialog').close());

$('btnUpdateFile').addEventListener('click', async () => {
  const status = $('updateStatus');
  let info;
  try {
    info = await window.desktop.pickInstaller();
  } catch (err) {
    return toast(err.message, true);
  }
  if (!info) return;
  if (info.error) return toast(info.error, true);
  const isTavern = /server forge|tavern host|game server panel/i.test(`${info.product} ${info.description}`);
  const lines = [
    isTavern
      ? `Install ${info.product} ${info.version || '(unknown version)'} over this Server Forge ${info.current}?`
      : `"${info.name}" doesn't say it's a Server Forge or legacy Tavern Host installer (it says "${info.product || info.description || 'nothing'}"). Run it anyway?`,
  ];
  if (isTavern && info.version && info.version === info.current) lines.push('\nThat is the version you have now: it will be reinstalled.');
  // Java/Bedrock servers started by versions before the separate runner have to stop for this one update.
  const oldStyle = info.oldRunners ? [...state.servers.values()].filter((s) => ['java', 'bedrock'].includes(s.game) && !['stopped', 'crashed'].includes(s.status)) : [];
  if (info.oldRunners) {
    lines.push(
      `\nThese servers were started by the older version and must stop for this update (their worlds are saved first):\n${oldStyle.map((s) => `• ${s.name}`).join('\n') || '• (Java/Bedrock servers)'}\nStart them again after the update; from then on they keep running through updates.`,
    );
  }
  lines.push('\nServer Forge closes and opens again by itself when the update is done.');
  if (!await confirmBox(lines.join('\n'))) return;
  $('btnUpdateFile').disabled = true;
  try {
    for (const s of oldStyle) {
      status.textContent = `Stopping ${s.name}…`;
      await stopAndWait(s);
    }
    status.textContent = 'Installing… Server Forge will close and reopen.';
    // Tell connected clients (Watcher, other browsers) this is a planned restart, not an outage.
    await api('POST', '/api/panel/restarting', { reason: 'update' }).catch(() => {});
    await window.desktop.runInstaller();
  } catch (err) {
    status.textContent = '';
    toast(err.message, true);
    $('btnUpdateFile').disabled = false;
  }
});

// ---------- permission editor (users and API keys) ----------
// Role presets (Admin / Moderator / Viewer / Custom), global permissions, and server access for "all servers" or
// "only these servers", each with its own grouped permissions. Editing any box switches the role to Custom.

let permInfo = null;
const PRESET_ORDER = ['admin', 'operator', 'viewer', 'custom'];
const PRESET_HELP = {
  admin: 'Everything on every server, plus creating servers and managing users (never the owner account).',
  operator: 'Console, commands, start/stop/restart, player lists (including Valheim admins and bans), backups and world checks, running tasks and viewing files, on every server.',
  viewer: 'Look only: status, players and statistics of every server.',
  custom: 'Pick exactly what they can do, on all servers or only chosen ones.',
};

function permEditor(container, { preset = 'viewer', grants = null, owner = false, locked = false } = {}) {
  container.innerHTML = '';
  const wrap = el('div', 'perm-editor');
  container.appendChild(wrap);
  if (owner) {
    wrap.appendChild(el('p', 'muted', 'The owner can do everything. This account can\'t be restricted.'));
    return { read: () => ({ role: 'owner' }) };
  }
  let current = preset;
  let g = structuredClone(grants ?? permInfo.presets[preset] ?? { global: [], servers: {} });

  // Role presets
  wrap.appendChild(el('h4', 'section-label', 'Role'));
  const seg = el('div', 'segmented four');
  const roleHelp = el('p', 'muted small-text');
  wrap.append(seg, roleHelp);

  // Global
  wrap.appendChild(el('h4', 'section-label', 'Panel permissions'));
  const globalBox = el('div', 'perm-grid');
  wrap.appendChild(globalBox);

  // Servers
  wrap.appendChild(el('h4', 'section-label', 'Server access'));
  const scopeRow = el('div', 'scope-row');
  const scopeAll = el('label', 'toggle');
  const rAll = el('input');
  rAll.type = 'radio';
  rAll.name = `scope-${Math.random()}`;
  scopeAll.append(rAll, document.createTextNode(' All servers (including ones added later)'));
  const scopeSome = el('label', 'toggle');
  const rSome = el('input');
  rSome.type = 'radio';
  rSome.name = rAll.name;
  scopeSome.append(rSome, document.createTextNode(' Only these servers'));
  scopeRow.append(scopeAll, scopeSome);
  wrap.appendChild(scopeRow);
  const serversBox = el('div', 'perm-servers');
  wrap.appendChild(serversBox);
  const warn = el('p', 'warn-banner perm-warn');
  wrap.appendChild(warn);

  const setPreset = (p) => {
    current = p;
    if (p !== 'custom') g = structuredClone(permInfo.presets[p]);
    render();
  };
  const toCustom = () => {
    if (current !== 'custom') {
      current = 'custom';
      renderRoles();
    }
  };

  function renderRoles() {
    seg.innerHTML = '';
    for (const p of PRESET_ORDER) {
      const b = el('button', current === p ? 'active' : '', permInfo.presetLabels[p]);
      b.type = 'button';
      b.disabled = locked;
      b.addEventListener('click', () => setPreset(p));
      seg.appendChild(b);
    }
    roleHelp.textContent = PRESET_HELP[current];
  }

  function checkbox(checked, onChange, disabled = false) {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.disabled = disabled || locked;
    cb.addEventListener('change', () => {
      onChange(cb.checked);
      toCustom();
      updateWarn();
    });
    return cb;
  }

  function permItem(info, checked, onChange, disabled = false, implied = false) {
    const lab = el('label', `perm-item${info.danger ? ' danger' : ''}`);
    lab.title = info.help;
    lab.append(checkbox(checked, onChange, disabled), el('span', null, info.label));
    if (info.danger) lab.appendChild(el('span', 'danger-badge', '⚠'));
    if (implied) lab.appendChild(el('span', 'muted small-text', ' (included)'));
    return lab;
  }

  /** One server scope (id or '*'): grouped permissions plus quick-fill buttons. */
  function scopePanel(id, title) {
    const perms = new Set(g.servers[id] ?? []);
    const panel = el('div', 'scope-panel');
    const head = el('div', 'scope-head');
    head.appendChild(el('b', null, title));
    const quick = el('div', 'quick-fill');
    for (const [label, preset] of [['Everything', 'admin'], ['Moderator', 'operator'], ['View only', 'viewer'], ['None', null]]) {
      const b = el('button', 'small ghost', label);
      b.type = 'button';
      b.disabled = locked;
      b.addEventListener('click', () => {
        g.servers[id] = preset ? [...permInfo.presets[preset].servers['*']] : [];
        if (!g.servers[id].length) delete g.servers[id];
        toCustom();
        renderServers();
        updateWarn();
      });
      quick.appendChild(b);
    }
    head.appendChild(quick);
    panel.appendChild(head);
    const grid = el('div', 'perm-groups');
    for (const group of permInfo.serverGroups) {
      const col = el('div', 'perm-group');
      col.appendChild(el('div', 'perm-group-name', group.group));
      for (const [perm, info] of group.perms) {
        // "See the server" is included whenever anything else is ticked.
        const implied = perm === 'view' && [...perms].some((x) => x !== 'view');
        col.appendChild(
          permItem(info, perms.has(perm) || implied, (on) => {
            const set = new Set(g.servers[id] ?? []);
            on ? set.add(perm) : set.delete(perm);
            if (set.size) g.servers[id] = [...set];
            else delete g.servers[id];
            renderServers();
          }, implied, implied),
        );
      }
      grid.appendChild(col);
    }
    panel.appendChild(grid);
    return panel;
  }

  function renderServers() {
    serversBox.innerHTML = '';
    const all = !!g.servers['*'] || (current !== 'custom' && !Object.keys(g.servers).length);
    rAll.checked = all;
    rSome.checked = !all;
    rAll.disabled = rSome.disabled = locked;
    if (all) {
      serversBox.appendChild(scopePanel('*', 'All servers'));
      return;
    }
    const servers = [...state.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!servers.length) serversBox.appendChild(el('p', 'muted small-text', 'No servers yet.'));
    const picker = el('div', 'server-picker');
    for (const s of servers) {
      const on = !!g.servers[s.id];
      const lab = el('label', `server-chip${on ? ' on' : ''}`);
      const cb = checkbox(on, (v) => {
        if (v) g.servers[s.id] = ['view'];
        else delete g.servers[s.id];
        renderServers();
      });
      lab.append(cb, serverIcon(s, 'srv-icon chip'), el('span', null, s.name));
      picker.appendChild(lab);
    }
    serversBox.appendChild(picker);
    for (const s of servers) if (g.servers[s.id]) serversBox.appendChild(scopePanel(s.id, s.name));
  }

  rAll.addEventListener('change', () => {
    if (!rAll.checked) return;
    // Merge what was given per server into one "all servers" set.
    const merged = new Set(Object.values(g.servers).flat());
    g.servers = { '*': merged.size ? [...merged] : ['view'] };
    toCustom();
    renderServers();
    updateWarn();
  });
  rSome.addEventListener('change', () => {
    if (!rSome.checked) return;
    const everywhere = g.servers['*'] ?? [];
    g.servers = {};
    for (const s of state.servers.values()) if (everywhere.length) g.servers[s.id] = [...everywhere];
    toCustom();
    renderServers();
    updateWarn();
  });

  function renderGlobal() {
    globalBox.innerHTML = '';
    for (const info of permInfo.global) {
      globalBox.appendChild(
        permItem(info, g.global.includes(info.id), (on) => {
          const set = new Set(g.global);
          on ? set.add(info.id) : set.delete(info.id);
          g.global = [...set];
        }),
      );
    }
  }

  function updateWarn() {
    const dangerous = [
      ...permInfo.global.filter((x) => x.danger && g.global.includes(x.id)).map((x) => x.label),
      ...new Set(
        Object.values(g.servers)
          .flat()
          .filter((p) => permInfo.serverGroups.some((grp) => grp.perms.some(([id, info]) => id === p && info.danger)))
          .map((p) => permInfo.serverGroups.flatMap((grp) => grp.perms).find(([id]) => id === p)[1].label),
      ),
    ];
    warn.hidden = !dangerous.length;
    warn.textContent = `⚠ Powerful permissions: ${dangerous.join(', ')}. These let them put programs on this system (mods, server files, Java settings) or manage other accounts. Only give them to people you'd trust with this system.`;
  }

  function render() {
    renderRoles();
    renderGlobal();
    renderServers();
    updateWarn();
  }
  render();
  return { read: () => ({ role: current, grants: current === 'custom' ? structuredClone(g) : undefined }) };
}

// ---------- users ----------

let editingUser = null;
let userEditor = null;
let usersCache = [];

function fmtAgoShort(t) {
  return t ? `${duration(Date.now() - t)} ago` : 'never';
}

function accessChip(access) {
  const chip = el('span', `access-chip ${access.scope}`, access.scope === 'all' ? '🌐 All servers' : access.scope === 'none' ? 'No servers' : `🖥 ${access.text}`);
  chip.title = access.text;
  return chip;
}

async function loadUsers() {
  permInfo ??= await api('GET', '/api/permissions');
  usersCache = await api('GET', '/api/users');
  renderUsers();
  fillActivityWho();
}

function renderUsers() {
  const q = $('userSearch').value.trim().toLowerCase();
  const list = $('usersBody');
  list.innerHTML = '';
  $('userCount').textContent = String(usersCache.length);
  for (const u of usersCache.filter((x) => !q || `${x.username} ${x.note ?? ''}`.toLowerCase().includes(q))) {
    const row = el('div', `user-row${u.disabled ? ' off' : ''}`);
    const avatar = letterHead(u.username);
    avatar.classList.add('user-avatar');
    row.appendChild(avatar);
    const info = el('div', 'user-info');
    const name = el('div', 'name', u.username);
    if (u.id === state.user.id) name.appendChild(el('span', 'type-badge', 'you'));
    name.appendChild(el('span', `type-badge role-${u.role}`, ROLE_NAMES[u.role] ?? u.role));
    if (u.disabled) name.appendChild(el('span', 'type-badge bad', 'disabled'));
    if (u.mustChangePassword) name.appendChild(el('span', 'type-badge', 'must change password'));
    if (u.remote) name.appendChild(el('span', 'type-badge', 'remote login'));
    info.appendChild(name);
    const line = el('div', 'sub');
    line.appendChild(accessChip(u.access));
    line.appendChild(
      document.createTextNode(` · last login ${fmtAgoShort(u.lastLogin)}${u.lastLoginIp ? ` from ${u.lastLoginIp}` : ''} · ${u.sessions} active session${u.sessions === 1 ? '' : 's'}`),
    );
    info.appendChild(line);
    if (u.note) info.appendChild(el('div', 'sub muted', u.note));
    row.appendChild(info);
    const actions = el('div', 'actions');
    const canTouch = isOwner() || u.role !== 'owner';
    if (canTouch) {
      const edit = el('button', 'small', 'Edit');
      edit.addEventListener('click', () => openUserDialog(u));
      actions.appendChild(edit);
      if (u.sessions) {
        const out = el('button', 'small ghost', 'Sign out everywhere');
        out.addEventListener('click', async () => {
          if (!await confirmBox(`Sign ${u.username} out of every browser and device?`)) return;
          try {
            await api('POST', `/api/users/${u.id}/signout`);
            toast(`${u.username} was signed out everywhere`);
            loadUsers();
          } catch (err) {
            toast(err.message, true);
          }
        });
        actions.appendChild(out);
      }
      if (hasGlobal('audit.view')) {
        const act = el('button', 'small ghost', 'Activity');
        act.addEventListener('click', () => {
          $('activityWho').value = u.id;
          loadActivity();
          $('activityBody').scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        actions.appendChild(act);
      }
    }
    if (u.role !== 'owner' && u.id !== state.user.id) {
      const del = el('button', 'small red ghost', 'Delete');
      del.addEventListener('click', async () => {
        if (!await confirmBox(`Delete user ${u.username}? They are logged out immediately.`)) return;
        try {
          await api('DELETE', `/api/users/${u.id}`);
          toast('User deleted');
          loadUsers();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.appendChild(del);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}
$('userSearch').addEventListener('input', renderUsers);

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return [...bytes].map((b) => chars[b % chars.length]).join('');
}

async function openUserDialog(user = null) {
  permInfo ??= await api('GET', '/api/permissions');
  editingUser = user;
  const ownerAccount = user?.role === 'owner';
  const self = user?.id === state.user.id;
  $('userDialogTitle').textContent = user ? `Edit ${user.username}` : 'Add user';
  $('uName').value = user?.username ?? '';
  $('uPass').value = '';
  $('uPass').required = !user;
  $('uPassLabel').textContent = user ? 'New password (leave empty to keep the current one)' : 'Password (8+ characters)';
  $('uRemote').checked = user ? !!user.remote : false;
  $('uRemote').disabled = ownerAccount;
  $('uMust').checked = user ? !!user.mustChangePassword : true;
  $('uMustWrap').hidden = ownerAccount;
  $('uDisabled').checked = !!user?.disabled;
  $('uDisabledWrap').hidden = !user || ownerAccount || self;
  $('uNote').value = user?.note ?? '';
  $('userError').textContent = '';
  // You can't change your own permissions (someone else has to), and nobody can restrict the owner.
  userEditor = permEditor($('uPerms'), { preset: user?.role && user.role !== 'owner' ? user.role : 'operator', grants: user?.grants ?? null, owner: ownerAccount, locked: self && !ownerAccount });
  if (self && !ownerAccount) $('uPerms').prepend(el('p', 'muted small-text', "You can't change your own permissions; ask the owner or another admin."));
  $('userDialog').showModal();
}

$('uGenPass').addEventListener('click', () => {
  $('uPass').value = randomPassword();
  $('uMust').checked = true;
  toast('Random password filled in. Give it to them; they choose their own at first login.');
});
$('btnAddUser').addEventListener('click', () => openUserDialog());
$('userCancel').addEventListener('click', () => $('userDialog').close());
$('userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { username: $('uName').value.trim(), remote: $('uRemote').checked, note: $('uNote').value };
  const ownerAccount = editingUser?.role === 'owner';
  if (!ownerAccount) {
    body.mustChangePassword = $('uMust').checked;
    if (editingUser?.id !== state.user.id) Object.assign(body, userEditor.read());
  }
  if ($('uPass').value) body.password = $('uPass').value;
  try {
    if (editingUser) {
      if (!ownerAccount && editingUser.id !== state.user.id) body.disabled = $('uDisabled').checked;
      await api('PUT', `/api/users/${editingUser.id}`, body);
    } else {
      await api('POST', '/api/users', body);
    }
    $('userDialog').close();
    toast('User saved');
    loadUsers();
  } catch (err) {
    $('userError').textContent = err.message;
  }
});

// ---------- API keys ----------

let editingKey = null;
let keyEditor = null;

async function loadKeys() {
  permInfo ??= await api('GET', '/api/permissions');
  const keys = await api('GET', '/api/apikeys');
  const list = $('keysBody');
  list.innerHTML = '';
  $('keyCount').textContent = keys.length ? String(keys.length) : '';
  if (!keys.length) list.appendChild(el('p', 'muted', 'No API keys yet.'));
  for (const k of keys) {
    const row = el('div', `user-row${k.expired ? ' off' : ''}`);
    row.appendChild(el('span', 'user-avatar key-avatar', '🔑'));
    const info = el('div', 'user-info');
    const name = el('div', 'name', k.name);
    name.appendChild(el('span', `type-badge role-${k.preset}`, ROLE_NAMES[k.preset] ?? k.preset));
    if (k.expired) name.appendChild(el('span', 'type-badge bad', 'expired'));
    info.appendChild(name);
    const line = el('div', 'sub');
    line.appendChild(accessChip(k.access));
    line.appendChild(
      document.createTextNode(
        ` · ${k.prefix}… · last used ${fmtAgoShort(k.lastUsed)} · ${k.expiresAt ? `${k.expired ? 'expired' : 'expires'} ${new Date(k.expiresAt).toLocaleDateString()}` : 'never expires'}${k.createdBy ? ` · made by ${k.createdBy}` : ''}`,
      ),
    );
    info.appendChild(line);
    row.appendChild(info);
    const actions = el('div', 'actions');
    const edit = el('button', 'small', 'Edit');
    edit.addEventListener('click', () => openKeyDialog(k));
    const del = el('button', 'small red ghost', 'Delete');
    del.addEventListener('click', async () => {
      if (!await confirmBox(`Delete the key "${k.name}"? Anything using it stops working immediately.`)) return;
      try {
        await api('DELETE', `/api/apikeys/${k.id}`);
        toast('Key deleted');
        loadKeys();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(edit, del);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function openKeyDialog(key = null) {
  permInfo ??= await api('GET', '/api/permissions');
  editingKey = key;
  $('keyForm').reset();
  $('keyDialogTitle').textContent = key ? `Edit key "${key.name}"` : 'Create API key';
  $('keySave').textContent = key ? 'Save' : 'Create key';
  $('kName').value = key?.name ?? '';
  $('kExpires').value = '';
  if (key?.expiresAt) $('kExpires').options[0].textContent = `Keep (${new Date(key.expiresAt).toLocaleDateString()})`;
  else $('kExpires').options[0].textContent = key ? 'Keep (never expires)' : 'Never';
  $('keyError').textContent = '';
  keyEditor = permEditor($('kPerms'), { preset: key?.preset ?? 'viewer', grants: key?.grants ?? null });
  $('keyDialog').showModal();
}

$('btnAddKey').addEventListener('click', () => openKeyDialog());
$('keyCancel').addEventListener('click', () => $('keyDialog').close());
$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { role, grants } = keyEditor.read();
  const exp = $('kExpires').value;
  try {
    if (editingKey) {
      const body = { name: $('kName').value, preset: role, grants };
      if (exp) body.expiresInDays = Number(exp);
      await api('PUT', `/api/apikeys/${editingKey.id}`, body);
      $('keyDialog').close();
      toast('Key saved');
    } else {
      const { key } = await api('POST', '/api/apikeys', { name: $('kName').value, preset: role, grants, expiresInDays: exp ? Number(exp) : null });
      $('keyDialog').close();
      $('newKey').value = key;
      $('keyShowDialog').showModal();
    }
    loadKeys();
  } catch (err) {
    $('keyError').textContent = err.message;
  }
});
$('btnCopyKey').addEventListener('click', async () => {
  $('newKey').select();
  try {
    await navigator.clipboard.writeText($('newKey').value);
    toast('Copied');
  } catch {
    document.execCommand('copy');
    toast('Copied');
  }
});
$('keyShowClose').addEventListener('click', () => {
  $('newKey').value = '';
  $('keyShowDialog').close();
});

// ---------- API reference (Settings) ----------
// [method, path, what it does, permission label]. Keep in step with the routes in src/main.ts.
const API_DOCS = [
  ['Storage (Tavern Vault)', [
    ['GET', '/api/vault', 'Storage on this system: {"state":"ok","status":{pools, disks, arrays, jobs, problems…}} or why it isn\'t available ("missing" = Tavern Vault not installed, "off" = its node mode is off, "nokey"/"down" = its service isn\'t reachable)', 'See storage'],
    ['GET', '/api/vault/summary', 'Storage at a glance for this system and every node', 'See storage'],
    ['POST', '/api/vault/call', 'Run a Tavern Vault call: {"method","args"} → {"ok","data"|"error"}. Reading (state, inventory, arrays, schedules, activity, scrubInfo, discoverArrays, validateArray, snapraidRunning) needs See storage; everything else (createPool, createVolume, addDisks, retireDisk, removeDisk, repairVolume, resizeVolume, attachPool, rename, deleteVolume, deletePool, eraseDisk, saveArray, snapraidRun, createSchedule…) needs Manage storage. Tavern Vault\'s practice mode and safety checks apply.', 'See / Manage storage'],
    ['GET', '/api/vault/events?since=', 'SnapRAID output and finish events after sequence number since', 'See storage'],
    ['GET', '/api/nodes/{node}/vault', 'The same, for a node (through its node link; the node needs Server Forge 0.5.0+ and Tavern Vault in node mode)', 'See storage'],
    ['POST', '/api/nodes/{node}/vault/call', 'Run a Tavern Vault call on a node', 'See / Manage storage'],
    ['GET', '/api/nodes/{node}/vault/events?since=', 'SnapRAID output on a node', 'See storage'],
  ]],
  ['General', [
    ['GET', '/api/me', 'Who you are, and your panel-wide permissions', 'Any key or login'],
    ['GET', '/api/games', 'Supported games and their settings fields', 'Any key or login'],
    ['GET', '/api/games/{game}/versions?from={type}', 'Versions you can install (e.g. Minecraft versions for "paper")', 'Any key or login'],
    ['GET', '/api/permissions', 'Every permission, grouped, with descriptions and role presets', 'Any key or login'],
    ['GET', '/api/events', 'Live updates stream (Server-Sent Events): server, line, chat, removed, panel ({status:"up"|"restarting", reason})', 'See the server (per server)'],
    ['GET', '/api/health', 'Is the panel up: {ok, startedAt, lastRestart:{reason, downAt, upAt}} (no login needed)', 'Nothing'],
    ['POST', '/api/panel/restarting', 'Announce a planned restart to live-stream clients: {"reason":"update"}', 'Panel settings'],
    ['GET', '/api/stats', 'CPU/RAM right now for every running server you can see', 'See the server (per server)'],
    ['GET', '/api/alerts', 'Health warnings (low disk/RAM, stuck starts, failed backup copies, world checks…), nodes included', 'See the server (per server)'],
    ['POST', '/api/alerts/{alert}/dismiss', 'Dismiss a warning', 'See the server (per server)'],
    ['PUT', '/api/me/password', 'Change your own password: {"current","password"} (logins only, not API keys)', 'Any login'],
    ['GET', '/api/app-update?check=1', 'New Server Forge version on GitHub: {current, latest, available, notes, url, checkedAt, error}; check=1 looks right now (otherwise the 6-hourly check)', 'Panel settings'],
  ]],
  ['Servers', [
    ['GET', '/api/servers', 'All servers you can see: status, players, version, join code, IP/port, your permissions', 'See the server'],
    ['GET', '/api/servers/{id}', 'One server in detail (console included if allowed, Valheim bosses, crash check)', 'See the server'],
    ['POST', '/api/servers/new', 'Create a server and download its software: {"game","name","installDir","settings","acceptEula"}', 'Create & import servers'],
    ['POST', '/api/servers', 'Import an existing server folder: {"game","name","installDir"}', 'Create & import servers'],
    ['PUT', '/api/servers/{id}', 'Change settings: {"name","installDir","autoRestart","settings"}', 'Change settings'],
    ['PUT', '/api/servers/{id}', 'Change automatic backups only: {"backupSchedule":{"everyHours","keep"}}', 'Make backups'],
    ['PUT', '/api/servers/{id}', 'Automatic game updates on/off only: {"autoUpdate":true} (Bedrock, Valheim)', 'Update server software'],
    ['POST', '/api/servers/{id}/clone', 'Copy a server (in the background): {"name","installDir"}', 'Create & import servers + View & download files'],
    ['POST', '/api/moves', 'Move a server to another system (this one or a node), in the background: {"serverId","to":"local" or a node id,"keepOld"?}. Answers the move; GET /api/moves/{id} follows it', 'Create & import servers + Remove the server + View & download files'],
    ['GET', '/api/servers/{id}/transfer-info', 'What moving this server would send (used by the main panel): its settings, scheduled tasks and the size of each part', 'Remove the server + View & download files'],
    ['GET', '/api/servers/{id}/transfer-part', 'One part as a tar stream: ?part=server|world|backups (the server must be stopped)', 'Remove the server + View & download files'],
    ['POST', '/api/transfer/begin', 'Receive a moved server: {"record","platform","parts","tasks"}. Answers {"token","installDir","id"}; then POST /api/transfer/{token}/part?name=… (tar body) per part, POST /api/transfer/{token}/finish, or DELETE /api/transfer/{token} to cancel', 'Create & import servers'],
    ['POST', '/api/servers/{id}/update', 'Download/update the server software', 'Update server software'],
    ['GET', '/api/servers/{id}/game-update?check=1', 'Game update status (Bedrock, Valheim): {current, latest, available, updating, auto…}; check=1 looks it up now', 'See the server'],
    ['POST', '/api/servers/{id}/game-update', 'Install the latest game version: {"countdownMinutes":5,"force":false} (progress in the console; 409 if already up to date unless force). /bedrock-update still works', 'Update server software (+ Stop when running)'],
    ['GET', '/api/servers/{id}/ports', 'Port forwarding help: {lanIp, publicIp, forwards:[{protocol, ports, why}], problems:[{text, fix?}], notes, joinAddress}', 'See the server'],
    ['GET', '/api/servers/{id}/difficulty', 'Current difficulty and the choices for this game', 'See the server'],
    ['PUT', '/api/servers/{id}/difficulty', 'Set it: {"value":"hard"} (Minecraft: peaceful/easy/normal/hard, applied live; Valheim: casual/easy/normal/hard/hardcore/immersive/hammer, or "keep"; applies on the next start)', 'Change settings'],
    ['DELETE', '/api/servers/{id}?files=0&backups=0', 'Remove the server from Server Forge. files=1 also sends its folder to the Recycle Bin (needs Edit & upload files too); backups=1 deletes its backups', 'Remove server'],
    ['POST', '/api/servers/{id}/eula', 'Accept the Minecraft EULA', 'Change settings'],
    ['PUT', '/api/server-order', 'Sidebar order: {"ids":[...]} in the new order (each listed server keeps a slot it already had; "position" in /api/servers)', 'Change settings (every listed server)'],
  ]],
  ['Control & console', [
    ['POST', '/api/servers/{id}/start', 'Start. Answers 428 with the reason if the pre-start check fails (world damaged, files in use); send {"force":true} to start anyway', 'Start'],
    ['POST', '/api/servers/{id}/stop', 'Stop (the world is saved first). Optional countdown: {"countdownMinutes":5,"message"?:"… {time} …"}', 'Stop'],
    ['POST', '/api/servers/{id}/restart', 'Restart (same countdown options as stop)', 'Restart'],
    ['POST', '/api/servers/{id}/countdown/cancel', 'Cancel a running stop/restart countdown', 'Stop or Restart'],
    ['POST', '/api/servers/{id}/kill', 'Force-close a stuck server without saving', 'Kill'],
    ['GET', '/api/servers/{id}/console?lines=100', 'Recent console lines', 'View console'],
    ['POST', '/api/servers/{id}/command', 'Send a command: {"command":"say hi"}', 'Send commands'],
    ['GET', '/api/servers/{id}/chat?limit=200', 'In-game chat history (Bedrock, with the chat relay on) and relay status. Live: "chat" events on /api/events', 'View console'],
    ['POST', '/api/servers/{id}/chat', 'Say something in the game: {"message","name"?,"source"?} shows as "[source] name: message" (e.g. source "Discord")', 'Send commands'],
    ['POST', '/api/servers/{id}/chat/relay', 'Chat relay on/off: {"enabled":true,"moduleVersion"?:"2.11.0-beta"} (applies when the server restarts)', 'Manage mods / plugins / addons'],
  ]],
  ['Players & statistics', [
    ['GET', '/api/servers/{id}/players', 'Everyone who has played: online first, last seen, joins, playtime, note, muted (Valheim: player ID, admin, banned, permitted, allowListOn); plus the actions this server has', 'See the server'],
    ['POST', '/api/servers/{id}/players/{name}/action', 'Player action: {"action":"kick|op|deop|allowlist-add|allowlist-remove|whitelist-add|whitelist-remove|ban|pardon|mute|unmute|note","reason"?,"note"?} (no ban on Bedrock; mute needs the Bedrock chat relay)', 'Edit player lists'],
    ['POST', '/api/servers/{id}/players/{name}/action', 'Valheim: {"action":"admin-add|admin-remove|list-ban|list-unban|permit-add|permit-remove"} edits adminlist/bannedlist/permittedlist by the player\'s ID (they must have joined once)', 'Edit player lists'],
    ['GET', '/api/servers/{id}/stats?range=3600', 'CPU, RAM, players and uptime history (range in seconds, 30 to 86400)', 'See the server'],
    ['GET', '/api/servers/{id}/lists/{list}', 'A player list (whitelist/allowlist, ops; Valheim: admins, banned, permitted)', 'See the server'],
    ['PUT', '/api/servers/{id}/lists/{list}', 'Replace a list: {"entries":["name1","name2"]}', 'Edit player lists'],
    ['POST', '/api/servers/{id}/diagnose', 'Run the crash checker (Java servers)', 'See the server'],
    ['DELETE', '/api/servers/{id}/diagnose', 'Clear the crash checker result', 'See the server'],
  ]],
  ['Properties & world', [
    ['GET', '/api/servers/{id}/properties', "The game's settings file with descriptions (server.properties; Palworld: PalWorldSettings.ini)", 'See the server'],
    ['PUT', '/api/servers/{id}/properties', 'Change values: {"values":{"max-players":"20"}}', 'Edit properties & world'],
    ['GET', '/api/servers/{id}/world', 'Bedrock world: cheats, cheat settings, experiments', 'See the server'],
    ['PUT', '/api/servers/{id}/world', 'Change them: {"cheats","cheatSettings","experiments","restart"}', 'Edit properties & world (+ Restart when running)'],
    ['POST', '/api/servers/{id}/properties/repair', 'Bedrock: rebuild server.properties from the official template, keeping your values and converting Java-format keys (a backup is kept)', 'Edit properties & world'],
    ['GET', '/api/servers/{id}/worlds', 'Worlds in the server folder and which one is active (Bedrock, Java)', 'See the server'],
    ['POST', '/api/servers/{id}/worlds/{folder}/activate', 'Make a world the active one (applies on the next start; "restartNeeded" says so)', 'Edit properties & world'],
    ['GET', '/api/servers/{id}/worlds/{folder}/export', 'Download a world (.mcworld / .zip)', 'View & download files'],
    ['POST', '/api/servers/{id}/worlds/import?name=&activate=1', 'Import a world (raw .mcworld/.zip body, X-Filename header)', 'Edit & upload files (+ Edit properties & world to activate)'],
    ['DELETE', '/api/servers/{id}/worlds/{folder}', 'Delete a world (Recycle Bin)', 'Edit & upload files'],
  ]],
  ['BungeeCord network', [
    ['GET', '/api/servers/{id}/network', "A proxy's servers (config.yml), where players land first (priorities), and Server Forge's Minecraft Java servers that can be added", 'See the server'],
    ['POST', '/api/servers/{id}/network', 'Add a server: {"serverId"?: a Server Forge server (address filled in) | "address": "host:port", "name", "first"?: true, "prepare"?: true (Paper/Spigot: bungeecord: true, online-mode=false)}', 'Edit properties & world (+ on the added server, to prepare it)'],
    ['DELETE', '/api/servers/{id}/network/{name}', "Remove a server from the proxy's list", 'Edit properties & world'],
    ['PUT', '/api/servers/{id}/network/default', 'Where players land first: {"name"}', 'Edit properties & world'],
  ]],
  ['Valheim profiles', [
    ['GET', '/api/servers/{id}/profiles', 'Profiles (a world plus which mods are on, or vanilla) and the active one', 'See the server'],
    ['POST', '/api/servers/{id}/profiles', 'Add a profile: {"name","world"?,"vanilla"?} (starts as a copy of how the server is set up now)', 'Change settings'],
    ['PUT', '/api/servers/{id}/profiles/{profile}', 'Change a profile: {"name"?,"world"?,"vanilla"?}', 'Change settings'],
    ['DELETE', '/api/servers/{id}/profiles/{profile}', 'Delete a profile (not the active one)', 'Change settings'],
    ['POST', '/api/servers/{id}/profiles/{profile}/activate', 'Switch to a profile: {"restart":true} is needed while it\'s running (409 otherwise)', 'Change settings (+ Restart when running)'],
  ]],
  ['Backups', [
    ['GET', '/api/servers/{id}/backups', 'List backups', 'See the server'],
    ['POST', '/api/servers/{id}/backups', 'Back up now', 'Make backups'],
    ['POST', '/api/servers/{id}/backups/{backup}/restore', 'Restore a backup (server stopped)', 'Restore backups'],
    ['DELETE', '/api/servers/{id}/backups/{backup}', 'Delete a backup', 'Delete backups'],
    ['POST', '/api/servers/{id}/backups/copies/{file}/bring-back', 'Copy a backup from the backup copy folder back to this system, so it can be restored', 'Restore backups'],
    ['GET', '/api/servers/{id}/world-check', 'World integrity check (Bedrock): last result, missing or regenerated chunks, last good backup', 'See the server'],
    ['POST', '/api/servers/{id}/world-check', 'Check the world now', 'Make backups'],
    ['POST', '/api/servers/{id}/world-check/accept', 'The flagged changes were on purpose: make the world as it is now the reference', 'Restore backups'],
  ]],
  ['Mods, plugins & addons', [
    ['GET', '/api/servers/{id}/addons', 'Installed mods/plugins/addons with compatibility warnings', 'See the server'],
    ['POST', '/api/servers/{id}/addons/upload', 'Install a file (raw body, name in the X-Filename header)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/upload-folder', 'Install an unpacked folder (Bedrock): 4-byte LE length of {"files":[{"path","size"}]}, then the file bytes in order', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/{item}/enabled', 'Switch on/off: {"enabled":true}', 'Manage mods / plugins / addons'],
    ['DELETE', '/api/servers/{id}/addons/{item}', 'Remove', 'Manage mods / plugins / addons'],
    ['PUT', '/api/servers/{id}/addons/order', 'Bedrock load order: {"type":"behavior"|"resource","ids":[...]} top first (top wins); "priority" in the list', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/check-updates', 'Newer versions available (Valheim: Thunderstore/Hexium; Bedrock: CurseForge, for linked addons)', 'See the server'],
    ['POST', '/api/servers/{id}/addons/{item}/update', 'Update one (Valheim; Bedrock: installs the newest CurseForge file on the chosen channel)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/{item}/curseforge', 'Bedrock: link an addon to a CurseForge project for updates: {"projectId":123}, or {"projectId":null} to unlink', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/steam-login', 'Open SteamCMD on the server\'s PC to sign in for Workshop downloads: {"username":"..."} (owner only). Then POST /steam-login/confirm with the same body; DELETE /steam-login signs out. In the container (no SteamCMD window) send {"username","password","code"?} instead: it signs in directly and answers {"account"}', 'Owner'],
    ['POST', '/api/servers/{id}/addons/by-id', 'Add a mod by ID or link (Space Engineers: Steam Workshop): {"input":"https://steamcommunity.com/sharedfiles/filedetails/?id=…"}', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/addons/update-settings', 'Bedrock addon updates: {channel: "release"|"beta"|"alpha", auto}', 'See the server'],
    ['PUT', '/api/servers/{id}/addons/update-settings', 'Change them: {"channel":"beta","auto":true} (beta/alpha files only count when newer than the newest release)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/setup', 'Turn on modding (Valheim: installs BepInEx; permanent)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/{item}/side', 'Who gets a mod (Valheim: {"side":"both|server|clients"}; Minecraft Java mod servers: {"side":"both|server"}). server = not shared with players', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/addons/settings', 'Valheim: mod settings files in BepInEx/config: {files:[{file, plugin, version, mod, settings, shared}]} (mod = the installed mod it belongs to, if known)', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/addons/settings/{file}', 'Valheim: one settings file: {entries:[{section, key, value, description, type, default, options, multi, range, shared}]}', 'Manage mods / plugins / addons'],
    ['PUT', '/api/servers/{id}/addons/settings/{file}', 'Valheim: change values and choose what players get: {"values":[{"section","key","value"}],"shared":[{"section","key"}]} (shared = the full list sent to players through the share link)', 'Manage mods / plugins / addons'],
    ['PUT', '/api/servers/{id}/addons/location','Where new addons go (games with more than one addon folder): {"location"}', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/{item}/move', 'Move one addon to the other folder: {"to"}', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/move-all', 'Move every addon to one folder: {"to"}', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/addons/{item}/icon', "An addon's icon (PNG)", 'See the server'],
    ['GET', '/api/servers/{id}/addons/curseforge/search?q=&page=0', 'Search CurseForge (needs the CurseForge key in Integrations)', 'See the server'],
    ['POST', '/api/servers/{id}/addons/curseforge', 'Install the latest file of a CurseForge project: {"projectId"} (answers needsBrowser when the author only allows website downloads)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/hexium', 'Valheim: install from Hexium with dependencies: {"input":"https://valheim.hexium.gg/mods/Author/Mod"} or {"namespace","name","version"?}', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/nexus', 'Valheim: install a Nexus Mods file: {"input":"nxm://…"} (needs the Nexus key in Integrations; a mod page address needs Premium)', 'Manage mods / plugins / addons'],
    ['POST', '/api/servers/{id}/addons/adopt', 'Valheim: take over mods added without Server Forge (r2modman, by hand) so they can be shared: {adopted, skipped}', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/plugins', 'Bedrock on Endstone: its plugins (.whl/.dll). Every /addons route above also works under /plugins for them (upload, {item}/enabled, DELETE, check-updates, {item}/update, setup)', 'See the server'],
    ['GET', '/api/servers/{id}/plugins/search?q=', 'Endstone: search plugins on GitHub and PyPI: {results:[{id, name, summary, author, url, source, version?, stars?}], errors}', 'See the server'],
    ['POST', '/api/servers/{id}/plugins/found', 'Endstone: install the newest file of a search result: {"id":"pypi:endstone-essentials"} or {"id":"github:owner/repo"}', 'Manage mods / plugins / addons'],
    ['GET', '/api/servers/{id}/share', "Players' share link (Valheim, Minecraft Java, Satisfactory, Bedrock, Terraria tModLoader, Space Engineers): links, public link, what's shared (summary, with mode sync|links|info), Remote access status", 'Share mods with players'],
    ['POST', '/api/servers/{id}/share', 'Sharing on/off or a new link: {"enabled":true,"newLink":false}', 'Share mods with players'],
    ['GET', '/api/share/{token}', "What the players' SF Mod Manager reads (Remote access port): {server, game, gameName, mode, join:{port,protocol}, note, mods…}. Minecraft Java mod servers add loader, mcVersion, loaderVersion", 'The share link token (no login)'],
    ['GET', '/api/share/{token}/file/{name}', 'Download a shared mod file (Valheim uploads, Nexus and Hexium copies; Minecraft Java mod jars players need)', 'The share link token (no login)'],
  ]],
  ['Tasks', [
    ['GET', '/api/servers/{id}/tasks', 'Scheduled tasks with next/last run', 'See the server'],
    ['POST', '/api/servers/{id}/tasks', 'Create a task: {"name","enabled","trigger","jobs","onlyWhenRunning"}', 'Create & edit tasks'],
    ['PUT', '/api/servers/{id}/tasks/{task}', 'Change a task', 'Create & edit tasks'],
    ['DELETE', '/api/servers/{id}/tasks/{task}', 'Delete a task', 'Create & edit tasks'],
    ['POST', '/api/servers/{id}/tasks/{task}/run', 'Run a task now', 'Run tasks'],
  ]],
  ['Server files', [
    ['GET', '/api/servers/{id}/files?path=', "List a folder in the server's folder", 'View & download files'],
    ['GET', '/api/servers/{id}/files/content?path=', 'Read a text file', 'View & download files'],
    ['GET', '/api/servers/{id}/files/download?path=', 'Download a file', 'View & download files'],
    ['PUT', '/api/servers/{id}/files/content', 'Save a text file: {"path","content","modified"}', 'Edit & upload files'],
    ['POST', '/api/servers/{id}/files/upload?path=', 'Upload a file into a folder (raw body, X-Filename)', 'Edit & upload files'],
    ['POST', '/api/servers/{id}/files/mkdir', 'New folder or file: {"path","name","file":false}', 'Edit & upload files'],
    ['POST', '/api/servers/{id}/files/rename', 'Rename: {"path","name"}', 'Edit & upload files'],
    ['POST', '/api/servers/{id}/files/delete', 'Delete to the Recycle Bin: {"path"}', 'Edit & upload files'],
  ]],
  ['Users, keys & panel', [
    ['GET', '/api/users', 'Users with role, access summary and last login', 'Manage users & API keys'],
    ['POST', '/api/users', 'Add a user: {"username","password","role","grants","remote","mustChangePassword","note"}', 'Manage users & API keys'],
    ['PUT', '/api/users/{id}', 'Change a user (same fields, plus "disabled")', 'Manage users & API keys'],
    ['POST', '/api/users/{id}/signout', 'Sign a user out everywhere', 'Manage users & API keys'],
    ['DELETE', '/api/users/{id}', 'Delete a user', 'Manage users & API keys'],
    ['GET', '/api/apikeys', 'API keys (never the key itself)', 'Manage users & API keys'],
    ['POST', '/api/apikeys', 'Create a key: {"name","preset","grants","expiresInDays"} (the key is returned once)', 'Manage users & API keys'],
    ['PUT', '/api/apikeys/{id}', 'Change a key', 'Manage users & API keys'],
    ['DELETE', '/api/apikeys/{id}', 'Delete a key', 'Manage users & API keys'],
    ['GET', '/api/activity?account=&q=', 'Activity log (newest first)', 'View activity log'],
    ['GET', '/api/settings/remote', 'Remote access status', 'Panel settings'],
    ['PUT', '/api/settings/remote', 'Remote access on/off and port: {"enabled","port"} (on this system only)', 'Panel settings'],
    ['POST', '/api/settings/remote/firewall', 'Add the Windows Firewall rule for the Remote access port (on this system only; Windows asks for admin)', 'Panel settings'],
    ['GET', '/api/settings/integrations', 'Which integrations are set up: {curseforge, nexus} (never the keys)', 'Panel settings'],
    ['PUT', '/api/settings/integrations', 'Set or remove keys: {"curseforgeKey"?,"nexusKey"?} ("" removes; the Nexus key is checked with Nexus)', 'Panel settings'],
    ['GET', '/api/servers/{id}/discord', 'Discord notifications: {url, events:{started, stopped, crashed, join, leave, updateAvailable, updated, backupFailed}, labels}', 'Change settings'],
    ['PUT', '/api/servers/{id}/discord', 'Set them: {"url":"https://discord.com/api/webhooks/…","events":{"join":true,…}} (url "" turns them off)', 'Change settings'],
    ['POST', '/api/servers/{id}/discord/test', 'Post a test message: {"url"?} (else the saved webhook)', 'Change settings'],
    ['PUT', '/api/settings/integrations/factorio','factorio.com login for Factorio servers and mods: {"username","token"} (checked with factorio.com; both "" removes). Answers {linked, username, spaceAge, canImport}', 'Panel settings'],
    ['POST', '/api/settings/integrations/factorio/import', "Take the factorio.com login the Factorio game saved on this system (player-data.json)", 'Panel settings'],
    ['GET', '/api/settings/backup-copy', 'Backup copies to another drive or share: {enabled, folder, keepDays}', 'Panel settings'],
    ['PUT', '/api/settings/backup-copy', 'Change them: {"enabled","folder","keepDays"}', 'Panel settings'],
    ['POST', '/api/settings/backup-copy/test', 'Test a folder: {"folder"} → free space', 'Panel settings'],
    ['POST', '/api/settings/backup-copy/sync', 'Copy every existing backup that isn\'t there yet (in the background)', 'Panel settings'],
    ['GET', '/api/nodes', 'Nodes (other systems) managed from this panel', 'Panel settings'],
    ['GET', '/api/node-targets', 'Systems you can create servers on (nodes with Server Forge, and whether they are online)', 'Create & import servers'],
    ['GET', '/api/nodes/{node}/games', "A node's games and their settings fields (for creating a server there)", 'Create & import servers'],
    ['GET', '/api/nodes/{node}/games/{game}/versions?from={type}', 'Versions a node can install', 'Create & import servers'],
    ['POST', '/api/nodes/{node}/servers/new', 'Create a server on a node (same body as POST /api/servers/new); the answer has its id here (n~node~server)', 'Create & import servers'],
    ['POST', '/api/nodes/{node}/servers', 'Import a server folder on a node (same body as POST /api/servers)', 'Create & import servers'],
    ['POST', '/api/nodes', 'Add a node: {"code":"thnode://…","name"?}', 'Panel settings'],
    ['PUT', '/api/nodes/{node}', 'Rename a node: {"name"}', 'Panel settings'],
    ['DELETE', '/api/nodes/{node}', 'Remove a node (its servers keep running there)', 'Panel settings'],
    ['POST', '/api/node-code', 'Make a code so another panel can manage this system (servers, and storage if Tavern Vault is in node mode): {"label"?} (on this system only; needs Remote access on)', 'Panel settings'],
    ['GET', '/api/files?path=', 'Browse any folder on this system', 'Browse all files on this system'],
    ['POST', '/api/files/mkdir', 'New folder: {"parent","name"}', 'Browse all files on this system'],
    ['POST', '/api/files/rename', 'Rename: {"path","name"} (not folders a running server uses)', 'Browse all files on this system'],
    ['POST', '/api/files/delete', 'Delete to the Recycle Bin: {"path"} (not folders a running server uses)', 'Browse all files on this system'],
  ]],
];

function renderApiRef() {
  const q = ($('apiSearch')?.value ?? '').trim().toLowerCase();
  const box = $('apiRef');
  if (!box) return;
  box.innerHTML = '';
  for (const [group, rows] of API_DOCS) {
    const hits = rows.filter((r) => !q || r.join(' ').toLowerCase().includes(q));
    if (!hits.length) continue;
    box.appendChild(el('h4', 'section-label', group));
    const table = el('table', 'table api-table');
    const head = el('tr');
    for (const h of ['Request', 'What it does', 'Permission']) head.appendChild(el('th', null, h));
    const thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const [method, path, what, perm] of hits) {
      const tr = el('tr');
      const req = el('td');
      req.append(el('span', `http-method m-${method.toLowerCase()}`, method), el('code', null, ` ${path}`));
      tr.append(req, el('td', null, what), el('td', 'muted', perm));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }
}
$('apiSearch').addEventListener('input', renderApiRef);
renderApiRef();

// ---------- activity log ----------

function fillActivityWho() {
  const sel = $('activityWho');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Everyone</option>';
  for (const u of usersCache) sel.add(new Option(u.username, u.id));
  sel.value = keep;
}

let activityTimer;
async function loadActivity() {
  if (!hasGlobal('audit.view')) return;
  const q = new URLSearchParams();
  if ($('activityWho').value) q.set('account', $('activityWho').value);
  if ($('activitySearch').value.trim()) q.set('q', $('activitySearch').value.trim());
  let rows;
  try {
    rows = await api('GET', `/api/activity?${q}`);
  } catch (err) {
    return toast(err.message, true);
  }
  const box = $('activityBody');
  box.innerHTML = '';
  if (!rows.length) box.appendChild(el('p', 'muted', 'Nothing yet.'));
  for (const a of rows) {
    const row = el('div', 'activity-row');
    row.append(el('span', 'muted mono small-text', new Date(a.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })), el('b', null, a.who), el('span', null, a.what));
    if (a.ip) row.appendChild(el('span', 'muted small-text', a.ip));
    box.appendChild(row);
  }
}
$('activityWho').addEventListener('change', loadActivity);
$('activitySearch').addEventListener('input', () => {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(loadActivity, 300);
});
$('btnActivityRefresh').addEventListener('click', loadActivity);

// Account (everyone)

let passwordForced = false;
/** forced = the account must choose a new password before it can do anything else. */
function openPasswordDialog(forced = false, why = 'Your account needs a new password before you can continue.') {
  passwordForced = forced;
  $('accountForm').reset();
  $('accountError').textContent = forced ? why : '';
  $('accountCancel').textContent = forced ? 'Log out' : 'Cancel';
  $('accountDialog').showModal();
}
$('btnAccount').addEventListener('click', () => openPasswordDialog(false));
$('accountCancel').addEventListener('click', async () => {
  if (passwordForced) {
    await api('POST', '/api/logout').catch(() => {});
    location.reload();
    return;
  }
  $('accountDialog').close();
});
$('accountDialog').addEventListener('cancel', (e) => passwordForced && e.preventDefault());
$('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/me/password', { current: $('aCurrent').value, password: $('aNew').value });
    $('accountDialog').close();
    if (passwordForced) {
      location.reload();
      return;
    }
    toast('Password changed. Other devices were logged out.');
  } catch (err) {
    $('accountError').textContent = err.message;
  }
});

// ---------- backups ----------

const KIND_LABEL = { manual: 'Manual', scheduled: 'Automatic', 'before-restore': 'Before restore' };
let backupFolder = '';
let backupsShownFor = null;

/** The server's backups on the other drive (Settings -> Backup copies), with "Bring back". */
function renderCopies(data) {
  const copies = data.copies ?? [];
  $('copiesCard').hidden = !data.copyFolder && !copies.length;
  $('copyCount').textContent = copies.length ? String(copies.length) : '';
  $('copiesHint').textContent = data.copyFolder
    ? `New backups are also copied to ${data.copyFolder}. "Bring back" copies one to this system so you can restore it above.`
    : 'Backup copies are turned off, but these copies are still there.';
  const body = $('copyRows');
  body.innerHTML = '';
  if (!copies.length) {
    const td = el('td', 'muted', 'No copies yet. New backups are copied automatically (or use "Copy existing backups now" in Settings).');
    td.colSpan = 4;
    const tr = el('tr');
    tr.appendChild(td);
    body.appendChild(tr);
  }
  const local = new Set(data.backups.map((b) => b.file));
  for (const c of copies) {
    const tr = el('tr');
    tr.appendChild(el('td', null, new Date(c.createdAt).toLocaleString()));
    const kind = el('td');
    kind.appendChild(el('span', `kind ${c.kind}`, KIND_LABEL[c.kind] ?? c.kind));
    tr.appendChild(kind);
    tr.appendChild(el('td', null, fmtSize(c.size)));
    const actions = el('td', 'actions');
    if (local.has(c.file)) actions.appendChild(el('span', 'muted small-text', 'also on this system'));
    else if (hasPerm('backups.restore')) {
      const back = el('button', 'small', 'Bring back');
      back.addEventListener('click', async () => {
        back.disabled = true;
        back.textContent = 'Copying…';
        try {
          await api('POST', `/api/servers/${state.selected}/backups/copies/${encodeURIComponent(c.file)}/bring-back`);
          toast('Copied back. You can restore it from the list above.');
          loadBackups();
        } catch (err) {
          toast(err.message, true);
          back.disabled = false;
          back.textContent = 'Bring back';
        }
      });
      actions.appendChild(back);
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

async function loadBackups() {
  let data;
  try {
    data = await api('GET', `/api/servers/${state.selected}/backups`);
  } catch (err) {
    return toast(err.message, true);
  }
  renderCopies(data);
  backupsShownFor = state.selected;
  backupFolder = data.folder;
  const d = state.detail;
  $('btnOpenBackups').hidden = !window.desktop?.openFolder;
  $('backupHint').textContent =
    d.game === 'bedrock'
      ? 'Backups are safe while the server runs: Server Forge pauses saving, copies the world, then lets it save again. Players can keep playing.'
      : 'Backs up the world and the admin/ban/allow lists. Taken as-is while running.';
  $('bkEvery').value = d.backupSchedule.everyHours;
  $('bkKeep').value = d.backupSchedule.keep;
  renderBackupJob();

  const body = $('backupRows');
  body.innerHTML = '';
  if (!data.backups.length) {
    const td = el('td', 'muted', 'No backups yet.');
    td.colSpan = 6;
    const tr = el('tr');
    tr.appendChild(td);
    body.appendChild(tr);
  }
  const stopped = ['stopped', 'crashed'].includes(d.status);
  const goodId = data.backups.find((b) => b.check?.status === 'ok')?.id;
  loadWorldCheck();
  for (const b of data.backups) {
    const tr = el('tr');
    tr.appendChild(el('td', null, `${new Date(b.createdAt).toLocaleString()}${b.live ? ' (while running)' : ''}`));
    const kind = el('td');
    kind.appendChild(el('span', `kind ${b.kind}`, KIND_LABEL[b.kind] ?? b.kind));
    tr.appendChild(kind);
    tr.appendChild(el('td', null, b.world ?? '—'));
    tr.appendChild(el('td', null, fmtSize(b.size)));
    const check = el('td');
    if (b.check) {
      const c = CHECK_BADGE[b.check.status];
      const badge = el('span', `check-badge ${b.check.status}`, `${c.icon} ${c.label}${b.id === goodId ? ' · last good' : ''}`);
      badge.title = b.check.summary ?? '';
      check.appendChild(badge);
    } else check.appendChild(el('span', 'muted', '—'));
    tr.appendChild(check);
    const actions = el('td', 'actions');
    {
      const restore = el('button', 'small', 'Restore');
      restore.hidden = !hasPerm('backups.restore');
      restore.disabled = !stopped;
      restore.title = stopped ? '' : 'Stop the server first';
      restore.addEventListener('click', async () => {
        if (!await confirmBox(`Restore the backup from ${new Date(b.createdAt).toLocaleString()}?\n\nThe current world is backed up first, so you can undo this.`)) return;
        try {
          await api('POST', `/api/servers/${state.selected}/backups/${b.id}/restore`);
          toast('Restoring…');
        } catch (err) {
          toast(err.message, true);
        }
      });
      const del = el('button', 'small red ghost', 'Delete');
      del.hidden = !hasPerm('backups.delete');
      del.addEventListener('click', async () => {
        const last = b.id === goodId ? '\n\nThis is the newest backup whose world passed its check (the last known-good copy).' : '';
        if (!await confirmBox(`Delete this backup permanently?${last}`)) return;
        try {
          await api('DELETE', `/api/servers/${state.selected}/backups/${b.id}`);
          loadBackups();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.append(restore, document.createTextNode(' '), del);
    }
    tr.appendChild(actions);
    body.appendChild(tr);
  }
}

// ---------- world check (Bedrock) ----------

const CHECK_BADGE = {
  checking: { icon: '⏳', label: 'Checking' },
  ok: { icon: '✔', label: 'World OK' },
  damaged: { icon: '⛔', label: 'Damage found' },
  failed: { icon: '⚠', label: 'Not checked' },
};
const CHECK_SOURCE = { backup: 'backup', manual: 'manual check', 'after-force-stop': 'check after a forced stop' };

async function loadWorldCheck() {
  const id = state.selected;
  let w;
  try {
    w = await api('GET', `/api/servers/${id}/world-check`);
  } catch {
    return;
  }
  if (id !== state.selected) return;
  renderWorldCheck(w);
}

function renderWorldCheckProgress(done, total) {
  const box = $('worldCheckStatus');
  const bar = box.querySelector('.wc-progress');
  if (bar) bar.textContent = total ? `Checking… ${Math.round((done / total) * 100)}% (${done.toLocaleString()} of ${total.toLocaleString()} database files)` : 'Checking…';
  else loadWorldCheck();
}

function renderWorldCheck(w) {
  $('worldCheckCard').hidden = !w.supported;
  if (!w.supported) return;
  const box = $('worldCheckStatus');
  const areas = $('worldCheckAreas');
  box.innerHTML = '';
  areas.innerHTML = '';
  const busy = !!w.running || w.queued;
  $('btnWorldCheck').disabled = busy;
  const last = w.last;
  $('btnWorldAccept').hidden = !(last?.status === 'damaged' && last.result?.baselineChunks != null) || !hasPerm('backups.restore');
  if (busy) {
    const p = w.running;
    box.appendChild(el('div', 'wc-line wc-progress', p?.total ? `Checking… ${Math.round((p.done / p.total) * 100)}%` : w.queued ? 'Waiting for another check to finish…' : 'Checking…'));
  }
  if (!last) {
    if (!busy) box.appendChild(el('div', 'wc-line muted', 'Not checked yet. The next backup is checked automatically, or press Check now.'));
    return;
  }
  const when = `${new Date(last.at).toLocaleString()} (${CHECK_SOURCE[last.source] ?? last.source}${last.seconds != null ? `, ${last.seconds}s` : ''})`;
  const r = last.result;
  if (last.status === 'failed') box.appendChild(el('div', 'wc-line warn', `⚠ The last check couldn't finish: ${last.error}`));
  else if (last.status === 'ok') {
    box.appendChild(el('div', 'wc-line ok', last.reference ? `✔ Reference taken: ${r.chunks.toLocaleString()} chunks. Later checks compare the world with it.` : `✔ No damage: ${r.chunks.toLocaleString()} chunks checked against the reference.`));
  } else {
    const parts = [
      r.gone && `${r.gone.toLocaleString()} chunks gone`,
      r.regenerated && `${r.regenerated.toLocaleString()} chunks regenerated (their data was lost, then a player went there)`,
      r.holes && `${r.holes.toLocaleString()} chunks missing block layers`,
      r.problemCount && `${r.problemCount} damaged database blocks`,
    ].filter(Boolean);
    box.appendChild(el('div', 'wc-line bad', `⛔ Damage found: ${parts.join(', ')}.`));
    box.appendChild(
      el(
        'div',
        'wc-line muted small-text',
        `Compared with the world as it was ${r.baselineAt ? new Date(r.baselineAt).toLocaleString() : 'at the reference'}. Keep the server stopped if you can, and restore or repair from the last good backup${w.lastGoodBackup ? ` (${new Date(w.lastGoodBackup.createdAt).toLocaleString()})` : ''}. If the changes were on purpose, press Accept as normal.`,
      ),
    );
  }
  box.appendChild(el('div', 'wc-line muted small-text', `Last check: ${when}${w.lastGoodBackup ? ` · Last good backup: ${new Date(w.lastGoodBackup.createdAt).toLocaleString()} (never deleted automatically)` : ''}`));
  if (last.status === 'damaged' && r.areas?.length) {
    const table = el('table', 'table');
    table.innerHTML = '<thead><tr><th>Where</th><th>Blocks</th><th>Chunks</th><th>What happened</th></tr></thead>';
    const body = el('tbody');
    for (const a of r.areas) {
      const tr = el('tr');
      tr.appendChild(el('td', null, `${a.dimension} X ${a.x}, Z ${a.z}`));
      tr.appendChild(el('td', 'muted', `${a.from.x}, ${a.from.z} → ${a.to.x}, ${a.to.z}`));
      tr.appendChild(el('td', null, String(a.chunks)));
      tr.appendChild(el('td', 'muted', [a.gone && `${a.gone} gone`, a.regenerated && `${a.regenerated} regenerated`, a.holes && `${a.holes} missing layers`].filter(Boolean).join(', ')));
      body.appendChild(tr);
    }
    table.appendChild(body);
    areas.appendChild(el('p', 'muted small-text', `Damaged areas${r.areas.length >= 40 ? ' (the 40 biggest)' : ''}:`));
    areas.appendChild(table);
  }
  if (r?.problems?.length) {
    const det = el('details');
    det.appendChild(el('summary', 'muted small-text', `Database problems (${r.problemCount})`));
    det.appendChild(el('pre', 'diag-evidence', r.problems.map((p) => `${p.file}: ${p.what}`).join('\n')));
    areas.appendChild(det);
  }
}

$('btnWorldCheck').addEventListener('click', async () => {
  try {
    renderWorldCheck(await api('POST', `/api/servers/${state.selected}/world-check`));
    toast('Checking the world… (takes a few minutes for big worlds; players can keep playing)');
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnWorldAccept').addEventListener('click', async () => {
  if (!await confirmBox('Accept the world as it is now?\n\nOnly do this if the flagged chunks were changed on purpose (e.g. trimmed with a tool). Later checks will compare with the world as it is now, and this damage won\'t be reported again.')) return;
  try {
    renderWorldCheck(await api('POST', `/api/servers/${state.selected}/world-check/accept`));
    toast('Accepted.');
  } catch (err) {
    toast(err.message, true);
  }
});

function renderBackupJob() {
  const job = state.detail?.job;
  const active = job && ['backup', 'restore'].includes(job.kind) && job.status === 'running';
  $('backupJob').textContent = active ? `${job.title}: ${job.step}` : job?.status === 'failed' && ['backup', 'restore'].includes(job.kind) ? `${job.title} failed: ${job.error}` : '';
  $('btnBackupNow').disabled = !!active || state.detail?.status === 'installing';
}

// When a backup/restore job finishes, refresh the list.
let lastJobState = '';
setInterval(() => {
  if (state.tab !== 'backups' || !state.detail) return;
  renderBackupJob();
  const key = `${state.detail.job?.id}:${state.detail.job?.status}`;
  if (key !== lastJobState) {
    const finished = lastJobState && state.detail.job?.status !== 'running';
    lastJobState = key;
    if (finished && backupsShownFor === state.selected) loadBackups();
  }
}, 1000);

$('btnBackupNow').addEventListener('click', async () => {
  try {
    await api('POST', `/api/servers/${state.selected}/backups`);
    toast('Backing up…');
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnSaveSchedule').addEventListener('click', async () => {
  try {
    const snap = await api('PUT', `/api/servers/${state.selected}`, { backupSchedule: { everyHours: Number($('bkEvery').value), keep: Number($('bkKeep').value) } });
    state.detail = { ...state.detail, ...snap };
    toast(snap.backupSchedule.everyHours ? `Automatic backups every ${snap.backupSchedule.everyHours} h` : 'Automatic backups off');
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnOpenBackups').addEventListener('click', () => window.desktop?.openFolder?.(backupFolder));

// ---------- addons (Bedrock) ----------

let addonState = { packs: [], curseforge: null, links: [], running: false };
// CurseForge only gives catalogue access to approved third-party apps, so its UI is off for now (the backend stays).
const CURSEFORGE_UI = false;
// The Addons and Plugins tabs (Bedrock on Endstone has both) share this panel; this says which one is showing.
let addonKind = 'addons';
const addonApi = () => `/api/servers/${state.selected}/${addonKind}`;

async function loadAddons() {
  const kind = addonKind;
  let data;
  try {
    data = await api('GET', `${addonApi()}`);
  } catch (err) {
    return toast(err.message, true);
  }
  // Switched tabs while this was loading.
  if (kind !== addonKind) return;
  // Install messages and update labels belong to one server's tab: clear them when showing another.
  if ($('addonResult').dataset.server !== `${state.selected}:${kind}`) {
    $('addonResult').innerHTML = '';
    $('addonResult').dataset.server = `${state.selected}:${kind}`;
    $('pluginResults').innerHTML = '';
    addonUpdates = {};
  }
  addonState = data;
  $('addonFile').accept = addonState.accept ?? '';
  // The built-in search (Endstone plugins: GitHub and PyPI).
  $('pluginSearchCard').hidden = !addonState.canSearch;
  // Wording for this server type: addons (Bedrock), mods or plugins (Java).
  const L = addonState.labels;
  // Listed only (Satisfactory: mods are managed with Satisfactory Mod Manager): no upload box.
  $('addonAddTitle').textContent = addonState.readOnly ? L.tab : `Add ${L.plural}`;
  // Games whose mods are added by ID get a box: instead of the file drop (Space Engineers: Steam Workshop), or as well
  // as it when files can be added too (Factorio: mod portal name/link, or a mod zip).
  $('addonDrop').hidden = !!addonState.readOnly || (!!addonState.canAddById && !addonState.accept);
  $('addonByIdForm').hidden = !addonState.canAddById;
  renderWorkshop();
  $('addonByIdInput').placeholder = addonState.byIdPlaceholder ?? 'Steam Workshop link or ID, e.g. https://steamcommunity.com/sharedfiles/filedetails/?id=123456789';
  $('addonAddHelp').innerHTML = L.dropHelp; // fixed text from Server Forge itself
  // Bedrock also takes unpacked pack folders.
  $('addonDrop').querySelector('span').innerHTML = addonState.folders
    ? `Drop ${L.plural} or unpacked pack folders here, or <u>choose files</u> · <u id="addonPickFolder">choose a folder</u>`
    : `Drop ${L.plural} here, or <u>choose files</u>`;
  $('addonPickFolder')?.addEventListener('click', (e) => {
    // Inside the drop zone's <label>: don't also open the file picker.
    e.preventDefault();
    e.stopPropagation();
    $('addonFolder').click();
  });
  $('addonSitesTitle').textContent = `Get ${L.plural}`;
  renderAddonStatus();
  renderAddonSites();
  renderAddonLocation();
  $('addonCheckUpdates').hidden = !addonState.canCheckUpdates || !hasPerm('addons.manage');
  loadAddonUpdateSettings();
  $('addonStopNote').hidden = !(addonState.needsStopped && addonState.running);
  $('addonShareCard').hidden = !addonState.share || addonState.moddingOff;
  if (addonState.share && !addonState.moddingOff) loadShare();
  // Vanilla (modding off): only the "Turn on modding" bar is shown.
  const off = !!addonState.moddingOff;
  for (const id of ['addonAddTitle', 'addonAddHelp', 'addonInstalledCard']) $(id).hidden = off;
  if (off) $('addonDrop').hidden = true;
  if (off) $('addonSitesCard').hidden = true;
  // Nexus Mods (Valheim): paste a link; the server downloads it with the Nexus API key.
  $('nexusCard').hidden = off || state.detail.game !== 'valheim';
  $('nexusHelp').textContent = `Hexium: paste a mod's page address (valheim.hexium.gg/mods/Author/Mod) to install its latest version and what it needs. Nexus Mods: paste a "Mod Manager Download" (nxm://) link, or a mod page address with a Premium account; needs your Nexus API key in Settings → Integrations.${window.desktop?.browseAddons ? ' Or open either site under Get mods: downloads there install by themselves.' : ''}`;
  $('cfCard').hidden = !CURSEFORGE_UI || !addonState.curseforge;
  $('cfSetup').hidden = !!addonState.curseforge?.available;
  $('cfForm').hidden = !addonState.curseforge?.available;
  renderAddons();
}

// Addon sites. In the desktop app they open in Server Forge's own browser window, and addons downloaded there install
// on this server by themselves. In a normal browser they open in a new tab; download, then drop the file above.
function renderAddonSites() {
  const box = $('addonSites');
  box.innerHTML = '';
  $('addonSitesCard').hidden = !addonState.links.length;
  const inApp = !!window.desktop?.browseAddons;
  const L = addonState.labels;
  const files = addonState.accept.split(',').join(' / ');
  $('addonSitesHelp').textContent = inApp
    ? `Opens the site in a Server Forge window. Download any ${L.noun} (${files}) there and it's installed on "${state.detail.name}" automatically.${state.detail.game === 'hytale' ? ' Check the mod page for Hytale version compatibility and required dependencies.' : " A warning is shown if it doesn't match this server's version."}`
    : `Opens the site in a new tab. Download a ${L.noun} there, then drop the file in the box above. (In the Server Forge desktop app, downloads install by themselves.)`;
  for (const link of addonState.links) {
    const btn = el('button', 'site-btn');
    btn.append(el('b', null, link.label));
    if (link.help) btn.append(el('span', 'muted small-text', link.help));
    btn.addEventListener('click', () => {
      if (inApp) window.desktop.browseAddons({ url: link.url, serverId: state.selected, serverName: state.detail.name, accept: addonState.accept, kind: addonKind });
      else window.open(link.url, '_blank', 'noopener');
    });
    box.appendChild(btn);
  }
}

// Where new addons go (Bedrock: server folder or the world's own folder).
function renderAddonLocation() {
  const loc = addonState.locations;
  $('addonLocation').hidden = !loc;
  if (!loc) return;
  const select = $('addonLocationSelect');
  select.innerHTML = '';
  for (const o of loc.options) {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    select.appendChild(opt);
  }
  select.value = loc.current;
  const current = loc.options.find((o) => o.value === loc.current);
  $('addonLocationHelp').textContent = current ? `${current.help} Updates always stay where the addon already is.` : '';
}
$('addonLocationSelect').addEventListener('change', async () => {
  try {
    const { current } = await api('PUT', `${addonApi()}/location`, { location: $('addonLocationSelect').value });
    addonState.locations.current = current;
    renderAddonLocation();
    toast(`New addons will go in the ${locationLabel(current).toLowerCase()}`);
  } catch (err) {
    toast(err.message, true);
    renderAddonLocation();
  }
});

// Mod loader status (Valheim: BepInEx) with one-click setup.
function renderAddonStatus() {
  const box = $('addonStatus');
  box.innerHTML = '';
  const s = addonState.status;
  if (!s) return;
  const bar = el('div', `status-bar ${s.ok ? 'ok' : 'todo'}`);
  const text = el('div');
  text.append(el('b', null, `${s.ok ? '✔' : '⚠'} ${s.title}`), el('div', 'muted small-text', s.text));
  bar.appendChild(text);
  if (s.setupLabel && hasPerm('addons.manage')) {
    const btn = el('button', 'primary', s.setupLabel);
    btn.addEventListener('click', async () => {
      if (s.confirm && !await confirmBox(s.confirm)) return;
      btn.disabled = true;
      btn.textContent = 'Installing…';
      try {
        const r = await api('POST', `${addonApi()}/setup`);
        toast(r.message);
        loadAddons();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = s.setupLabel;
      }
    });
    bar.appendChild(btn);
  }
  box.appendChild(bar);
}

let addonUpdates = {};

/** The Mods tab's Steam Workshop section: sign-in (where Server Forge does the downloading) and browsing. */
function renderWorkshop() {
  const w = addonState.workshop;
  $('addonWorkshop').hidden = !w || !!addonState.moddingOff;
  if (!w) return;
  const ready = !w.needsLogin || !!w.account;
  const inApp = !!window.desktop?.browseAddons;
  $('addonByIdForm').hidden = !addonState.canAddById || !ready;
  $('btnBrowseWorkshop').hidden = !ready;
  $('steamLoginForm').hidden = ready || !w.canSignIn;
  // No SteamCMD window where Server Forge runs (the container): the password and code are typed here instead.
  $('steamLoginPass').hidden = $('steamLoginCode').hidden = !w.signInHere;
  $('btnSteamConfirm').hidden = ready || !steamLoginPending;
  $('btnSteamSignOut').hidden = !w.needsLogin || !w.account || !w.canSignIn;
  const how = inApp ? 'Browse, open a mod, and press the blue Install button on its page, or paste its link below.' : 'Browse, open a mod, copy its link and paste it below.';
  if (!w.needsLogin) $('addonWorkshopStatus').textContent = `${how} No Steam sign-in is needed: this game's server downloads its own mods.`;
  else if (w.account) $('addonWorkshopStatus').textContent = `Signed in on this server's PC as ${w.account}. ${how}`;
  else if (steamLoginPending) $('addonWorkshopStatus').textContent = "A SteamCMD window opened on this server's PC. Type your password and Steam Guard code there (Server Forge never sees them), then close it and press I've signed in.";
  else if (w.canSignIn && w.signInHere) $('addonWorkshopStatus').textContent = "Downloading Workshop mods needs a Steam account that owns this game. Your password goes straight to Steam's SteamCMD and isn't saved. If your Steam app asks you to approve the sign-in, approve it there.";
  else if (w.canSignIn) $('addonWorkshopStatus').textContent = "Downloading Workshop mods needs a Steam account that owns this game. You sign in on this server's PC, in SteamCMD's own window.";
  else $('addonWorkshopStatus').textContent = "Downloading Workshop mods needs a Steam account that owns this game. Only the owner can sign in.";
}

let steamLoginPending = false;

$('steamLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const here = !!addonState.workshop?.signInHere;
  const btn = $('steamLoginForm').querySelector('button[type="submit"]');
  btn.disabled = true;
  if (here) btn.textContent = 'Signing in…';
  try {
    const body = { username: $('steamLoginUser').value.trim() };
    if (here) Object.assign(body, { password: $('steamLoginPass').value, code: $('steamLoginCode').value.trim() });
    await api('POST', `/api/servers/${state.selected}/steam-login`, body);
    if (here) {
      $('steamLoginPass').value = $('steamLoginCode').value = '';
      await loadAddons();
    } else {
      steamLoginPending = true;
      renderWorkshop();
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in to Steam';
  }
});

$('btnSteamConfirm').addEventListener('click', async () => {
  const btn = $('btnSteamConfirm');
  btn.disabled = true;
  try {
    await api('POST', `/api/servers/${state.selected}/steam-login/confirm`, { username: $('steamLoginUser').value.trim() });
    steamLoginPending = false;
    await loadAddons();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btnSteamSignOut').addEventListener('click', async () => {
  try {
    await api('DELETE', `/api/servers/${state.selected}/steam-login`);
    await loadAddons();
  } catch (err) {
    toast(err.message, true);
  }
});

$('btnBrowseWorkshop').addEventListener('click', () => {
  const url = addonState.workshop.url;
  if (window.desktop?.browseAddons) window.desktop.browseAddons({ url, serverId: state.selected, serverName: state.detail.name, accept: '', kind: addonKind, workshop: true });
  else window.open(url, '_blank', 'noopener');
});

$('addonByIdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('addonByIdInput').value.trim();
  if (!input) return;
  const btn = $('addonByIdForm').querySelector('button');
  btn.disabled = true;
  try {
    const r = await api('POST', `${addonApi()}/by-id`, { input });
    $('addonByIdInput').value = '';
    addonState.packs = r.packs;
    showInstallResult(r);
    renderAddons();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/** Shows a list to choose from; resolves to the chosen item, or null if cancelled. */
function pick(title, help, items, describe) {
  return new Promise((resolve) => {
    const dialog = $('pickDialog');
    $('pickTitle').textContent = title;
    $('pickHelp').textContent = help;
    const list = $('pickList');
    list.innerHTML = '';
    let chosen = null;
    for (const item of items) {
      const d = describe(item);
      const b = el('button', 'ghost');
      b.type = 'button';
      if (d.image) {
        const img = el('img');
        img.src = d.image;
        img.alt = '';
        b.appendChild(img);
      }
      const text = el('span', null, d.title);
      if (d.sub) text.appendChild(el('span', 'pick-sub', d.sub));
      b.appendChild(text);
      b.addEventListener('click', () => {
        chosen = item;
        dialog.close();
      });
      list.appendChild(b);
    }
    if (!items.length) list.appendChild(el('p', 'muted', 'Nothing found.'));
    $('pickCancel').onclick = () => dialog.close();
    dialog.addEventListener('close', () => resolve(chosen), { once: true });
    dialog.showModal();
  });
}

// Bedrock: link an addon to its CurseForge project, so "Check for updates" can find newer files.
async function linkCurseforge(p, packUrl) {
  const query = await ask(`Search CurseForge for "${p.name}". Change the search if it's listed under another name:`, p.name.replace(/\b(BP|RP|behaviou?r|resource)\b/gi, '').replace(/\s+/g, ' ').trim());
  if (!query) return;
  let found;
  try {
    found = await api('GET', `${addonApi()}/curseforge/search?q=${encodeURIComponent(query)}`);
  } catch (err) {
    return toast(err.message, true);
  }
  const project = await pick(
    `Which one is "${p.name}"?`,
    'The version installed now counts as current; newer files on CurseForge will show as updates. MCPEDL addons are usually on CurseForge under the same name.',
    found.results,
    (r) => ({ title: r.name, sub: [r.author ? `by ${r.author}` : null, `${r.downloads.toLocaleString()} downloads`, r.summary].filter(Boolean).join(' · '), image: r.thumbnail }),
  );
  if (!project) return;
  try {
    const r = await api('POST', `${packUrl}/curseforge`, { projectId: project.id });
    addonState.packs = r.packs;
    toast(`Linked to ${project.name}. Use "Check for updates" to look for newer versions.`);
    renderAddons();
  } catch (err) {
    toast(err.message, true);
  }
}

async function unlinkCurseforge(p, packUrl) {
  if (!await confirmBox(`Stop checking CurseForge for updates to "${p.name}"? (The addon stays installed.)`)) return;
  try {
    const r = await api('POST', `${packUrl}/curseforge`, { projectId: null });
    addonState.packs = r.packs;
    renderAddons();
  } catch (err) {
    toast(err.message, true);
  }
}

// Bedrock update settings (channel, automatic), loaded once per server.
async function loadAddonUpdateSettings() {
  const show = state.detail?.game === 'bedrock' && addonKind === 'addons' && addonState.canCheckUpdates;
  $('addonUpdateSettings').hidden = !show || !hasPerm('addons.manage');
  $('addonUpdateHelp').hidden = !show;
  if (!show || addonState.updateSettingsFor === state.selected) return;
  addonState.updateSettingsFor = state.selected;
  try {
    const s = await api('GET', `${addonApi()}/update-settings`);
    $('addonChannel').value = s.channel;
    $('addonAutoUpdate').checked = s.auto;
  } catch {}
}
async function saveAddonUpdateSettings() {
  try {
    const s = await api('PUT', `${addonApi()}/update-settings`, { channel: $('addonChannel').value, auto: $('addonAutoUpdate').checked });
    toast(`Addon updates: ${{ release: 'releases only', beta: 'releases + beta', alpha: 'releases + beta + alpha' }[s.channel]}${s.auto ? ', installed automatically' : ''}`);
    addonUpdates = {};
    renderAddons();
  } catch (err) {
    toast(err.message, true);
  }
}
$('addonChannel').addEventListener('change', saveAddonUpdateSettings);
$('addonAutoUpdate').addEventListener('change', saveAddonUpdateSettings);
$('addonCheckUpdates').addEventListener('click', async () => {
  const btn = $('addonCheckUpdates');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    addonUpdates = (await api('POST', `${addonApi()}/check-updates`)).updates;
    const n = Object.keys(addonUpdates).length;
    toast(n ? `${n} update${n === 1 ? '' : 's'} available` : 'Everything is up to date');
    renderAddons();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for updates';
  }
});

// Sharing with players' SF Mod Manager (Valheim).
async function loadShare() {
  let info;
  try {
    info = await api('GET', `/api/servers/${state.selected}/share`);
  } catch {
    return;
  }
  renderShare(info);
}

/** How many mods players get, and which ones they don't (with the reason and, where there is one, the fix). */
const SHARE_INTRO = {
  sync: 'Players install <b>SF Mod Manager</b>, paste this link once, and their game gets the same mods as this server: new mods are added, updated mods are updated and removed mods are removed (their own extra mods are left alone). "Server only" mods aren\'t shared.',
  java: 'Players install <b>SF Mod Manager</b> and paste this link once. It sets up the same mod loader in their Minecraft launcher (a separate profile, so their other worlds and mods are untouched) and keeps its mods the same as this server\'s. "Server only" mods aren\'t shared.',
  links: 'Players install <b>SF Mod Manager</b> and paste this link once. It shows this server\'s mods with versions, and each one opens in <b>Satisfactory Mod Manager</b> to install, so players don\'t have to hunt for them.',
  info: "This game downloads what it needs by itself when a player joins. The link gives players this server's join details in <b>SF Mod Manager</b>, next to their other servers.",
};

function renderShareSummary(body, s) {
  if (!s) return;
  $('shareIntro').innerHTML = s.mode === 'sync' && s.loader ? SHARE_INTRO.java : SHARE_INTRO[s.mode] ?? SHARE_INTRO.sync;
  if (s.mode === 'info') return;
  const names = (list) => (list.length > 6 ? `${list.slice(0, 6).join(', ')} and ${list.length - 6} more` : list.join(', '));
  if (s.mode === 'links') {
    body.appendChild(el('p', s.shared ? 'ok-text' : 'warn-text', s.shared ? `Players see ${s.shared} mod${s.shared === 1 ? '' : 's'} to install with Satisfactory Mod Manager.` : 'No mods on this server yet.'));
    return;
  }
  body.appendChild(el('p', s.shared ? 'ok-text' : 'warn-text', s.vanilla ? 'A vanilla profile is active: players get no mods (their app removes the ones it added).' : s.shared ? `Players get ${s.shared} mod${s.shared === 1 ? '' : 's'}.` : 'Players get no mods yet: nothing on this server can be shared.'));
  if (s.settings) body.appendChild(el('p', 'muted small-text', `Players also get ${s.settings} mod setting${s.settings === 1 ? '' : 's'} (chosen with "To players" in a mod's Settings). Needs SF Mod Manager 0.5.1 or newer.`));
  if (s.loader && !s.loaderVersion) body.appendChild(el('p', 'warn-banner', "Server Forge doesn't know which loader version this server runs (it wasn't installed by Server Forge). Players' app syncs the mods but can't set the loader up, so players install it themselves."));
  if (s.manual?.length) {
    const box = el('div', 'warn-banner');
    box.appendChild(el('p', null, `${s.manual.length} mod${s.manual.length === 1 ? ' was' : 's were'} added outside Server Forge (by r2modman, another mod manager or by hand), so ${s.manual.length === 1 ? "it isn't" : "they aren't"} shared: ${names(s.manual)}. Server Forge can take ${s.manual.length === 1 ? 'it' : 'them'} over if ${s.manual.length === 1 ? "it's" : "they're"} on Thunderstore or Hexium.`));
    if (hasPerm('addons.manage')) {
      const btn = el('button', 'primary small', 'Take them over');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Looking them up…';
        try {
          const r = await api('POST', `${addonApi()}/adopt`);
          const lines = [];
          if (r.adopted.length) lines.push(`Taken over: ${r.adopted.join(', ')}.`);
          for (const k of r.skipped) lines.push(`Left as is: ${k.name}: ${k.reason}.`);
          const result = el('div', 'result-box');
          for (const l of lines) result.appendChild(el('div', l.startsWith('Left') ? 'warn-banner' : null, l));
          $('addonResult').prepend(result);
          toast(r.adopted.length ? `Took over ${r.adopted.length} mod${r.adopted.length === 1 ? '' : 's'}` : 'Nothing could be taken over (see why above)', !r.adopted.length);
          loadAddons();
        } catch (err) {
          toast(err.message, true);
        }
        loadShare();
      });
      box.appendChild(btn);
    }
    body.appendChild(box);
  }
  if (s.uploadsMissing?.length) body.appendChild(el('p', 'warn-banner', `Players can't get ${names(s.uploadsMissing)}: the uploaded file isn't kept on this system any more. Upload the zip again.`));
  if (s.serverOnly.length) body.appendChild(el('p', 'muted small-text', `Not shared ("Server only"): ${names(s.serverOnly)}. Change a mod to "Server + players" in the list below if players need it too.`));
  if (s.off.length) body.appendChild(el('p', 'muted small-text', `Not shared (switched off): ${names(s.off)}.`));
}

function renderShare(info) {
  $('shareEnabled').checked = info.enabled;
  const body = $('shareBody');
  body.innerHTML = '';
  if (!info.enabled) return;
  renderShareSummary(body, info.summary);
  if (!info.remote.enabled || !info.remote.listening || !info.hasCertificate) {
    const banner = el('div', 'warn-banner');
    banner.appendChild(
      el(
        'p',
        null,
        !info.remote.enabled
          ? `Players' SF Mod Manager connects to this system through Remote access (HTTPS, port ${info.remote.port}), which is off. Turn it on to get the link.`
          : `Remote access is switched on but isn't running on port ${info.remote.port} (another program may be using the port). Check Settings → Remote access.`,
      ),
    );
    // Owners on this system can switch it on right here (Remote access can't be changed over Remote access itself).
    if (!info.remote.enabled && hasGlobal('panel.settings')) {
      const btn = el('button', 'primary', 'Turn on Remote access');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Turning on…';
        try {
          const r = await api('PUT', '/api/settings/remote', { enabled: true });
          if (!r.listening) throw new Error(r.error || `Remote access didn't start on port ${r.port}.`);
          // Windows asks for permission to add the firewall rule; the link works on this network either way once allowed.
          await api('POST', '/api/settings/remote/firewall').catch(() => toast('Allow Server Forge through the Windows Firewall (Settings → Remote access) so other systems can connect.', true));
          toast(`Remote access is on (port ${r.port}). For players outside your network, forward TCP ${r.port} on your router.`);
        } catch (err) {
          toast(err.message, true);
        }
        loadShare();
      });
      banner.appendChild(btn);
    }
    body.appendChild(banner);
    return;
  }
  body.appendChild(el('p', 'muted small-text', 'Give players one of these links (the one on the same network as them). Anyone with the link can see and download this server\'s mod list, nothing else.'));
  const addLink = (link) => {
    const row = el('div', 'share-link');
    const code = el('code', null, link);
    const copy = el('button', 'small primary', 'Copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied');
      } catch {
        toast(link);
      }
    });
    row.append(code, copy);
    body.appendChild(row);
  };
  if (info.publicLink) {
    body.appendChild(el('p', 'small-text', `Players anywhere else (forward TCP port ${info.remote.port} on your router to this system first):`));
    addLink(info.publicLink);
  } else {
    body.appendChild(el('p', 'muted small-text', `Players outside your network: forward TCP port ${info.remote.port} on your router and give them the link with your public IP instead of the local address.`));
  }
  body.appendChild(el('p', 'small-text', 'Players on your network (same house/LAN):'));
  info.links.forEach(addLink);
  const regen = el('button', 'small ghost', 'Make a new link (the old one stops working)');
  regen.addEventListener('click', async () => {
    if (!await confirmBox('Make a new link? Players using the old one will have to paste the new one.')) return;
    renderShare(await api('POST', `/api/servers/${state.selected}/share`, { enabled: true, newLink: true }));
  });
  body.appendChild(regen);
}

$('shareEnabled').addEventListener('change', async () => {
  try {
    renderShare(await api('POST', `/api/servers/${state.selected}/share`, { enabled: $('shareEnabled').checked }));
  } catch (err) {
    toast(err.message, true);
  }
});

// "Move all to …" buttons above the installed list: one per location that has addons elsewhere.
function renderMoveAll() {
  const box = $('addonMoveAll');
  box.innerHTML = '';
  const loc = addonState.locations;
  if (!loc || !hasPerm('addons.manage')) return;
  for (const o of loc.options) {
    const elsewhere = addonState.packs.filter((p) => p.location && p.location !== o.value);
    if (!elsewhere.length) continue;
    const btn = el('button', 'primary move-all-btn', `⇄ Move all to ${o.label.toLowerCase()} (${elsewhere.length})`);
    btn.title = o.help;
    btn.addEventListener('click', () => moveAllAddons(o.value));
    box.appendChild(btn);
  }
}

async function moveAllAddons(to) {
  const label = locationLabel(to).toLowerCase();
  try {
    const result = await api('POST', `${addonApi()}/move-all`, { to });
    addonState.packs = result.packs;
    renderAddons();
    if (result.moved.length) noteRestart();
    toast(`Moved ${result.moved.length} addon${result.moved.length === 1 ? '' : 's'} to the ${label}${result.failed.length ? `; ${result.failed.length} couldn't be moved` : ''}`, result.failed.length > 0);
    if (result.failed.length) {
      const box = el('div', 'result-box');
      box.appendChild(el('div', 'error', `Not moved:\n${result.failed.map((f) => `${f.name}: ${f.error}`).join('\n')}`));
      $('addonResult').prepend(box);
    }
  } catch (err) {
    toast(err.message, true);
  }
}
const locationLabel = (value) => addonState.locations?.options.find((o) => o.value === value)?.label ?? value;

// Downloads from the desktop addon browser report back here.
window.desktop?.onAddonDownload?.((info) => {
  if (info.status === 'downloading') return;
  const here = info.serverId === state.selected && state.tab === (info.kind ?? 'addons');
  if (info.status === 'installed') {
    toast(`Installed ${info.filename}`);
    if (here) {
      showInstallResult(info.result);
      loadAddons().then(noteRestart);
    }
  } else {
    toast(`${info.filename}: ${info.error}`, true);
    if (here) {
      const box = el('div', 'result-box');
      box.appendChild(el('div', 'error', `${info.filename}: ${info.error}`));
      $('addonResult').prepend(box);
    }
  }
});

function renderAddons() {
  renderMoveAll();
  const list = $('addonList');
  list.innerHTML = '';
  $('addonCount').textContent = addonState.packs.length ? `${addonState.packs.length}` : '';
  if (!addonState.packs.length) list.appendChild(el('p', 'muted', `No ${addonState.labels.plural} installed yet.`));
  else if (addonState.ordered) renderOrderedAddons(list);
  else for (const p of addonState.packs) list.appendChild(addonRow(p));
  renderOtherSettingsFiles(list);
}

/** Settings files no installed mod could be matched to (mods added by hand, files left by removed mods). */
function renderOtherSettingsFiles(list) {
  if (!addonState.settingsFiles) return;
  const ids = new Set(addonState.packs.map((p) => p.id));
  const others = addonState.settingsFiles.filter((f) => !f.mod || !ids.has(f.mod));
  const box = el('div', 'settings-files');
  if (others.length) {
    box.appendChild(el('h4', null, 'Other mod settings files'));
    box.appendChild(el('p', 'muted small-text', "Settings files Server Forge couldn't match to a mod above (mods added by hand, or files left by removed mods)."));
    const row = el('div', 'settings-file-list');
    for (const f of others) {
      const b = el('button', 'small', `${f.plugin ?? f.file}${f.shared ? ` · ${f.shared} to players` : ''}`);
      b.title = `Edit ${f.file}`;
      b.addEventListener('click', () => openModSettings(f.file));
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  if (addonState.packs.length) box.appendChild(el('p', 'muted small-text', "A mod's Settings button appears after the server has started with it once (that's when the mod writes its settings file)."));
  list.appendChild(box);
}

// ---------- mod settings (Valheim: BepInEx config files) ----------
// Each setting can be sent to players: their SF Mod Manager writes the server's value into their own copy of
// the file when it syncs. Needed for player-side settings, such as Server devcommands' automatic god mode for admins.

let msState = null; // { server, data, edits: Map(id -> value), shared: Set(id) }
const msId = (e) => `${e.section}\u0000${e.key}`;
const msSplit = (id) => {
  const [section, key] = id.split('\u0000');
  return { section, key };
};

async function openModSettings(file) {
  let data;
  try {
    data = await api('GET', `${addonApi()}/settings/${encodeURIComponent(file)}`);
  } catch (err) {
    return toast(err.message, true);
  }
  msState = { server: state.selected, data, edits: new Map(), shared: new Set(data.entries.filter((e) => e.shared).map(msId)) };
  $('msFilter').value = '';
  $('msOnlyShared').checked = false;
  renderModSettings();
  $('modSettingsDialog').showModal();
}

function msControl(e, onChange) {
  const cur = msState.edits.get(msId(e)) ?? e.value;
  // Lists, multi-line values...: shown as they are (edit them in the Files tab).
  if (e.editable === false) {
    const ro = el('input');
    ro.value = cur;
    ro.readOnly = true;
    ro.disabled = true;
    ro.title = "Can't be changed here: edit the file in the Files tab.";
    return ro;
  }
  if (e.type === 'Boolean') {
    const lab = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = cur.toLowerCase() === 'true';
    cb.addEventListener('change', () => onChange(cb.checked ? 'true' : 'false'));
    lab.append(cb, document.createTextNode(' On'));
    return lab;
  }
  if (e.options && !e.multi) {
    const sel = el('select');
    for (const o of e.options.includes(cur) ? e.options : [cur, ...e.options]) {
      const opt = el('option', null, o);
      opt.value = o;
      sel.appendChild(opt);
    }
    sel.value = cur;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }
  const input = el('input');
  const numeric = /^(U?Int(16|32|64)?|S?Byte|Single|Double|Decimal)$/.test(e.type ?? '');
  input.type = numeric ? 'number' : 'text';
  if (numeric) {
    input.step = /^(Single|Double|Decimal)$/.test(e.type) ? 'any' : '1';
    if (e.range) {
      input.min = String(e.range.min);
      input.max = String(e.range.max);
    }
  }
  if (e.multi && e.options) input.placeholder = e.options.join(', ');
  input.value = cur;
  input.spellcheck = false;
  input.addEventListener('input', () => onChange(input.value.trim()));
  return input;
}

function msStatus() {
  const changed = msState.edits.size;
  const before = msState.data.entries.filter((e) => e.shared).map(msId);
  const sharedChanged = before.length !== msState.shared.size || before.some((id) => !msState.shared.has(id));
  $('msStatus').textContent = [changed ? `${changed} changed` : '', sharedChanged ? 'players list changed' : '', `${msState.shared.size} sent to players`].filter(Boolean).join(' · ');
  $('msSave').disabled = !changed && !sharedChanged;
  return changed || sharedChanged;
}

function renderModSettings() {
  const { data } = msState;
  // Valheim settings can be sent to players; Minecraft ones can't. Some formats have settings that can't be edited here.
  const canShare = data.canShare !== false;
  $('msShareHelp').hidden = !canShare;
  $('msOnlySharedRow').hidden = !canShare;
  $('msReadOnlyHelp').hidden = !data.entries.some((e) => e.editable === false);
  $('msTitle').textContent = `${data.plugin ?? data.file} settings`;
  $('msSub').textContent = [data.version ? `v${data.version}` : null, data.file.includes('/') ? data.file : `BepInEx/config/${data.file}`].filter(Boolean).join(' · ');
  const body = $('msBody');
  body.innerHTML = '';
  const q = $('msFilter').value.trim().toLowerCase();
  const onlyShared = $('msOnlyShared').checked;
  let section = null;
  let shown = 0;
  for (const e of data.entries) {
    const id = msId(e);
    if (onlyShared && !msState.shared.has(id)) continue;
    if (q && !`${e.section} ${e.key} ${e.description}`.toLowerCase().includes(q)) continue;
    if (e.section !== section) {
      section = e.section;
      body.appendChild(el('h4', 'ms-section', section));
    }
    shown++;
    const row = el('div', 'ms-row');
    const mark = () => {
      row.classList.toggle('changed', msState.edits.has(id));
      row.classList.toggle('shared', msState.shared.has(id));
    };
    const info = el('div', 'ms-info');
    const name = el('div', 'ms-key', e.key);
    if (e.type) name.appendChild(el('span', 'type-badge', e.type));
    info.appendChild(name);
    if (e.description) info.appendChild(el('div', 'muted small-text ms-desc', e.description));
    const hints = [e.default != null ? `Default: ${e.default === '' ? '(empty)' : e.default}` : null, e.range ? `${e.range.min} to ${e.range.max}` : null, e.multi && e.options ? 'several allowed, separated by ", "' : null];
    info.appendChild(el('div', 'muted small-text', hints.filter(Boolean).join(' · ')));
    row.appendChild(info);
    row.appendChild(
      msControl(e, (v) => {
        if (v === e.value) msState.edits.delete(id);
        else msState.edits.set(id, v);
        mark();
        msStatus();
      }),
    );
    const share = el('label', 'toggle ms-share');
    share.title = "Players' SF Mod Manager sets this to the server's value in their own game every time it syncs.";
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = msState.shared.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) msState.shared.add(id);
      else msState.shared.delete(id);
      mark();
      msStatus();
    });
    share.append(cb, document.createTextNode(' To players'));
    share.hidden = !canShare;
    row.appendChild(share);
    mark();
    body.appendChild(row);
  }
  if (!shown) body.appendChild(el('p', 'muted', data.entries.length ? 'No settings match.' : 'This file has no settings.'));
  msStatus();
}

$('msFilter').addEventListener('input', renderModSettings);
$('msOnlyShared').addEventListener('change', renderModSettings);
async function closeModSettings(e) {
  if (msStatus()) {
    // Esc (the dialog's cancel event) has to be stopped now; the dialog closes below if they confirm.
    e?.preventDefault();
    if (!(await confirmBox('Close without saving your changes?', 'Close'))) return;
  }
  $('modSettingsDialog').close();
}
$('msCancel').addEventListener('click', () => closeModSettings());
$('modSettingsDialog').addEventListener('cancel', (e) => closeModSettings(e));
$('msSave').addEventListener('click', async () => {
  const values = [...msState.edits].map(([id, value]) => ({ ...msSplit(id), value }));
  const shared = [...msState.shared].map(msSplit);
  $('msSave').disabled = true;
  try {
    const r = await api('PUT', `/api/servers/${msState.server}/addons/settings/${encodeURIComponent(msState.data.file)}`, { values, shared });
    msState.data = r;
    msState.edits.clear();
    msState.shared = new Set(r.entries.filter((e) => e.shared).map(msId));
    if (msState.server === state.selected) {
      addonState.settingsFiles = r.files;
      renderAddons();
      if (values.length) noteRestart();
    }
    renderModSettings();
    toast(values.length && r.running ? 'Saved. Restart the server to use the new settings.' : 'Settings saved');
  } catch (err) {
    toast(err.message, true);
    msStatus();
  }
});

// ---------- load order (Bedrock) ----------
// Bedrock loads a world's packs in the order of world_resource_packs.json / world_behavior_packs.json. Like the game's
// "Active" list, the top has the highest priority: where two packs change the same thing, the higher one wins.

let packDrag = null; // { id, type }

function renderOrderedAddons(list) {
  const canEdit = hasPerm('addons.manage');
  // Behavior and resource packs side by side, each in its own load order.
  const cols = el('div', 'order-cols');
  list.appendChild(cols);
  for (const type of ['behavior', 'resource']) {
    const active = addonState.packs.filter((p) => p.type === type && p.enabled).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const col = el('div', 'order-col');
    cols.appendChild(col);
    const head = el('div', 'order-head');
    head.appendChild(el('h4', null, `Active ${type} packs`));
    head.appendChild(el('span', 'muted small-text', canEdit && active.length > 1 ? 'Top wins: drag or use the arrows.' : 'Top wins, like Bedrock’s Active list.'));
    col.appendChild(head);
    if (!active.length) col.appendChild(el('p', 'muted small-text', `No ${type} packs switched on.`));
    active.forEach((p, i) => {
      const row = addonRow(p, true);
      row.classList.add('ordered');
      const rank = el('div', 'order-rank');
      rank.appendChild(el('span', 'order-num', String(i + 1)));
      if (canEdit && active.length > 1) {
        const up = el('button', 'small ghost order-btn', '▲');
        up.title = 'Higher priority';
        up.disabled = i === 0;
        up.addEventListener('click', () => movePackOrder(type, active, i, i - 1));
        const down = el('button', 'small ghost order-btn', '▼');
        down.title = 'Lower priority';
        down.disabled = i === active.length - 1;
        down.addEventListener('click', () => movePackOrder(type, active, i, i + 1));
        rank.append(up, down);
        enablePackDrag(row, p, type, active);
      }
      row.prepend(rank);
      col.appendChild(row);
    });
  }
  const inactive = addonState.packs.filter((p) => !p.enabled);
  if (inactive.length) {
    const head = el('div', 'order-head');
    head.appendChild(el('h4', null, 'Not active'));
    head.appendChild(el('span', 'muted small-text', 'Switched off in this world. Turning one on puts it at the top.'));
    list.appendChild(head);
    for (const p of inactive) list.appendChild(addonRow(p));
  }
}

async function savePackOrder(type, ids) {
  try {
    const r = await api('PUT', `${addonApi()}/order`, { type, ids });
    addonState.packs = r.packs;
    renderAddons();
    noteRestart();
  } catch (err) {
    toast(err.message, true);
    loadAddons();
  }
}

function movePackOrder(type, active, from, to) {
  const ids = active.map((p) => p.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  savePackOrder(type, ids);
}

function enablePackDrag(row, p, type, active) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    // Let text fields and buttons inside the row behave normally.
    if (e.target.closest('button, select, input, label')) return e.preventDefault();
    packDrag = { id: p.id, type };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', p.id);
  });
  row.addEventListener('dragend', () => {
    packDrag = null;
    row.classList.remove('dragging');
    for (const n of document.querySelectorAll('#addonList .drop-before, #addonList .drop-after')) n.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('dragover', (e) => {
    if (!packDrag || packDrag.type !== type || packDrag.id === p.id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    for (const n of document.querySelectorAll('#addonList .drop-before, #addonList .drop-after')) n.classList.remove('drop-before', 'drop-after');
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  row.addEventListener('drop', (e) => {
    if (!packDrag || packDrag.type !== type || packDrag.id === p.id) return;
    e.preventDefault();
    const after = row.classList.contains('drop-after');
    const ids = active.map((x) => x.id).filter((id) => id !== packDrag.id);
    ids.splice(ids.indexOf(p.id) + (after ? 1 : 0), 0, packDrag.id);
    packDrag = null;
    savePackOrder(type, ids);
  });
}

/** compact: the narrower layout used in the side-by-side load-order columns (Bedrock). */
function addonRow(p, compact = false) {
  const row = el('div', `addon${p.enabled ? '' : ' off'}${compact ? ' compact' : ''}`);
  const packUrl = `${addonApi()}/${encodeURIComponent(p.id ?? p.uuid)}`;
  // Its own icon if it has one, otherwise a coloured letter tile (most plugins ship without an icon).
  const letter = () => {
    const tile = letterHead(p.name);
    tile.classList.add('addon-icon');
    return tile;
  };
  if (p.hasIcon) {
    const icon = el('img', 'addon-icon');
    icon.alt = '';
    icon.src = `${packUrl}/icon`;
    icon.addEventListener('error', () => icon.replaceWith(letter()), { once: true });
    row.appendChild(icon);
  } else row.appendChild(letter());
  const info = el('div', 'info');
  const name = el('div', 'name');
  const nameText = el('span', 'name-text', p.name);
  nameText.title = p.name;
  name.appendChild(nameText);
  // In the load-order columns the column already says behavior/resource.
  if (!compact) name.appendChild(el('span', `type-badge ${p.typeClass ?? p.type}`, p.typeLabel ?? (p.type === 'behavior' ? 'Behavior pack' : 'Resource pack')));
  if (p.location) name.appendChild(el('span', `type-badge loc-${p.location}`, compact ? (p.location === 'world' ? 'World' : 'Server') : locationLabel(p.location)));
  // Incompatible items are installed switched off, but the owner can still force them on.
  const incompatible = p.warnings?.some((w) => w.level === 'error');
  if (incompatible) name.appendChild(el('span', `type-badge ${p.enabled ? 'forced' : 'bad'}`, p.enabled ? 'Forced on' : 'Incompatible'));
  // Bedrock: linked to a CurseForge project (for update checks).
  if (p.curseforge && !compact) {
    const cf = el('a', 'type-badge curseforge', 'CurseForge');
    cf.title = `Updates come from CurseForge: ${p.curseforge.name}`;
    if (p.curseforge.url) {
      cf.href = p.curseforge.url;
      cf.target = '_blank';
      cf.rel = 'noopener';
    }
    name.appendChild(cf);
  }
  info.appendChild(name);
  if (p.description) {
    const desc = el('div', 'sub desc', p.description);
    desc.title = p.description;
    info.appendChild(desc);
  }
  const version = Array.isArray(p.version) ? p.version.join('.') : p.version;
  const source = compact && p.source ? p.source.replace(/^upload: /, '') : p.source;
  const meta = [version ? `v${version}` : null, p.mcRange ? `for MC ${p.mcRange}` : null, p.authors ? `by ${p.authors}` : null, compact ? null : p.uuid ?? p.file, source].filter(Boolean);
  const metaLine = el('div', 'sub meta', meta.join(' · '));
  metaLine.title = [p.uuid ?? p.file, p.source].filter(Boolean).join('\n');
  info.appendChild(metaLine);
  for (const w of p.warnings ?? []) info.appendChild(el('div', `sub ${w.level === 'error' ? 'error-text' : 'warn-text'}`, `${w.level === 'error' ? '⛔' : '⚠'} ${w.text}`));
  if (p.duplicate) info.appendChild(el('div', 'sub warn-text', 'This pack is in both the server folder and the world folder. Remove one copy so it only loads once.'));
  row.appendChild(info);
  const actions = el('div', 'actions');
  // Managed by another tool (Satisfactory Mod Manager): just a link to the mod's page, whose Install button opens SMM.
  if (addonState.readOnly && p.url) {
    const page = el('a', 'small button-like', 'On ficsit.app');
    page.href = p.url;
    page.target = '_blank';
    page.rel = 'noopener';
    page.title = 'The mod’s page. Its Install button opens Satisfactory Mod Manager.';
    actions.appendChild(page);
  }
  if (hasPerm('addons.manage') && !addonState.readOnly) {
    // Newer version found by "Check for updates".
    const newer = addonUpdates[p.id];
    if (newer) {
      const up = el('button', 'small primary', `Update to ${newer}`);
      up.addEventListener('click', async () => {
        up.disabled = true;
        up.textContent = 'Updating…';
        try {
          const r = await api('POST', `${packUrl}/update`);
          delete addonUpdates[p.id];
          // Bedrock: the other packs from the same CurseForge project were updated with it.
          if (p.curseforge) for (const q of addonState.packs) if (q.curseforge?.projectId === p.curseforge.projectId) delete addonUpdates[q.id];
          addonState.packs = r.packs;
          showInstallResult(r);
          renderAddons();
        } catch (err) {
          toast(err.message, true);
          up.disabled = false;
          up.textContent = `Update to ${newer}`;
        }
      });
      actions.appendChild(up);
    }
    // Bedrock: link to a CurseForge project (so updates can be found), or remove the link.
    if (state.detail.game === 'bedrock' && addonKind === 'addons' && !compact) {
      const link = el('button', 'small ghost', p.curseforge ? 'Unlink' : 'Link to CurseForge…');
      link.title = p.curseforge ? `Stop checking ${p.curseforge.name} on CurseForge for updates` : 'Find this addon on CurseForge so Server Forge can update it';
      link.addEventListener('click', () => (p.curseforge ? unlinkCurseforge(p, packUrl) : linkCurseforge(p, packUrl)));
      actions.appendChild(link);
    }
    // Its settings files (Valheim: BepInEx/config; Minecraft: config/ or plugins/<name>/), once the mod has written them.
    const cfgs = compact ? [] : (addonState.settingsFiles ?? []).filter((f) => f.mod === p.id);
    if (cfgs.length) {
      const shared = cfgs.reduce((n, f) => n + (f.shared || 0), 0);
      const b = el('button', 'small ghost', shared ? `Settings · ${shared} to players` : cfgs.length > 1 ? `Settings (${cfgs.length})` : 'Settings');
      b.title = cfgs.map((f) => f.file).join('\n');
      b.addEventListener('click', async () => {
        const f = cfgs.length === 1 ? cfgs[0] : await pick(`${p.name} settings`, 'Which settings file?', cfgs, (x) => ({ title: x.plugin ?? x.file, sub: x.file }));
        if (f) openModSettings(f.file);
      });
      actions.appendChild(b);
    }
    // Who needs it (Valheim): server + players / server only / players only.
    if (addonState.sides && p.side) {
      const sel = el('select', 'side-select');
      sel.title = p.sideHelp ?? '';
      for (const o of addonState.sides) {
        const opt = el('option', null, o.label);
        opt.value = o.value;
        sel.appendChild(opt);
      }
      sel.value = p.side;
      sel.addEventListener('change', async () => {
        try {
          addonState.packs = (await api('POST', `${packUrl}/side`, { side: sel.value })).packs;
          renderAddons();
        } catch (err) {
          toast(err.message, true);
          sel.value = p.side;
        }
      });
      actions.appendChild(sel);
    }
  }
  if (hasPerm('addons.manage') && !p.readOnly) {
    const lab = el('label', 'toggle');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = p.enabled;
    const setOn = async (on) => {
      // Turning on something flagged as incompatible: say why, and let the owner decide.
      if (on && incompatible) {
        const why = p.warnings.filter((w) => w.level === 'error').map((w) => `• ${w.text}`).join('\n');
        if (!await confirmBox(`"${p.name}" is marked incompatible with this server:\n\n${why}\n\nIt may not work, or may stop the server from starting (you can switch it off again here). Force it on anyway?`)) {
          cb.checked = false;
          return;
        }
      }
      try {
        addonState.packs = (await api('POST', `${packUrl}/enabled`, { enabled: on })).packs;
        renderAddons();
        noteRestart();
        if (on && incompatible) toast(`"${p.name}" forced on`);
      } catch (err) {
        toast(err.message, true);
        cb.checked = !on;
      }
    };
    cb.addEventListener('change', () => setOn(cb.checked));
    lab.append(cb, document.createTextNode(' On'));
    if (incompatible && !p.enabled) {
      const force = el('button', 'small force', 'Force on');
      force.title = 'Turn it on even though it looks incompatible with this server';
      force.addEventListener('click', () => setOn(true));
      actions.append(force);
    }
    const rm = el('button', 'small red ghost', 'Remove');
    rm.addEventListener('click', async () => {
      const msg = p.duplicate
        ? `Remove the copy of "${p.name}" in the ${locationLabel(p.location).toLowerCase()}? The other copy stays installed.`
        : p.location
          ? `Remove "${p.name}"? Its files are deleted and it's taken out of the world.`
          : `Remove "${p.name}"? The file ${p.file} is deleted from the server.`;
      if (!await confirmBox(msg)) return;
      try {
        addonState.packs = (await api('DELETE', packUrl)).packs;
        renderAddons();
        noteRestart();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(lab);
    if (addonState.locations && p.location) {
      const other = addonState.locations.options.find((o) => o.value !== p.location);
      const mv = el('button', 'small', `Move to ${other.label.toLowerCase()}`);
      mv.title = other.help;
      mv.addEventListener('click', async () => {
        try {
          addonState.packs = (await api('POST', `${packUrl}/move`, { to: other.value })).packs;
          renderAddons();
          noteRestart();
          toast(`Moved "${p.name}" to the ${other.label.toLowerCase()}`);
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.append(mv);
    }
    actions.append(rm);
  } else if (hasPerm('addons.manage') && p.readOnly) {
    // Added by hand outside Server Forge: can only be removed.
    const rm = el('button', 'small red ghost', 'Remove');
    rm.addEventListener('click', async () => {
      if (!await confirmBox(`Remove "${p.name}" from BepInEx/plugins?`)) return;
      try {
        addonState.packs = (await api('DELETE', packUrl)).packs;
        renderAddons();
      } catch (err) {
        toast(err.message, true);
      }
    });
    actions.append(rm);
  }
  row.appendChild(actions);
  return row;
}

function noteRestart() {
  $('addonRestart').hidden = !['running', 'starting'].includes(state.detail.status);
}

$('nexusForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('nexusInput').value.trim();
  if (!input) return;
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const hexium = /hexium\.gg\//i.test(input);
    const result = await api('POST', `${addonApi()}/${hexium ? 'hexium' : 'nexus'}`, { input });
    $('nexusInput').value = '';
    toast(`Installed from ${hexium ? 'Hexium' : 'Nexus Mods'}`);
    showInstallResult(result);
    loadAddons().then(noteRestart);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Install';
  }
});

function showInstallResult(result) {
  const box = el('div', 'result-box');
  const ul = el('ul');
  for (const p of result.installed) ul.appendChild(el('li', null, `${{ installed: 'Installed', updated: 'Updated', reinstalled: 'Reinstalled' }[p.action.replace('-off', '')] ?? 'Installed'}${p.action.endsWith('-off') ? ' (switched off)' : ''} ${p.name} (${['behavior', 'resource'].includes(p.type) ? `${p.type} pack` : p.type}${p.version ? `, v${p.version}` : ''})`));
  box.appendChild(ul);
  for (const w of result.warnings) box.appendChild(el('div', 'warn-banner', w));
  if (result.running) box.appendChild(el('div', 'muted small-text', `Restart the server to load the new ${addonKind === 'plugins' ? 'plugins' : 'packs'}.`));
  $('addonResult').prepend(box);
}

async function uploadAddon(file) {
  const res = await fetch(`${addonApi()}/upload`, {
    method: 'POST',
    headers: { 'X-Panel': '1', 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data;
}

async function uploadAddons(files) {
  for (const file of files) {
    toast(`Installing ${file.name}…`);
    try {
      showInstallResult(await uploadAddon(file));
    } catch (err) {
      const box = el('div', 'result-box');
      box.appendChild(el('div', 'error', `${file.name}: ${err.message}`));
      $('addonResult').prepend(box);
    }
  }
  await loadAddons();
  noteRestart();
}

$('addonFile').addEventListener('change', () => {
  uploadAddons([...$('addonFile').files]);
  $('addonFile').value = '';
});
for (const evt of ['dragenter', 'dragover']) {
  $('addonDrop').addEventListener(evt, (e) => {
    e.preventDefault();
    $('addonDrop').classList.add('over');
  });
}
for (const evt of ['dragleave', 'drop']) $('addonDrop').addEventListener(evt, () => $('addonDrop').classList.remove('over'));
$('addonDrop').addEventListener('drop', async (e) => {
  e.preventDefault();
  // Folders (unpacked packs) come through as directory entries; plain files go the usual way.
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  const dirs = entries.filter((x) => x.isDirectory);
  if (!dirs.length) return uploadAddons([...e.dataTransfer.files]);
  if (!addonState.folders) return toast(`Drop the packed file here (${addonState.accept}), not a folder.`, true);
  const files = await Promise.all(entries.filter((x) => !x.isDirectory).map((x) => new Promise((resolve, reject) => x.file(resolve, reject))));
  for (const dir of dirs) {
    try {
      toast(`Reading ${dir.name}…`);
      await uploadFolder(dir.name, await readFolderEntry(dir, dir.name));
    } catch (err) {
      folderError(dir.name, err);
    }
  }
  if (files.length) await uploadAddons(files);
  else {
    await loadAddons();
    noteRestart();
  }
});

// "choose a folder": every file comes with its path inside the chosen folder.
$('addonFolder').addEventListener('change', async () => {
  const chosen = [...$('addonFolder').files];
  $('addonFolder').value = '';
  if (!chosen.length) return;
  const name = chosen[0].webkitRelativePath.split('/')[0] || 'folder';
  try {
    await uploadFolder(name, chosen.map((file) => ({ path: file.webkitRelativePath || file.name, file })));
  } catch (err) {
    folderError(name, err);
  }
  await loadAddons();
  noteRestart();
});

function folderError(name, err) {
  const box = el('div', 'result-box');
  box.appendChild(el('div', 'error', `${name}: ${err.message}`));
  $('addonResult').prepend(box);
}

/** Every file under a dropped folder, as { path: "Folder/sub/file", file }. */
async function readFolderEntry(dir, prefix) {
  const out = [];
  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const all = [];
      // readEntries returns results in batches; keep asking until it returns none.
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
      next();
    });
  for (const entry of await readAll(dir.createReader())) {
    const p = `${prefix}/${entry.name}`;
    if (entry.isDirectory) out.push(...(await readFolderEntry(entry, p)));
    else out.push({ path: p, file: await new Promise((resolve, reject) => entry.file(resolve, reject)) });
  }
  return out;
}

/**
 * Sends a folder as one upload: 4-byte length of a JSON list of {path, size}, then the files' bytes in that order.
 * The panel rebuilds the folder and installs it like a packed addon.
 */
async function uploadFolder(name, files) {
  if (!files.length) throw new Error('That folder is empty.');
  const total = files.reduce((n, f) => n + f.file.size, 0);
  if (total > 512 * 1024 * 1024) throw new Error('That folder is larger than 512 MB.');
  const header = new TextEncoder().encode(JSON.stringify({ files: files.map((f) => ({ path: f.path, size: f.file.size })) }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  toast(`Installing ${name}…`);
  const res = await fetch(`${addonApi()}/upload-folder`, {
    method: 'POST',
    headers: { 'X-Panel': '1', 'X-Filename': encodeURIComponent(`${name}.folder`), 'Content-Type': 'application/octet-stream' },
    body: new Blob([len, header, ...files.map((f) => f.file)]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  showInstallResult(data);
}

// Endstone plugins: search GitHub and PyPI through the server, install with one click.
$('pluginSearchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('pluginResults');
  box.innerHTML = '';
  box.appendChild(el('p', 'muted', 'Searching GitHub and PyPI…'));
  let found;
  try {
    found = await api('GET', `${addonApi()}/search?q=${encodeURIComponent($('pluginQuery').value)}`);
  } catch (err) {
    box.innerHTML = '';
    return toast(err.message, true);
  }
  box.innerHTML = '';
  for (const msg of found.errors) box.appendChild(el('p', 'warn-banner', msg));
  if (!found.results.length) box.appendChild(el('p', 'muted', 'Nothing found.'));
  const installed = new Set(addonState.packs.map((p) => p.id));
  for (const r of found.results) {
    const item = el('div', 'cf-item');
    const tile = letterHead(r.name);
    tile.classList.add('addon-icon');
    item.appendChild(tile);
    const info = el('div');
    info.appendChild(el('div', 'name', r.name));
    info.appendChild(el('div', 'meta', [r.source, r.version ? `v${r.version}` : null, r.author ? `by ${r.author}` : null, r.stars ? `★ ${r.stars}` : null].filter(Boolean).join(' · ')));
    if (r.summary) info.appendChild(el('div', 'summary', r.summary));
    const row = el('div', 'with-button');
    const already = r.id.startsWith('pypi:') && installed.has(r.id.slice(5));
    const install = el('button', 'small primary', already ? 'Reinstall' : 'Install');
    install.addEventListener('click', async () => {
      install.disabled = true;
      install.textContent = 'Installing…';
      try {
        const result = await api('POST', `${addonApi()}/found`, { id: r.id });
        showInstallResult(result);
        addonState.packs = result.packs;
        renderAddons();
        noteRestart();
        install.textContent = 'Installed';
      } catch (err) {
        toast(err.message, true);
        install.disabled = false;
        install.textContent = already ? 'Reinstall' : 'Install';
      }
    });
    row.appendChild(install);
    const page = el('a', 'small button-like', r.source === 'GitHub' ? 'On GitHub' : 'On PyPI');
    page.href = r.url;
    page.target = '_blank';
    page.rel = 'noopener';
    row.appendChild(page);
    info.appendChild(row);
    item.appendChild(info);
    box.appendChild(item);
  }
});

$('cfForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('cfResults');
  box.innerHTML = '';
  box.appendChild(el('p', 'muted', 'Searching…'));
  try {
    const { results } = await api('GET', `${addonApi()}/curseforge/search?q=${encodeURIComponent($('cfQuery').value)}`);
    box.innerHTML = '';
    if (!results.length) box.appendChild(el('p', 'muted', 'Nothing found.'));
    for (const r of results) {
      const item = el('div', 'cf-item');
      const img = el('img');
      img.alt = '';
      if (r.thumbnail) img.src = r.thumbnail;
      item.appendChild(img);
      const info = el('div');
      info.appendChild(el('div', 'name', r.name));
      info.appendChild(el('div', 'meta', `${r.author ? `by ${r.author} · ` : ''}${r.downloads.toLocaleString()} downloads`));
      info.appendChild(el('div', 'summary', r.summary));
      const row = el('div', 'with-button');
      const install = el('button', 'small primary', 'Install');
      install.addEventListener('click', async () => {
        install.disabled = true;
        install.textContent = 'Installing…';
        try {
          const result = await api('POST', `${addonApi()}/curseforge`, { projectId: r.id });
          if (result.needsBrowser) {
            toast(result.message);
            if (result.url) window.open(result.url, '_blank');
          } else {
            showInstallResult(result);
            await loadAddons();
            noteRestart();
          }
        } catch (err) {
          toast(err.message, true);
        } finally {
          install.disabled = false;
          install.textContent = 'Install';
        }
      });
      row.appendChild(install);
      if (r.url) {
        const open = el('a', 'small-text', 'View on CurseForge');
        open.href = r.url;
        open.target = '_blank';
        open.rel = 'noopener';
        row.appendChild(open);
      }
      info.appendChild(row);
      item.appendChild(info);
      box.appendChild(item);
    }
  } catch (err) {
    box.innerHTML = '';
    box.appendChild(el('p', 'error', err.message));
  }
});

// Nexus Mods / CurseForge keys (Settings → Integrations, owner only)
async function loadIntegrations() {
  $('integrationsCard').hidden = false;
  $('cfIntegration').hidden = !CURSEFORGE_UI;
  const { curseforge, nexus, factorio } = await api('GET', '/api/settings/integrations');
  renderFactorioLogin(factorio);
  $('nexusKeyStatus').textContent = nexus ? `Linked to Nexus Mods as ${nexus.name}${nexus.premium ? ' (Premium: mod page addresses work too)' : ' (free account: use "Mod Manager Download" links or Manual download)'}.` : 'No key saved. Nexus Mods zips can still be installed by dropping them in the Mods tab.';
  $('nexusKey').value = '';
  $('cfKeyStatus').textContent = curseforge ? 'A CurseForge key is saved. CurseForge browsing is on.' : 'No key saved. CurseForge browsing is off.';
  $('cfKey').value = '';
}
$('btnSaveNexusKey').addEventListener('click', async () => {
  const key = $('nexusKey').value.trim();
  if (!key) return toast('Paste the key first', true);
  try {
    const r = await api('PUT', '/api/settings/integrations', { nexusKey: key });
    toast(`Nexus Mods linked as ${r.nexus?.name ?? 'your account'}`);
    loadIntegrations();
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnRemoveNexusKey').addEventListener('click', async () => {
  try {
    await api('PUT', '/api/settings/integrations', { nexusKey: '' });
    toast('Nexus Mods key removed');
    loadIntegrations();
  } catch (err) {
    toast(err.message, true);
  }
});
// factorio.com login (Factorio servers and the mod portal): pasted, or imported from the game on this PC.
function renderFactorioLogin(f) {
  if (!f) return;
  $('factorioStatus').textContent = f.linked
    ? `Linked as ${f.username}${f.spaceAge ? ' (owns Space Age)' : ' (base game; this account doesn\'t own Space Age)'}.`
    : `No login saved. Factorio servers can't be installed or updated until one is.${f.canImport ? ' Factorio is logged in on this PC: "Import from this PC" takes that login.' : ''}`;
  $('btnImportFactorio').hidden = !f.canImport;
  $('factorioUser').value = '';
  $('factorioToken').value = '';
}
async function saveFactorio(method, url, body, btn) {
  btn.disabled = true;
  try {
    const f = await api(method, url, body);
    renderFactorioLogin(f);
    toast(f.linked ? `Factorio linked as ${f.username}` : 'Factorio login removed');
  } catch (err) {
    toast(err.message, true);
  }
  btn.disabled = false;
}
$('btnSaveFactorio').addEventListener('click', (e) => {
  const username = $('factorioUser').value.trim();
  const token = $('factorioToken').value.trim();
  if (!username || !token) return toast('Enter your factorio.com username and token', true);
  saveFactorio('PUT', '/api/settings/integrations/factorio', { username, token }, e.currentTarget);
});
$('btnImportFactorio').addEventListener('click', (e) => saveFactorio('POST', '/api/settings/integrations/factorio/import', undefined, e.currentTarget));
$('btnRemoveFactorio').addEventListener('click', (e) => saveFactorio('PUT', '/api/settings/integrations/factorio', { username: '', token: '' }, e.currentTarget));

$('btnSaveCfKey').addEventListener('click', async () => {
  try {
    await api('PUT', '/api/settings/integrations', { curseforgeKey: $('cfKey').value });
    toast('CurseForge key saved');
    loadIntegrations();
  } catch (err) {
    toast(err.message, true);
  }
});
$('btnRemoveCfKey').addEventListener('click', async () => {
  try {
    await api('PUT', '/api/settings/integrations', { curseforgeKey: '' });
    toast('CurseForge key removed');
    loadIntegrations();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- colour theme (hue picker, bottom-left) ----------

const DEFAULT_HUE = 214; // vibrant blue
const LOGO_HUE = 214; // the logo is drawn in the default blue; recolouring turns it by the difference from this
const PRESET_HUES = [214, 32, 0, 50, 95, 145, 185, 265, 300, 330];
let logoImage = null;

function loadHue() {
  try {
    const v = Number(localStorage.getItem('th-hue'));
    return Number.isFinite(v) && localStorage.getItem('th-hue') !== null ? v : DEFAULT_HUE;
  } catch {
    return DEFAULT_HUE;
  }
}

// ---------- live icon: the four drive bays in the logo show the first four servers' status ----------

let logoSvg = null;
let blinkOn = true;
const LIGHT = { green: '#4ade80', greenDim: '#1f6b3a', blue: '#60a5fa', amber: '#fbbf24', amberDim: '#6b4a10', red: '#ef4444', off: '#16264a' };

/** Power + activity light colours for a server status (blinkOn flips every tick for the blinking ones). */
function bayLights(status) {
  switch (status) {
    case 'running':
      return [LIGHT.green, blinkOn ? LIGHT.green : LIGHT.greenDim];
    case 'starting':
    case 'stopping':
      return [blinkOn ? LIGHT.amber : LIGHT.amberDim, LIGHT.off];
    case 'installing':
      return [LIGHT.blue, blinkOn ? LIGHT.blue : LIGHT.off];
    case 'crashed':
      return [LIGHT.red, LIGHT.off];
    default:
      return [LIGHT.off, LIGHT.off];
  }
}

/** The first four servers as the sidebar shows them (sections, then servers, in your saved order): bay 1 = the top one. */
function iconServers() {
  const byPos = [...state.servers.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const games = [...new Set(byPos.map((s) => s.game))];
  return games.flatMap((g) => byPos.filter((s) => s.game === g)).slice(0, 4);
}

/** Moves a #rgb/#rrggbb colour round the colour wheel by `delta` degrees (true HSL, like the theme's own colours). */
function shiftHex(hex, delta) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return hex; // grey: nothing to turn
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (((hue * 60 + delta) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return `#${[r1, g1, b1].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The logo turned to the theme hue: every colour except the drive-bay lights (those show server status). */
function recolourSvg(svg, hue) {
  const delta = hue - LOGO_HUE;
  if (!delta) return svg;
  return svg
    .split(/(<[^>]*id="bay\d[pa]"[^>]*>)/)
    .map((part) => (/id="bay\d[pa]"/.test(part) ? part : part.replace(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi, (m) => shiftHex(m, delta))))
    .join('');
}

/** Renders the logo with live lights, recoloured to the hue: favicon + (desktop app) window/taskbar icon. */
async function recolouredIcon(hue) {
  if (logoSvg === null) logoSvg = await (await fetch('/logo.svg')).text();
  let svg = recolourSvg(logoSvg, hue);
  // Before logging in (no server list yet) the logo keeps its normal lights.
  if (state.user) {
    const servers = iconServers();
    for (let i = 0; i < 4; i++) {
      const [p, a] = bayLights(servers[i]?.status ?? 'none');
      svg = svg.replace(new RegExp(`(id="bay${i + 1}p"[^>]*fill=")[^"]*"`), `$1${p}"`).replace(new RegExp(`(id="bay${i + 1}a"[^>]*fill=")[^"]*"`), `$1${a}"`);
    }
  }
  logoImage = new Image();
  logoImage.src = `data:image/svg+xml;base64,${btoa(svg)}`;
  await logoImage.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  // Already recoloured above (no canvas filter: it's only an approximation, turns the lights too, and Safari ignores it).
  canvas.getContext('2d').drawImage(logoImage, 0, 0, 256, 256);
  return canvas.toDataURL('image/png');
}

// Header logo, animated (the hammer strikes the rack) only in Neon glass with animation on: Classic, and so server
// PCs, keep the still picture and pay nothing for it. It's inline SVG so the live lights can change without
// restarting the animation (a new <img> src would start it over every blink).
let animLogo = null;
function animatedLogoWanted() {
  const c = document.documentElement.classList;
  return c.contains('neon') && !c.contains('neon-still') && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}
async function refreshBrandAnim(hue) {
  const brand = $('brandLogo');
  if (!brand) return;
  let box = $('brandAnim');
  if (!animatedLogoWanted()) {
    box?.remove();
    brand.hidden = false;
    return;
  }
  if (animLogo === null) animLogo = await (await fetch('/logo-animated.svg')).text();
  // Mode changes/icon refreshes can overlap while the SVG loads. Re-read the
  // current element so two pending refreshes cannot create duplicate logos.
  box = $('brandAnim');
  if (!animatedLogoWanted()) {
    box?.remove();
    brand.hidden = false;
    return;
  }
  if (!box || box.dataset.hue !== String(hue)) {
    // ids prefixed so they can't clash with any other SVG on the page
    const svg = recolourSvg(animLogo, hue).replace(/id="([^"]+)"/g, 'id="sf-$1"').replace(/url\(#([^)]+)\)/g, 'url(#sf-$1)');
    if (!box) {
      box = document.createElement('div'); // not a <span>: applyPanelName writes the name into the header's span
      box.id = 'brandAnim';
      box.className = 'brand-anim';
      box.setAttribute('aria-hidden', 'true');
      brand.after(box);
    }
    box.innerHTML = svg;
    box.dataset.hue = String(hue);
  }
  brand.hidden = true;
  if (state.user) {
    const servers = iconServers();
    for (let i = 0; i < 4; i++) {
      const [p, a] = bayLights(servers[i]?.status ?? 'none');
      box.querySelector(`#sf-bay${i + 1}p`)?.setAttribute('fill', p);
      box.querySelector(`#sf-bay${i + 1}a`)?.setAttribute('fill', a);
    }
  }
  // Window hidden (appearance.js sets neon-paused): hold the hammer still too.
  const svgEl = box.querySelector('svg');
  if (document.documentElement.classList.contains('neon-paused')) svgEl?.pauseAnimations();
  else svgEl?.unpauseAnimations();
}

let lastIcon = '';
async function refreshIcon() {
  try {
    // (Hue 0 is red, a real choice: only fall back when the value isn't a number.)
    const picked = Number($('themeHue').value);
    const hue = Number.isFinite(picked) && $('themeHue').value !== '' ? picked : DEFAULT_HUE;
    await refreshBrandAnim(hue).catch(() => {});
    const url = await recolouredIcon(hue);
    if (url === lastIcon) return; // nothing changed (e.g. every server stopped): don't touch the taskbar
    lastIcon = url;
    document.querySelector('link[rel="icon"]').href = url;
    window.desktop?.setIcon?.(url);
    // The header logo shows the same live lights (already recoloured, so no CSS hue filter on it).
    const brand = $('brandLogo');
    if (brand) {
      brand.src = url;
      brand.classList.add('live');
    }
    // Login/setup screens: same exact recolour instead of the CSS hue filter.
    for (const img of document.querySelectorAll('.auth-brand img')) {
      img.src = url;
      img.classList.add('live');
    }
  } catch {}
}
// Blink: flip the lights about once a second.
setInterval(() => {
  blinkOn = !blinkOn;
  refreshIcon();
}, 900);

let iconTimer;
function applyHue(hue, save = true) {
  document.documentElement.style.setProperty('--hue', String(hue));
  $('themeHue').value = String(hue);
  if (save) {
    try {
      localStorage.setItem('th-hue', String(hue));
    } catch {}
  }
  // Updating the icon on every slider step is wasteful; do it once the slider settles.
  clearTimeout(iconTimer);
  iconTimer = setTimeout(refreshIcon, 250);
}

for (const hue of PRESET_HUES) {
  const b = el('button');
  b.type = 'button';
  b.title = hue === DEFAULT_HUE ? 'Default blue' : hue === LOGO_HUE ? 'Tavern amber' : `Hue ${hue}`;
  b.style.background = `hsl(${hue} 84% 55%)`;
  b.addEventListener('click', () => applyHue(hue));
  $('themeSwatches').appendChild(b);
}
$('themeHue').addEventListener('input', () => applyHue(Number($('themeHue').value)));
$('themeReset').addEventListener('click', () => applyHue(DEFAULT_HUE));
$('btnTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  $('themePop').hidden = !$('themePop').hidden;
  $('btnTheme').setAttribute('aria-expanded', String(!$('themePop').hidden));
});
document.addEventListener('click', (e) => {
  if (!$('themePop').hidden && !e.target.closest('.theme-corner')) {
    $('themePop').hidden = true;
    $('btnTheme').setAttribute('aria-expanded', 'false');
  }
});
applyHue(loadHue(), false);

boot().catch((err) => toast(err.message, true));
