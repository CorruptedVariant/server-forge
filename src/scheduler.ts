// Task scheduler (like MCSS): per-server tasks that run on an interval, at set times of day, or only when started by
// hand. Each task runs its jobs in order: console commands, in-game messages, start/stop/restart (with countdown
// warnings to players), kill, backup, wait. Stored in data/tasks.json.
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './store.ts';
import { getInstance, listInstances } from './instances.ts';
import { jobsFor } from './jobs.ts';

const FILE = 'tasks.json';

export type Trigger =
  | { type: 'interval'; everyMinutes: number }
  /** times: "HH:MM" (24 h, this system's time); days: 0 = Sunday ... 6 = Saturday (empty = every day). */
  | { type: 'daily'; times: string[]; days: number[] }
  | { type: 'manual' };

export type TaskJob =
  | { type: 'command'; commands: string[] }
  | { type: 'say'; message: string }
  /** warnMinutes: announce "…in N minutes" to players at these points before stopping/restarting. */
  | { type: 'start' | 'stop' | 'restart'; warnMinutes?: number[]; message?: string }
  | { type: 'kill' }
  | { type: 'backup' }
  | { type: 'wait'; seconds: number };

export interface Task {
  id: string;
  serverId: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  jobs: TaskJob[];
  /** Skip the whole task if the server isn't running when it's due. */
  onlyWhenRunning: boolean;
  createdAt: number;
  lastRun: number | null;
  lastResult: string | null;
  lastOk: boolean | null;
}

let tasks: Task[] = readJson<Task[]>(FILE, []);
const running = new Set<string>();

function save() {
  writeJson(FILE, tasks);
}

// ---------- validation ----------

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function validTrigger(t: any): Trigger {
  if (t?.type === 'interval') {
    const every = Number(t.everyMinutes);
    if (!Number.isFinite(every) || every < 1 || every > 60 * 24 * 31) throw new Error('Interval must be between 1 minute and 31 days.');
    return { type: 'interval', everyMinutes: Math.round(every) };
  }
  if (t?.type === 'daily') {
    const times = [...new Set((Array.isArray(t.times) ? t.times : []).map((x: unknown) => String(x).trim()).filter(Boolean))] as string[];
    if (!times.length) throw new Error('Add at least one time of day.');
    for (const x of times) if (!HHMM.test(x)) throw new Error(`"${x}" isn't a time like 04:00 or 16:30.`);
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(Number).filter((d: number) => d >= 0 && d <= 6))] as number[];
    return { type: 'daily', times: times.map((x) => x.padStart(5, '0')).sort(), days: days.sort() };
  }
  if (t?.type === 'manual') return { type: 'manual' };
  throw new Error('Choose when the task runs.');
}

