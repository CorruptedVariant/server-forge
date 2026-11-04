import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, createWriteStream, createReadStream, statSync, mkdirSync, rmSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { installVcRedist } from './vcredist.ts';
import { curseforgeKey, setCurseforgeKey, searchProjects, latestFile, newestFile } from './curseforge.ts';
import { linkPacks, unlinkPack, getUpdateSettings, setUpdateSettings } from './games/bedrock-addons.ts';
import { listProxyServers, addProxyServer, removeProxyServer, setDefaultProxyServer, proxyName, prepareBackend } from './games/bungee-network.ts';
import { downloadNexus, nexusPackage, NEXUS_GAMES } from './nexus.ts';
import { nexusKey, nexusUser, setNexusKey, NEXUS_APP } from './nexus-key.ts';
import { factorioStatus, setFactorioLogin, importFactorioLogin } from './factorio-key.ts';
import { getDiscord, setDiscord, testDiscord, startDiscordNotifications, NOTIFY_EVENTS } from './discord.ts';
import { downloadFile } from './download.ts';
import { serverStats } from './stats.ts';
import { knownPlayers, setPlayerNote, setPlayerMuted } from './players.ts';
import { listTasks, createTask, updateTask, deleteTask, deleteTasksFor, runTaskNow } from './scheduler.ts';
import { rootDir, readJson, writeJson, dataPath, isDev } from './store.ts';
import * as auth from './auth.ts';
import * as files from './files.ts';
import * as serverFiles from './server-files.ts';
import { listBackups, deleteBackup, backupsFolder, getCopySettings, setCopySettings, testCopyFolder, listCopies, copyFolderFor, copyAllToOffsite, bringBackCopy } from './backups.ts';
import { applyRemote, remoteStatus, addFirewallRule, certFingerprint, type RemoteConfig } from './remote.ts';
import { installFromHexium, ensureHexiumCopy, placeOnServer, adoptManualMods } from './games/valheim-addons.ts';
import { shareManifest, shareSummary, sharedFile, canShare } from './share.ts';
import { parseHexiumUrl, setLoaderEnabled, bepinexStatus } from './valheim-mods.ts';
import { profilesInfo, createProfile, updateProfile, deleteProfile, applyProfile, ensureDefaultProfile } from './games/valheim-profiles.ts';

const vmBepinexInstalled = (dir: string) => bepinexStatus(dir).installed;
import { writeEula } from './games/java-sources.ts';
import {
  can,
  canGlobal,
  permsOn,
  accessSummary,
  GLOBAL_PERMS,
  SERVER_PERMS,
  GLOBAL_PERM_INFO,
  SERVER_PERM_GROUPS,
  SERVER_PERM_INFO,
  PRESETS,
  PRESET_LABELS,
  type Principal,
  type ServerPerm,
  type GlobalPerm,
  type Preset,
} from './permissions.ts';
import { logActivity, readActivity } from './audit.ts';
import { readChat, recordChat } from './chat.ts';
import { cloneServer } from './clone.ts';
import { listNodes, addNode, removeNode, renameNode, getNode, nodeJson, nodeRequest, remoteServers, remoteId, parseRemoteId, isRemoteId, startNodes } from './nodes.ts';
import { checkUpdates, updateInfo, updateGame, startUpdateChecks, updatesSupported, updateKey } from './game-updates.ts';
import { checkAppUpdate, appUpdateInfo, startAppUpdateChecks } from './app-updates.ts';
import { lookupPublicIp } from './public-ip.ts';
import { portHelp } from './port-help.ts';
import { difficultyInfo, setDifficulty } from './difficulty.ts';
import { supportsWorlds, listWorlds, setActiveWorld, exportWorld, importWorld, deleteWorld } from './worlds.ts';
import { listAlerts, dismissAlert, startHealthChecks, type Alert } from './health.ts';
import { vaultState, vaultCall, vaultEvents, vaultUiFile, vaultShim, vaultPage, isViewMethod, UI_FILES as VAULT_UI } from './vault.ts';
import { worldCheckInfo, checkNow, acceptCurrent, startWorldChecks } from './world-check.ts';
import { GAMES, events, loadInstances, listInstances, getInstance, importServer, createNewServer, updateServer, deleteServer, reorderServers } from './instances.ts';

interface PanelConfig {
  port: number;
  remote: RemoteConfig;
  /** Storage (Tavern Vault): off until turned on in Settings. Covers showing it here and sharing it with a main panel. */
  storage: { enabled: boolean };
}

// The local listener is always on and only reachable from this system. Remote access adds an HTTPS listener.
const saved = readJson<Partial<PanelConfig>>('config.json', {});
const config: PanelConfig = { port: saved.port ?? 8190, remote: { enabled: false, port: 8191, ...saved.remote }, storage: { enabled: false, ...saved.storage } };
writeJson('config.json', config);

const publicDir = path.join(rootDir, 'public');
const COOKIE = 'panel_session';
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- helpers ----------

function cookies(req: http.IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  principal: Principal | null;
  user: auth.User | null;
  params: string[];
  token?: string;
  /** Came in over the remote (HTTPS) listener. */
  remote: boolean;
}

function sessionCookie(ctx: Ctx, token: string, maxAge: number) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${ctx.remote ? '; Secure' : ''}`;
}

function need(ctx: Ctx): Principal {
  if (!ctx.principal) throw new HttpError(401, 'Please log in.');
  return ctx.principal;
}

function needServer(ctx: Ctx, perm: ServerPerm, serverId: string): Principal {
  const p = need(ctx);
  getInstance(serverId); // 404 if it doesn't exist
  if (!can(p, perm, serverId)) throw new HttpError(403, 'You do not have permission to do that.');
  return p;
}

function needGlobal(ctx: Ctx, right: GlobalPerm): Principal {
  const p = need(ctx);
  if (!canGlobal(p, right)) throw new HttpError(403, 'You do not have permission to do that.');
  return p;
}

/** Any of several server permissions (e.g. the Files tab is readable with view-files or edit-files). */
function needServerAny(ctx: Ctx, perms: ServerPerm[], serverId: string): Principal {
  const p = need(ctx);
  getInstance(serverId);
  if (!perms.some((x) => can(p, x, serverId))) throw new HttpError(403, 'You do not have permission to do that.');
  return p;
}

function needOwner(ctx: Ctx): Principal {
  const p = need(ctx);
  if (!p.owner) throw new HttpError(403, 'Only the owner can do that.');
  return p;
}

function serverIds() {
  return listInstances().map((i) => i.id);
}

/** Hides what this principal isn't allowed to see (e.g. the server password without settings rights). */
function visibleSnapshot<T extends { id: string; settings: Record<string, unknown> }>(snap: T, p: Principal): T & { permissions: ServerPerm[] } {
  const permissions = permsOn(p, snap.id);
  if (can(p, 'settings.edit', snap.id)) return { ...snap, permissions };
  const { password: _, ...settings } = snap.settings;
  return { ...snap, settings, permissions };
}

function audit(p: Principal, message: string) {
  logActivity({ at: Date.now(), who: p.name, kind: p.kind, id: p.id, what: message });
}

// ---------- live updates (Server-Sent Events) ----------

const streams = new Map<http.ServerResponse, Principal>();

events.on('state', async (id: string) => {
  try {
    const snap = await getInstance(id).snapshot();
    for (const [res, p] of streams) if (can(p, 'view', id)) res.write(`event: server\ndata: ${JSON.stringify(visibleSnapshot(snap, p))}\n\n`);
  } catch {}
});
events.on('line', (id: string, line: string) => {
  const msg = `event: line\ndata: ${JSON.stringify({ id, line })}\n\n`;
  for (const [res, p] of streams) if (can(p, 'console.view', id)) res.write(msg);
});
events.on('chat', (id: string, msg: unknown) => {
  const data = `event: chat\ndata: ${JSON.stringify({ id, message: msg })}\n\n`;
  for (const [res, p] of streams) if (can(p, 'console.view', id)) res.write(data);
});
events.on('alert', (payload: { alert: Alert; active: boolean }) => {
  const data = `event: alert\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [res, p] of streams) if (!payload.alert.serverId || can(p, 'view', payload.alert.serverId)) res.write(data);
});
events.on('world-check', (payload: { serverId: string; phase: string }) => {
  const data = `event: world-check\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [res, p] of streams) if (can(p, 'view', payload.serverId)) res.write(data);
});
// Nodes' live updates, re-broadcast with this panel's ids and permissions.
events.on('remote-server', (snap: { id: string; settings: Record<string, unknown> }) => {
  for (const [res, p] of streams) if (can(p, 'view', snap.id)) res.write(`event: server\ndata: ${JSON.stringify(visibleSnapshot(snap, p))}\n\n`);
});
events.on('remote-removed', (id: string) => {
  for (const res of streams.keys()) res.write(`event: removed\ndata: ${JSON.stringify({ id })}\n\n`);
});
events.on('remote-line', (id: string, line: string) => {
  const msg = `event: line\ndata: ${JSON.stringify({ id, line })}\n\n`;
  for (const [res, p] of streams) if (can(p, 'console.view', id)) res.write(msg);
});
events.on('remote-chat', (id: string, message: unknown) => {
  const msg = `event: chat\ndata: ${JSON.stringify({ id, message })}\n\n`;
  for (const [res, p] of streams) if (can(p, 'console.view', id)) res.write(msg);
});
events.on('remote-alert', (payload: { alert: Alert; active: boolean }) => {
  const data = `event: alert\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [res, p] of streams) if (!payload.alert.serverId || can(p, 'view', payload.alert.serverId)) res.write(data);
});
events.on('nodes', () => {
  for (const [res, p] of streams) if (canGlobal(p, 'panel.settings')) res.write('event: nodes\ndata: {}\n\n');
});
events.on('removed', (id: string) => {
  for (const res of streams.keys()) res.write(`event: removed\ndata: ${JSON.stringify({ id })}\n\n`);
});

// ---------- routes ----------

type Handler = (ctx: Ctx) => Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), handler]);

// Lets the desktop app notice an old service still running after an update (and replace it). Local listener only.
const PANEL_VERSION: string = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8')).version;
route('GET', '/api/version', async (ctx) => {
  if (ctx.remote) throw new HttpError(404, 'Not found.');
  return { version: PANEL_VERSION, pid: process.pid, build: isDev ? 'development' : 'release' };
});

// The version this data folder ran last: when it changed, this start is the first one after an update (the page shows
// "Server Forge was updated to X" once).
const updatedFrom: { from: string | null; at: number } | null = (() => {
  const seen = readJson<{ version?: string; updatedFrom?: { from: string | null; at: number } } | null>('version.json', null);
  if (seen?.version && seen.version !== PANEL_VERSION) {
    const u = { from: seen.version, at: Date.now() };
    writeJson('version.json', { version: PANEL_VERSION, updatedFrom: u });
    return u;
  }
  if (!seen?.version) {
    // Versions before 0.4.3 didn't write version.json. An in-app update leaves a recent "restarting for an update"
    // notice, so that still counts as an update (from an unknown version); a fresh install doesn't.
    const notice = readJson<{ reason?: string; at?: number } | null>('restart-notice.json', null);
    const u = notice?.reason === 'update' && Date.now() - (notice.at ?? 0) < 30 * 60_000 ? { from: null, at: Date.now() } : null;
    writeJson('version.json', { version: PANEL_VERSION, ...(u ? { updatedFrom: u } : {}) });
    return u;
  }
  return seen.updatedFrom ?? null;
})();

/**
 * What this panel is, for its name:
 * - manages nodes, nothing of its own (no game servers, no Tavern Vault connected here): "Server Forge Master"
 * - manages nodes and has its own servers or storage too: "Super Server Forge"
 * - is a node of another panel (its node link has been used): "Server Forge Node", or "Super Server Forge Node" with Tavern Vault here
 * - otherwise: "Server Forge"
 * Managing nodes wins if a panel is both. Whether Tavern Vault is connected here is checked at most once a minute.
 */
type PanelRole = 'host' | 'master' | 'super' | 'node' | 'supernode';
const PANEL_NAMES: Record<PanelRole, string> = { host: 'Server Forge', master: 'Server Forge Master', super: 'Super Server Forge', node: 'Server Forge Node', supernode: 'Super Server Forge Node' };
let ownVault = { at: 0, ok: false };
async function panelIdentity(): Promise<{ role: PanelRole; name: string }> {
  if (Date.now() - ownVault.at > 60_000) ownVault = { at: Date.now(), ok: (await vaultState().catch(() => ({ state: 'down' }))).state === 'ok' };
  let role: PanelRole = 'host';
  if (listNodes().length) role = listInstances().length || ownVault.ok ? 'super' : 'master';
  else if (auth.usedAsNode()) role = ownVault.ok ? 'supernode' : 'node';
  return { role, name: PANEL_NAMES[role] };
}

route('GET', '/api/me', async ({ user, principal, remote }) => ({
  version: PANEL_VERSION,
  panel: await panelIdentity(),
  updatedFrom,
  // "development" = running from the sources (test panel); "release" = an installed or portable build.
  build: isDev ? 'development' : 'release',
  user: user ? auth.toPublic(user) : null,
  apiKey: principal?.kind === 'apikey' ? principal.name : undefined,
  // What this account may do outside single servers (the UI hides what it can't use).
  global: principal ? (principal.owner ? [...GLOBAL_PERMS] : principal.grants.global) : [],
  needsSetup: !auth.hasUsers(),
  remote,
}));

route('POST', '/api/setup', async (ctx) => {
  if (auth.hasUsers()) throw new HttpError(403, 'Setup is already done.');
  if (ctx.remote) throw new HttpError(403, 'Create the owner account on the panel system itself.');
  const { username, password } = await readBody(ctx.req);
  const user = auth.createUser({ username, password, role: 'owner' }, []);
  ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, auth.createSession(user.id), 7 * 86400));
  return { user: auth.toPublic(user) };
});

route('POST', '/api/login', async (ctx) => {
  const ip = ctx.req.socket.remoteAddress ?? '';
  if (!auth.loginAllowed(ip)) throw new HttpError(429, 'Too many failed logins. Try again in 15 minutes.');
  const { username, password } = await readBody(ctx.req);
  const user = auth.verifyLogin(String(username ?? ''), String(password ?? ''));
  if (!user) {
    auth.recordLoginFailure(ip);
    throw new HttpError(401, 'Wrong username or password.');
  }
  if (ctx.remote && !user.remote) throw new HttpError(403, 'This account is not allowed to log in remotely.');
  auth.clearLoginFailures(ip);
  auth.recordLoginIp(user.id, ip.replace(/^::ffff:/, ''));
  logActivity({ at: Date.now(), who: user.username, kind: 'user', id: user.id, what: `logged in${ctx.remote ? ' remotely' : ''}`, ip: ip.replace(/^::ffff:/, '') });
  ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, auth.createSession(user.id), 7 * 86400));
  return { user: auth.toPublic(user) };
});

// The desktop app logs in as the owner with a key the panel writes to its data folder at startup.
// Only programs on this system that can read that folder can use it, and only over the local listener.
const desktopKey = randomBytes(32).toString('hex');
writeFileSync(dataPath('desktop.key'), desktopKey);

route('POST', '/api/desktop-login', async (ctx) => {
  if (ctx.remote || !LOOPBACK.includes(ctx.req.socket.remoteAddress ?? '')) throw new HttpError(403, 'Desktop login only works on this system.');
  const { key } = await readBody(ctx.req);
  const given = Buffer.from(String(key ?? ''));
  const expected = Buffer.from(desktopKey);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid desktop key.');
  const owner = auth.firstOwner();
  if (!owner) return { user: null, needsSetup: true };
  ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, auth.createSession(owner.id), 7 * 86400));
  return { user: auth.toPublic(owner) };
});

route('POST', '/api/logout', async (ctx) => {
  auth.destroySession(ctx.token);
  ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, '', 0));
  return {};
});

