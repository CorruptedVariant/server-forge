// Discord notifications: each server can post to a Discord channel through a webhook (Channel settings → Integrations →
// Webhooks → New webhook → Copy URL). No bot needed. Server Forge watches its own events and posts when a server starts,
// stops or crashes, players join or leave, an update is available, done or failed, or a backup fails.
// Settings live in data/discord.json. Messages are queued per webhook and spaced out (Discord limits how fast a webhook
// may post); players joining or leaving within a few seconds are grouped into one message.
import { readJson, writeJson } from './store.ts';
import { events } from './events.ts';
import { getInstance, listInstances } from './instances.ts';
import type { JobInfo } from './jobs.ts';

const FILE = 'discord.json';
const WEBHOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[\w-]{20,200}$/;

export const NOTIFY_EVENTS = {
  started: 'Server started (ready for players)',
  stopped: 'Server stopped',
  crashed: 'Server crashed',
  join: 'Player joined',
  leave: 'Player left',
  updateAvailable: 'Update available',
  updated: 'Update installed (or failed)',
  backupFailed: 'Backup failed',
} as const;
export type NotifyEvent = keyof typeof NOTIFY_EVENTS;

export interface DiscordSettings {
  url: string;
  events: Record<NotifyEvent, boolean>;
}

const DEFAULT_EVENTS: Record<NotifyEvent, boolean> = { started: true, stopped: true, crashed: true, join: false, leave: false, updateAvailable: true, updated: true, backupFailed: true };

function all(): Record<string, DiscordSettings> {
  return readJson<Record<string, DiscordSettings>>(FILE, {});
}

export function getDiscord(serverId: string): DiscordSettings {
  const s = all()[serverId];
  return { url: s?.url ?? '', events: { ...DEFAULT_EVENTS, ...(s?.events ?? {}) } };
}

export function setDiscord(serverId: string, input: { url?: unknown; events?: unknown }): DiscordSettings {
  const url = String(input.url ?? '').trim();
  if (url && !WEBHOOK.test(url)) throw new Error('That is not a Discord webhook address. In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.');
  const events = { ...DEFAULT_EVENTS };
  const given = (input.events ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_EVENTS) as NotifyEvent[]) if (k in given) events[k] = given[k] === true;
  const data = all();
  if (url) data[serverId] = { url, events };
  else delete data[serverId];
  writeJson(FILE, data);
  return getDiscord(serverId);
}

export function forgetDiscord(serverId: string) {
  const data = all();
  if (data[serverId]) {
    delete data[serverId];
    writeJson(FILE, data);
  }
}

// ---------- sending (a queue per webhook) ----------

interface Embed {
  title: string;
  description?: string;
  color: number;
}
const COLORS = { good: 0x3fb950, info: 0x58a6ff, warn: 0xd29922, bad: 0xf85149, muted: 0x8b949e };

const queues = new Map<string, { items: { embed: Embed; server: string }[]; busy: boolean }>();

async function post(url: string, body: unknown): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${url}?wait=false`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({})))?.retry_after ?? 2);
      await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0.5, wait)) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Discord answered ${res.status}${res.status === 404 ? ' (the webhook was deleted)' : ''}.`);
    return;
  }
  throw new Error('Discord kept saying "too many messages"; try again in a minute.');
}

function enqueue(url: string, server: string, embed: Embed) {
  let q = queues.get(url);
  if (!q) queues.set(url, (q = { items: [], busy: false }));
  if (q.items.length > 50) return; // something is flooding: drop rather than pile up
  q.items.push({ embed, server });
  void drain(url);
}

