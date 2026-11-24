// Master backups: when this panel manages servers on other systems (nodes), it can keep its own copies of their
// backups here, so a node's disk dying doesn't take its worlds with it. Works for every game whose servers can be
// backed up: the node makes a normal backup (safe while running, as always), then this panel downloads the zip.
//
// Stored under data/master-backups/<nodeId>-<serverId>/ with an index.json, like local backups. Each node server has
// its own schedule (every N hours while it runs, keep the newest N automatic ones). A copy can be sent back to the
// node, where it shows up in the server's own backups, ready to restore.
import { existsSync, mkdirSync, rmSync, statSync, createWriteStream, createReadStream, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { dataPath, readJson, writeJson } from './store.ts';
import { events } from './events.ts';
import { getNode, listNodes, nodeJson, nodeRequest, parseRemoteId, remoteServers } from './nodes.ts';

export interface MasterBackup {
  id: string;
  file: string;
  kind: 'manual' | 'scheduled';
  createdAt: number;
  /** When this panel finished copying it. */
  copiedAt: number;
  size: number;
  world: string | null;
  live: boolean;
  /** The server's name when it was copied (the server may be renamed or removed later). */
  serverName: string;
  nodeName: string;
}

export interface MasterSchedule {
  /** 0 = off. */
  everyHours: number;
  /** Automatic copies kept (manual ones are never removed automatically). */
  keep: number;
}

export interface MasterStatus {
  running: boolean;
  step: string | null;
  error: string | null;
  lastAt: number | null;
}

const SCHEDULES = 'master-backups/schedules.json';
const status = new Map<string, MasterStatus>();
/** A failed automatic run waits this long before trying again (instead of retrying every minute). */
const RETRY_AFTER_FAIL_MS = 30 * 60_000;
const lastFail = new Map<string, number>();

function parse(remote: string) {
  const r = parseRemoteId(remote);
  if (!r) throw Object.assign(new Error('Master backups are for servers on linked systems.'), { status: 400 });
  return r;
}

function folderOf(remote: string) {
  const { nodeId, serverId } = parse(remote);
  return dataPath('master-backups', `${nodeId}-${serverId}`);
}

function indexRel(remote: string) {
  const { nodeId, serverId } = parse(remote);
  return path.join('master-backups', `${nodeId}-${serverId}`, 'index.json');
}

export function listMasterBackups(remote: string): MasterBackup[] {
  const folder = folderOf(remote);
  return readJson<MasterBackup[]>(indexRel(remote), [])
    .filter((b) => existsSync(path.join(folder, b.file)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveIndex(remote: string, list: MasterBackup[]) {
  writeJson(indexRel(remote), list);
}

export function masterFolder(remote: string) {
  return folderOf(remote);
}

export function getSchedule(remote: string): MasterSchedule {
  parse(remote);
  const saved: Partial<MasterSchedule> = readJson<Record<string, MasterSchedule>>(SCHEDULES, {})[remote] ?? {};
  return { everyHours: saved.everyHours ?? 0, keep: saved.keep ?? 10 };
}

export function setSchedule(remote: string, input: Partial<MasterSchedule>): MasterSchedule {
  const next = { ...getSchedule(remote) };
  if (input.everyHours !== undefined) {
    const h = Number(input.everyHours);
    if (!Number.isFinite(h) || h < 0 || h > 24 * 30) throw new Error('Back up every 0 (off) to 720 hours.');
    next.everyHours = h;
  }
  if (input.keep !== undefined) {
    const k = Number(input.keep);
    if (!Number.isInteger(k) || k < 1 || k > 500) throw new Error('Keep 1-500 automatic copies.');
    next.keep = k;
  }
  const all = readJson<Record<string, MasterSchedule>>(SCHEDULES, {});
  all[remote] = next;
  writeJson(SCHEDULES, all);
  return next;
}

export function getStatus(remote: string): MasterStatus {
  return status.get(remote) ?? { running: false, step: null, error: null, lastAt: null };
}

function setStatus(remote: string, s: Partial<MasterStatus>) {
  status.set(remote, { ...getStatus(remote), ...s });
  events.emit('master-backups', remote);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface NodeBackup {
  id: string;
  file: string;
  kind: string;
  createdAt: number;
  size: number;
  world: string | null;
  live: boolean;
}

/**
 * Has the node back the server up, waits for it, and downloads the zip here. Resolves with the new copy.
 * Only one run per server at a time.
 */
export async function pullBackup(remote: string, kind: 'manual' | 'scheduled'): Promise<MasterBackup> {
  const { nodeId, serverId } = parse(remote);
  if (getStatus(remote).running) throw new Error('A copy of this server is already being made.');
  const node = getNode(nodeId);
  if (node.kind === 'vault') throw new Error('That system only stores files; it has no servers to back up.');
  const sid = encodeURIComponent(serverId);
  setStatus(remote, { running: true, step: 'Asking the server to back up…', error: null });
  const tmpName = `${randomUUID().slice(0, 8)}.part`;
  let tmp: string | null = null;
  try {
    // 1. A normal backup on the node (its own safe method; fine while running). The ones already there are noted,
    //    so only the new one is taken.
    const before = new Set((await nodeJson<{ backups: NodeBackup[] }>(node, 'GET', `/api/servers/${sid}/backups`))?.backups?.map((b) => b.id) ?? []);
    const started = await nodeJson<{ name?: string; job?: { id: string } | null }>(node, 'POST', `/api/servers/${sid}/backups`);
    const jobId = started?.job?.id;
    const serverName = String(started?.name ?? serverId);
    setStatus(remote, { step: `${node.name} is backing up "${serverName}"…` });
    const deadline = Date.now() + 6 * 3600_000;
    let backup: NodeBackup | null = null;
    while (Date.now() < deadline) {
      await sleep(3000);
      const snap = await nodeJson<{ job?: { id: string; status: string; step?: string; error?: string | null } | null }>(node, 'GET', `/api/servers/${sid}`).catch(() => null);
      const job = snap?.job;
      if (job && jobId && job.id === jobId) {
        if (job.status === 'running') {
          if (job.step) setStatus(remote, { step: `${node.name}: ${job.step}` });
          continue;
        }
        if (job.status !== 'done' && job.error) throw new Error(`${node.name} couldn't back it up: ${job.error}`);
      } else if (!snap) continue;
      const list = await nodeJson<{ backups: NodeBackup[] }>(node, 'GET', `/api/servers/${sid}/backups`);
      backup = (list?.backups ?? []).filter((b) => !before.has(b.id) && b.kind === 'manual').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      // Finished (or no job to follow) but nothing new yet: keep waiting unless the job is known to be over.
      if (backup || (job && jobId && job.id === jobId)) break;
    }
    if (!backup) throw new Error(`${node.name} didn't finish the backup in time.`);

    // 2. Download it here (under a temporary name, so a half-copied file is never listed).
    const folder = folderOf(remote);
    mkdirSync(folder, { recursive: true });
    tmp = path.join(folder, tmpName);
    setStatus(remote, { step: `Copying ${backup.file} to this system…` });
    const res = await nodeRequest(node, 'GET', `/api/servers/${sid}/backups/${encodeURIComponent(backup.id)}/download`, { timeoutMs: 0 });
    if ((res.statusCode ?? 500) >= 400) {
      res.resume();
      throw new Error(res.statusCode === 404 ? `${node.name} runs an older Server Forge that can't send backups. Update it first.` : `${node.name} answered ${res.statusCode}.`);
    }
    await pipeline(res, createWriteStream(tmp));
    const file = `${new Date(backup.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${kind}.zip`;
    const dest = existsSync(path.join(folder, file)) ? file.replace(/\.zip$/, `-${randomUUID().slice(0, 4)}.zip`) : file;
    await rename(tmp, path.join(folder, dest));
    tmp = null;
    const copy: MasterBackup = {
      id: randomUUID().slice(0, 8),
      file: dest,
      kind,
      createdAt: backup.createdAt,
      copiedAt: Date.now(),
      size: statSync(path.join(folder, dest)).size,
      world: backup.world ?? null,
      live: !!backup.live,
      serverName,
      nodeName: node.name,
    };
    const list = [copy, ...listMasterBackups(remote)];
    saveIndex(remote, list);
    if (kind === 'scheduled') prune(remote, getSchedule(remote).keep);
    lastFail.delete(remote);
    setStatus(remote, { running: false, step: null, error: null, lastAt: Date.now() });
    return copy;
  } catch (err) {
    if (tmp) rmSync(tmp, { force: true });
    if (kind === 'scheduled') lastFail.set(remote, Date.now());
    setStatus(remote, { running: false, step: null, error: (err as Error).message });
    throw err;
  }
}

/** Removes the oldest automatic copies beyond `keep`. Manual copies stay until deleted. */
function prune(remote: string, keep: number) {
  const list = listMasterBackups(remote);
  const auto = list.filter((b) => b.kind === 'scheduled');
  const remove = new Set(auto.slice(Math.max(1, keep)).map((b) => b.id));
  for (const b of list) if (remove.has(b.id)) rmSync(path.join(folderOf(remote), b.file), { force: true });
  saveIndex(remote, list.filter((b) => !remove.has(b.id)));
}

export function deleteMasterBackup(remote: string, id: string) {
  const list = listMasterBackups(remote);
  const b = list.find((x) => x.id === id);
  if (!b) throw Object.assign(new Error('That copy is not there any more.'), { status: 404 });
  rmSync(path.join(folderOf(remote), b.file), { force: true });
  saveIndex(remote, list.filter((x) => x.id !== id));
}

export function masterBackupFile(remote: string, id: string): { file: string; info: MasterBackup } | null {
  const b = listMasterBackups(remote).find((x) => x.id === id);
  return b ? { file: path.join(folderOf(remote), b.file), info: b } : null;
}

/** Sends a copy back to the node; it appears in the server's own backups there, ready to restore. */
export async function sendBack(remote: string, id: string): Promise<{ file: string }> {
  const { nodeId, serverId } = parse(remote);
  const found = masterBackupFile(remote, id);
  if (!found) throw Object.assign(new Error('That copy is not there any more.'), { status: 404 });
  if (getStatus(remote).running) throw new Error('Wait for the current copy to finish.');
  const node = getNode(nodeId);
  setStatus(remote, { running: true, step: `Sending ${found.info.file} to ${node.name}…`, error: null });
  try {
    const res = await nodeRequest(node, 'POST', `/api/servers/${encodeURIComponent(serverId)}/backups/upload`, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(statSync(found.file).size),
        'X-Filename': encodeURIComponent(found.info.file.replace(/-(manual|scheduled)(-\w+)?\.zip$/, '-from-master.zip')),
        'X-Backup-Created': String(found.info.createdAt),
        'X-Backup-World': encodeURIComponent(found.info.world ?? ''),
        'X-Backup-Live': found.info.live ? '1' : '0',
      },
      body: createReadStream(found.file),
      timeoutMs: 0,
    });
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    let data: { error?: string; backup?: { file: string } } = {};
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {}
    if ((res.statusCode ?? 500) >= 400) {
      throw new Error(res.statusCode === 404 && !data.error ? `${node.name} runs an older Server Forge that can't receive backups. Update it first.` : (data.error ?? `${node.name} answered ${res.statusCode}.`));
    }
    setStatus(remote, { running: false, step: null, error: null });
    return { file: data.backup?.file ?? found.info.file };
  } catch (err) {
    setStatus(remote, { running: false, step: null, error: (err as Error).message });
    throw err;
  }
}

/** Every node server with master copies or a schedule (for the overview), with its totals. */
export function overview() {
  const schedules = readJson<Record<string, MasterSchedule>>(SCHEDULES, {});
  const ids = new Set(Object.keys(schedules));
  try {
    for (const d of readdirSync(dataPath('master-backups'), { withFileTypes: true })) {
      const m = /^([a-z0-9]+)-([\w-]+)$/i.exec(d.name);
      if (d.isDirectory() && m) ids.add(`n~${m[1]}~${m[2]}`);
    }
  } catch {}
  return [...ids].map((remote) => {
    const list = listMasterBackups(remote);
    return { id: remote, schedule: getSchedule(remote), count: list.length, size: list.reduce((n, b) => n + b.size, 0), newest: list[0]?.createdAt ?? null, ...getStatus(remote) };
  });
}

// Automatic copies: while a node server runs, copy it here once the newest copy is older than its schedule.
setInterval(() => {
  const schedules = readJson<Record<string, MasterSchedule>>(SCHEDULES, {});
  const online = new Set(listNodes().filter((n) => n.online).map((n) => n.id));
  const snaps = new Map(remoteServers().map((s) => [String(s.id), s]));
  for (const [remote, sch] of Object.entries(schedules)) {
    if (!sch.everyHours || getStatus(remote).running) continue;
    const r = parseRemoteId(remote);
    const snap = snaps.get(remote);
    if (!r || !online.has(r.nodeId) || !snap || snap.status !== 'running') continue;
    if (Date.now() - (lastFail.get(remote) ?? 0) < RETRY_AFTER_FAIL_MS) continue;
    const newest = listMasterBackups(remote)[0]?.copiedAt ?? 0;
    if (Date.now() - newest < sch.everyHours * 3600_000) continue;
    pullBackup(remote, 'scheduled').catch(() => {});
  }
}, 60_000).unref();