route('PUT', '/api/me/password', async (ctx) => {
  if (!ctx.user) throw new HttpError(401, 'Please log in.');
  const { current, password } = await readBody(ctx.req);
  try {
    // Other devices are signed out; this one gets a fresh session.
    auth.changeOwnPassword(ctx.user.id, String(current ?? ''), String(password ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  ctx.res.setHeader('Set-Cookie', sessionCookie(ctx, auth.createSession(ctx.user.id), 7 * 86400));
  logActivity({ at: Date.now(), who: ctx.user.username, kind: 'user', id: ctx.user.id, what: 'changed their password' });
  return {};
});

route('GET', '/api/games', async (ctx) => {
  need(ctx);
  return Object.values(GAMES).map((g) => ({
    id: g.id,
    name: g.name,
    fields: g.fields,
    accessLists: g.accessLists ?? [],
    canCreate: !!g.install,
    canCommand: !!g.commands,
    hasProperties: !!g.properties,
    eula: g.eula ?? null,
    // Fields for the "New server" form.
    newFields: g.newFields ?? (g.quickFields ?? []).map((k) => g.fields.find((f) => f.key === k)).filter(Boolean),
  }));
});

route('GET', '/api/games/:game/versions', async (ctx) => {
  need(ctx);
  const game = GAMES[ctx.params[0]];
  if (!game?.listVersions) throw new HttpError(404, 'This game has no version list.');
  const from = new URL(ctx.req.url ?? '', 'http://x').searchParams.get('from') ?? '';
  return { versions: await game.listVersions(from) };
});

route('GET', '/api/permissions', async (ctx) => {
  need(ctx);
  return { serverGroups: SERVER_PERM_GROUPS, global: GLOBAL_PERMS.map((id) => ({ id, ...GLOBAL_PERM_INFO[id] })), presets: PRESETS, presetLabels: PRESET_LABELS };
});

// ---------- servers ----------

route('GET', '/api/servers', async (ctx) => {
  const p = need(ctx);
  const visible = listInstances().filter((i) => can(p, 'view', i.id));
  const local = await Promise.all(visible.map(async (i) => visibleSnapshot(await i.snapshot(), p)));
  // Servers on connected nodes (other systems), with this panel's permissions for them.
  const remote = remoteServers().filter((s) => can(p, 'view', String(s.id))).map((s) => visibleSnapshot(s as { id: string; settings: Record<string, unknown> }, p));
  return [...local, ...remote];
});

route('POST', '/api/servers', async (ctx) => {
  const p = needGlobal(ctx, 'servers.create');
  const { inst, notes } = await importServer(await readBody(ctx.req));
  const snap = await inst.snapshot();
  audit(p, `added server "${snap.name}"`);
  // What the import found or brought along (Endstone: addons, plugins), shown in the panel.
  return { ...snap, importNotes: notes };
});

route('POST', '/api/servers/new', async (ctx) => {
  const p = needGlobal(ctx, 'servers.create');
  const inst = createNewServer(await readBody(ctx.req));
  audit(p, `created new ${inst.module.name} server "${inst.record.name}" in ${inst.record.installDir}`);
  return inst.snapshot();
});

route('POST', '/api/servers/:id/update', async (ctx) => {
  const p = needServer(ctx, 'server.update', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  inst.installSoftware(`Updating ${inst.module.name} server`);
  audit(p, `started a software update for "${inst.record.name}"`);
  return inst.snapshot();
});

route('GET', '/api/servers/:id', async (ctx) => {
  const p = needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  return {
    ...visibleSnapshot(await inst.snapshot(true), p),
    console: can(p, 'console.view', inst.id) ? inst.console : [],
    knownPlayers: inst.knownPlayers(),
  };
});

route('GET', '/api/servers/:id/console', async (ctx) => {
  needServer(ctx, 'console.view', ctx.params[0]);
  const lines = Math.min(Math.max(Number(new URL(ctx.req.url ?? '', 'http://x').searchParams.get('lines')) || 100, 1), 2000);
  return { lines: getInstance(ctx.params[0]).console.slice(-lines) };
});

route('PUT', '/api/servers/:id', async (ctx) => {
  const body = await readBody(ctx.req);
  // Automatic backups are part of "make backups"; everything else here is the server's settings.
  const onlySchedule = body && Object.keys(body).every((k) => k === 'backupSchedule');
  // The auto-update switch belongs to "update server software".
  const onlyAutoUpdate = body && Object.keys(body).length && Object.keys(body).every((k) => k === 'autoUpdate');
  const p = needServer(ctx, onlySchedule ? 'backups.create' : onlyAutoUpdate ? 'server.update' : 'settings.edit', ctx.params[0]);
  const snap = await updateServer(ctx.params[0], body).snapshot();
  // Automatic updates just turned on: check now, so a version that came out before the switch installs straight away.
  if (body?.autoUpdate === true && updatesSupported(snap.game)) {
    checkUpdates(true, snap.game).catch((err) => getInstance(ctx.params[0]).log(`Couldn't check for updates: ${(err as Error).message}`));
  }
  audit(p, onlySchedule ? `changed automatic backups of "${snap.name}"` : onlyAutoUpdate ? `turned automatic updates ${body.autoUpdate ? 'on' : 'off'} for "${snap.name}"` : `changed settings of "${snap.name}"`);
  return visibleSnapshot(snap, p);
});

// Body: {"name": "...", "installDir": "C:\\..."}. Copies in the background; the new server appears when it's done.
route('POST', '/api/servers/:id/clone', async (ctx) => {
  const p = needGlobal(ctx, 'servers.create');
  needServer(ctx, 'files.view', ctx.params[0]);
  const { name, installDir } = await readBody(ctx.req);
  const job = cloneServer(ctx.params[0], { name: String(name ?? ''), installDir: String(installDir ?? '') });
  audit(p, `made a copy of "${getInstance(ctx.params[0]).record.name}" as "${name}" in ${installDir}`);
  return { job };
});

// Sidebar order (shared by everyone using this panel). Only servers you may change settings on can be moved.
route('PUT', '/api/server-order', async (ctx) => {
  const { ids } = await readBody(ctx.req);
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) throw new HttpError(400, 'Send {"ids": [...]} in the new order.');
  let p: Principal | null = null;
  for (const id of ids) {
    if (!isRemoteId(id)) getInstance(id);
    p = needServer(ctx, 'settings.edit', id);
  }
  // Local servers are ordered here; each node orders its own (ids passed on without the node prefix).
  const local = ids.filter((id) => !isRemoteId(id));
  if (local.length) reorderServers(local);
  const byNode = new Map<string, string[]>();
  for (const id of ids) {
    const r = parseRemoteId(id);
    if (r) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r.serverId]);
  }
  for (const [nodeId, serverIds] of byNode) await nodeJson(getNode(nodeId), 'PUT', '/api/server-order', { ids: serverIds });
  if (p) audit(p, 'reordered the server list');
  return {};
});

route('DELETE', '/api/servers/:id', async (ctx) => {
  const p = needServer(ctx, 'server.delete', ctx.params[0]);
  const { name, installDir } = getInstance(ctx.params[0]).record;
  const q = new URL(ctx.req.url ?? '', 'http://x').searchParams;
  const opts = { files: q.get('files') === '1', backups: q.get('backups') === '1' };
  // Deleting files off the system is a bigger deal than unlisting: it also needs permission to edit this server's files.
  if (opts.files) needServer(ctx, 'files.edit', ctx.params[0]);
  await deleteServer(ctx.params[0], opts);
  deleteTasksFor(ctx.params[0]);
  audit(p, `removed server "${name}"${opts.files ? ` and sent ${installDir} to the Recycle Bin` : ''}${opts.backups ? ' (backups deleted)' : ''}`);
  return {};
});

for (const action of ['start', 'stop', 'restart', 'kill'] as const) {
  route('POST', `/api/servers/:id/${action}`, async (ctx) => {
    const p = needServer(ctx, `control.${action}`, ctx.params[0]);
    const inst = getInstance(ctx.params[0]);
    // Refuse right away (with the reason) if another Server Forge on this system is running this server folder.
    if (action === 'start' || action === 'restart') inst.assertNotOwnedElsewhere();
    // Stop/restart can count down first: {"countdownMinutes": 5, "message"?: "... {time} ..."}. Start/restart take
    // {"force": true} to skip the world checks (answered with 428 and the reason, so the panel can ask first).
    const body = await readBody(ctx.req);
    const force = !!body.force;
    if (action === 'start' && !force) {
      try {
        await inst.preStartCheck();
      } catch (err) {
        throw new HttpError(428, (err as Error).message);
      }
    }
    const minutes = Math.min(Math.max(Number(body.countdownMinutes) || 0, 0), 60);
    if (minutes && (action === 'stop' || action === 'restart')) {
      if (inst.countdown) throw new HttpError(409, 'A countdown is already running. Cancel it first.');
      const marks = [60, 30, 15, 10, 5, 2, 1].filter((m) => m < minutes);
      audit(p, `${action} "${inst.record.name}" in ${minutes} min (countdown)`);
      inst.countdownThen(action, [minutes, ...marks], body.message ? String(body.message).slice(0, 200) : undefined, `by ${p.name}`).catch(() => {});
      return {};
    }
    // Doing it now replaces any countdown that was running.
    inst.cancelCountdown();
    audit(p, `${action} "${inst.record.name}"${force ? ' (skipping the world checks)' : ''}`);
    // Don't hold the request open for a whole stop/restart; progress arrives over the live stream.
    (action === 'stop' ? inst.stop() : inst[action]({ force })).catch(() => {});
    return {};
  });
}

route('POST', '/api/servers/:id/countdown/cancel', async (ctx) => {
  const inst = getInstance(ctx.params[0]);
  const p = needServer(ctx, inst.countdown?.action === 'stop' ? 'control.stop' : 'control.restart', ctx.params[0]);
  if (!inst.countdown) return {};
  inst.cancelCountdown();
  audit(p, `cancelled the countdown on "${inst.record.name}"`);
  return {};
});

route('POST', '/api/servers/:id/command', async (ctx) => {
  const p = needServer(ctx, 'console.command', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const { command } = await readBody(ctx.req);
  await inst.sendCommand(String(command ?? ''));
  audit(p, `ran "${String(command).slice(0, 200)}" on "${inst.record.name}"`);
  return {};
});

// ---------- nodes (other systems managed from this panel) ----------

route('GET', '/api/nodes', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  return { nodes: listNodes() };
});

// Body: {"code": "thnode://...", "name"?: "Gaming System"}.
route('POST', '/api/nodes', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const { code, name } = await readBody(ctx.req);
  const node = await addNode(String(code ?? ''), name ? String(name) : undefined).catch((err) => {
    throw new HttpError(400, err.message);
  });
  audit(p, `added node "${node.name}" (${node.host}:${node.port})`);
  return { nodes: listNodes() };
});

route('PUT', '/api/nodes/:id', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const { name } = await readBody(ctx.req);
  renameNode(ctx.params[0], String(name ?? ''));
  audit(p, `renamed node ${ctx.params[0]} to "${name}"`);
  return { nodes: listNodes() };
});

route('DELETE', '/api/nodes/:id', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const name = getNode(ctx.params[0]).name;
  removeNode(ctx.params[0]);
  audit(p, `removed node "${name}"`);
  return { nodes: listNodes() };
});

// On the system that should become a node: makes the code to paste into the main panel. The key it creates can run
// servers (every server permission, plus creating/copying servers) but not manage users or panel settings.
route('POST', '/api/node-code', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  if (ctx.remote) throw new HttpError(403, 'Make node codes on this system itself.');
  const status = remoteStatus(config.remote);
  if (!config.remote.enabled || !status.listening) throw new HttpError(409, 'Turn on Remote access first (above): the main panel connects to this system through it.');
  const fingerprint = await certFingerprint();
  if (!fingerprint) throw new HttpError(409, "Remote access hasn't made its certificate yet. Try again in a moment.");
  const { label } = await readBody(ctx.req);
  const { key } = auth.createApiKey(`Node link${label ? ` (${String(label).slice(0, 30)})` : ''}`, 'custom', { global: ['servers.create', 'storage.view', 'storage.manage'], servers: { '*': [...SERVER_PERMS] } }, [], p);
  const address = status.addresses.find((a) => a.includes('192.168.')) ?? status.addresses[0] ?? `https://${os.hostname()}:${config.remote.port}`;
  const hostPort = address.replace(/^https:\/\//, '');
  audit(p, 'made a node code for this system');
  return { code: `thnode://${hostPort}/${key}?fp=${fingerprint.replace(/:/g, '')}&name=${encodeURIComponent(os.hostname())}` };
});

// ---------- storage (Tavern Vault, on this system and on nodes) ----------
// Tavern Vault is a separate app; with its node mode on, these pass requests to it. Storage is off until it's turned on
// in Settings (on this panel to show it, on a node to share that node's storage). Reading needs storage.view, any change
// storage.manage (checked here, by method). Nodes are reached through their node link.

const STORAGE_OFF_HERE = 'Storage is turned off in Server Forge on this system. Turn it on in Settings → Storage (Tavern Vault).';

function needStorageOn() {
  if (!config.storage.enabled) throw new HttpError(409, STORAGE_OFF_HERE);
}

/** This system's storage, honouring the Storage switch. */
async function localVault() {
  return config.storage.enabled ? vaultState() : { state: 'disabled', message: STORAGE_OFF_HERE };
}

function needStorage(ctx: Ctx, method?: string): Principal {
  const p = need(ctx);
  const right: GlobalPerm = method && !isViewMethod(method) ? 'storage.manage' : 'storage.view';
  if (!canGlobal(p, right)) throw new HttpError(403, right === 'storage.manage' ? 'You can see storage but not change it (needs "Manage storage").' : 'You do not have permission to see storage.');
  return p;
}

/** Who asked, for Tavern Vault's activity log. A master panel passes its own "who" through the node link. */
function vaultVia(p: Principal, body: { via?: unknown }): string {
  // The key's own name is always kept, so a key can't make its changes look like someone else's.
  if (p.kind === 'apikey' && typeof body.via === 'string' && body.via) return `${body.via.slice(0, 60)} [key: ${p.name}]`.slice(0, 100);
  return `Server Forge · ${p.name}`.slice(0, 80);
}

route('GET', '/api/vault', async (ctx) => {
  needStorage(ctx);
  return localVault();
});
route('POST', '/api/vault/call', async (ctx) => {
  const body = await readBody(ctx.req);
  const method = String(body.method ?? '');
  const p = needStorage(ctx, method);
  needStorageOn();
  const r = await vaultCall(method, body.args ?? {}, vaultVia(p, body));
  if (!isViewMethod(method) && r.ok && !(r.data as { practice?: boolean })?.practice) audit(p, `storage: ${method}`);
  return r;
});
route('GET', '/api/vault/events', async (ctx) => {
  needStorage(ctx);
  needStorageOn();
  return vaultEvents(Number(new URL(ctx.req.url ?? '/', 'http://x').searchParams.get('since')));
});
route('GET', '/api/vault/ui/:file', async (ctx) => {
  needStorage(ctx);
  needStorageOn();
  const file = ctx.params[0];
  const text = await vaultUiFile(file);
  ctx.res.writeHead(200, { 'Content-Type': VAULT_UI[file], 'Cache-Control': 'no-store' });
  ctx.res.end(text);
  return undefined;
});

// Nodes: the same, through the node link. A node older than 0.5.0 answers 404.
const tooOld = (err: { status?: number }) => err.status === 404;
const OLD_NODE = 'That system runs a Server Forge older than 0.5.0. Update Server Forge there to see its storage.';

async function nodeVault<T>(id: string, method: string, path: string, body?: unknown): Promise<T> {
  needStorageOn();
  try {
    return await nodeJson<T>(getNode(id), method, path, body);
  } catch (err) {
    if (tooOld(err as { status?: number })) throw new HttpError(409, OLD_NODE);
    throw err;
  }
}

/** A node's storage state, as this panel describes it (messages name the node instead of "this system"). */
async function nodeVaultState(n: { id: string; name: string; online?: boolean; error?: string | null }): Promise<Record<string, any>> {
  if (n.online === false) return { state: 'unreachable', message: `${n.name} is offline${n.error ? ` (${n.error})` : ''}.` };
  try {
    const v = await nodeJson<Record<string, any>>(getNode(n.id), 'GET', '/api/vault');
    if (v.state === 'disabled') return { state: 'disabled', message: `Storage is turned off in Server Forge on ${n.name}. Turn it on there in Settings → Storage (Tavern Vault).` };
    if (v.state === 'missing') return { state: 'missing', message: `Tavern Vault isn't installed on ${n.name}. Install it there and turn on its Node mode.` };
    if (v.state === 'off') return { state: 'off', message: `Tavern Vault is installed on ${n.name}, but its Node mode is off (Tavern Vault → Settings → Node mode).` };
    return v;
  } catch (err) {
    return tooOld(err as { status?: number }) ? { state: 'old', message: `${n.name} runs a Server Forge older than 0.5.0. Update Server Forge there.` } : { state: 'unreachable', message: (err as Error).message };
  }
}

route('GET', '/api/nodes/:id/vault', async (ctx) => {
  needStorage(ctx);
  needStorageOn();
  const n = getNode(ctx.params[0]);
  return nodeVaultState({ ...n, ...listNodes().find((x) => x.id === n.id) });
});
route('POST', '/api/nodes/:id/vault/call', async (ctx) => {
  const body = await readBody(ctx.req);
  const method = String(body.method ?? '');
  const p = needStorage(ctx, method);
  const node = getNode(ctx.params[0]);
  const r = await nodeVault<{ ok: boolean; data?: unknown }>(node.id, 'POST', '/api/vault/call', { method, args: body.args ?? {}, via: `${os.hostname()} (master) · ${p.name}` });
  if (!isViewMethod(method) && r.ok && !(r.data as { practice?: boolean })?.practice) audit(p, `storage on ${node.name}: ${method}`);
  return r;
});
route('GET', '/api/nodes/:id/vault/events', async (ctx) => {
  needStorage(ctx);
  const since = Number(new URL(ctx.req.url ?? '/', 'http://x').searchParams.get('since')) || 0;
  return nodeVault(ctx.params[0], 'GET', `/api/vault/events?since=${since}`);
});