function validJobs(list: any, canCommand: boolean): TaskJob[] {
  if (!Array.isArray(list) || !list.length) throw new Error('Add at least one job.');
  if (list.length > 30) throw new Error('A task can have at most 30 jobs.');
  return list.map((j: any, i: number): TaskJob => {
    const where = `Job ${i + 1}`;
    switch (j?.type) {
      case 'command': {
        if (!canCommand) throw new Error(`${where}: this server doesn't accept console commands.`);
        const commands = (Array.isArray(j.commands) ? j.commands : String(j.commands ?? '').split(/\r?\n/)).map((c: unknown) => String(c).trim().replace(/^\//, '')).filter(Boolean);
        if (!commands.length) throw new Error(`${where}: enter at least one command.`);
        if (commands.some((c: string) => c.length > 1000)) throw new Error(`${where}: a command is too long.`);
        return { type: 'command', commands };
      }
      case 'say': {
        if (!canCommand) throw new Error(`${where}: this server can't send in-game messages.`);
        const message = String(j.message ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!message) throw new Error(`${where}: enter a message.`);
        return { type: 'say', message: message.slice(0, 500) };
      }
      case 'start':
        return { type: 'start' };
      case 'stop':
      case 'restart': {
        const warn = [...new Set((Array.isArray(j.warnMinutes) ? j.warnMinutes : []).map(Number).filter((n: number) => Number.isFinite(n) && n > 0 && n <= 60))] as number[];
        if (warn.length && !canCommand) throw new Error(`${where}: this server can't warn players in-game.`);
        return { type: j.type, warnMinutes: warn.sort((a, b) => b - a), message: String(j.message ?? '').trim().slice(0, 200) || undefined };
      }
      case 'kill':
        return { type: 'kill' };
      case 'backup':
        return { type: 'backup' };
      case 'wait': {
        const seconds = Number(j.seconds);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error(`${where}: wait 1 to 3600 seconds.`);
        return { type: 'wait', seconds: Math.round(seconds) };
      }
      default:
        throw new Error(`${where}: unknown job type.`);
    }
  });
}

function validTask(input: any, serverId: string): Omit<Task, 'id' | 'createdAt' | 'lastRun' | 'lastResult' | 'lastOk'> {
  const inst = getInstance(serverId);
  const name = String(input?.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Give the task a name (up to 80 characters).');
  return {
    serverId,
    name,
    enabled: input.enabled !== false,
    trigger: validTrigger(input.trigger),
    jobs: validJobs(input.jobs, !!inst.module.commands),
    onlyWhenRunning: input.onlyWhenRunning === true,
  };
}

// ---------- API helpers ----------

export function listTasks(serverId: string) {
  return tasks.filter((t) => t.serverId === serverId).map((t) => ({ ...t, nextRun: nextRun(t), running: running.has(t.id) }));
}

export function createTask(serverId: string, input: unknown) {
  const task: Task = { ...validTask(input, serverId), id: randomUUID().slice(0, 8), createdAt: Date.now(), lastRun: null, lastResult: null, lastOk: null };
  tasks.push(task);
  save();
  return task;
}

export function updateTask(serverId: string, id: string, input: unknown) {
  const task = tasks.find((t) => t.id === id && t.serverId === serverId);
  if (!task) throw new Error('Task not found.');
  Object.assign(task, validTask(input, serverId));
  save();
  return task;
}

export function deleteTask(serverId: string, id: string) {
  const before = tasks.length;
  tasks = tasks.filter((t) => !(t.id === id && t.serverId === serverId));
  if (tasks.length === before) throw new Error('Task not found.');
  save();
}

export function deleteTasksFor(serverId: string) {
  tasks = tasks.filter((t) => t.serverId !== serverId);
  save();
}

export function runTaskNow(serverId: string, id: string) {
  const task = tasks.find((t) => t.id === id && t.serverId === serverId);
  if (!task) throw new Error('Task not found.');
  if (running.has(task.id)) throw new Error('That task is already running.');
  void runTask(task, 'by hand');
}

// ---------- timing ----------

/** The most recent daily slot at or before `now` (ms), or null. */
function lastDailySlot(t: Extract<Trigger, { type: 'daily' }>, now: number): number | null {
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now);
    day.setDate(day.getDate() - back);
    if (t.days.length && !t.days.includes(day.getDay())) continue;
    const slots = t.times
      .map((hm) => {
        const [h, m] = hm.split(':').map(Number);
        const d = new Date(day);
        d.setHours(h, m, 0, 0);
        return d.getTime();
      })
      .filter((x) => x <= now)
      .sort((a, b) => b - a);
    if (slots.length) return slots[0];
  }
  return null;
}

export function nextRun(task: Task): number | null {
  if (!task.enabled) return null;
  const t = task.trigger;
  if (t.type === 'manual') return null;
  if (t.type === 'interval') return (task.lastRun ?? task.createdAt) + t.everyMinutes * 60_000;
  const now = Date.now();
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now);
    day.setDate(day.getDate() + ahead);
    if (t.days.length && !t.days.includes(day.getDay())) continue;
    for (const hm of t.times) {
      const [h, m] = hm.split(':').map(Number);
      const d = new Date(day);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > now) return d.getTime();
    }
  }
  return null;
}

