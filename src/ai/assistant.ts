// The SF Assistant: chat sessions with Claude or ChatGPT inside Server Forge.
//
// The AI has no tools of its own (no shell, no files, no web). It works only through Server Forge's MCP tools
// (src/ai/mcp.ts), with a short-lived token that carries the permissions of the person chatting, so it can never do
// more in Server Forge than they could themselves. Each session belongs to the person who made it.
//
// A session can have a server as its working folder: the AI is told which server it is working on and its folder.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dataPath, readJson, writeJson } from '../store.ts';
import type { Principal } from '../permissions.ts';
import { issueAssistantToken, revokeAssistantToken, TOOLS } from './mcp.ts';
import * as eng from './engines.ts';

export const bus = new EventEmitter(); // 'event' ({ ownerId, sessionId, ... })

export interface Settings {
  /** The whole AI feature (assistant, helper, accounts) is off until the owner turns it on. */
  enabled: boolean;
  /** Who may chat with the assistant: 'admins' (Panel settings permission) or 'everyone' signed in. */
  who: 'admins' | 'everyone';
  /** Stop using an account at this % of its 5-hour window / its longer (weekly) windows. */
  maxShort: number;
  maxLong: number;
  defaultAccount: string | null;
}

const SETTINGS_FILE = 'ai/settings.json';
let settings: Settings = { enabled: false, who: 'admins', maxShort: 80, maxLong: 80, defaultAccount: null, ...readJson<Partial<Settings>>(SETTINGS_FILE, {}) };

export function getSettings(): Settings {
  return { ...settings };
}

export function setSettings(patch: Partial<Settings>) {
  const p = patch ?? {};
  const num = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
  if ('enabled' in p) settings.enabled = !!p.enabled;
  if (p.who === 'admins' || p.who === 'everyone') settings.who = p.who;
  if (p.maxShort != null && Number.isFinite(Number(p.maxShort))) settings.maxShort = num(p.maxShort, 1, 100);
  if (p.maxLong != null && Number.isFinite(Number(p.maxLong))) settings.maxLong = num(p.maxLong, 1, 100);
  if ('defaultAccount' in p) settings.defaultAccount = p.defaultAccount && eng.getAccount(String(p.defaultAccount)) ? String(p.defaultAccount) : null;
  writeJson(SETTINGS_FILE, settings);
  return getSettings();
}

// ---------- sessions ----------

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'note';
  text: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
  t: number;
  by?: string;
}