/** Storage at a glance for the sidebar: this system and every node (nodes asked at most every 30 s). */
const nodeVaultCache = new Map<string, { at: number; value: Record<string, unknown> }>();
function brief(v: Record<string, any>) {
  if (v.state !== 'ok') return { state: v.state, message: v.message };
  const s = v.status ?? {};
  return { state: 'ok', level: s.level ?? 'ok', problems: (s.problems ?? []).length, pools: (s.pools ?? []).length, arrays: (s.arrays ?? []).length, practice: !!s.practice, at: s.at };
}
/**
 * Storage on this system and every node, for the sidebar (only systems with state "ok" get a Storage entry) and for
 * Settings (which explains the rest). With Storage off, only this system is checked, so Settings can say what's needed.
 */
route('GET', '/api/vault/summary', async (ctx) => {
  const p = need(ctx);
  if (!canGlobal(p, 'storage.view') && !canGlobal(p, 'panel.settings')) throw new HttpError(403, 'You do not have permission to see storage.');
  const enabled = config.storage.enabled;
  const local = brief(await vaultState());
  ownVault = { at: Date.now(), ok: local.state === 'ok' };
  const panel = await panelIdentity();
  if (!enabled) return { enabled, local, nodes: [], panel };
  const nodes = await Promise.all(
    listNodes().map(async (n) => {
      const cached = nodeVaultCache.get(n.id);
      if (cached && Date.now() - cached.at < 30_000) return { id: n.id, name: n.name, ...cached.value };
      const value = brief(await nodeVaultState(n));
      nodeVaultCache.set(n.id, { at: Date.now(), value });
      return { id: n.id, name: n.name, ...value };
    }),
  );
  return { enabled, local, nodes, panel };
});

// The Storage switch (Settings → Storage (Tavern Vault)).
route('PUT', '/api/settings/storage', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const { enabled } = await readBody(ctx.req);
  config.storage.enabled = !!enabled;
  writeJson('config.json', config);
  nodeVaultCache.clear();
  audit(p, `turned storage (Tavern Vault) ${config.storage.enabled ? 'on' : 'off'}`);
  return { enabled: config.storage.enabled };
});

/** Tavern Vault's page files for /vault-ui/<scope>/, from this system's Tavern Vault or a node's. */
async function vaultUiFor(scope: string, file: string): Promise<string> {
  needStorageOn();
  if (scope === 'local') return vaultUiFile(file);
  const id = /^n-([a-z0-9]+)$/i.exec(scope)?.[1];
  if (!id) throw new HttpError(404, 'Not found.');
  const res = await nodeRequest(getNode(id), 'GET', `/api/vault/ui/${file}`);
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  if ((res.statusCode ?? 500) >= 400) throw new HttpError(res.statusCode === 404 ? 409 : 502, res.statusCode === 404 ? OLD_NODE : `The node answered ${res.statusCode}.`);
  return Buffer.concat(chunks).toString('utf-8');
}

// ---------- creating / importing servers on a node (from this panel's New and Import) ----------

/** The systems this account can make servers on: this one, plus every node (online ones can be picked). */
route('GET', '/api/node-targets', async (ctx) => {
  needGlobal(ctx, 'servers.create');
  // Systems with only Tavern Vault have no game servers.
  return { nodes: listNodes().filter((n) => n.kind !== 'vault').map((n) => ({ id: n.id, name: n.name, online: n.online, version: n.version })) };
});

function nodeForCreate(ctx: Ctx, id: string) {
  const p = needGlobal(ctx, 'servers.create');
  const node = getNode(id);
  const info = listNodes().find((n) => n.id === id);
  if (info?.kind === 'vault') throw new HttpError(400, `${node.name} only has Tavern Vault; install Server Forge there to run game servers.`);
  if (!info?.online) throw new HttpError(409, `${node.name} is offline right now.`);
  return { p, node };
}

// The node's own list of games and versions (it may run a newer or older Server Forge than this panel).
route('GET', '/api/nodes/:id/games', async (ctx) => {
  const { node } = nodeForCreate(ctx, ctx.params[0]);
  return nodeJson(node, 'GET', '/api/games');
});
route('GET', '/api/nodes/:id/games/:game/versions', async (ctx) => {
  const { node } = nodeForCreate(ctx, ctx.params[0]);
  const from = new URL(ctx.req.url ?? '', 'http://x').searchParams.get('from') ?? '';
  return nodeJson(node, 'GET', `/api/games/${encodeURIComponent(ctx.params[1])}/versions?from=${encodeURIComponent(from)}`);
});

/** Passes a create/import to the node; the answer's server id becomes this panel's id for it (n~<node>~<server>). */
async function createOnNode(ctx: Ctx, nodePath: '/api/servers/new' | '/api/servers', what: string) {
  const { p, node } = nodeForCreate(ctx, ctx.params[0]);
  const body = await readBody(ctx.req);
  let snap: Record<string, unknown>;
  try {
    // An import can take a few minutes (Endstone: finding its Python and bringing plugins in).
    snap = await nodeJson<Record<string, unknown>>(node, 'POST', nodePath, body, nodePath === '/api/servers' ? 5 * 60_000 : undefined);
  } catch (err) {
    throw new HttpError((err as { status?: number }).status && (err as { status: number }).status < 500 ? (err as { status: number }).status : 502, `${node.name}: ${(err as Error).message}`);
  }
  audit(p, `${what} "${body.name}" on node ${node.name} (${body.installDir})`);
  return { ...snap, id: remoteId(node.id, String(snap.id)), node: { id: node.id, name: node.name } };
}
// Body: the same as POST /api/servers/new (game, name, installDir, settings, acceptEula).
route('POST', '/api/nodes/:id/servers/new', (ctx) => createOnNode(ctx, '/api/servers/new', 'created server'));
// Body: the same as POST /api/servers (game, name, installDir).
route('POST', '/api/nodes/:id/servers', (ctx) => createOnNode(ctx, '/api/servers', 'imported server'));

// ---------- difficulty (every server type) ----------

route('GET', '/api/servers/:id/difficulty', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  return difficultyInfo(ctx.params[0]);
});

// Body: {"value": "hard"} (Minecraft: peaceful/easy/normal/hard; Valheim: a world preset or "keep").
route('PUT', '/api/servers/:id/difficulty', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const { value } = await readBody(ctx.req);
  let info;
  try {
    info = await setDifficulty(ctx.params[0], String(value ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `set the difficulty of "${getInstance(ctx.params[0]).record.name}" to ${value}`);
  return info;
});

// ---------- port forwarding help ----------

route('GET', '/api/servers/:id/ports', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  return portHelp(inst.record, inst.module.connection?.(inst.record) ?? null);
});

// ---------- game updates (Bedrock, Valheim) ----------
// /game-update is the route; /bedrock-update is kept for anything that already uses it (e.g. Watcher).

for (const route_ of ['game-update', 'bedrock-update']) {
  route('GET', `/api/servers/:id/${route_}`, async (ctx) => {
    needServer(ctx, 'view', ctx.params[0]);
    const inst = getInstance(ctx.params[0]);
    if (!updatesSupported(inst.record.game)) throw new HttpError(404, `${inst.module.name} servers don't have update checks.`);
    const force = new URL(ctx.req.url ?? '', 'http://x').searchParams.get('check') === '1';
    try {
      await checkUpdates(force, updateKey(inst));
    } catch (err) {
      return { ...updateInfo(inst), error: (err as Error).message };
    }
    return updateInfo(inst);
  });

  // Body: {"countdownMinutes": 5, "force": false}. Runs in the background (progress in the console). With force, the
  // latest version is looked up right now and installed even if the server already looks up to date.
  route('POST', `/api/servers/:id/${route_}`, async (ctx) => {
    const p = needServer(ctx, 'server.update', ctx.params[0]);
    const inst = getInstance(ctx.params[0]);
    if (!updatesSupported(inst.record.game)) throw new HttpError(404, `${inst.module.name} servers can't be updated this way.`);
    if (inst.isRunning) needServer(ctx, 'control.stop', ctx.params[0]);
    const { countdownMinutes, force } = await readBody(ctx.req);
    try {
      await checkUpdates(!!force, updateKey(inst));
    } catch (err) {
      if (!force) throw new HttpError(502, (err as Error).message);
    }
    const info = updateInfo(inst);
    if (!force && !info.available) throw new HttpError(409, 'This server is already up to date. Use Force update to reinstall it anyway.');
    // A second click while it's already updating: say so, instead of logging a failed update.
    if (info.updating) throw new HttpError(409, 'This server is already updating.');
    updateGame(inst.id, { countdownMinutes: Number(countdownMinutes) || 0, force: !!force }).catch((err) => inst.log(`Update failed: ${(err as Error).message}`));
    audit(p, `${force ? 'forced' : 'started'} the ${inst.module.name} update of "${inst.record.name}" (${info.current ?? 'unknown'} → ${info.latest ?? 'latest'})`);
    return { latest: info.latest, current: info.current };
  });
}

// ---------- worlds (Bedrock / Java) ----------

function worldsOf(id: string) {
  const inst = getInstance(id);
  if (!supportsWorlds(inst)) throw new HttpError(404, `${inst.module.name} servers don't have world tools yet.`);
  return inst;
}

route('GET', '/api/servers/:id/worlds', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  return listWorlds(worldsOf(ctx.params[0]));
});

route('POST', '/api/servers/:id/worlds/:folder/activate', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = worldsOf(ctx.params[0]);
  const folder = wrap(() => setActiveWorld(inst, decodeURIComponent(ctx.params[1])));
  audit(p, `switched "${inst.record.name}" to world "${folder}"`);
  return { ...(await listWorlds(inst)), restartNeeded: inst.isRunning };
});

route('GET', '/api/servers/:id/worlds/:folder/export', async (ctx) => {
  const p = needServer(ctx, 'files.view', ctx.params[0]);
  const inst = worldsOf(ctx.params[0]);
  const { file, name, tmp } = await exportWorld(inst, decodeURIComponent(ctx.params[1])).catch((err) => {
    throw new HttpError(400, err.message);
  });
  try {
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
    await new Promise<void>((resolve) => createReadStream(file).on('error', () => resolve()).on('end', resolve).pipe(ctx.res));
    audit(p, `exported world "${decodeURIComponent(ctx.params[1])}" from "${inst.record.name}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return undefined;
});

// Raw .mcworld/.zip body (X-Filename header); ?name=<world name>&activate=1.
route('POST', '/api/servers/:id/worlds/import', async (ctx) => {
  const p = needServer(ctx, 'files.edit', ctx.params[0]);
  const inst = worldsOf(ctx.params[0]);
  const q = new URL(ctx.req.url ?? '', 'http://x').searchParams;
  if (q.get('activate') === '1') needServer(ctx, 'properties.edit', ctx.params[0]);
  const { file } = await receiveUpload(ctx.req);
  try {
    const folder = await importWorld(inst, file, q.get('name') ?? '', q.get('activate') === '1').catch((err) => {
      throw new HttpError(400, err.message);
    });
    audit(p, `imported world "${folder}" into "${inst.record.name}"`);
    return { folder, ...(await listWorlds(inst)), restartNeeded: q.get('activate') === '1' && inst.isRunning };
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

route('DELETE', '/api/servers/:id/worlds/:folder', async (ctx) => {
  const p = needServer(ctx, 'files.edit', ctx.params[0]);
  const inst = worldsOf(ctx.params[0]);
  const folder = decodeURIComponent(ctx.params[1]);
  await deleteWorld(inst, folder).catch((err) => {
    throw new HttpError(400, err.message);
  });
  audit(p, `deleted world "${folder}" from "${inst.record.name}" (Recycle Bin)`);
  return listWorlds(inst);
});

// ---------- in-game chat (Bedrock, through the chat relay pack) ----------

function chatOf(id: string) {
  const inst = getInstance(id);
  if (!inst.module.chat) throw new HttpError(404, `${inst.module.name} servers don't have chat in Server Forge yet.`);
  return { inst, chat: inst.module.chat };
}

route('GET', '/api/servers/:id/chat', async (ctx) => {
  needServer(ctx, 'console.view', ctx.params[0]);
  const { inst, chat } = chatOf(ctx.params[0]);
  const limit = Math.min(Math.max(Number(new URL(ctx.req.url ?? '', 'http://x').searchParams.get('limit')) || 200, 1), 300);
  return { relay: chat.status(inst.record), running: inst.isRunning, messages: readChat(inst.id, limit) };
});

// Body: {"message": "...", "name"?: "who (e.g. a Discord user)", "source"?: "where from (e.g. Discord)"}.
route('POST', '/api/servers/:id/chat', async (ctx) => {
  const p = needServer(ctx, 'console.command', ctx.params[0]);
  const { inst, chat } = chatOf(ctx.params[0]);
  if (!inst.isRunning) throw new HttpError(409, 'The server is not running.');
  const body = await readBody(ctx.req);
  const text = String(body.message ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  if (!text) throw new HttpError(400, 'Type a message first.');
  const name = String(body.name ?? p.name).trim().slice(0, 40) || p.name;
  const via = String(body.source ?? (p.kind === 'apikey' ? p.name : 'Panel')).trim().slice(0, 24) || 'Panel';
  await inst.sendCommand(chat.sayCommand(`§9[${via}]§r ${name}: ${text}`));
  recordChat(inst.id, { t: Date.now(), from: 'panel', name, text, via });
  audit(p, `said "${text.slice(0, 100)}" in chat on "${inst.record.name}"`);
  return {};
});

// Body: {"enabled": true|false, "moduleVersion"?: "2.11.0-beta"}. Takes effect when the server (re)starts.
route('POST', '/api/servers/:id/chat/relay', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, chat } = chatOf(ctx.params[0]);
  const { enabled, moduleVersion } = await readBody(ctx.req);
  const status = await chat.setRelay(inst.record, !!enabled, moduleVersion ? String(moduleVersion) : undefined);
  audit(p, `${enabled ? 'turned on' : 'turned off'} the chat relay on "${inst.record.name}"${enabled ? ` (${status.moduleVersion})` : ''}`);
  return { relay: status, running: inst.isRunning };
});

route('GET', '/api/servers/:id/properties', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!inst.module.properties) throw new HttpError(404, 'This game has no settings file editor.');
  return inst.module.properties.read(inst.record);
});

route('PUT', '/api/servers/:id/properties', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!inst.module.properties) throw new HttpError(404, 'This game has no settings file editor.');
  const { values } = await readBody(ctx.req);
  if (!values || typeof values !== 'object') throw new HttpError(400, 'values must be an object.');
  const clean = Object.fromEntries(Object.entries(values as Record<string, unknown>).map(([k, v]) => [String(k), String(v)]));
  inst.module.properties.write(inst.record, clean);
  audit(p, `changed ${Object.keys(clean).join(', ')} in "${inst.record.name}" server.properties`);
  return inst.module.properties.read(inst.record);
});

route('POST', '/api/servers/:id/properties/repair', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!inst.module.properties?.repair) throw new HttpError(404, 'This game has no settings file repair.');
  const note = inst.module.properties.repair(inst.record);
  audit(p, `repaired server.properties of "${inst.record.name}"`);
  return { note, ...inst.module.properties.read(inst.record) };
});

// ---------- addons / mods / plugins ----------

// /api/servers/:id/plugins/... is the second manager (GameModule.plugins, e.g. Endstone plugins next to Bedrock addons).
// It's answered by the /addons routes below, which pick the manager from this.
const addonKind = new AsyncLocalStorage<'addons' | 'plugins'>();

/** `changing`: the request changes files; games whose mod files are locked while running need the server stopped. */
function addonsOf(id: string, changing = false) {
  const inst = getInstance(id);
  const plugins = addonKind.getStore() === 'plugins';
  const addons = plugins ? inst.module.plugins : inst.module.addons;
  if (!addons || addons.available?.(inst.record) === false) {
    throw new HttpError(404, `This ${inst.module.name} server has no ${plugins ? 'plugin' : 'addon, mod or plugin'} manager.`);
  }
  if (changing && addons.needsStopped && inst.isRunning) {
    throw new HttpError(409, `Stop the server first: ${inst.module.name} keeps its mod files locked while it runs.`);
  }
  return { inst, addons };
}

const MAX_UPLOAD = 512 * 1024 * 1024;