function isDue(task: Task, now: number): boolean {
  if (!task.enabled || running.has(task.id)) return false;
  const t = task.trigger;
  if (t.type === 'manual') return false;
  if (t.type === 'interval') return now >= (task.lastRun ?? task.createdAt) + t.everyMinutes * 60_000;
  const slot = lastDailySlot(t, now);
  // Run a slot once; if Server Forge was off at the time, still run it if it's less than 10 minutes late.
  return slot !== null && slot > (task.lastRun ?? task.createdAt) && now - slot < 10 * 60_000;
}

// ---------- running ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBackup(serverId: string, jobId: string) {
  for (;;) {
    const job = jobsFor(serverId).find((j) => j.id === jobId);
    if (!job || job.status !== 'running') return job;
    await sleep(2000);
  }
}

async function runTask(task: Task, why: string) {
  running.add(task.id);
  const inst = (() => {
    try {
      return getInstance(task.serverId);
    } catch {
      return null;
    }
  })();
  const started = Date.now();
  let ok = true;
  let result = '';
  try {
    if (!inst) throw new Error('The server no longer exists.');
    if (task.onlyWhenRunning && !inst.isRunning) {
      result = 'Skipped: the server was not running.';
      return;
    }
    inst.log(`Task "${task.name}" started (${why}).`);
    const done: string[] = [];
    for (const job of task.jobs) {
      switch (job.type) {
        case 'command':
          if (!inst.isRunning) {
            done.push('commands skipped (not running)');
            break;
          }
          for (const c of job.commands) {
            await inst.sendCommand(c);
            await sleep(300);
          }
          done.push(`${job.commands.length} command(s)`);
          break;
        case 'say':
          if (inst.isRunning) await inst.sendCommand(`say ${job.message}`);
          done.push('message');
          break;
        case 'start':
          if (!inst.isRunning) await inst.start();
          done.push('start');
          break;
        case 'stop':
        case 'restart': {
          if (!inst.isRunning) {
            if (job.type === 'restart') await inst.start();
            done.push(job.type === 'restart' ? 'start (was stopped)' : 'stop (already stopped)');
            break;
          }
          // Countdown (e.g. [5, 1] minutes, then the last seconds), shared with the panel's Countdown button.
          const went = await inst.countdownThen(job.type, job.warnMinutes ?? [], job.message, `task "${task.name}"`);
          done.push(went ? job.type : `${job.type} cancelled`);
          break;
        }
        case 'kill':
          await inst.kill();
          done.push('kill');
          break;
        case 'backup': {
          const info = inst.backupNow('manual');
          const finished = await waitForBackup(task.serverId, info.id);
          if (finished?.status === 'failed') throw new Error(`Backup failed: ${finished.error}`);
          done.push('backup');
          break;
        }
        case 'wait':
          await sleep(job.seconds * 1000);
          done.push(`wait ${job.seconds}s`);
          break;
      }
    }
    result = `Done: ${done.join(', ')} (${Math.round((Date.now() - started) / 1000)} s).`;
    inst.log(`Task "${task.name}" finished.`);
  } catch (err) {
    ok = false;
    result = `Failed: ${(err as Error).message}`;
    inst?.log(`Task "${task.name}" failed: ${(err as Error).message}`);
  } finally {
    running.delete(task.id);
    const live = tasks.find((t) => t.id === task.id);
    if (live) {
      live.lastRun = started;
      live.lastResult = result;
      live.lastOk = ok;
      save();
    }
  }
}

// Check every 15 seconds.
setInterval(() => {
  const now = Date.now();
  // Archived servers are put away: their tasks wait until they're unarchived.
  const servers = new Set(listInstances().filter((i) => !i.record.archivedAt).map((i) => i.id));
  for (const task of tasks) if (servers.has(task.serverId) && isDue(task, now)) void runTask(task, 'scheduled');
}, 15_000).unref();
