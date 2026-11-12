// CPU, memory and player counts per server. One long-lived PowerShell sampler lists every process's CPU time and
// working set every few seconds (only while at least one server is running); each server's usage is the sum over its
// process tree. CPU % is like Task Manager: share of the whole system (all cores).
// History: every sample for the last hour, plus one-minute averages for 24 hours (saved to disk, so graphs survive a
// panel restart). Stopped periods simply have no samples, which the graphs show as gaps.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { isLinux } from './platform/host.ts';
import { readJson, writeJson } from './store.ts';

const INTERVAL_S = 3;
const RAW_KEEP_MS = 60 * 60_000;
const MINUTE_KEEP_MS = 24 * 60 * 60_000;
const STATS_FILE = 'stats-history.json';

export interface Sample {
  t: number;
  /** % of the whole system's CPU. */
  cpu: number;
  /** Working set (RAM in use), bytes. */
  mem: number;
  /** Players online (null if the game didn't report it). */
  players: number | null;
}

interface Target {
  id: string;
  pid: number;
  /** Skip the root process itself (Server Forge's runner, which owns the game's console). */
  excludeRoot: boolean;
  players: number | null;
}

interface History {
  raw: Sample[];
  /** One-minute buckets: average CPU/RAM, highest player count. */
  minutes: Sample[];
}