/** Streams a raw upload to a temp file (the body is the file itself; the name comes from X-Filename). */
async function receiveUpload(req: http.IncomingMessage): Promise<{ file: string; name: string }> {
  const name = path.basename(decodeURIComponent(String(req.headers['x-filename'] ?? 'upload.zip'))).replace(/[^\w.\- ]/g, '_') || 'upload.zip';
  const dir = path.join(os.tmpdir(), `tavernhost-upload-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const out = createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, 'That file is larger than 512 MB.');
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { file, name };
}

route('GET', '/api/servers/:id/addons', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  return {
    packs: addons.list(inst.record),
    accept: addons.accept,
    // Load order matters and can be changed (Bedrock).
    ordered: !!addons.reorder,
    // Unpacked folders can be dropped in (Bedrock packs).
    folders: !!addons.folders,
    labels: addons.labels?.(inst.record) ?? {
      tab: 'Addons',
      noun: 'addon',
      plural: 'addons',
      dropHelp: 'Drop a <b>.mcaddon</b> or <b>.mcpack</b> here, or choose a file. Server Forge installs its behavior and resource packs and adds them to the world.',
    },
    curseforge: addons.curseforgeGame ? { available: !!curseforgeKey() } : null,
    links: typeof addons.links === 'function' ? addons.links(inst.record) : (addons.links ?? []),
    running: inst.isRunning,
    needsStopped: !!addons.needsStopped,
    status: addons.status?.(inst.record) ?? null,
    moddingOff: addons.isOn ? !addons.isOn(inst.record) : false,
    sides: addons.sides ?? null,
    canCheckUpdates: !!addons.checkUpdates,
    // Mod settings files (Valheim), for people who can change mods (they can hold secrets).
    settingsFiles: addons.settings && can(ctx.principal!, 'addons.manage', inst.id) ? addons.settings.list(inst.record) : null,
    // Listed only: another tool manages them (Satisfactory Mod Manager).
    readOnly: !!addons.readOnly,
    // Added by ID or link instead of a file (Space Engineers: Steam Workshop).
    canAddById: !!addons.addById,
    byIdPlaceholder: addons.addByIdPlaceholder ?? null,
    share: addons === inst.module.addons && canShare(inst.record.game) ? { enabled: !!shareToken(inst.id) } : null,
    locations: addons.locations
      ? { options: addons.locations.options, current: addons.locations.get(inst.record), paths: addons.locations.describe(inst.record) }
      : null,
    // A built-in search with one-click installs (Endstone plugins).
    canSearch: !!addons.search,
  };
});

route('GET', '/api/servers/:id/addons/search', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.search) throw new HttpError(404, 'No search here.');
  const q = new URL(ctx.req.url ?? '', 'http://x').searchParams.get('q') ?? '';
  return addons.search(inst.record, q.slice(0, 100));
});

route('POST', '/api/servers/:id/addons/found', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!addons.installFound) throw new HttpError(404, 'No search here.');
  const { id } = await readBody(ctx.req);
  let result;
  try {
    result = await addons.installFound(inst.record, String(id ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `installed ${id} on "${inst.record.name}"`);
  return { ...result, running: inst.isRunning, packs: addons.list(inst.record) };
});

route('POST', '/api/servers/:id/addons/setup', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!addons.setup) throw new HttpError(404, 'Nothing to set up.');
  const lines: string[] = [];
  let message: string;
  try {
    message = await addons.setup(inst.record, (l) => lines.push(l));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `set up the mod loader on "${inst.record.name}"`);
  return { message, lines, status: addons.status?.(inst.record) ?? null };
});

route('POST', '/api/servers/:id/addons/check-updates', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.checkUpdates) throw new HttpError(404, 'This game has no update check.');
  return { updates: await addons.checkUpdates(inst.record) };
});

route('POST', '/api/servers/:id/addons/:pack/update', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!addons.update) throw new HttpError(404, 'This game has no updates here.');
  let result;
  try {
    result = await addons.update(inst.record, ctx.params[1]);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `updated ${ctx.params[1]} on "${inst.record.name}"`);
  return { ...result, packs: addons.list(inst.record) };
});

route('POST', '/api/servers/:id/addons/:pack/side', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.setSide) throw new HttpError(404, 'Not available for this game.');
  const { side } = await readBody(ctx.req);
  try {
    addons.setSide(inst.record, ctx.params[1], String(side));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `set ${ctx.params[1]} on "${inst.record.name}" to ${side}`);
  return { packs: addons.list(inst.record) };
});

// Mod settings files (Valheim: BepInEx/config). Reading needs Manage mods too: mod configs can hold secrets (webhooks,
// passwords). Saving works while the server runs; the mod reads the file when the server starts.
function settingsOf(id: string) {
  const { inst, addons } = addonsOf(id);
  if (!addons.settings) throw new HttpError(404, `${inst.module.name} servers have no mod settings files.`);
  return { inst, settings: addons.settings };
}

route('GET', '/api/servers/:id/addons/settings', async (ctx) => {
  needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, settings } = settingsOf(ctx.params[0]);
  return { files: settings.list(inst.record) };
});

route('GET', '/api/servers/:id/addons/settings/:file', async (ctx) => {
  needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, settings } = settingsOf(ctx.params[0]);
  try {
    return settings.read(inst.record, decodeURIComponent(ctx.params[1]));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

route('PUT', '/api/servers/:id/addons/settings/:file', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, settings } = settingsOf(ctx.params[0]);
  const file = decodeURIComponent(ctx.params[1]);
  const { values, shared } = await readBody(ctx.req);
  if (!Array.isArray(values) || !Array.isArray(shared) || values.length > 2000 || shared.length > 2000) throw new HttpError(400, 'Send {"values":[{section,key,value}],"shared":[{section,key}]}.');
  let r;
  try {
    r = settings.write(
      inst.record,
      file,
      values.map((v: any) => ({ section: String(v?.section ?? ''), key: String(v?.key ?? ''), value: String(v?.value ?? '') })),
      shared.map((v: any) => ({ section: String(v?.section ?? ''), key: String(v?.key ?? '') })),
    );
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const what = [r.changed ? `changed ${r.changed} setting${r.changed === 1 ? '' : 's'}` : '', r.shared !== r.sharedBefore ? `now sends ${r.shared} to players` : ''].filter(Boolean).join(', ');
  if (what) audit(p, `${what} in ${file} on "${inst.record.name}"`);
  return { ...settings.read(inst.record, file) as object, files: settings.list(inst.record), running: inst.isRunning };
});

// ---------- mod sharing with players (Tavern Client Mod Manager) ----------
// Each Valheim server can publish a read-only mod list behind a secret token. The Tavern Client Mod Manager reads it over the
// remote-access HTTPS port and checks the certificate against the fingerprint in the link.

const SHARE_FILE = 'mod-share.json';
function shareTokens(): Record<string, string> {
  return readJson<Record<string, string>>(SHARE_FILE, {});
}
function shareToken(serverId: string): string | null {
  return shareTokens()[serverId] ?? null;
}
function serverForToken(token: string) {
  const entry = Object.entries(shareTokens()).find(([, t]) => t.length === token.length && timingSafeEqual(Buffer.from(t), Buffer.from(token)));
  if (!entry) throw new HttpError(404, 'This mod link is no longer valid. Ask the server owner for a new one.');
  const inst = getInstance(entry[0]);
  if (!canShare(inst.record.game)) throw new HttpError(404, 'This server has no shared mod list.');
  return inst;
}

async function shareInfo(serverId: string) {
  const token = shareToken(serverId);
  const fingerprint = await certFingerprint();
  const status = remoteStatus(config.remote);
  const make = (hostPort: string) => `thmods://${hostPort}/${token}?fp=${fingerprint!.replace(/:/g, '')}`;
  // Local addresses (skipping 169.254.x.x, which Windows makes up when a network has no router), plus the public one.
  const links = token && fingerprint ? status.addresses.map((a) => a.replace(/^https:\/\//, '')).filter((a) => !a.startsWith('169.254.')).map(make) : [];
  const ip = token && fingerprint && config.remote.enabled ? await lookupPublicIp() : null;
  return {
    enabled: !!token,
    links,
    summary: shareSummary(getInstance(serverId)),
    publicLink: ip ? make(`${ip}:${config.remote.port}`) : null,
    remote: { enabled: config.remote.enabled, listening: status.listening, port: config.remote.port },
    hasCertificate: !!fingerprint,
  };
}

route('GET', '/api/servers/:id/share', async (ctx) => {
  needServer(ctx, 'addons.share', ctx.params[0]);
  return shareInfo(ctx.params[0]);
});

route('POST', '/api/servers/:id/share', async (ctx) => {
  const p = needServer(ctx, 'addons.share', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!canShare(inst.record.game)) throw new HttpError(400, `${inst.module.name} servers have no share link.`);
  const { enabled, newLink } = await readBody(ctx.req);
  const tokens = shareTokens();
  if (enabled === false) delete tokens[inst.id];
  else if (enabled === true && (!tokens[inst.id] || newLink === true)) tokens[inst.id] = randomBytes(18).toString('base64url');
  writeJson(SHARE_FILE, tokens);
  audit(p, `${enabled === false ? 'stopped sharing' : newLink ? 'made a new share link for' : 'started sharing'} mods of "${inst.record.name}"`);
  return shareInfo(inst.id);
});

// Public (token only): the mod list, and uploaded mod files that aren't on Thunderstore.
route('GET', '/api/share/:token', async (ctx) => {
  const inst = serverForToken(ctx.params[0]);
  return shareManifest(inst);
});

route('GET', '/api/share/:token/file/:name', async (ctx) => {
  const inst = serverForToken(ctx.params[0]);
  const name = ctx.params[1];
  // Other games (Minecraft Java and Palworld mods): only enabled mods players need.
  if (inst.record.game !== 'valheim') {
    const f = await sharedFile(inst, name);
    if (!f) throw new HttpError(404, 'That file is not shared.');
    ctx.res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': statSync(f.file).size, 'Cache-Control': 'no-store' });
    await new Promise<void>((resolve) => createReadStream(f.file).on('error', () => resolve()).on('end', resolve).pipe(ctx.res));
    return undefined;
  }
  if (!/^[\w.-]+\.zip$/.test(name)) throw new HttpError(400, 'Bad file name.');
  // Hexium mods are fetched from Hexium the first time a players' app asks (see ensureHexiumCopy).
  await ensureHexiumCopy(inst.record, name).catch(() => false);
  const full = dataPath('valheim-uploads', inst.id, name);
  if (!existsSync(full)) throw new HttpError(404, 'That file is not shared.');
  ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': statSync(full).size, 'Cache-Control': 'no-store' });
  await new Promise<void>((resolve) => createReadStream(full).on('error', () => resolve()).on('end', resolve).pipe(ctx.res));
  return undefined;
});

route('PUT', '/api/servers/:id/addons/location', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.locations) throw new HttpError(404, 'This game keeps addons in one place only.');
  const { location } = await readBody(ctx.req);
  try {
    addons.locations.set(inst.record, String(location));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `set new addons on "${inst.record.name}" to go in the ${location} folder`);
  return { current: addons.locations.get(inst.record) };
});

// Moves every addon in the other location to `to`, one by one, reporting any that can't move (e.g. a copy is already there).
route('POST', '/api/servers/:id/addons/move-all', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.locations) throw new HttpError(404, 'This game keeps addons in one place only.');
  const { to } = await readBody(ctx.req);
  if (!addons.locations.options.some((o) => o.value === to)) throw new HttpError(400, 'Unknown location.');
  const moved: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const packs = addons.list(inst.record) as { id: string; name: string; location?: string }[];
  for (const pack of packs.filter((x) => x.location && x.location !== to)) {
    try {
      addons.locations.move(inst.record, pack.id, String(to));
      moved.push(pack.name);
    } catch (err) {
      failed.push({ name: pack.name, error: (err as Error).message });
    }
  }
  audit(p, `moved ${moved.length} addon(s) to the ${to} folder on "${inst.record.name}"${failed.length ? ` (${failed.length} failed)` : ''}`);
  return { moved, failed, packs: addons.list(inst.record), running: inst.isRunning };
});

route('POST', '/api/servers/:id/addons/:pack/move', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.locations) throw new HttpError(404, 'This game keeps addons in one place only.');
  const { to } = await readBody(ctx.req);
  try {
    addons.locations.move(inst.record, ctx.params[1], String(to));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `moved addon ${ctx.params[1]} to the ${to} folder on "${inst.record.name}"`);
  return { packs: addons.list(inst.record) };
});

route('GET', '/api/servers/:id/addons/:pack/icon', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  const file = addons.icon(inst.record, ctx.params[1]);
  if (!file) throw new HttpError(404, 'No icon.');
  ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=300' });
  ctx.res.end(Buffer.isBuffer(file) ? file : readFileSync(file));
  return undefined;
});

route('POST', '/api/servers/:id/addons/upload', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  const { file, name } = await receiveUpload(ctx.req);
  try {
    const result = await addons.install(inst.record, file, `upload: ${name}`);
    audit(p, `installed ${name} on "${inst.record.name}"`);
    return { ...result, running: inst.isRunning };
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

/**
 * Rebuilds an uploaded folder. The upload is: 4-byte length (little-endian) of a JSON header
 * {"files":[{"path":"Pack/manifest.json","size":123},...]}, then each file's bytes in that order.
 * Paths must stay inside the folder: no "..", drive letters or absolute paths.
 */
function unpackFolderUpload(file: string, dest: string) {
  const total = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(4);
    if (readSync(fd, lenBuf, 0, 4, 0) !== 4) throw new HttpError(400, 'Empty folder upload.');
    const headerLen = lenBuf.readUInt32LE(0);
    if (headerLen < 2 || headerLen > 8 * 1024 * 1024 || 4 + headerLen > total) throw new HttpError(400, 'Damaged folder upload.');
    const headerBuf = Buffer.alloc(headerLen);
    readSync(fd, headerBuf, 0, headerLen, 4);
    let files: { path: string; size: number }[];
    try {
      files = JSON.parse(headerBuf.toString('utf-8')).files;
    } catch {
      throw new HttpError(400, 'Damaged folder upload.');
    }
    if (!Array.isArray(files) || !files.length) throw new HttpError(400, 'That folder is empty.');
    if (files.length > 50_000) throw new HttpError(400, 'That folder has too many files (50,000 max).');
    const sum = files.reduce((n, f) => n + (Number.isSafeInteger(f?.size) && f.size >= 0 ? f.size : NaN), 0);
    if (!Number.isFinite(sum) || 4 + headerLen + sum !== total) throw new HttpError(400, 'Damaged folder upload (sizes don\'t add up).');
    const root = path.resolve(dest);
    let pos = 4 + headerLen;
    const chunk = Buffer.alloc(1024 * 1024);
    for (const f of files) {
      const parts = String(f.path ?? '').split(/[\\/]+/).filter(Boolean);
      if (!parts.length || parts.some((p) => p === '.' || p === '..' || /[:*?"<>|\x00-\x1f]/.test(p))) throw new HttpError(400, `Bad file name in folder: ${String(f.path).slice(0, 200)}`);
      const target = path.resolve(root, ...parts);
      if (!target.startsWith(root + path.sep)) throw new HttpError(400, 'Bad file name in folder.');
      mkdirSync(path.dirname(target), { recursive: true });
      const out = openSync(target, 'w');
      try {
        let left = f.size;
        while (left > 0) {
          const n = readSync(fd, chunk, 0, Math.min(chunk.length, left), pos);
          if (n <= 0) throw new HttpError(400, 'Damaged folder upload.');
          writeSync(out, chunk, 0, n);
          pos += n;
          left -= n;
        }
      } finally {
        closeSync(out);
      }
    }
  } finally {
    closeSync(fd);
  }
}

route('POST', '/api/servers/:id/addons/upload-folder', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!addons.folders) throw new HttpError(400, `${inst.module.name} ${addons.labels?.(inst.record).plural ?? 'addons'} can't be added as folders. Use the packed file instead.`);
  const { file, name } = await receiveUpload(ctx.req);
  const folderName = name.replace(/\.folder$/i, '');
  const dest = path.join(path.dirname(file), 'folder', folderName);
  try {
    unpackFolderUpload(file, dest);
    const result = await addons.install(inst.record, dest, `folder: ${folderName}`);
    audit(p, `installed folder ${folderName} on "${inst.record.name}"`);
    return { ...result, running: inst.isRunning };
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

route('POST', '/api/servers/:id/addons/:pack/enabled', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  const { enabled } = await readBody(ctx.req);
  addons.setEnabled(inst.record, ctx.params[1], !!enabled);
  audit(p, `${enabled ? 'enabled' : 'disabled'} pack ${ctx.params[1]} on "${inst.record.name}"`);
  return { packs: addons.list(inst.record) };
});

// Load order of active packs (Bedrock). Body: {"type":"behavior"|"resource","ids":[...top first]}.
route('PUT', '/api/servers/:id/addons/order', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!addons.reorder) throw new HttpError(400, `The load order of ${inst.module.name} addons can't be changed.`);
  const { type, ids } = await readBody(ctx.req);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new HttpError(400, 'Send {"type": "...", "ids": [...]}.');
  addons.reorder(inst.record, String(type), ids);
  audit(p, `changed the ${type} pack order on "${inst.record.name}"`);
  return { packs: addons.list(inst.record), running: inst.isRunning };
});

route('DELETE', '/api/servers/:id/addons/:pack', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  addons.remove(inst.record, ctx.params[1]);
  audit(p, `removed pack ${ctx.params[1]} from "${inst.record.name}"`);
  return { packs: addons.list(inst.record) };
});

route('GET', '/api/servers/:id/addons/curseforge/search', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { addons } = addonsOf(ctx.params[0]);
  if (!addons.curseforgeGame) throw new HttpError(404, 'No CurseForge browsing for this game.');
  const url = new URL(ctx.req.url ?? '', 'http://x');
  return searchProjects(addons.curseforgeGame, url.searchParams.get('q') ?? '', Number(url.searchParams.get('page')) || 0);
});