async function drain(url: string) {
  const q = queues.get(url)!;
  if (q.busy) return;
  q.busy = true;
  try {
    while (q.items.length) {
      // Up to 10 embeds per message (Discord's limit), all for the same webhook.
      const batch = q.items.splice(0, 10);
      await post(url, {
        username: 'Server Forge',
        allowed_mentions: { parse: [] },
        embeds: batch.map((b) => ({ ...b.embed, footer: { text: b.server }, timestamp: new Date().toISOString() })),
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally {
    q.busy = false;
  }
}

/** Posts if this server has a webhook and that event switched on. */
function notify(serverId: string, event: NotifyEvent, embed: Embed) {
  const s = getDiscord(serverId);
  if (!s.url || !s.events[event]) return;
  let name = serverId;
  try {
    name = getInstance(serverId).record.name;
  } catch {}
  enqueue(s.url, name, embed);
}

/** "Send test message" in Settings. Waits for Discord's answer so a wrong webhook shows an error. */
export async function testDiscord(serverId: string, url?: string) {
  const target = String(url ?? getDiscord(serverId).url).trim();
  if (!WEBHOOK.test(target)) throw new Error('Paste a Discord webhook address first.');
  const name = getInstance(serverId).record.name;
  await post(target, {
    username: 'Server Forge',
    allowed_mentions: { parse: [] },
    embeds: [{ title: '👋 Test message', description: `Notifications for **${name.replace(/[*_`~|>]/g, '')}** will appear here.`, color: COLORS.info, footer: { text: name }, timestamp: new Date().toISOString() }],
  });
}

// ---------- watching Server Forge's events ----------

const clean = (s: string) => s.replace(/[*_`~|>@]/g, '').slice(0, 200);
const seen = new Map<string, { status: string; players: Set<string> }>();
const pendingPlayers = new Map<string, { joined: Set<string>; left: Set<string>; timer: NodeJS.Timeout }>();
const notifiedJobs = new Set<string>();
const notifiedUpdates = new Map<string, string>();

function flushPlayers(serverId: string) {
  const p = pendingPlayers.get(serverId);
  pendingPlayers.delete(serverId);
  if (!p) return;
  if (p.joined.size) notify(serverId, 'join', { title: `➡️ ${[...p.joined].map(clean).join(', ')} joined`, color: COLORS.good });
  if (p.left.size) notify(serverId, 'leave', { title: `⬅️ ${[...p.left].map(clean).join(', ')} left`, color: COLORS.muted });
}

function onState(serverId: string) {
  let inst;
  try {
    inst = getInstance(serverId);
  } catch {
    return;
  }
  const status = inst.status;
  const players = new Set(inst.status === 'running' ? (inst.liveState().players ?? []).map((p) => p.name) : []);
  const before = seen.get(serverId);
  seen.set(serverId, { status, players });
  if (!before) return; // first look after Server Forge started: nothing changed yet
  if (status !== before.status) {
    if (status === 'running') notify(serverId, 'started', { title: '🟢 Server is up', description: 'Ready for players.', color: COLORS.good });
    else if (status === 'stopped' && ['running', 'stopping', 'starting'].includes(before.status)) notify(serverId, 'stopped', { title: '⚪ Server stopped', color: COLORS.muted });
    else if (status === 'crashed') notify(serverId, 'crashed', { title: '🔴 Server crashed', description: clean(inst.lastError ?? 'It stopped without being asked to.') + (inst.record.autoRestart ? '\nServer Forge is restarting it.' : ''), color: COLORS.bad });
  }
  // Players: only while running (a stop isn't everyone "leaving").
  if (status === 'running' && before.status === 'running') {
    const joined = [...players].filter((n) => !before.players.has(n));
    const left = [...before.players].filter((n) => !players.has(n));
    if (joined.length || left.length) {
      let p = pendingPlayers.get(serverId);
      if (!p) pendingPlayers.set(serverId, (p = { joined: new Set(), left: new Set(), timer: setTimeout(() => flushPlayers(serverId), 5000) }));
      for (const n of joined) p.left.has(n) ? p.left.delete(n) : p.joined.add(n);
      for (const n of left) p.joined.has(n) ? p.joined.delete(n) : p.left.add(n);
    }
  }
}

function onJob(info: JobInfo) {
  if (info.status === 'running' || notifiedJobs.has(info.id)) return;
  notifiedJobs.add(info.id);
  if (notifiedJobs.size > 500) notifiedJobs.delete(notifiedJobs.values().next().value!);
  if (info.kind === 'backup' && info.status === 'failed') {
    notify(info.serverId, 'backupFailed', { title: '⚠️ Backup failed', description: clean(info.error ?? ''), color: COLORS.bad });
  } else if (info.kind === 'update') {
    notify(
      info.serverId,
      'updated',
      info.status === 'done'
        ? { title: '⬆️ Update installed', description: clean(info.title.replace(/^Updating to /, '')), color: COLORS.good }
        : { title: '⚠️ Update failed', description: clean(info.error ?? ''), color: COLORS.bad },
    );
  }
}

function onGameUpdate(u: { serverId: string; available: boolean; latest: string | null; auto: boolean }) {
  if (!u.available || !u.latest || notifiedUpdates.get(u.serverId) === u.latest) return;
  notifiedUpdates.set(u.serverId, u.latest);
  notify(u.serverId, 'updateAvailable', {
    title: '🆕 Update available',
    description: `Version ${clean(u.latest)}${u.auto ? ' (installing automatically)' : ' (update it from Server Forge: Settings → Server software)'}.`,
    color: COLORS.warn,
  });
}

export function startDiscordNotifications() {
  for (const inst of listInstances()) seen.set(inst.id, { status: inst.status, players: new Set((inst.liveState().players ?? []).map((p) => p.name)) });
  events.on('state', onState);
  events.on('job', onJob);
  events.on('game-update', onGameUpdate);
  events.on('removed', (id: string) => forgetDiscord(id));
}
