// Health warnings: low disk space, RAM near a server's limit (or the system's), a server stuck starting, two servers on
// the same port, a world growing unusually fast, failed backups and crashes. Checked every minute (folder sizes
// hourly). Each warning is raised once and cleared when the problem goes away; both are announced on the 'alert'
// event (the live stream passes it on, so Watcher can post it). The owner can dismiss one until it comes back.
import { statfsSync, existsSync, readFileSync } from 'node:fs';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { events } from './events.ts';
import { listInstances } from './instances.ts';
import { serverStats } from './stats.ts';
import { readJson, writeJson } from './store.ts';
import { lookupPublicIp } from './public-ip.ts';
import { parseUdpPorts } from './port-help.ts';
import { readProperties, writePropertiesText } from './properties.ts';
import { runningJob, type JobInfo } from './jobs.ts';
import { replaceBedrockPublicIp } from './games/bedrock-network.ts';

export interface Alert {
  id: string;
  /** null = about the whole system (disk, RAM). */
  serverId: string | null;
  level: 'warn' | 'error';
  title: string;
  detail: string;
  since: number;
  dismissed?: boolean;
}

const active = new Map<string, Alert>();
const dismissed = new Set<string>();

function raise(a: Omit<Alert, 'since'>) {
  const old = active.get(a.id);
  if (old && old.title === a.title && old.detail === a.detail && old.level === a.level) return;
  const alert: Alert = { ...a, since: old?.since ?? Date.now() };
  active.set(a.id, alert);
  // Only announce new problems (or ones that got worse), not every wording change.
  if (!old || (old.level === 'warn' && a.level === 'error')) events.emit('alert', { alert, active: true });
}

function clear(id: string) {
  const old = active.get(id);
  if (!old) return;
  active.delete(id);
  dismissed.delete(id);
  events.emit('alert', { alert: old, active: false });
}

/** Clears alerts with this prefix that weren't raised in the current check. */
function sweep(prefix: string, stillActive: Set<string>) {
  for (const id of [...active.keys()]) if (id.startsWith(prefix) && !stillActive.has(id)) clear(id);
}

export function listAlerts(): Alert[] {
  return [...active.values()].map((a) => ({ ...a, dismissed: dismissed.has(a.id) })).sort((a, b) => b.since - a.since);
}

export function dismissAlert(id: string) {
  if (active.has(id)) dismissed.add(id);
}

const GB = 1024 ** 3;
const fmtGB = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`;

// ---------- checks (every minute) ----------

function checkDisks() {
  const seen = new Set<string>();
  for (const inst of listInstances()) {
    const root = path.parse(path.resolve(inst.record.installDir)).root;
    if (seen.has(root) || !existsSync(root)) continue;
    seen.add(root);
    try {
      const fs = statfsSync(root);
      const free = fs.bavail * fs.bsize;
      const total = fs.blocks * fs.bsize;
      const id = `disk:${root.toLowerCase()}`;
      if (free < 5 * GB || free / total < 0.03) raise({ id, serverId: null, level: 'error', title: `Drive ${root} is almost full`, detail: `Only ${fmtGB(free)} free of ${fmtGB(total)}. Worlds and backups can't be saved when it runs out.` });
      else if (free < 15 * GB || free / total < 0.08) raise({ id, serverId: null, level: 'warn', title: `Drive ${root} is getting full`, detail: `${fmtGB(free)} free of ${fmtGB(total)}.` });
      else clear(id);
    } catch {}
  }
}

function checkMemory() {
  const now = new Set<string>();
  for (const inst of listInstances()) {
    if (!inst.isRunning) continue;
    const limit = inst.module.memoryLimit?.(inst.record);
    if (!limit?.mb) continue;
    const recent = serverStats(inst.id, 180).history.filter((s) => s.mem);
    if (recent.length < 10) continue;
    const avg = recent.reduce((n, s) => n + s.mem, 0) / recent.length;
    const share = avg / (limit.mb * 1024 * 1024);
    const id = `ram:${inst.id}`;
    if (share > 0.92) {
      raise({ id, serverId: inst.id, level: 'warn', title: `"${inst.record.name}" is near its RAM limit`, detail: `Using ${(avg / GB).toFixed(1)} GB of ${(limit.mb / 1024).toFixed(1)} GB for the last few minutes. It may lag or crash; raise the limit in Settings.` });
      now.add(id);
    }
  }
  sweep('ram:', now);
  const freeShare = os.freemem() / os.totalmem();
  if (freeShare < 0.05) raise({ id: 'pc-ram', serverId: null, level: 'warn', title: 'This system is almost out of RAM', detail: `${fmtGB(os.freemem())} free of ${fmtGB(os.totalmem())}.` });
  else clear('pc-ram');
}