route('POST', '/api/servers/:id/addons/curseforge', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  const { projectId } = await readBody(ctx.req);
  const file = await latestFile(Number(projectId));
  if (!file.downloadUrl) {
    return { needsBrowser: true, url: file.projectUrl, message: `The author of "${file.name}" only allows downloads from the CurseForge website.` };
  }
  const dir = path.join(os.tmpdir(), `tavernhost-cf-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  try {
    const local = path.join(dir, path.basename(file.fileName).replace(/[^\w.\- ]/g, '_'));
    await downloadFile(file.downloadUrl, local);
    const result = await addons.install(inst.record, local, `CurseForge: ${file.name}`);
    // Bedrock: remember where these packs came from, for update checks.
    const uuids = (result as { uuids?: string[] }).uuids;
    if (inst.record.game === 'bedrock' && uuids?.length) {
      linkPacks(inst.record.installDir, uuids, { projectId: Number(projectId), name: file.name, url: file.projectUrl, fileId: file.fileId, fileDate: file.fileDate });
    }
    audit(p, `installed "${file.name}" from CurseForge on "${inst.record.name}"`);
    return { ...result, running: inst.isRunning };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Adds a mod by ID or link (games whose mods come from somewhere like the Steam Workshop). Body: {"input": "..."}.
route('POST', '/api/servers/:id/addons/by-id', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0]);
  if (!addons.addById) throw new HttpError(404, 'This game adds mods from files.');
  const { input } = await readBody(ctx.req);
  let result;
  try {
    result = await addons.addById(inst.record, String(input ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `added mod ${String(input).slice(0, 120)} on "${inst.record.name}"`);
  return { ...result, packs: addons.list(inst.record), running: inst.isRunning };
});

// ---------- BungeeCord network (the servers behind a proxy) ----------

function proxyOf(id: string) {
  const inst = getInstance(id);
  if (inst.record.game !== 'java' || inst.record.settings.flavor !== 'bungeecord') throw new HttpError(404, 'That server is not a BungeeCord proxy.');
  return inst;
}

/** Server Forge's Minecraft Java servers that could go behind this proxy (this system's and the nodes'), with their address. */
function proxyCandidates(p: Principal, proxyId: string) {
  const local = listInstances()
    .filter((i) => i.id !== proxyId && i.record.game === 'java' && i.record.settings.flavor !== 'bungeecord' && can(p, 'view', i.id))
    .map((i) => {
      const port = i.module.connection?.(i.record)?.port ?? 25565;
      return { id: i.id, name: i.record.name, flavor: String(i.record.settings.flavor), address: `127.0.0.1:${port}`, node: null as string | null, suggested: proxyName(i.record.name), canPrepare: ['paper', 'spigot'].includes(String(i.record.settings.flavor)) };
    });
  const remote = (remoteServers() as { id: string; name: string; game: string; settings?: Record<string, unknown>; connection?: { ip?: string; port?: number }; node?: { name?: string } }[])
    .filter((s) => s.game === 'java' && s.settings?.flavor !== 'bungeecord' && s.connection?.ip && s.connection?.port && can(p, 'view', s.id))
    .map((s) => ({ id: s.id, name: s.name, flavor: String(s.settings?.flavor ?? ''), address: `${s.connection!.ip}:${s.connection!.port}`, node: s.node?.name ?? 'node', suggested: proxyName(s.name), canPrepare: false }));
  return [...local, ...remote];
}

route('GET', '/api/servers/:id/network', async (ctx) => {
  const p = needServer(ctx, 'view', ctx.params[0]);
  const inst = proxyOf(ctx.params[0]);
  let current;
  try {
    current = listProxyServers(inst.record);
  } catch (err) {
    return { servers: [], priorities: [], candidates: proxyCandidates(p, inst.id), error: (err as Error).message };
  }
  return { ...current, candidates: proxyCandidates(p, inst.id), running: inst.isRunning };
});

// Body: {"serverId"?: "<a Server Forge server>", "name": "survival", "address"?: "host:port", "first"?: true, "prepare"?: true}.
// With serverId the address is filled in; prepare also sets that (Paper/Spigot) server up for the proxy.
route('POST', '/api/servers/:id/network', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = proxyOf(ctx.params[0]);
  const body = await readBody(ctx.req);
  let address = String(body.address ?? '');
  const notes: string[] = [];
  if (body.serverId) {
    const c = proxyCandidates(p, inst.id).find((x) => x.id === String(body.serverId));
    if (!c) throw new HttpError(404, 'That server is not one of your Minecraft Java servers.');
    address = c.address;
    if (body.prepare) {
      if (!c.canPrepare) throw new HttpError(400, 'Only Paper and Spigot servers on this system can be set up for BungeeCord automatically.');
      needServer(ctx, 'properties.edit', c.id);
      notes.push(...prepareBackend(getInstance(c.id).record));
      if (getInstance(c.id).isRunning) notes.push(`Restart ${c.name} to apply that.`);
    }
  }
  try {
    addProxyServer(inst.record, { name: String(body.name ?? ''), address, first: !!body.first, motd: body.motd ? String(body.motd) : undefined });
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  if (inst.isRunning) notes.push('Restart the proxy to load the change.');
  audit(p, `added ${body.name} (${address}) to BungeeCord "${inst.record.name}"`);
  return { ...listProxyServers(inst.record), notes };
});

route('DELETE', '/api/servers/:id/network/:name', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = proxyOf(ctx.params[0]);
  try {
    removeProxyServer(inst.record, ctx.params[1]);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `removed ${ctx.params[1]} from BungeeCord "${inst.record.name}"`);
  return listProxyServers(inst.record);
});

// Body: {"name": "survival"}: the server players land on first.
route('PUT', '/api/servers/:id/network/default', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const inst = proxyOf(ctx.params[0]);
  const { name } = await readBody(ctx.req);
  try {
    setDefaultProxyServer(inst.record, String(name ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `made ${name} the first server of BungeeCord "${inst.record.name}"`);
  return listProxyServers(inst.record);
});

// ---------- Bedrock addon updates (CurseForge) ----------

function bedrockAddons(id: string) {
  const { inst, addons } = addonsOf(id);
  if (inst.record.game !== 'bedrock') throw new HttpError(404, 'Addon links and update settings are for Bedrock servers.');
  return { inst, addons };
}

// Body: {"projectId": 123} links the pack (and the other packs from the same file) to that CurseForge project; the
// installed file counts as the version from that moment, so newer files on CurseForge show as updates. {"projectId": null} unlinks.
route('POST', '/api/servers/:id/addons/:pack/curseforge', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = bedrockAddons(ctx.params[0]);
  const pack = (addons.list(inst.record) as { id: string; uuid: string; name: string; installedAt: number | null }[]).find((x) => x.id === ctx.params[1]);
  if (!pack) throw new HttpError(404, 'That addon is not installed.');
  const { projectId } = await readBody(ctx.req);
  if (projectId === null) {
    unlinkPack(inst.record.installDir, pack.uuid);
    audit(p, `unlinked addon "${pack.name}" from CurseForge on "${inst.record.name}"`);
    return { packs: addons.list(inst.record) };
  }
  const id = Number(projectId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Pick a CurseForge project.');
  const latest = await newestFile(id, 'alpha').catch((err) => {
    throw new HttpError(400, (err as Error).message);
  });
  // Packs installed from the same file (e.g. its behavior and resource pack) share the link.
  const same = (addons.list(inst.record) as { uuid: string; installedAt: number | null }[]).filter((x) => x.installedAt && pack.installedAt && Math.abs(x.installedAt - pack.installedAt) < 5000).map((x) => x.uuid);
  linkPacks(inst.record.installDir, [...new Set([pack.uuid, ...same])], { projectId: id, name: latest.name, url: latest.url, fileId: null, fileDate: new Date(pack.installedAt ?? Date.now()).toISOString() });
  audit(p, `linked addon "${pack.name}" to CurseForge project "${latest.name}" on "${inst.record.name}"`);
  return { packs: addons.list(inst.record) };
});

route('GET', '/api/servers/:id/addons/update-settings', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst } = bedrockAddons(ctx.params[0]);
  return getUpdateSettings(inst.record.installDir);
});

// Body: {"channel": "release" | "beta" | "alpha", "auto": true}.
route('PUT', '/api/servers/:id/addons/update-settings', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst } = bedrockAddons(ctx.params[0]);
  let next;
  try {
    next = setUpdateSettings(inst.record.installDir, await readBody(ctx.req));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `set addon updates on "${inst.record.name}" to ${next.channel}${next.auto ? ', automatic' : ''}`);
  return next;
});

// Valheim and Palworld: install a Nexus Mods file. Body: {"input": "nxm://valheim/mods/…" | "https://www.nexusmods.com/valheim/mods/…"}.
// Needs the Nexus API key (Settings → Integrations); a mod page address needs a Premium account.
route('POST', '/api/servers/:id/addons/nexus', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst, addons } = addonsOf(ctx.params[0], true);
  if (!NEXUS_GAMES[inst.record.game]) throw new HttpError(400, 'Nexus Mods downloads are for Valheim and Palworld servers.');
  const key = nexusKey();
  if (!key) throw new HttpError(400, 'Add your Nexus Mods API key first (Settings → Integrations).');
  const { input } = await readBody(ctx.req);
  const dir = path.join(os.tmpdir(), `tavernhost-nexus-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  try {
    const local = path.join(dir, 'mod.zip');
    let info;
    try {
      info = await downloadNexus(String(input ?? ''), local, key, NEXUS_APP, (l) => inst.log(l), inst.record.game);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const result = await addons.install(inst.record, local, `Nexus Mods: ${info.modName}`, nexusPackage(info));
    audit(p, `installed "${info.modName}" ${info.version} from Nexus Mods on "${inst.record.name}"`);
    return { ...result, running: inst.isRunning };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Valheim: install a mod from Hexium. Body: {"input": "https://valheim.hexium.gg/mods/Author/Mod"} or
// {"namespace", "name", "version"?} (the desktop app's browser window sends those).
route('POST', '/api/servers/:id/addons/hexium', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst } = addonsOf(ctx.params[0], true);
  if (inst.record.game !== 'valheim') throw new HttpError(400, 'Hexium mods are for Valheim servers.');
  const body = await readBody(ctx.req);
  const pkg = body.input ? parseHexiumUrl(String(body.input)) : body.namespace && body.name ? { namespace: String(body.namespace), name: String(body.name), version: body.version ? String(body.version) : null } : null;
  if (!pkg || !/^[\w.]+$/.test(pkg.namespace) || !/^[\w.]+$/.test(pkg.name)) throw new HttpError(400, 'Paste a Hexium mod page address, e.g. https://valheim.hexium.gg/mods/Author/ModName');
  let result;
  try {
    result = await installFromHexium(inst.record, pkg);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `installed ${pkg.namespace}-${pkg.name}${pkg.version ? ` ${pkg.version}` : ''} from Hexium on "${inst.record.name}"`);
  return { ...result, running: inst.isRunning };
});

// Valheim: take over mods put on the server without Server Forge (r2modman, by hand), so they can be shared.
route('POST', '/api/servers/:id/addons/adopt', async (ctx) => {
  const p = needServer(ctx, 'addons.manage', ctx.params[0]);
  const { inst } = addonsOf(ctx.params[0], true);
  if (inst.record.game !== 'valheim') throw new HttpError(400, 'Only Valheim mods can be taken over this way.');
  const r = await adoptManualMods(inst.record);
  audit(p, `took over ${r.adopted.length} manually added mod(s) on "${inst.record.name}"`);
  return r;
});

// ---------- Valheim profiles (world + mods) ----------

function valheimOnly(id: string) {
  const inst = getInstance(id);
  if (inst.record.game !== 'valheim') throw new HttpError(404, 'Profiles are for Valheim servers.');
  return inst;
}

route('GET', '/api/servers/:id/profiles', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  return profilesInfo(valheimOnly(ctx.params[0]).record);
});

// Body: {"name", "world"?, "vanilla"?}. Starts as a copy of how the server is set up now.
route('POST', '/api/servers/:id/profiles', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = valheimOnly(ctx.params[0]);
  const body = await readBody(ctx.req);
  try {
    createProfile(inst.record, body);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `added profile "${body.name}" to "${inst.record.name}"`);
  return profilesInfo(inst.record);
});

route('PUT', '/api/servers/:id/profiles/:profile', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = valheimOnly(ctx.params[0]);
  const body = await readBody(ctx.req);
  let r;
  try {
    r = updateProfile(inst.record, ctx.params[1], body);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  // Editing the active profile changes the server itself (world from the next start; the loader right away).
  if (r.isActive) {
    if (body.world !== undefined) updateServer(inst.id, { settings: { ...inst.record.settings, world: r.profile.world } });
    if (body.vanilla !== undefined && vmBepinexInstalled(inst.record.installDir)) setLoaderEnabled(inst.record.installDir, !r.profile.vanilla);
  }
  audit(p, `changed profile "${r.profile.name}" of "${inst.record.name}"`);
  return profilesInfo(inst.record);
});

route('DELETE', '/api/servers/:id/profiles/:profile', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = valheimOnly(ctx.params[0]);
  try {
    deleteProfile(inst.record, ctx.params[1]);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `deleted a profile of "${inst.record.name}"`);
  return profilesInfo(inst.record);
});

// Body: {"restart"?: true}. A running server has to restart to switch (answered with 409 unless restart is true).
route('POST', '/api/servers/:id/profiles/:profile/activate', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = valheimOnly(ctx.params[0]);
  if (inst.isRunning) needServer(ctx, 'control.restart', ctx.params[0]);
  const { restart } = await readBody(ctx.req);
  const wasRunning = inst.isRunning;
  if (wasRunning && !restart) throw new HttpError(409, 'The server is running: it restarts to switch profiles.');
  if (wasRunning) await inst.stop();
  let applied;
  try {
    applied = applyProfile(inst.record, ctx.params[1], (full) => placeOnServer(inst.record, full));
  } catch (err) {
    if (wasRunning) inst.start().catch(() => {});
    throw new HttpError(400, (err as Error).message);
  }
  updateServer(inst.id, { settings: { ...inst.record.settings, world: applied.world } });
  inst.log(`Profile "${applied.profile.name}" active: world ${applied.world}, ${applied.profile.vanilla ? 'vanilla (mods off)' : `${applied.profile.disabled.length} mod(s) switched off`}.`);
  audit(p, `switched "${inst.record.name}" to profile "${applied.profile.name}"`);
  if (wasRunning) inst.start().catch((err) => inst.log(`Start after switching profiles failed: ${(err as Error).message}`));
  return profilesInfo(inst.record);
});

route('GET', '/api/settings/integrations', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  return { curseforge: !!curseforgeKey(), nexus: nexusUser(), factorio: factorioStatus() };
});

// factorio.com login (Factorio server downloads and mod portal). Body: {"username","token"}; both "" removes it.
route('PUT', '/api/settings/integrations/factorio', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const { username, token } = await readBody(ctx.req);
  try {
    await setFactorioLogin(String(username ?? ''), String(token ?? ''));
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, username ? `set the factorio.com login (${String(username).slice(0, 60)})` : 'removed the factorio.com login');
  return factorioStatus();
});

// Takes the login the Factorio game saved on this system (%APPDATA%\Factorio\player-data.json).
route('POST', '/api/settings/integrations/factorio/import', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  let login;
  try {
    login = await importFactorioLogin();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `imported the factorio.com login from this system (${login?.username})`);
  return factorioStatus();
});

// Body: {"curseforgeKey"?: string|null, "nexusKey"?: string|null} (only the keys sent are changed; "" removes).
route('PUT', '/api/settings/integrations', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const body = await readBody(ctx.req);
  if ('curseforgeKey' in body) {
    await setCurseforgeKey(body.curseforgeKey);
    audit(p, body.curseforgeKey ? 'set the CurseForge API key' : 'removed the CurseForge API key');
  }
  if ('nexusKey' in body) {
    try {
      await setNexusKey(body.nexusKey);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    audit(p, body.nexusKey ? 'set the Nexus Mods API key' : 'removed the Nexus Mods API key');
  }
  return { curseforge: !!curseforgeKey(), nexus: nexusUser() };
});

// ---------- Discord notifications (per server, through a webhook) ----------
// The webhook address lets anyone post to that channel, so it's treated like a setting: "Change settings" to see it.

route('GET', '/api/servers/:id/discord', async (ctx) => {
  needServer(ctx, 'settings.edit', ctx.params[0]);
  return { ...getDiscord(ctx.params[0]), labels: NOTIFY_EVENTS };
});

// Body: {"url": "https://discord.com/api/webhooks/…" | "", "events": {"started": true, …}}. An empty url turns it off.
route('PUT', '/api/servers/:id/discord', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const body = await readBody(ctx.req);
  let s;
  try {
    s = setDiscord(inst.id, body);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, s.url ? `set Discord notifications for "${inst.record.name}"` : `turned off Discord notifications for "${inst.record.name}"`);
  return { ...s, labels: NOTIFY_EVENTS };
});