// Exits by itself if the panel goes away (e.g. it was force-closed and couldn't stop the sampler).
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while (Get-Process -Id ${process.pid}) {
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime,WorkingSetSize
  $parts = foreach ($p in $all) { '{0},{1},{2},{3},{4}' -f $p.ProcessId, $p.ParentProcessId, ([uint64]$p.KernelModeTime + [uint64]$p.UserModeTime), $p.WorkingSetSize, ($p.Name -replace '[,;]', '') }
  [Console]::Out.WriteLine(($parts -join ';'))
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${INTERVAL_S}
}`;

let source: () => Target[] = () => [];
let sampler: ChildProcess | null = null;
let lastCpu = new Map<number, number>(); // pid -> CPU time (100 ns units) at the previous sample
let lastAt = 0;
const history = new Map<string, History>(Object.entries(readJson<Record<string, History>>(STATS_FILE, {})));
let dirty = false;

/** Tells the sampler which servers are running (called by instances.ts). */
export function setStatsSource(fn: () => Target[]) {
  source = fn;
}

function historyOf(id: string): History {
  let h = history.get(id);
  if (!h) {
    h = { raw: [], minutes: [] };
    history.set(id, h);
  }
  return h;
}

/** Folds finished minutes of raw samples into minute buckets and trims old data. */
function roll(h: History, at: number) {
  const lastBucket = h.minutes.at(-1)?.t ?? 0;
  const currentMinute = Math.floor(at / 60_000) * 60_000;
  const pending = h.raw.filter((s) => s.t >= lastBucket + 60_000 && s.t < currentMinute);
  const groups = new Map<number, Sample[]>();
  for (const s of pending) {
    const m = Math.floor(s.t / 60_000) * 60_000;
    if (m <= lastBucket) continue;
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m)!.push(s);
  }
  for (const [m, list] of [...groups].sort((a, b) => a[0] - b[0])) {
    const players = list.map((s) => s.players).filter((p): p is number => p != null);
    h.minutes.push({
      t: m,
      cpu: Math.round((list.reduce((a, s) => a + s.cpu, 0) / list.length) * 10) / 10,
      mem: Math.round(list.reduce((a, s) => a + s.mem, 0) / list.length),
      players: players.length ? Math.max(...players) : null,
    });
  }
  while (h.raw.length && h.raw[0].t < at - RAW_KEEP_MS) h.raw.shift();
  while (h.minutes.length && h.minutes[0].t < at - MINUTE_KEEP_MS) h.minutes.shift();
}

function onSample(line: string) {
  const at = Date.now();
  const procs = new Map<number, { ppid: number; cpu: number; mem: number; name: string }>();
  const children = new Map<number, number[]>();
  for (const part of line.split(';')) {
    const fields = part.split(',');
    const [pid, ppid, cpu, mem] = fields.slice(0, 4).map(Number);
    if (!pid) continue;
    procs.set(pid, { ppid, cpu, mem, name: (fields[4] ?? '').toLowerCase() });
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const elapsed = lastAt ? (at - lastAt) * 10_000 : 0; // ms -> 100 ns units
  const cores = os.cpus().length || 1;
  for (const target of source()) {
    if (!procs.has(target.pid)) continue;
    // The server's process and everything it started.
    const members: number[] = [];
    const stack = [target.pid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      // The hidden console window (conhost) isn't the server's own memory; Task Manager lists it separately too.
      if (!(target.excludeRoot && pid === target.pid) && procs.get(pid)?.name !== 'conhost.exe') members.push(pid);
      for (const c of children.get(pid) ?? []) if (c !== pid) stack.push(c);
    }
    let mem = 0;
    let cpuDelta = 0;
    for (const pid of members) {
      const p = procs.get(pid)!;
      mem += p.mem;
      const before = lastCpu.get(pid);
      if (before !== undefined && p.cpu >= before) cpuDelta += p.cpu - before;
    }
    if (elapsed <= 0) continue;
    const cpu = Math.min(100, (cpuDelta / (elapsed * cores)) * 100);
    const h = historyOf(target.id);
    h.raw.push({ t: at, cpu: Math.round(cpu * 10) / 10, mem, players: target.players });
    roll(h, at);
    dirty = true;
  }
  lastCpu = new Map([...procs].map(([pid, p]) => [pid, p.cpu]));
  lastAt = at;
}

/** One sample in the sampler's format, from /proc. CPU time is in clock ticks (100 a second), converted to 100 ns units. */
function linuxSample(): string {
  const page = 4096;
  const parts: string[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1');
      const close = stat.lastIndexOf(')'); // the program's name is in brackets and may contain spaces
      const f = stat.slice(close + 2).split(' ');
      parts.push(`${name},${f[1]},${(Number(f[11]) + Number(f[12])) * 100_000},${Number(f[21]) * page},${stat.slice(stat.indexOf('(') + 1, close).replace(/[,;]/g, '')}`);
    } catch {} // it exited while we looked
  }
  return parts.join(';');
}

let linuxTimer: NodeJS.Timeout | null = null;

function startSampler() {
  if (isLinux) {
    if (linuxTimer) return;
    lastAt = 0;
    const tick = () => {
      try {
        onSample(linuxSample());
      } catch {}
    };
    tick();
    linuxTimer = setInterval(tick, INTERVAL_S * 1000);
    linuxTimer.unref();
    return;
  }
  if (sampler) return;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  sampler = child;
  lastAt = 0;
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      onSample(line);
    } catch {}
  });
  child.on('exit', () => {
    if (sampler === child) sampler = null;
  });
}

function stopSampler() {
  if (linuxTimer) clearInterval(linuxTimer);
  linuxTimer = null;
  sampler?.kill();
  sampler = null;
}

function save() {
  if (!dirty) return;
  dirty = false;
  writeJson(STATS_FILE, Object.fromEntries(history));
}

// Run the sampler only while something is running; save history now and then.
setInterval(() => {
  if (source().length) startSampler();
  else stopSampler();
}, 2000).unref();
setInterval(save, 60_000).unref();
process.on('exit', () => {
  stopSampler();
  save();
});

// The whole system's CPU %, from the cores' busy/idle times between two samples (inside a container: the host's).
let cpuTimes: { busy: number; total: number } | null = null;
let systemCpu: number | null = null;
function sampleSystemCpu() {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
    total += t;
    busy += t - c.times.idle;
  }
  if (cpuTimes && total > cpuTimes.total) systemCpu = Math.min(100, Math.max(0, ((busy - cpuTimes.busy) / (total - cpuTimes.total)) * 100));
  cpuTimes = { busy, total };
}
sampleSystemCpu();
setInterval(sampleSystemCpu, INTERVAL_S * 1000).unref();

/** The whole system's CPU % (all cores) and core count, for the sidebar's system headings. */
export function systemCpuUsage(): { cpu: number | null; cores: number } {
  return { cpu: systemCpu, cores: os.cpus().length };
}

/**
 * The whole system's RAM, for the sidebar's system headings (bytes). Inside a container these are the host's numbers.
 * ZFS (TrueNAS) keeps its read cache in RAM and hands it back when programs need it, so it's reported apart from "used"
 * the way TrueNAS's own dashboard does, instead of making the system look full.
 */
export function systemMemory(): { total: number; used: number; zfsCache: number } {
  const total = os.totalmem();
  let zfsCache = 0;
  if (isLinux) {
    try {
      zfsCache = Number(/^size\s+\d+\s+(\d+)$/m.exec(readFileSync('/proc/spl/kstat/zfs/arcstats', 'utf-8'))?.[1] ?? 0);
    } catch {}
  }
  // freemem() is MemAvailable on Linux, which doesn't count the ZFS cache as available.
  const used = Math.max(0, total - os.freemem() - zfsCache);
  return { total, used, zfsCache };
}

/** Drops a deleted server's history. */
export function forgetStats(id: string) {
  if (history.delete(id)) dirty = true;
}

/** Latest sample plus the history for the last `rangeSeconds` (every sample up to 1 hour, minute averages beyond). */
export function serverStats(id: string, rangeSeconds = 300) {
  const h = history.get(id) ?? { raw: [], minutes: [] };
  const last = h.raw.at(-1) ?? null;
  const fresh = last && Date.now() - last.t < INTERVAL_S * 1000 * 4;
  const since = Date.now() - rangeSeconds * 1000;
  const useRaw = rangeSeconds <= 3600;
  const points = (useRaw ? h.raw : [...h.minutes, ...h.raw.filter((s) => s.t >= (h.minutes.at(-1)?.t ?? 0) + 60_000)]).filter((s) => s.t >= since);
  return {
    cpu: fresh ? last.cpu : null,
    mem: fresh ? last.mem : null,
    players: fresh ? last.players : null,
    history: points,
    /** Spacing of the points, so graphs can tell a gap (server off) from normal spacing. */
    step: useRaw ? INTERVAL_S : 60,
    cores: os.cpus().length,
    systemMem: os.totalmem(),
    intervalSeconds: INTERVAL_S,
  };
}