function checkStuckAndCrashed() {
  const stuck = new Set<string>();
  const crashed = new Set<string>();
  for (const inst of listInstances()) {
    const s = { status: inst.status, startedAt: inst.startedAt, lastError: inst.lastError };
    if (s.status === 'starting' && s.startedAt && Date.now() - s.startedAt > 5 * 60_000) {
      raise({ id: `stuck:${inst.id}`, serverId: inst.id, level: 'warn', title: `"${inst.record.name}" is stuck starting`, detail: `Started ${Math.round((Date.now() - s.startedAt) / 60_000)} minutes ago and isn't ready yet. Check its console.` });
      stuck.add(`stuck:${inst.id}`);
    }
    if (s.status === 'crashed') {
      const cause = inst.diagnosis?.findings?.find((f) => f.severity === 'error')?.title;
      raise({ id: `crash:${inst.id}`, serverId: inst.id, level: 'error', title: `"${inst.record.name}" crashed`, detail: cause ? `Crash check: ${cause}.` : (s.lastError ?? 'It stopped without being asked to.') });
      crashed.add(`crash:${inst.id}`);
    }
  }
  sweep('stuck:', stuck);
  sweep('crash:', crashed);
}

function checkPorts() {
  const byPort = new Map<string, string[]>();
  for (const inst of listInstances()) {
    // An archived server never starts, so its port can't clash with anything.
    if (inst.record.archivedAt) continue;
    const c = inst.module.connection?.(inst.record);
    if (!c?.port) continue;
    const k = `${c.protocol}:${c.port}`;
    byPort.set(k, [...(byPort.get(k) ?? []), inst.record.name]);
  }
  const now = new Set<string>();
  for (const [k, names] of byPort) {
    if (names.length < 2) continue;
    const id = `port:${k}`;
    const [proto, port] = k.split(':');
    raise({ id, serverId: null, level: 'warn', title: `${names.length} servers use port ${port} (${proto})`, detail: `${names.map((n) => `"${n}"`).join(', ')} can't run at the same time. Give each its own port in Settings/Properties.` });
    now.add(id);
  }
  sweep('port:', now);
}

// ---------- world growth (hourly) ----------

const SIZES_FILE = 'health-sizes.json';
const sizes: Record<string, { t: number; bytes: number }[]> = readJson(SIZES_FILE, {});

/** Total size of a folder, walked gently (yields between folders; gives up past 400,000 files). */
async function folderSize(dir: string): Promise<number | null> {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        if (++files > 400_000) return null;
        try {
          total += (await lstat(p)).size;
        } catch {}
      }
    }
    await new Promise((r) => setImmediate(r));
  }
  return total;
}

async function checkGrowth() {
  const now = new Set<string>();
  for (const inst of listInstances()) {
    const bytes = await folderSize(inst.record.installDir);
    if (bytes == null) continue;
    const list = (sizes[inst.id] ??= []);
    list.push({ t: Date.now(), bytes });
    while (list.length && Date.now() - list[0].t > 48 * 3600_000) list.shift();
    const dayAgo = [...list].reverse().find((s) => Date.now() - s.t >= 23 * 3600_000);
    if (!dayAgo) continue;
    const grew = bytes - dayAgo.bytes;
    const id = `growth:${inst.id}`;
    if (grew > 5 * GB || (grew > GB && grew / Math.max(dayAgo.bytes, 1) > 0.5)) {
      raise({ id, serverId: inst.id, level: 'warn', title: `"${inst.record.name}" grew ${fmtGB(grew)} in a day`, detail: `Its folder went from ${fmtGB(dayAgo.bytes)} to ${fmtGB(bytes)}. Worth checking for a runaway farm, log spam or lots of new chunks.` });
      now.add(id);
    }
  }
  for (const id of Object.keys(sizes)) if (!listInstances().some((i) => i.id === id)) delete sizes[id];
  writeJson(SIZES_FILE, sizes);
  sweep('growth:', now);
}

// ---------- events: failed backups ----------