// Body: {"url"?: "…"} (a webhook not saved yet), else the saved one.
route('POST', '/api/servers/:id/discord/test', async (ctx) => {
  needServer(ctx, 'settings.edit', ctx.params[0]);
  const { url } = await readBody(ctx.req);
  try {
    await testDiscord(ctx.params[0], url ? String(url) : undefined);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return { ok: true };
});

// ---------- backups ----------

route('GET', '/api/servers/:id/backups', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const copy = getCopySettings();
  return {
    backups: listBackups(inst.id),
    folder: backupsFolder(inst.id),
    // Copies on another drive/share (see Settings -> Backup copies).
    copies: copy.folder ? listCopies(inst.record) : [],
    copyFolder: copy.enabled && copy.folder ? copyFolderFor(inst.record) : null,
  };
});

route('POST', '/api/servers/:id/backups/copies/:file/bring-back', async (ctx) => {
  const p = needServer(ctx, 'backups.restore', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const info = await bringBackCopy(inst.record, decodeURIComponent(ctx.params[1]));
  audit(p, `copied backup ${info.file} back to this system for "${inst.record.name}"`);
  return { backup: info, backups: listBackups(inst.id) };
});

// ---------- backup copies (panel-wide) ----------

route('GET', '/api/settings/backup-copy', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  return getCopySettings();
});

// Body: {"enabled", "folder", "keepDays"}.
route('PUT', '/api/settings/backup-copy', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const next = setCopySettings(await readBody(ctx.req));
  audit(p, `backup copies ${next.enabled ? `on, to ${next.folder}, kept ${next.keepDays} days` : 'off'}`);
  return next;
});

route('POST', '/api/settings/backup-copy/test', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  const { folder } = await readBody(ctx.req);
  const f = String(folder ?? getCopySettings().folder).trim();
  if (!f || !path.isAbsolute(f)) throw new HttpError(400, 'Use a full folder path.');
  return { ok: true, free: testCopyFolder(f) };
});

// Copies every existing backup that isn't there yet (in the background; progress in each server's console).
route('POST', '/api/settings/backup-copy/sync', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const copy = getCopySettings();
  if (!copy.enabled || !copy.folder) throw new HttpError(400, 'Turn on backup copies first.');
  (async () => {
    for (const inst of listInstances()) {
      try {
        const n = await copyAllToOffsite(inst.record);
        if (n) inst.log(`Copied ${n} existing backup${n === 1 ? '' : 's'} to ${copyFolderFor(inst.record)}.`);
        events.emit('backup-copy', { serverId: inst.id, ok: true });
      } catch (err) {
        events.emit('backup-copy', { serverId: inst.id, ok: false, error: (err as Error).message, folder: copy.folder });
      }
    }
  })();
  audit(p, 'copied existing backups to the backup copy folder');
  return {};
});

route('POST', '/api/servers/:id/backups', async (ctx) => {
  const p = needServer(ctx, 'backups.create', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  inst.backupNow('manual');
  audit(p, `started a backup of "${inst.record.name}"`);
  return inst.snapshot();
});

route('POST', '/api/servers/:id/backups/:backup/restore', async (ctx) => {
  const p = needServer(ctx, 'backups.restore', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  inst.restore(ctx.params[1]);
  audit(p, `started restoring backup ${ctx.params[1]} of "${inst.record.name}"`);
  return inst.snapshot();
});

route('DELETE', '/api/servers/:id/backups/:backup', async (ctx) => {
  const p = needServer(ctx, 'backups.delete', ctx.params[0]);
  deleteBackup(ctx.params[0], ctx.params[1]);
  audit(p, `deleted backup ${ctx.params[1]} of "${getInstance(ctx.params[0]).record.name}"`);
  return { backups: listBackups(ctx.params[0]) };
});

// ---------- world checks (Bedrock) ----------

route('GET', '/api/servers/:id/world-check', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  return worldCheckInfo(ctx.params[0]);
});

route('POST', '/api/servers/:id/world-check', async (ctx) => {
  const p = needServer(ctx, 'backups.create', ctx.params[0]);
  await checkNow(ctx.params[0]);
  audit(p, `started a world check of "${getInstance(ctx.params[0]).record.name}"`);
  return worldCheckInfo(ctx.params[0]);
});

// The flagged changes are intended (e.g. chunks trimmed on purpose): make the world as it is now the reference.
route('POST', '/api/servers/:id/world-check/accept', async (ctx) => {
  const p = needServer(ctx, 'backups.restore', ctx.params[0]);
  acceptCurrent(ctx.params[0]);
  audit(p, `accepted the world of "${getInstance(ctx.params[0]).record.name}" as it is now (world check)`);
  return worldCheckInfo(ctx.params[0]);
});

route('GET', '/api/servers/:id/lists/:list', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!inst.module.readAccessList) throw new HttpError(404, 'This game has no access lists.');
  return { entries: inst.module.readAccessList(inst.record, ctx.params[1]), knownPlayers: inst.knownPlayers() };
});

route('PUT', '/api/servers/:id/lists/:list', async (ctx) => {
  const p = needServer(ctx, 'access.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (!inst.module.writeAccessList) throw new HttpError(404, 'This game has no access lists.');
  const { entries } = await readBody(ctx.req);
  if (!Array.isArray(entries)) throw new HttpError(400, 'entries must be a list.');
  const followUp = (await inst.module.writeAccessList(inst.record, ctx.params[1], entries.map(String), inst.status === 'running')) ?? [];
  audit(p, `changed the ${ctx.params[1]} list of "${inst.record.name}"`);
  // Tell a running server to reload the list (e.g. "allowlist reload"), so no restart is needed.
  let reloaded = false;
  if (followUp.length && inst.status === 'running') {
    for (const cmd of followUp) await inst.sendCommand(cmd).catch(() => {});
    reloaded = true;
    // Give the server a moment to write the file before reading it back.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { entries: inst.module.readAccessList!(inst.record, ctx.params[1]), reloaded };
});

// ---------- file browser (sees the whole file system, so it's a separate right) ----------

function foldersInUse(): string[] {
  return listInstances()
    .filter((i) => i.pid && i.status !== 'stopped' && i.status !== 'crashed')
    .flatMap((i) => [i.record.installDir, String(i.record.settings.saveDir ?? '')])
    .filter(Boolean);
}

route('GET', '/api/files', async (ctx) => {
  needGlobal(ctx, 'files.browse');
  return files.listDir(new URL(ctx.req.url ?? '', 'http://x').searchParams.get('path') ?? '');
});

route('POST', '/api/files/mkdir', async (ctx) => {
  const p = needGlobal(ctx, 'files.browse');
  const { parent, name } = await readBody(ctx.req);
  const created = files.makeDir(parent, name);
  audit(p, `created folder ${created}`);
  return { path: created };
});

route('POST', '/api/files/rename', async (ctx) => {
  const p = needGlobal(ctx, 'files.browse');
  const { path: target, name } = await readBody(ctx.req);
  const renamed = files.renameEntry(target, name, foldersInUse());
  audit(p, `renamed ${target} -> ${renamed}`);
  return { path: renamed };
});

route('POST', '/api/files/delete', async (ctx) => {
  const p = needGlobal(ctx, 'files.browse');
  const { path: target } = await readBody(ctx.req);
  await files.deleteEntry(target, foldersInUse());
  audit(p, `deleted ${target} (Recycle Bin)`);
  return {};
});

// ---------- crash checker ----------

route('POST', '/api/servers/:id/diagnose', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  try {
    return getInstance(ctx.params[0]).diagnoseNow();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
});

route('DELETE', '/api/servers/:id/diagnose', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  getInstance(ctx.params[0]).clearDiagnosis();
  return {};
});

// One-click fix from the crash checker (Bedrock): install the Microsoft Visual C++ runtime on the server's system.
// Windows asks for admin rights there; waits until the installer is done (a minute or two).
route('POST', '/api/servers/:id/vcredist', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  let message: string;
  try {
    message = await installVcRedist(inst.record.installDir);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `installed the Visual C++ runtime for "${inst.record.name}"`);
  // The finding is fixed: check again so the Overview card shows what's left (if anything).
  try {
    inst.diagnoseNow();
  } catch {}
  return { message };
});

// One-click fix from the crash checker: accept the Minecraft EULA.
route('POST', '/api/servers/:id/eula', async (ctx) => {
  const p = needServer(ctx, 'settings.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  if (inst.record.game !== 'java') throw new HttpError(400, 'Only Minecraft Java servers use eula.txt.');
  writeEula(inst.record.installDir);
  audit(p, `accepted the Minecraft EULA for "${inst.record.name}"`);
  return {};
});

// ---------- task scheduler ----------

route('GET', '/api/servers/:id/tasks', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  return { tasks: listTasks(inst.id), canCommand: !!inst.module.commands, canBackup: !!inst.module.backup, now: Date.now() };
});

route('POST', '/api/servers/:id/tasks', async (ctx) => {
  const p = needServer(ctx, 'tasks.edit', ctx.params[0]);
  const body = await readBody(ctx.req);
  let task;
  try {
    task = createTask(ctx.params[0], body);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `created task "${task.name}" on ${ctx.params[0]}`);
  return task;
});

route('PUT', '/api/servers/:id/tasks/:task', async (ctx) => {
  const p = needServer(ctx, 'tasks.edit', ctx.params[0]);
  const body = await readBody(ctx.req);
  let task;
  try {
    task = updateTask(ctx.params[0], ctx.params[1], body);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `edited task "${task.name}" on ${ctx.params[0]}`);
  return task;
});

route('DELETE', '/api/servers/:id/tasks/:task', async (ctx) => {
  const p = needServer(ctx, 'tasks.edit', ctx.params[0]);
  try {
    deleteTask(ctx.params[0], ctx.params[1]);
  } catch (err) {
    throw new HttpError(404, (err as Error).message);
  }
  audit(p, `deleted task ${ctx.params[1]} on ${ctx.params[0]}`);
  return {};
});

route('POST', '/api/servers/:id/tasks/:task/run', async (ctx) => {
  const p = needServer(ctx, 'tasks.run', ctx.params[0]);
  try {
    runTaskNow(ctx.params[0], ctx.params[1]);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `ran task ${ctx.params[1]} on ${ctx.params[0]}`);
  return {};
});

// ---------- players ----------

route('GET', '/api/servers/:id/players', async (ctx) => {
  const viewer = needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const live = inst.liveState();
  const running = inst.status === 'running';
  const since = new Map(live.players.map((p) => [p.name.toLowerCase(), p.joinedAt]));
  // Valheim: which list files each player is in (admins / banned / allow list), by their platform ID.
  const lists = inst.record.game === 'valheim' ? valheimListState(inst) : null;
  return {
    game: inst.record.game,
    running,
    maxPlayers: inst.module.connection?.(inst.record)?.maxPlayers ?? null,
    players: knownPlayers(inst.id).map((p) => ({ ...p, joinedAt: p.online ? (since.get(p.name.toLowerCase()) ?? null) : null, ...(lists ? lists(p.id) : {}) })),
    // Which player actions this server has (the page shows only these).
    actions: playerActions(inst),
    canManage: can(viewer, 'access.edit', inst.id),
  };
});

// Valheim has no console: admins, bans and the allow list are its list files (adminlist.txt etc.), one player ID per
// line. Server Forge knows each player's ID from the log ("Steam_7656…", "Xbox_…"). Steam players are written in both
// forms (with and without "Steam_"), which every Valheim version accepts.
const VALHEIM_LIST_ACTIONS: Record<string, { list: string; add: boolean; done: string }> = {
  'admin-add': { list: 'admins', add: true, done: 'is now an admin' },
  'admin-remove': { list: 'admins', add: false, done: 'is no longer an admin' },
  'list-ban': { list: 'banned', add: true, done: 'is banned' },
  'list-unban': { list: 'banned', add: false, done: 'is unbanned' },
  'permit-add': { list: 'permitted', add: true, done: 'is on the allow list' },
  'permit-remove': { list: 'permitted', add: false, done: 'is off the allow list' },
};
const idForms = (id: string) => {
  const steam = /^(?:Steam_)?(\d{17})$/.exec(id);
  return steam ? [`Steam_${steam[1]}`, steam[1]] : [id];
};
function valheimListState(inst: ReturnType<typeof getInstance>) {
  const read = (list: string) => new Set((inst.module.readAccessList?.(inst.record, list) ?? []).map((e) => e.toLowerCase()));
  const [admins, banned, permitted] = [read('admins'), read('banned'), read('permitted')];
  const inList = (set: Set<string>, id: string | null) => !!id && idForms(id).some((f) => set.has(f.toLowerCase()));
  return (id: string | null) => ({ admin: inList(admins, id), banned: inList(banned, id), permitted: inList(permitted, id), allowListOn: permitted.size > 0 });
}

/** Player actions per game. Bedrock has no ban command; mute needs the Bedrock chat relay; Valheim edits its list files. */
function playerActions(inst: ReturnType<typeof getInstance>): string[] {
  const out = ['note'];
  if (inst.record.game === 'valheim') return [...out, ...Object.keys(VALHEIM_LIST_ACTIONS)];
  if (inst.record.game.startsWith('terraria')) return [...out, 'kick', 'ban'];
  // Games that list their own player commands (Factorio, Project Zomboid, 7 Days to Die).
  if (inst.module.playerCommands) return [...out, ...Object.keys(inst.module.playerCommands)];
  if (!inst.module.commands) return out;
  out.push('kick', 'op', 'deop');
  if (inst.record.game === 'java') out.push('whitelist-add', 'whitelist-remove', 'ban', 'pardon');
  if (inst.record.game === 'bedrock') {
    out.push('allowlist-add', 'allowlist-remove');
    if (inst.module.chat?.status(inst.record).on) out.push('mute', 'unmute');
  }
  return out;
}