export interface Session {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  accountId: string | null;
  model: string;
  effort: string;
  /** The server this session works on (its "working folder"), or null for all servers. */
  serverId: string | null;
  serverName: string | null;
  serverDir: string | null;
  /** Claude Code session id or Codex thread id, to continue the conversation. null = fresh context. */
  engineSession: string | null;
  engineAccount: string | null;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

const dir = () => dataPath('ai', 'sessions');
const fileOf = (id: string) => `ai/sessions/${id}.json`;
const cache = new Map<string, Session>();
const running = new Map<string, { abort: AbortController; started: number }>();

function load(id: string): Session | null {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  if (cache.has(id)) return cache.get(id)!;
  const s = readJson<Session | null>(fileOf(id), null);
  if (s) cache.set(id, s);
  return s;
}

function save(s: Session) {
  s.updatedAt = Date.now();
  if (s.messages.length > 600) s.messages = s.messages.slice(-500);
  cache.set(s.id, s);
  writeJson(fileOf(s.id), s);
}

function emit(s: Session, e: Record<string, unknown>) {
  bus.emit('event', { ownerId: s.ownerId, sessionId: s.id, ...e });
}

const summary = (s: Session) => ({
  id: s.id,
  title: s.title,
  accountId: s.accountId,
  model: s.model,
  effort: s.effort,
  serverId: s.serverId,
  serverName: s.serverName,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  busy: running.has(s.id),
  messages: s.messages.length,
  hasContext: !!s.engineSession,
});

/** Whether this person may use the assistant at all. */
export function mayUse(p: Principal): boolean {
  if (!settings.enabled || p.kind !== 'user') return false;
  return p.owner || settings.who === 'everyone' || p.grants.global.includes('panel.settings');
}

export function listSessions(p: Principal) {
  let files: string[] = [];
  try {
    files = readdirSync(dir()).filter((f) => /^[a-f0-9]{12}\.json$/.test(f));
  } catch {}
  return files
    .map((f) => load(f.slice(0, 12)))
    .filter((s): s is Session => !!s && s.ownerId === p.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(summary);
}

export function getSession(p: Principal, id: string): Session {
  const s = load(id);
  if (!s || s.ownerId !== p.id) throw Object.assign(new Error('Session not found.'), { status: 404 });
  return s;
}

export function sessionView(p: Principal, id: string) {
  const s = getSession(p, id);
  return { ...summary(s), serverDir: s.serverDir, list: s.messages };
}

export interface ServerRef {
  id: string;
  name: string;
  dir: string | null;
}

export function createSession(p: Principal, input: { title?: string; accountId?: string; model?: string; effort?: string; server?: ServerRef | null }) {
  mkdirSync(dir(), { recursive: true });
  const accountId = input.accountId && eng.getAccount(input.accountId) ? input.accountId : (settings.defaultAccount ?? eng.listAccounts()[0]?.id ?? null);
  const s: Session = {
    id: randomBytes(6).toString('hex'),
    ownerId: p.id,
    ownerName: p.name,
    title: String(input.title ?? '').trim().slice(0, 80) || (input.server ? `Working on ${input.server.name}` : 'New chat'),
    accountId,
    model: String(input.model ?? 'default').slice(0, 60) || 'default',
    effort: ['low', 'medium', 'high'].includes(String(input.effort)) ? String(input.effort) : 'medium',
    serverId: input.server?.id ?? null,
    serverName: input.server?.name ?? null,
    serverDir: input.server?.dir ?? null,
    engineSession: null,
    engineAccount: null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  save(s);
  return summary(s);
}

export function updateSession(p: Principal, id: string, patch: { title?: string; accountId?: string; model?: string; effort?: string; server?: ServerRef | null }) {
  const s = getSession(p, id);
  if (running.has(id)) throw new Error('Wait for the current answer to finish (or press Stop).');
  if (typeof patch.title === 'string' && patch.title.trim()) s.title = patch.title.trim().slice(0, 80);
  if (typeof patch.accountId === 'string' && eng.getAccount(patch.accountId) && patch.accountId !== s.accountId) {
    s.accountId = patch.accountId;
    // The other engine can't continue this engine's conversation.
    s.engineSession = null;
    s.messages.push({ role: 'note', text: `Switched to ${eng.getAccount(patch.accountId)!.name}. It starts with a fresh context.`, t: Date.now() });
  }
  if (typeof patch.model === 'string') s.model = patch.model.slice(0, 60) || 'default';
  if (typeof patch.effort === 'string' && ['low', 'medium', 'high'].includes(patch.effort)) s.effort = patch.effort;
  if (patch.server !== undefined) {
    s.serverId = patch.server?.id ?? null;
    s.serverName = patch.server?.name ?? null;
    s.serverDir = patch.server?.dir ?? null;
    s.messages.push({ role: 'note', text: patch.server ? `Now working on ${patch.server.name}.` : 'Now working on all servers.', t: Date.now() });
  }
  save(s);
  emit(s, { kind: 'session', session: summary(s) });
  return summary(s);
}

export function deleteSession(p: Principal, id: string) {
  const s = getSession(p, id);
  running.get(id)?.abort.abort();
  cache.delete(id);
  rmSync(dataPath(fileOf(s.id)), { force: true });
  rmSync(eng.scratchDir(`s-${s.id}`), { recursive: true, force: true });
}

/** Clear context: the AI forgets the conversation (the chat stays on screen). */
export function clearContext(p: Principal, id: string) {
  const s = getSession(p, id);
  if (running.has(id)) throw new Error('Wait for the current answer to finish (or press Stop).');
  s.engineSession = null;
  s.messages.push({ role: 'note', text: 'Context cleared: the AI starts fresh from here.', t: Date.now() });
  save(s);
  emit(s, { kind: 'message', message: s.messages.at(-1) });
  emit(s, { kind: 'session', session: summary(s) });
  return summary(s);
}

export function stop(p: Principal, id: string) {
  getSession(p, id);
  running.get(id)?.abort.abort();
}

// ---------- a turn ----------

function systemPrompt(s: Session, p: Principal) {
  const tools = TOOLS.map((t) => `- ${t.name}: ${t.title}`).join('\n');
  return [
    'You are the SF Assistant, built into Server Forge, a control panel for hosting game servers (Minecraft Java and Bedrock, Valheim, Palworld, Project Zomboid, BeamMP and more).',
    `You are helping ${p.name}. You act with their Server Forge permissions: when a tool says "Not allowed", they don't have that permission, so tell them plainly instead of trying another way.`,
    'Your only tools are the Server Forge tools below. You cannot run programs, browse the web or open files outside Server Forge; say so if asked.',
    tools,
    s.serverId
      ? `WORKING ON: the server "${s.serverName}" (id ${s.serverId})${s.serverDir ? `, folder ${s.serverDir}` : ''}. Assume questions are about this server unless the user names another. File paths in the file tools are relative to its folder.`
      : 'WORKING ON: all servers. Use sf_list_servers to find server ids.',
    'How to work:',
    '- Look before you change anything: read the console, settings or file first.',
    '- Before something that affects players (stop, restart, kick, ban, changing the world) say what you are about to do. Check sf_players first; when people are online use a countdown or ask the user.',
    '- Never delete or overwrite files or backups unless the user clearly asked for that.',
    '- Most setting and file changes need a restart; say so instead of restarting on your own.',
    '- Be concise. Use short paragraphs or bullet points; plain language, no jargon.',
  ].join('\n');
}

let apiBase = 'http://127.0.0.1:8190';
export function initAssistant(opts: { port: number }) {
  apiBase = `http://127.0.0.1:${opts.port}`;
}

const codexServers = new Map<string, { srv: eng.AppServer | null; starting: Promise<eng.AppServer> | null }>();
const codexTurns = new Map<string, (method: string, p: any) => void>(); // threadId -> handler

function codexFor(a: eng.Account, token: string): Promise<eng.AppServer> {
  // One app-server per account per token holder would be heavy; tokens go per thread through the env var, so one
  // process per account per signed-in person.
  const key = `${a.id}:${token.slice(0, 16)}`;
  const cur = codexServers.get(key);
  if (cur?.srv && !cur.srv.closed) return Promise.resolve(cur.srv);
  if (cur?.starting) return cur.starting;
  const entry: { srv: eng.AppServer | null; starting: Promise<eng.AppServer> | null } = { srv: null, starting: null };
  codexServers.set(key, entry);
  entry.starting = (async () => {
    const s = new eng.AppServer(a, { SF_AI_TOKEN: token });
    s.onRequest = async (method, p) => {
      // Codex asks before MCP tools that change things; Server Forge's own permission checks already apply to them.
      if (method === 'mcpServer/elicitation/request' && p?._meta?.codex_approval_kind === 'mcp_tool_call' && p?.serverName === 'serverforge') return { action: 'accept', content: null, _meta: null };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
      throw new Error('Not available in Server Forge.');
    };
    s.on('notification', (method: string, p: any) => {
      if (method === 'account/rateLimits/updated') eng.readCodexLimits(a.id, { rateLimits: p.rateLimits });
      const h = codexTurns.get(p?.threadId);
      if (h) h(method, p);
    });
    s.on('exit', () => {
      if (entry.srv === s) entry.srv = null;
    });
    await s.init();
    entry.srv = s;
    return s;
  })().finally(() => (entry.starting = null));
  return entry.starting;
}

const tokensOf = new Map<string, string>(); // principal id -> current token

function tokenFor(p: Principal) {
  const t = tokensOf.get(p.id);
  if (t) return t;
  const n = issueAssistantToken(p);
  tokensOf.set(p.id, n);
  setTimeout(() => {
    if (tokensOf.get(p.id) === n) tokensOf.delete(p.id);
    revokeAssistantToken(n);
    for (const [k, e] of codexServers) if (k.endsWith(n.slice(0, 16))) e.srv?.close();
  }, 11 * 3600_000).unref?.();
  return n;
}

/** Sends a message and runs the AI's turn. Resolves when the turn is finished (events stream meanwhile). */
export async function send(p: Principal, id: string, text: string) {
  const s = getSession(p, id);
  const msg = String(text ?? '').trim().slice(0, 20_000);
  if (!msg) throw new Error('Type a message first.');
  if (running.has(id)) throw new Error('Wait for the current answer to finish (or press Stop).');
  const a = s.accountId ? eng.getAccount(s.accountId) : null;
  if (!a) throw new Error('Pick an AI account for this session first (AI settings → Accounts).');
  const block = eng.limitBlock(a.id, settings.maxShort, settings.maxLong);
  if (block) throw new Error(`${a.name} is paused: ${block}. Raise the limit in AI settings, pick another account, or wait for it to reset.`);
  if (s.engineAccount && s.engineAccount !== a.id) s.engineSession = null;
  const add = (m: Omit<Message, 't'>) => {
    const full = { ...m, t: Date.now() } as Message;
    s.messages.push(full);
    emit(s, { kind: 'message', message: full });
    return full;
  };
  add({ role: 'user', text: msg, by: p.name });
  if (s.messages.filter((m) => m.role === 'user').length === 1 && s.title === 'New chat') s.title = msg.replace(/\s+/g, ' ').slice(0, 60);
  save(s);
  const abort = new AbortController();
  running.set(id, { abort, started: Date.now() });
  emit(s, { kind: 'session', session: summary(s) });
  const token = tokenFor(p);
  const mcpUrl = `${apiBase}/mcp`;
  const onEvent = (e: eng.TurnEvent) => {
    if (e.type === 'text' && e.text) add({ role: 'assistant', text: e.text });
    else if (e.type === 'tool') add({ role: 'tool', text: '', tool: e.tool, input: e.input });
    else if (e.type === 'tool_result') {
      const last = [...s.messages].reverse().find((m) => m.role === 'tool' && m.text === '');
      if (last) {
        last.text = (e.text || (e.isError ? 'Failed.' : 'Done.')).slice(0, 2000);
        last.isError = !!e.isError;
        emit(s, { kind: 'tool_done', message: last, index: s.messages.lastIndexOf(last) });
      }
    }
  };
  try {
    if (a.engine === 'claude') {
      const r = await eng.claudeTurn({ account: a, prompt: msg, system: systemPrompt(s, p), cwd: eng.scratchDir(`s-${s.id}`), model: s.model, effort: s.effort, resume: s.engineSession, mcp: { url: mcpUrl, token }, onEvent, signal: abort.signal }).catch(async (err) => {
        // A conversation Claude Code no longer has: start a fresh one once.
        if (s.engineSession && /no conversation found|session.*not found/i.test((err as Error).message)) {
          s.engineSession = null;
          add({ role: 'note', text: "The earlier conversation couldn't be continued, so this starts a fresh one." });
          return eng.claudeTurn({ account: a, prompt: msg, system: systemPrompt(s, p), cwd: eng.scratchDir(`s-${s.id}`), model: s.model, effort: s.effort, mcp: { url: mcpUrl, token }, onEvent, signal: abort.signal });
        }
        throw err;
      });
      if (r.sessionId) {
        s.engineSession = r.sessionId;
        s.engineAccount = a.id;
      }
      if (r.isError) add({ role: 'error', text: r.text });
    } else await codexTurn(s, a, p, msg, token, mcpUrl, onEvent, abort.signal);
  } catch (err) {
    add({ role: 'error', text: abort.signal.aborted ? 'Stopped.' : (err as Error).message });
  } finally {
    running.delete(id);
    save(s);
    emit(s, { kind: 'session', session: summary(s) });
    emit(s, { kind: 'done' });
  }
}

async function codexTurn(s: Session, a: eng.Account, p: Principal, msg: string, token: string, mcpUrl: string, onEvent: (e: eng.TurnEvent) => void, signal: AbortSignal) {
  const srv = await codexFor(a, token);
  const common = {
    cwd: eng.scratchDir(`s-${s.id}`),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: eng.codexThreadConfig({ url: mcpUrl, tokenEnv: 'SF_AI_TOKEN' }),
    baseInstructions: systemPrompt(s, p),
    ...(s.model && s.model !== 'default' ? { model: s.model } : {}),
  };
  let threadId: string | null = null;
  if (s.engineSession && s.engineAccount === a.id) {
    const r = await srv.request('thread/resume', { threadId: s.engineSession, ...common, excludeTurns: true }).catch(() => null);
    threadId = r?.thread?.id ?? null;
  }
  if (!threadId) {
    const r = await srv.request('thread/start', common);
    threadId = r.thread.id;
  }
  s.engineSession = threadId;
  s.engineAccount = a.id;
  await new Promise<void>((resolve, reject) => {
    let turnId: string | null = null;
    let violation: string | null = null;
    const finish = (err?: Error) => {
      codexTurns.delete(threadId!);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => {
      srv.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      finish(new Error('The AI took too long (10 minutes).'));
    }, 10 * 60_000);
    signal.addEventListener('abort', () => srv.request('turn/interrupt', { threadId, turnId }).catch(() => {}), { once: true });
    codexTurns.set(threadId!, (method, n) => {
      if (method === 'turn/started') turnId = n.turn?.id ?? turnId;
      else if (method === 'item/started' && n.item) {
        if (!eng.CODEX_ALLOWED_ITEMS.has(n.item.type)) {
          violation = n.item.type;
          srv.request('turn/interrupt', { threadId, turnId: n.turnId ?? turnId }).catch(() => {});
        } else if (n.item.type === 'mcpToolCall') {
          if (n.item.server !== 'serverforge') {
            violation = `${n.item.server} tools`;
            srv.request('turn/interrupt', { threadId, turnId: n.turnId ?? turnId }).catch(() => {});
          } else onEvent({ type: 'tool', tool: n.item.tool, input: n.item.arguments ?? {} });
        }
      } else if (method === 'item/completed' && n.item) {
        if (n.item.type === 'agentMessage' && n.item.text) onEvent({ type: 'text', text: n.item.text });
        else if (n.item.type === 'mcpToolCall') {
          const content = n.item.result?.content ?? [];
          onEvent({ type: 'tool_result', isError: !!n.item.error || !!n.item.result?.isError, text: n.item.error?.message ?? content.map((c: any) => c.text ?? '').join('\n').slice(0, 2000) });
        }
      } else if (method === 'turn/completed') {
        if (violation) return finish(new Error(`The AI tried to use "${violation}", which Server Forge doesn't allow, so the turn was stopped.`));
        if (signal.aborted) return finish(new Error('Stopped.'));
        if (n.turn?.status === 'failed') return finish(new Error(n.turn?.error?.message ?? 'ChatGPT failed.'));
        finish();
      }
    });
    srv
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text: msg }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...(s.model && s.model !== 'default' ? { model: s.model } : {}),
        effort: s.effort,
      })
      .catch((err) => finish(err));
  });
}

export function busy(id: string) {
  return running.has(id);
}

export function shutdown() {
  for (const r of running.values()) r.abort.abort();
  for (const e of codexServers.values()) e.srv?.close();
}

export const sessionsDirExists = () => existsSync(dir());