events.on('job', (job: JobInfo) => {
  if (job.kind !== 'backup') return;
  const id = `backup:${job.serverId}`;
  const name = listInstances().find((i) => i.id === job.serverId)?.record.name ?? 'a server';
  if (job.status === 'failed') raise({ id, serverId: job.serverId, level: 'error', title: `Backup of "${name}" failed`, detail: job.error ?? 'Unknown error.' });
  else if (job.status === 'done') clear(id);
});
events.on('backup-copy', (r: { serverId: string; ok: boolean; error?: string; folder?: string }) => {
  const id = `backup-copy:${r.serverId}`;
  const name = listInstances().find((i) => i.id === r.serverId)?.record.name ?? 'a server';
  if (r.ok) clear(id);
  else raise({ id, serverId: r.serverId, level: 'warn', title: `Backup of "${name}" wasn't copied to ${r.folder}`, detail: `${r.error ?? 'Unknown error.'} The backup on this system is fine. Check the drive or network share is reachable.` });
});
events.on('game-update', (u: { serverId: string; source: string; steamBuild: boolean; current: string | null; latest: string | null; available: boolean; auto: boolean }) => {
  const id = `bedrock-update:${u.serverId}`;
  const name = listInstances().find((i) => i.id === u.serverId)?.record.name ?? 'a server';
  const what = u.steamBuild ? `${u.source} server build ${u.latest}` : `${u.source} ${u.latest}`;
  const now = u.current ? (u.steamBuild ? `It runs build ${u.current}.` : `It runs ${u.current}.`) :"Its installed version isn't known yet (one update makes it known).";
  // Servers with automatic updates handle it themselves; the others get a notice with "Update now".
  if (u.available && !u.auto) raise({ id, serverId: u.serverId, level: 'warn', title: `${what} is available for "${name}"`, detail: `${now} Open the server → Settings → Server software and press "Update now", or turn on automatic updates.` });
  else clear(id);
});
// World checks (world-check.ts): damage stays raised until a clean check, a repair or the owner accepting it.
events.on('world-check', (e: { serverId: string; phase: string; run?: { status: string; error?: string; result?: { gone: number; regenerated: number; holes: number; problemCount: number; areas: { dimension: string; x: number; z: number }[] } } }) => {
  const id = `world:${e.serverId}`;
  const name = listInstances().find((i) => i.id === e.serverId)?.record.name ?? 'a server';
  if (e.phase === 'accepted' || e.phase === 'reset') return clear(id);
  if (e.phase !== 'done' || !e.run) return;
  const r = e.run.result;
  if (e.run.status === 'damaged' && r) {
    const parts = [
      r.gone && `${r.gone.toLocaleString()} chunks gone`,
      r.regenerated && `${r.regenerated.toLocaleString()} regenerated`,
      r.holes && `${r.holes.toLocaleString()} with missing block layers`,
      r.problemCount && `${r.problemCount} damaged database blocks`,
    ].filter(Boolean);
    const where = r.areas.slice(0, 3).map((a) => `${a.dimension} X ${a.x} Z ${a.z}`).join('; ');
    raise({ id, serverId: e.serverId, level: 'error', title: `World damage found in "${name}"`, detail: `${parts.join(', ')}.${where ? ` Around: ${where}.` : ''} Open Backups → World check for the list. The last good backup is kept safe.` });
  } else if (e.run.status === 'failed') raise({ id, serverId: e.serverId, level: 'warn', title: `World check of "${name}" couldn't finish`, detail: e.run.error ?? 'Unknown error.' });
  else clear(id);
});
events.on('start-blocked', (e: { serverId: string; reason: string }) => {
  const name = listInstances().find((i) => i.id === e.serverId)?.record.name ?? 'a server';
  raise({ id: `start-blocked:${e.serverId}`, serverId: e.serverId, level: 'error', title: `"${name}" was not started`, detail: e.reason });
});
events.on('state', (serverId: string) => {
  const inst = listInstances().find((i) => i.id === serverId);
  if (inst?.isRunning) clear(`start-blocked:${serverId}`);
  if (!inst?.startedAt) clear(`udp-ports-restart:${serverId}`);
});
events.on('removed', (serverId: string) => {
  for (const [id, a] of active) if (a.serverId === serverId) clear(id);
});

// Public IP changes: players outside the network join with the public IP, and Bedrock's server-udp-ports has it
// written in, so a change (most home internet gets a new one now and then) quietly stops outside players joining.
const PUBLIC_IP_FILE = 'public-ip.json';
const PUBLIC_IP_INTERVAL = 5 * 60_000;
interface PublicIpState {
  ip: string | null;
  changedAt: number | null;
  previous: string | null;
  bedrockRestarts?: Record<string, number>;
}