// Body: {"action": "kick"|"op"|"deop"|"allowlist-add"|"allowlist-remove"|"whitelist-add"|"whitelist-remove"|"ban"|
// "pardon"|"mute"|"unmute"|"note", "reason"?: "...", "note"?: "..."}.
route('POST', '/api/servers/:id/players/:name/action', async (ctx) => {
  const p = needServer(ctx, 'access.edit', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const name = decodeURIComponent(ctx.params[1]).trim();
  if (!name || name.length > 64 || /["\r\n]/.test(name)) throw new HttpError(400, 'Bad player name.');
  const { action, reason, note } = await readBody(ctx.req);
  const a = String(action ?? '');
  if (!playerActions(inst).includes(a)) throw new HttpError(400, `"${a}" isn't available on this server.`);
  if (a === 'note') {
    setPlayerNote(inst.id, name, String(note ?? ''));
    audit(p, `${String(note ?? '').trim() ? 'set a note on' : 'cleared the note on'} ${name} ("${inst.record.name}")`);
    return {};
  }
  if (a === 'mute' || a === 'unmute') {
    setPlayerMuted(inst.id, name, a === 'mute');
    if (inst.isRunning) await inst.sendMutes();
    audit(p, `${a}d ${name} on "${inst.record.name}"`);
    return {};
  }
  const listAction = inst.record.game === 'valheim' ? VALHEIM_LIST_ACTIONS[a] : undefined;
  if (listAction) {
    const id = knownPlayers(inst.id).find((x) => x.name.toLowerCase() === name.toLowerCase())?.id;
    if (!id) throw new HttpError(400, `Server Forge hasn't seen ${name}'s player ID yet (it's picked up when they join). Add it in the Access tab instead.`);
    const forms = idForms(id);
    const current = inst.module.readAccessList!(inst.record, listAction.list);
    const lower = new Set(forms.map((f) => f.toLowerCase()));
    const next = listAction.add ? [...current.filter((e) => !lower.has(e.toLowerCase())), ...forms] : current.filter((e) => !lower.has(e.toLowerCase()));
    await inst.module.writeAccessList!(inst.record, listAction.list, next, inst.isRunning);
    audit(p, `${name} ${listAction.done} on "${inst.record.name}" (${forms[0]})`);
    return { message: `${name} ${listAction.done}.${inst.isRunning ? ' Valheim picks it up when they (re)join.' : ''}` };
  }
  if (!inst.isRunning) throw new HttpError(409, 'The server is not running.');
  // Terraria's console takes the plain name ("kick Some Player"); Minecraft wants it quoted.
  const q = inst.record.game.startsWith('terraria') ? name : `"${name}"`;
  const why = inst.record.game.startsWith('terraria') ? '' : String(reason ?? '').replace(/[\r\n"]/g, ' ').trim().slice(0, 120);
  const own = inst.module.playerCommands?.[a as keyof NonNullable<typeof inst.module.playerCommands>];
  const cmd = own ? own(name, why) : {
    kick: `kick ${q}${why ? ` ${why}` : ''}`,
    op: `op ${q}`,
    deop: `deop ${q}`,
    'allowlist-add': `allowlist add ${q}`,
    'allowlist-remove': `allowlist remove ${q}`,
    'whitelist-add': `whitelist add ${name}`,
    'whitelist-remove': `whitelist remove ${name}`,
    ban: `ban ${name}${why ? ` ${why}` : ''}`,
    pardon: `pardon ${name}`,
  }[a];
  if (!cmd) throw new HttpError(400, 'Unknown action.');
  await inst.sendCommand(cmd);
  audit(p, `${a} ${name} on "${inst.record.name}"${why ? ` (${why})` : ''}`);
  return {};
});

// ---------- CPU / RAM ----------

// Latest numbers for every running server this principal can see (sidebar mini view).
route('GET', '/api/stats', async (ctx) => {
  const p = need(ctx);
  const out: Record<string, { cpu: number | null; mem: number | null; limit: number }> = {};
  for (const inst of listInstances()) {
    if (!can(p, 'view', inst.id) || !inst.pid || inst.status === 'stopped' || inst.status === 'crashed') continue;
    const st = serverStats(inst.id, 30);
    const limit = inst.module.memoryLimit?.(inst.record);
    out[inst.id] = { cpu: st.cpu, mem: st.mem, limit: limit ? limit.mb * 1024 * 1024 : st.systemMem };
  }
  // Nodes: their numbers too, ids rewritten.
  await Promise.all(
    listNodes()
      .filter((n) => n.online)
      .map(async (n) => {
        try {
          const st = await nodeJson<typeof out>(getNode(n.id), 'GET', '/api/stats');
          for (const [id, v] of Object.entries(st ?? {})) if (can(p, 'view', remoteId(n.id, id))) out[remoteId(n.id, id)] = v;
        } catch {}
      }),
  );
  return out;
});

route('GET', '/api/servers/:id/stats', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  const limit = inst.module.memoryLimit?.(inst.record) ?? null;
  const range = Math.min(86_400, Math.max(30, Number(new URL(ctx.req.url ?? '', 'http://x').searchParams.get('range')) || 300));
  return {
    running: !!inst.pid && inst.status !== 'stopped' && inst.status !== 'crashed',
    startedAt: inst.startedAt,
    maxPlayers: inst.module.connection?.(inst.record)?.maxPlayers ?? null,
    range,
    ...serverStats(inst.id, range),
    limit: limit ? { bytes: limit.mb * 1024 * 1024, label: limit.label, note: limit.note } : null,
    noLimitNote: limit
      ? null
      : `${inst.module.name} has no setting for how much RAM it may use: it takes what it needs. Shown against this system's total RAM.`,
  };
});

// ---------- world settings (Bedrock experiments + cheats) ----------

function worldOf(id: string) {
  const inst = getInstance(id);
  if (!inst.module.world) throw new HttpError(404, `${inst.module.name} servers have no world settings here.`);
  return { inst, world: inst.module.world };
}

route('GET', '/api/servers/:id/world', async (ctx) => {
  needServer(ctx, 'view', ctx.params[0]);
  const { inst, world } = worldOf(ctx.params[0]);
  try {
    return { ...(world.read(inst.record) as object), running: inst.isRunning };
  } catch (err) {
    throw new HttpError(400, `Couldn't read the world settings: ${(err as Error).message}`);
  }
});

// The server rewrites level.dat when it stops, so edits happen while it's stopped. With restart: true a running server
// is stopped (saving the world), changed, and started again.
route('PUT', '/api/servers/:id/world', async (ctx) => {
  const p = needServer(ctx, 'properties.edit', ctx.params[0]);
  const { inst, world } = worldOf(ctx.params[0]);
  const { cheats, experiments, cheatSettings, force, restart } = await readBody(ctx.req);
  const changes = {
    cheats: typeof cheats === 'boolean' ? cheats : undefined,
    experiments: experiments && typeof experiments === 'object' ? Object.fromEntries(Object.entries(experiments).map(([k, v]) => [k, !!v])) : undefined,
    cheatSettings:
      cheatSettings && typeof cheatSettings === 'object'
        ? (Object.fromEntries(Object.entries(cheatSettings).filter(([, v]) => ['boolean', 'number', 'string'].includes(typeof v))) as Record<string, boolean | number | string>)
        : undefined,
    force: force === true,
  };
  const wasRunning = inst.isRunning;
  if (wasRunning && !restart) throw new HttpError(409, 'Stop the server first (or use "Save and restart"): it rewrites the world settings when it stops.');
  if (wasRunning) {
    if (!can(p, 'control.restart', inst.id)) throw new HttpError(403, 'Saving and restarting needs the Restart permission.');
    await inst.stop();
  }
  let notes: string[];
  try {
    notes = world.write(inst.record, changes);
  } catch (err) {
    if (wasRunning) inst.start().catch(() => {});
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `changed world settings on "${inst.record.name}": ${notes.join(', ') || 'no changes'}`);
  if (wasRunning) inst.start().catch(() => {});
  return { notes, restarted: wasRunning, ...(world.read(inst.record) as object) };
});

// ---------- server files (Files tab; everything stays inside the server's folder) ----------

/** Reading needs "View files", changing needs "Edit files". */
function serverRoot(ctx: Ctx, perm: ServerPerm = 'files.edit') {
  const p = needServer(ctx, perm, ctx.params[0]);
  const inst = getInstance(ctx.params[0]);
  return { p, inst, root: inst.record.installDir };
}
function queryPath(ctx: Ctx) {
  return new URL(ctx.req.url ?? '', 'http://x').searchParams.get('path') ?? '';
}
function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  }
}

route('GET', '/api/servers/:id/files', async (ctx) => {
  const { root } = serverRoot(ctx, 'files.view');
  return wrap(() => serverFiles.list(root, queryPath(ctx)));
});

route('GET', '/api/servers/:id/files/content', async (ctx) => {
  const { root } = serverRoot(ctx, 'files.view');
  return wrap(() => serverFiles.readText(root, queryPath(ctx)));
});

route('PUT', '/api/servers/:id/files/content', async (ctx) => {
  const { p, inst, root } = serverRoot(ctx);
  const { path: rel, content, bom, modified } = await readBody(ctx.req);
  const saved = wrap(() => serverFiles.writeText(root, rel, content, !!bom, Number(modified) || undefined));
  audit(p, `edited ${rel} on "${inst.record.name}"`);
  return { modified: saved, running: inst.isRunning };
});

route('GET', '/api/servers/:id/files/download', async (ctx) => {
  const { root } = serverRoot(ctx, 'files.view');
  const full = wrap(() => serverFiles.resolveIn(root, queryPath(ctx)));
  if (!existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, 'That file no longer exists.');
  const name = path.basename(full);
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': statSync(full).size,
    'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  await new Promise<void>((resolve) => createReadStream(full).on('error', () => resolve()).on('end', resolve).pipe(ctx.res));
  return undefined;
});

route('POST', '/api/servers/:id/files/upload', async (ctx) => {
  const { p, inst, root } = serverRoot(ctx);
  const dir = queryPath(ctx);
  wrap(() => serverFiles.resolveIn(root, dir));
  const { file, name } = await receiveUpload(ctx.req);
  try {
    const placed = wrap(() => serverFiles.placeUpload(root, dir, file, name));
    audit(p, `uploaded ${placed} to "${inst.record.name}"`);
    return { path: placed };
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

route('POST', '/api/servers/:id/files/mkdir', async (ctx) => {
  const { p, inst, root } = serverRoot(ctx);
  const { path: parent, name, file } = await readBody(ctx.req);
  const created = wrap(() => (file ? serverFiles.makeFile(root, parent, name) : serverFiles.makeDir(root, parent, name)));
  audit(p, `created ${created} on "${inst.record.name}"`);
  return { path: created };
});

route('POST', '/api/servers/:id/files/rename', async (ctx) => {
  const { p, inst, root } = serverRoot(ctx);
  const { path: rel, name } = await readBody(ctx.req);
  const renamed = wrap(() => serverFiles.rename(root, rel, name));
  audit(p, `renamed ${rel} -> ${renamed} on "${inst.record.name}"`);
  return { path: renamed };
});

route('POST', '/api/servers/:id/files/delete', async (ctx) => {
  const { p, inst, root } = serverRoot(ctx);
  const { path: rel } = await readBody(ctx.req);
  try {
    await serverFiles.remove(root, rel);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  audit(p, `deleted ${rel} on "${inst.record.name}" (Recycle Bin)`);
  return {};
});

// ---------- users (owner, or "Manage users & API keys"; never handing out more than the manager has) ----------

const serverNames = () => Object.fromEntries(listInstances().map((i) => [i.id, i.record.name]));
const bad = (err: unknown) => new HttpError(400, (err as Error).message);

route('GET', '/api/users', async (ctx) => {
  needGlobal(ctx, 'users.manage');
  const names = serverNames();
  return auth.listUsers().map((u) => ({ ...u, access: u.role === 'owner' ? { scope: 'all', text: 'Everything (owner)' } : accessSummary(u.grants ?? { global: [], servers: {} }, names) }));
});

route('POST', '/api/users', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const body = await readBody(ctx.req);
  if (body.role === 'owner') throw new HttpError(400, 'There can only be one owner.');
  let user;
  try {
    user = auth.createUser(body, serverIds(), p);
  } catch (err) {
    throw bad(err);
  }
  audit(p, `created user ${user.username} (${PRESET_LABELS[user.role as Preset] ?? user.role})`);
  return auth.toPublic(user);
});

route('PUT', '/api/users/:id', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const body = await readBody(ctx.req);
  if (body.role === 'owner') throw new HttpError(400, 'There can only be one owner.');
  let user;
  try {
    user = auth.updateUser(ctx.params[0], body, serverIds(), p);
  } catch (err) {
    throw bad(err);
  }
  const what = [
    body.password ? 'reset the password' : null,
    body.grants !== undefined || body.role !== undefined ? 'changed permissions' : null,
    body.disabled === true ? 'disabled the account' : body.disabled === false ? 'enabled the account' : null,
    body.username !== undefined ? 'renamed' : null,
  ].filter(Boolean);
  audit(p, `updated user ${user.username}${what.length ? ` (${what.join(', ')})` : ''}`);
  return auth.toPublic(user);
});

route('POST', '/api/users/:id/signout', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const user = auth.getUser(ctx.params[0]);
  if (!user) throw new HttpError(404, 'User not found.');
  if (user.role === 'owner' && !p.owner) throw new HttpError(403, 'Only the owner can sign the owner out.');
  // Signing yourself out everywhere keeps this session.
  auth.signOutEverywhere(user.id, user.id === p.id ? ctx.token : undefined);
  audit(p, `signed ${user.username} out everywhere`);
  return {};
});

route('DELETE', '/api/users/:id', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const name = auth.getUser(ctx.params[0])?.username;
  try {
    auth.deleteUser(ctx.params[0], p);
  } catch (err) {
    throw bad(err);
  }
  audit(p, `deleted user ${name}`);
  return {};
});

route('GET', '/api/activity', async (ctx) => {
  needGlobal(ctx, 'audit.view');
  const q = new URL(ctx.req.url ?? '', 'http://x').searchParams;
  return readActivity({ accountId: q.get('account') || undefined, search: q.get('q') || undefined, limit: Math.min(1000, Number(q.get('limit')) || 300) });
});

// ---------- API keys ----------

route('GET', '/api/apikeys', async (ctx) => {
  needGlobal(ctx, 'users.manage');
  const names = serverNames();
  return auth.listApiKeys().map((k) => ({ ...k, access: accessSummary(k.grants, names), expired: !!k.expiresAt && k.expiresAt < Date.now() }));
});

route('POST', '/api/apikeys', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const { name, preset, grants, expiresInDays } = await readBody(ctx.req);
  let created;
  try {
    created = auth.createApiKey(name, (preset ?? 'viewer') as Preset, grants, serverIds(), p, expiresInDays ?? null);
  } catch (err) {
    throw bad(err);
  }
  audit(p, `created API key "${created.apiKey.name}"`);
  return created;
});

route('PUT', '/api/apikeys/:id', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  const body = await readBody(ctx.req);
  let key;
  try {
    key = auth.updateApiKey(ctx.params[0], body, serverIds(), p);
  } catch (err) {
    throw bad(err);
  }
  audit(p, `changed API key "${key.name}"`);
  return key;
});

route('DELETE', '/api/apikeys/:id', async (ctx) => {
  const p = needGlobal(ctx, 'users.manage');
  try {
    auth.deleteApiKey(ctx.params[0], p);
  } catch (err) {
    throw bad(err);
  }
  audit(p, `deleted an API key`);
  return {};
});

// ---------- remote access (owner only) ----------

route('GET', '/api/settings/remote', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  return remoteStatus(config.remote);
});

route('PUT', '/api/settings/remote', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  if (ctx.remote) throw new HttpError(403, 'Change remote access from the panel system itself.');
  const { enabled, port } = await readBody(ctx.req);
  const newPort = port === undefined ? config.remote.port : Number(port);
  if (!Number.isInteger(newPort) || newPort < 1024 || newPort > 65535 || newPort === config.port) {
    throw new HttpError(400, `Port must be 1024-65535 and not ${config.port} (used locally).`);
  }
  config.remote = { enabled: !!enabled, port: newPort };
  writeJson('config.json', config);
  audit(p, `turned remote access ${config.remote.enabled ? `on (port ${newPort})` : 'off'}`);
  await applyRemote(config.remote, (req, res) => handle(req, res, true)).catch((err) => {
    throw new HttpError(400, err.message);
  });
  return remoteStatus(config.remote);
});

route('POST', '/api/settings/remote/firewall', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  if (ctx.remote) throw new HttpError(403, 'This has to be done on the panel system.');
  await addFirewallRule(config.remote.port);
  return {};
});

// ---------- restart notices ----------
// Before Server Forge restarts on purpose (e.g. installing an update) it tells connected clients, so they can show
// "restarting" instead of treating the gap as an outage. When it's back, /api/health and the live stream say when it
// went down and why.

const STARTED_AT = Date.now();
const RESTART_NOTICE = 'restart-notice.json';
let lastRestart: { reason: string; downAt: number; upAt: number } | null = null;
{
  const notice = readJson<{ reason: string; at: number } | null>(RESTART_NOTICE, null);
  if (notice && Date.now() - notice.at < 30 * 60_000) lastRestart = { reason: notice.reason, downAt: notice.at, upAt: STARTED_AT };
  if (notice) writeJson(RESTART_NOTICE, null);
}
const panelStatus = () => ({ status: 'up', startedAt: STARTED_AT, lastRestart });

// ---------- health warnings ----------

route('GET', '/api/alerts', async (ctx) => {
  const p = need(ctx);
  const alerts: Alert[] = listAlerts().filter((a) => !a.serverId || can(p, 'view', a.serverId));
  // Nodes' warnings too (named after the node).
  await Promise.all(
    listNodes()
      .filter((n) => n.online)
      .map(async (n) => {
        try {
          const r = await nodeJson<{ alerts: Alert[] }>(getNode(n.id), 'GET', '/api/alerts');
          for (const a of r?.alerts ?? []) {
            const serverId = a.serverId ? remoteId(n.id, a.serverId) : null;
            if (!serverId || can(p, 'view', serverId)) alerts.push({ ...a, id: `n~${n.id}~${a.id}`, serverId, title: `${n.name}: ${a.title}` });
          }
        } catch {}
      }),
  );
  return { alerts };
});

route('POST', '/api/alerts/:id/dismiss', async (ctx) => {
  const p = need(ctx);
  const id = decodeURIComponent(ctx.params[0]);
  const remoteAlert = /^n~([a-z0-9]+)~(.+)$/i.exec(id);
  if (remoteAlert) {
    await nodeJson(getNode(remoteAlert[1]), 'POST', `/api/alerts/${encodeURIComponent(remoteAlert[2])}/dismiss`).catch(() => {});
    return {};
  }
  const alert = listAlerts().find((a) => a.id === id);
  if (alert && (!alert.serverId || can(p, 'view', alert.serverId))) dismissAlert(id);
  return {};
});

// New Server Forge versions (GitHub releases). ?check=1 looks right now instead of using the last 6-hourly check.
route('GET', '/api/app-update', async (ctx) => {
  needGlobal(ctx, 'panel.settings');
  await checkAppUpdate(new URL(ctx.req.url ?? '', 'http://x').searchParams.get('check') === '1');
  return appUpdateInfo(PANEL_VERSION);
});

// What changed in a version, from the CHANGELOG.md that ships with Server Forge (the "updated to X" box after an update).
route('GET', '/api/changelog', async (ctx) => {
  need(ctx);
  const version = new URL(ctx.req.url ?? '', 'http://x').searchParams.get('version') ?? PANEL_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HttpError(400, 'Bad version.');
  let text = '';
  try {
    text = readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf-8');
  } catch {}
  const heading = `## Server Forge ${version}`;
  const at = text.indexOf(heading);
  if (at < 0) return { version, notes: null };
  const rest = text.slice(at + heading.length);
  const end = rest.search(/\n## /);
  return { version, notes: (end < 0 ? rest : rest.slice(0, end)).trim() };
});

// Anyone may ask whether the panel is up (no version or server details, so it's safe over remote access too).
route('GET', '/api/health', async () => ({ ok: true, ...panelStatus() }));

// Body: {"reason": "update"}. The desktop app calls this just before it runs an installer.
route('POST', '/api/panel/restarting', async (ctx) => {
  const p = needGlobal(ctx, 'panel.settings');
  const { reason } = await readBody(ctx.req);
  const why = String(reason ?? 'restart').slice(0, 40) || 'restart';
  writeJson(RESTART_NOTICE, { reason: why, at: Date.now() });
  const msg = `event: panel\ndata: ${JSON.stringify({ status: 'restarting', reason: why, expectBackSeconds: 90 })}\n\n`;
  for (const res of streams.keys()) res.write(msg);
  audit(p, `announced a panel restart (${why})`);
  return {};
});

route('GET', '/api/events', async (ctx) => {
  const p = need(ctx);
  ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  ctx.res.write(': connected\n\n');
  // Straight away: when this panel started and whether it just came back from a planned restart.
  ctx.res.write(`event: panel\ndata: ${JSON.stringify(panelStatus())}\n\n`);
  streams.set(ctx.res, p);
  const ping = setInterval(() => ctx.res.write(': ping\n\n'), 25_000);
  ctx.req.on('close', () => {
    clearInterval(ping);
    streams.delete(ctx.res);
  });
  return undefined;
});

// ---------- request handling (shared by the local and remote listeners) ----------

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // CurseForge project thumbnails are the only outside images the page shows.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://media.forgecdn.net https://mc-heads.net; style-src 'self'",
};