async function checkPublicIp() {
  const ip = await lookupPublicIp({ maxAgeMs: 0, allowStale: false });
  if (!ip) return;
  const seen = readJson<PublicIpState>(PUBLIC_IP_FILE, { ip: null, changedAt: null, previous: null });
  const changed = !!seen.ip && seen.ip !== ip;
  const previous = changed ? seen.ip : seen.previous;
  const changedAt = changed ? Date.now() : seen.changedAt;
  const restarts: Record<string, number> = {};
  const pendingAlerts = new Set<string>();
  const staleAlerts = new Set<string>();
  for (const inst of listInstances()) {
    if (inst.record.game !== 'bedrock' || inst.record.archivedAt) continue;
    const file = path.join(inst.record.installDir, 'server.properties');
    const staleId = `udp-ports-ip:${inst.id}`;
    let updated = false;
    try {
      if (previous && previous !== ip && !runningJob(inst.id) && (inst.status !== 'starting' || inst.startedAt) && existsSync(file)) {
        const before = readFileSync(file, 'utf-8');
        const after = replaceBedrockPublicIp(before, previous, ip);
        if (after !== before) {
          inst.assertNotOwnedElsewhere();
          writePropertiesText(file, after);
          updated = true;
        }
      }
      const props = readProperties(file).values;
      const udp = parseUdpPorts(props.get('server-udp-ports'));
      if (props.get('transport')?.trim() !== 'raknet' && udp && udp.ip !== ip) {
        staleAlerts.add(staleId);
        raise({
          id: staleId,
          serverId: inst.id,
          level: 'error',
          title: `"${inst.record.name}": server-udp-ports uses a different public IP`,
          detail: `It has ${udp.ip} and this system's public IP is ${ip}. Check the address under Port forwarding and restart the server after any changes.`,
        });
      }
    } catch (err) {
      staleAlerts.add(staleId);
      raise({
        id: staleId,
        serverId: inst.id,
        level: 'error',
        title: `"${inst.record.name}": couldn't check or update server-udp-ports`,
        detail: `Server Forge will try again. ${(err as Error).message}`,
      });
    }

    const startedAt = inst.startedAt;
    if (startedAt && (updated || seen.bedrockRestarts?.[inst.id] === startedAt)) {
      restarts[inst.id] = startedAt;
      const id = `udp-ports-restart:${inst.id}`;
      pendingAlerts.add(id);
      raise({
        id,
        serverId: inst.id,
        level: 'warn',
        title: `"${inst.record.name}": restart to apply its updated public IP`,
        detail: 'Server Forge updated server-udp-ports. Restart the Bedrock server when ready to apply the new public IP.',
      });
    }
  }
  if (seen.ip !== ip || JSON.stringify(seen.bedrockRestarts ?? {}) !== JSON.stringify(restarts)) {
    writeJson(PUBLIC_IP_FILE, { ip, changedAt, previous, bedrockRestarts: restarts });
  }
  sweep('udp-ports-ip:', staleAlerts);
  sweep('udp-ports-restart:', pendingAlerts);

  // The general notice stays for 3 days (or until dismissed).
  if (changed) clear('public-ip-changed');
  if (changedAt && Date.now() - changedAt < 3 * 86400_000) {
    raise({
      id: 'public-ip-changed',
      serverId: null,
      level: 'warn',
      title: 'Your public IP address changed',
      detail: `It was ${previous}, now it's ${ip}. Players outside your network need the new address. Create new share links to use it.`,
    });
  } else clear('public-ip-changed');
}

export function startHealthChecks() {
  setTimeout(() => checkPublicIp().catch(() => {}), 60_000).unref();
  setInterval(() => checkPublicIp().catch(() => {}), PUBLIC_IP_INTERVAL).unref();
  const minute = () => {
    for (const check of [checkDisks, checkMemory, checkStuckAndCrashed, checkPorts]) {
      try {
        check();
      } catch {}
    }
  };
  setTimeout(minute, 15_000).unref();
  setInterval(minute, 60_000).unref();
  // Folder sizes: first a few minutes after start, then hourly.
  setTimeout(() => checkGrowth().catch(() => {}), 5 * 60_000).unref();
  setInterval(() => checkGrowth().catch(() => {}), 3600_000).unref();
}