function apiKeyFrom(req: http.IncomingMessage): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  return bearer?.[1] ?? (req.headers['x-api-key'] as string | undefined) ?? (req.headers.apikey as string | undefined);
}

// ---------- passing requests for node servers through ----------

/**
 * Which of this panel's permissions a request on a server needs (the node itself trusts this panel's key, so the
 * check happens here). `sub` is the part after /api/servers/<id>. null = only the owner.
 */
function permFor(method: string, sub: string): { server?: ServerPerm; also?: ServerPerm; global?: GlobalPerm } | null {
  const s = sub.replace(/\?.*$/, '');
  const get = method === 'GET';
  const rules: [RegExp, ServerPerm | null, ServerPerm | null][] = [
    // [path, perm for GET, perm for changes]
    [/^$/, 'view', null],
    [/^\/(start)$/, null, 'control.start'],
    [/^\/(stop)$/, null, 'control.stop'],
    [/^\/(restart|countdown\/cancel)$/, null, 'control.restart'],
    [/^\/kill$/, null, 'control.kill'],
    [/^\/console/, 'console.view', null],
    [/^\/command$/, null, 'console.command'],
    [/^\/chat\/relay$/, null, 'addons.manage'],
    [/^\/chat$/, 'console.view', 'console.command'],
    [/^\/players$/, 'view', null],
    [/^\/players\/[^/]+\/action$/, null, 'access.edit'],
    [/^\/(stats|diagnose)/, 'view', 'view'],
    [/^\/lists\//, 'view', 'access.edit'],
    [/^\/properties(\/repair)?$/, 'view', 'properties.edit'],
    [/^\/world$/, 'view', 'properties.edit'],
    [/^\/worlds$/, 'view', null],
    [/^\/worlds\/import$/, null, 'files.edit'],
    [/^\/worlds\/[^/]+\/activate$/, null, 'properties.edit'],
    [/^\/worlds\/[^/]+\/export$/, 'files.view', null],
    [/^\/worlds\/[^/]+$/, null, 'files.edit'],
    [/^\/world-check\/accept$/, null, 'backups.restore'],
    [/^\/world-check$/, 'view', 'backups.create'],
    [/^\/backups$/, 'view', 'backups.create'],
    [/^\/backups\/copies\/[^/]+\/bring-back$/, null, 'backups.restore'],
    [/^\/backups\/[^/]+\/restore$/, null, 'backups.restore'],
    [/^\/backups\/[^/]+$/, null, 'backups.delete'],
    [/^\/share/, 'addons.share', 'addons.share'],
    [/^\/(addons|plugins)\/check-updates$/, null, 'view'],
    [/^\/(addons|plugins)\/settings/, 'addons.manage', 'addons.manage'],
    [/^\/(addons|plugins)/, 'view', 'addons.manage'],
    [/^\/tasks\/[^/]+\/run$/, null, 'tasks.run'],
    [/^\/tasks/, 'view', 'tasks.edit'],
    [/^\/(server-files|files)/, 'files.view', 'files.edit'],
    [/^\/(update|bedrock-update|game-update)$/, 'view', 'server.update'],
    [/^\/difficulty$/, 'view', 'settings.edit'],
    [/^\/discord(\/test)?$/, 'settings.edit', 'settings.edit'],
    [/^\/ports$/, 'view', null],
    [/^\/network(\/[^/]+)?$/, 'view', 'properties.edit'],
    [/^\/profiles(\/[^/]+(\/activate)?)?$/, 'view', 'settings.edit'],
    [/^\/eula$/, null, 'settings.edit'],
    [/^\/vcredist$/, null, 'settings.edit'],
  ];
  if (s === '' && method === 'PUT') return { server: 'settings.edit' };
  if (s === '' && method === 'DELETE') return { server: 'server.delete' };
  if (s === '/clone') return { global: 'servers.create' };
  // These may stop or restart the server, which needs that permission too here (the node can't tell who asked, so
  // it's asked for whether or not the server is running).
  if (!get && /^\/profiles\/[^/]+\/activate$/.test(s)) return { server: 'settings.edit', also: 'control.restart' };
  if (!get && /^\/(bedrock-update|game-update)$/.test(s)) return { server: 'server.update', also: 'control.stop' };
  for (const [re, forGet, forChange] of rules) {
    if (!re.test(s)) continue;
    const perm = get ? forGet : forChange;
    return perm ? { server: perm } : null;
  }
  return null;
}

async function proxyToNode(req: http.IncomingMessage, res: http.ServerResponse, p: Principal | null, nsId: string, sub: string, search: string) {
  if (!p) throw new HttpError(401, 'Log in first.');
  const r = parseRemoteId(nsId);
  if (!r) throw new HttpError(404, 'Server not found.');
  const node = getNode(r.nodeId);
  const need = permFor(req.method ?? 'GET', sub);
  if (!need && !p.owner) throw new HttpError(403, "You don't have permission to do that.");
  if (need?.server && !can(p, need.server, nsId)) throw new HttpError(403, "You don't have permission to do that on this server.");
  if (need?.also && !can(p, need.also, nsId)) throw new HttpError(403, `That also needs "${SERVER_PERM_INFO[need.also].label}" on this server.`);
  if (need?.global && !canGlobal(p, need.global)) throw new HttpError(403, "You don't have permission to do that.");
  const headers: Record<string, string> = {};
  for (const h of ['content-type', 'x-filename', 'content-length']) if (req.headers[h]) headers[h] = String(req.headers[h]);
  const upstream = await nodeRequest(node, req.method ?? 'GET', `/api/servers/${encodeURIComponent(r.serverId)}${sub}${search}`, {
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? null : req,
    timeoutMs: 0,
  }).catch((err) => {
    throw new HttpError(502, `${node.name}: ${(err as Error).message}`);
  });
  const type = String(upstream.headers['content-type'] ?? '');
  if (req.method !== 'GET') audit(p, `${req.method} ${sub || '/'} on "${nsId}" (node ${node.name})`);
  // JSON answers: put this panel's ids back in (e.g. a server snapshot after saving settings).
  if (type.includes('application/json') && !upstream.headers['content-disposition']) {
    const chunks: Buffer[] = [];
    for await (const c of upstream) chunks.push(c as Buffer);
    let body = Buffer.concat(chunks).toString('utf-8');
    try {
      const data = JSON.parse(body);
      const fix = (o: Record<string, unknown>) => {
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          if (o.id === r.serverId) o.id = nsId;
          if (o.serverId === r.serverId) o.serverId = nsId;
        }
        return o;
      };
      fix(data);
      if (data && typeof data === 'object' && data.id === nsId) {
        data.node = { id: node.id, name: node.name };
        if (Array.isArray(data.permissions)) data.permissions = permsOn(p, nsId);
      }
      body = JSON.stringify(data);
    } catch {}
    res.writeHead(upstream.statusCode ?? 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  // Everything else (downloads, event streams, icons): passed through as it comes.
  const pass: Record<string, string> = {};
  for (const h of ['content-type', 'content-length', 'content-disposition', 'cache-control']) if (upstream.headers[h]) pass[h] = String(upstream.headers[h]);
  res.writeHead(upstream.statusCode ?? 502, pass);
  upstream.pipe(res);
  await new Promise<void>((resolve) => {
    upstream.on('end', resolve);
    upstream.on('error', () => resolve());
    res.on('close', () => {
      upstream.destroy();
      resolve();
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, remote: boolean) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (remote) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url ?? '/', 'http://panel');

  // The local listener answers only requests addressed to this system by name. A web page can point a domain of its
  // own at 127.0.0.1 ("DNS rebinding") and would then count as the same site as the panel; its requests still carry
  // its own domain in Host, so they stop here.
  if (!remote && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host ?? ''))) {
    send(res, 421, { error: 'Open Server Forge at http://127.0.0.1 (or localhost).' });
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      let principal: Principal | null = null;
      let user: auth.User | null = null;
      let token: string | undefined;
      const key = apiKeyFrom(req);
      if (key) {
        // API keys (for bots) don't use cookies, so cross-site request forgery doesn't apply to them.
        principal = auth.apiKeyPrincipal(key);
        if (!principal) throw new HttpError(401, 'Invalid API key.');
      } else {
        // Browser changes need our custom header: browsers won't send it cross-site, which blocks CSRF.
        if (req.method !== 'GET' && req.headers['x-panel'] !== '1') throw new HttpError(403, 'Missing X-Panel header.');
        token = cookies(req)[COOKIE];
        user = auth.sessionUser(token);
        if (user && remote && !user.remote) user = null; // remote login was revoked
        principal = user ? auth.userPrincipal(user) : null;
        // An account that must change its password can only do that (and see who it is / log out).
        if (user?.mustChangePassword && !['/api/me', '/api/me/password', '/api/logout'].includes(url.pathname)) {
          throw new HttpError(403, 'Please choose a new password first.');
        }
      }
      // A server on another system (node): check this panel's permissions, then pass it through.
      const nodeServer = /^\/api\/servers\/(n~[^/]+)(\/.*)?$/.exec(url.pathname);
      if (nodeServer) {
        await proxyToNode(req, res, principal, decodeURIComponent(nodeServer[1]), nodeServer[2] ?? '', url.search);
        return;
      }
      // The plugins manager uses the addon routes (see addonsOf).
      const pluginsPath = /^(\/api\/servers\/[^/]+\/)plugins(\/.*)?$/.exec(url.pathname);
      const pathname = pluginsPath ? `${pluginsPath[1]}addons${pluginsPath[2] ?? ''}` : url.pathname;
      for (const [method, re, handler] of routes) {
        const m = req.method === method && re.exec(pathname);
        if (m) {
          const ctx = { req, res, principal, user, params: m.slice(1).map(decodeURIComponent), token, remote };
          const result = await addonKind.run(pluginsPath ? 'plugins' : 'addons', () => handler(ctx));
          if (result !== undefined) send(res, 200, result);
          return;
        }
      }
      throw new HttpError(404, 'Not found.');
    }

    // Tavern Vault's own page, shown inside the Storage view (an iframe): /vault-ui/local/ or /vault-ui/n-<node>/.
    // Signed-in users with "See storage" only. These pages may be framed by this panel and use inline styles.
    const vaultUi = /^\/vault-ui\/(local|n-[a-z0-9]+)\/([\w.-]*)$/i.exec(url.pathname);
    if (vaultUi) {
      let user = auth.sessionUser(cookies(req)[COOKIE]);
      if (user && remote && !user.remote) user = null;
      const p = user && !user.mustChangePassword ? auth.userPrincipal(user) : null;
      if (!p || !canGlobal(p, 'storage.view')) throw new HttpError(403, 'Sign in with "See storage" permission to view this.');
      const [, scope, file = ''] = vaultUi;
      const name = file || 'index.html';
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'");
      let body: string;
      let type: string;
      if (name === 'shim.js') {
        body = vaultShim(scope === 'local' ? '/api/vault' : `/api/nodes/${scope.slice(2)}/vault`);
        type = 'text/javascript';
      } else if (VAULT_UI[name]) {
        body = await vaultUiFor(scope, name);
        if (name === 'index.html') body = vaultPage(body);
        type = VAULT_UI[name];
      } else throw new HttpError(404, 'Not found.');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    // UI test designs (development panel only): /launcher/ and /dashboard/ serve the normal page with that design's
    // stylesheet and script added (ui-tests/<name>/), so they always run the current panel code. Not in builds.
    const uiTest = isDev ? /^\/(launcher|dashboard)(\/.*)?$/.exec(url.pathname) : null;
    if (uiTest) {
      const name = uiTest[1];
      const sub = (uiTest[2] ?? '').replace(/^\/+/, '');
      if (!uiTest[2]) {
        res.writeHead(302, { Location: `/${name}/` });
        res.end();
        return;
      }
      const testDir = path.join(rootDir, 'ui-tests', name);
      const own = sub ? path.join(testDir, path.normalize(sub).replace(/^(\.\.[/\\])+/, '')) : '';
      if (own && own.startsWith(testDir + path.sep) && existsSync(own) && path.extname(own)) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(own)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(readFileSync(own));
        return;
      }
      if (!sub || !path.extname(sub)) {
        // Test designs log in by themselves: development panel, opened on this system (not over Remote access), as the
        // owner, like the desktop window does. Only when the browser has no session yet.
        const hasSession = !!auth.sessionUser(/(?:^|;\s*)panel_session=([^;]+)/.exec(String(req.headers.cookie ?? ''))?.[1]);
        const owner = auth.firstOwner();
        if (!remote && !hasSession && owner && LOOPBACK.includes(req.socket.remoteAddress ?? '')) {
          res.setHeader('Set-Cookie', `${COOKIE}=${auth.createSession(owner.id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}`);
        }
        const html = readFileSync(path.join(publicDir, 'index.html'), 'utf-8')
          .replace('</head>', `<link rel="stylesheet" href="/${name}/theme.css">\n<script type="module" src="/${name}/extra.js"></script>\n</head>`)
          .replace('<body>', `<body class="ui-${name}">`);
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
        return;
      }
    }

    // Static files; anything else serves the app shell.
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !existsSync(file) || !path.extname(file)) file = path.join(publicDir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(readFileSync(file));
  } catch (err) {
    const status = err instanceof HttpError ? err.status : ((err as { status?: number }).status ?? 400);
    if (!res.headersSent) send(res, status, { error: (err as Error).message });
    else res.end();
  }
}

await loadInstances();
// Valheim servers made before profiles existed (e.g. right after updating Server Forge) get their "Main" profile now.
for (const inst of listInstances()) {
  if (inst.record.game !== 'valheim') continue;
  try {
    if (ensureDefaultProfile(inst.record)) inst.log('Profiles: made "Main" from how this server is set up now (world and mods). Add more in Settings → Profiles.');
  } catch {}
}
// 0.5.0: node links made before storage existed get "See / Manage storage", so the master panel can reach Tavern Vault.
{
  const upgraded = auth.upgradeNodeLinkKeys();
  if (upgraded) logActivity({ at: Date.now(), who: 'Server Forge', kind: 'user', id: 'system', what: `gave ${upgraded} node link key(s) the new storage permissions (Tavern Vault on this system)` });
}
startHealthChecks();
startWorldChecks();
startUpdateChecks();
startDiscordNotifications();
startAppUpdateChecks();
// Bedrock addons with "Update automatically" on: checked against CurseForge every 6 hours (the first time 10 minutes
// after start). A pack update is loaded the next time the server starts.
async function autoUpdateAddons() {
  if (!curseforgeKey()) return;
  for (const inst of listInstances()) {
    if (inst.record.game !== 'bedrock' || !getUpdateSettings(inst.record.installDir).auto) continue;
    const addons = inst.module.addons!;
    try {
      const labels = await addons.checkUpdates!(inst.record);
      const packs = addons.list(inst.record) as { id: string; name: string; curseforge: { projectId: number } | null }[];
      const done = new Set<number>();
      for (const id of Object.keys(labels)) {
        const pack = packs.find((x) => x.id === id);
        if (!pack?.curseforge || done.has(pack.curseforge.projectId)) continue;
        done.add(pack.curseforge.projectId);
        try {
          await addons.update!(inst.record, id);
          inst.log(`Addon updated from CurseForge: ${pack.name} → ${labels[id]}${inst.isRunning ? ' (loaded at the next restart)' : ''}.`);
          logActivity({ at: Date.now(), who: 'Server Forge', kind: 'system', id: inst.id, what: `updated addon "${pack.name}" to ${labels[id]} on "${inst.record.name}" (automatic)` });
        } catch (err) {
          inst.log(`Couldn't update addon ${pack.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      inst.log(`Couldn't check addon updates: ${(err as Error).message}`);
    }
  }
}
setTimeout(() => autoUpdateAddons().catch(() => {}), 10 * 60_000).unref();
setInterval(() => autoUpdateAddons().catch(() => {}), 6 * 3600_000).unref();
startNodes();
http.createServer((req, res) => handle(req, res, false)).listen(config.port, '127.0.0.1', () => {
  console.log(`Panel running at http://127.0.0.1:${config.port}`);
});
if (config.remote.enabled) {
  applyRemote(config.remote, (req, res) => handle(req, res, true))
    .then(() => console.log(`Remote access on at https://<this-pc>:${config.remote.port}`))
    .catch((err) => console.log(`Remote access could not start: ${err.message}`));
}
