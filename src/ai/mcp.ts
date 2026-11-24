// Server Forge as an MCP server (Model Context Protocol), so AI apps (Claude Desktop, Claude Code, ChatGPT/Codex,
// AIDA, the SF Assistant) can manage servers through Server Forge.
//
// Endpoint: POST /mcp (Streamable HTTP, JSON answers). It needs a Server Forge API key (Authorization: Bearer th_...),
// or a short-lived assistant token (sfai_...) that the SF Assistant hands its AI for one signed-in user.
//
// Every tool is a call to Server Forge's own API made with the caller's own key, so the key's permissions, node
// forwarding and the activity log all apply exactly as they do for the page. The AI can never do more than the key.
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Principal } from '../permissions.ts';

let apiPort = 8190;
let version = '0';

/** Called once by main.ts with the local listener's port. */
export function initMcp(opts: { port: number; version: string }) {
  apiPort = opts.port;
  version = opts.version;
}

// ---------- short-lived tokens for the SF Assistant ----------

const tokens = new Map<string, { principal: Principal; expires: number }>();

/** A token that acts as this signed-in user (same permissions) for the assistant's AI. Valid 12 hours. */
export function issueAssistantToken(principal: Principal): string {
  const t = `sfai_${randomBytes(24).toString('hex')}`;
  tokens.set(t, { principal, expires: Date.now() + 12 * 3600_000 });
  for (const [k, v] of tokens) if (v.expires < Date.now()) tokens.delete(k);
  return t;
}

export function revokeAssistantToken(t: string) {
  tokens.delete(t);
}

/** The principal behind an assistant token, or null. */
export function assistantTokenPrincipal(t: string | undefined): Principal | null {
  if (!t || !t.startsWith('sfai_')) return null;
  const e = tokens.get(t);
  if (!e) return null;
  if (e.expires < Date.now()) {
    tokens.delete(t);
    return null;
  }
  return e.principal;
}

// ---------- calling Server Forge's own API ----------

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** One request to this Server Forge's API, as the holder of `key`. */
export async function localApi(key: string, method: string, apiPath: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${apiPort}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) throw new ApiError(res.status, (data && typeof data === 'object' && data.error) || `HTTP ${res.status}`);
  return data;
}

// ---------- tools ----------

type Args = Record<string, any>;
interface Tool {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  required?: string[];
  /** Changes something (shown to clients as not read-only). */
  writes?: boolean;
  run: (key: string, a: Args) => Promise<unknown>;
}

const sid = { type: 'string', description: 'The server id (from sf_list_servers).' };
const enc = encodeURIComponent;
const srv = (a: Args) => `/api/servers/${enc(String(a.server ?? ''))}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut at ${n} characters)` : s);
const consoleText = (lines: unknown[]) => lines.map((l) => (typeof l === 'string' ? l : ((l as { text?: string })?.text ?? JSON.stringify(l)))).join('\n');

/** The parts of a server snapshot an AI needs (snapshots carry a lot more). */
function brief(s: any) {
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const k of ['id', 'name', 'game', 'gameName', 'status', 'installDir', 'archivedAt', 'startedAt', 'uptime', 'version', 'players', 'playerCount', 'maxPlayers', 'port', 'node', 'updating', 'countdown']) if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  if (Array.isArray(out.players)) out.players = (out.players as any[]).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean);
  if (s.node) out.node = s.node?.name ?? s.node;
  return out;
}

export const TOOLS: Tool[] = [
  {
    name: 'sf_list_servers',
    title: 'List servers',
    description: 'Every game server this key can see (on this system and connected systems), with id, name, game, status and players. Archived servers are included with archivedAt set.',
    input: {},
    run: async (key) => {
      const r = await localApi(key, 'GET', '/api/servers');
      const list = Array.isArray(r) ? r : (r?.servers ?? []);
      return list.map(brief);
    },
  },
  {
    name: 'sf_server_details',
    title: 'Server details',
    description: "One server's full status and settings (passwords are hidden without settings permission).",
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', srv(a)),
  },
  {
    name: 'sf_read_console',
    title: 'Read console',
    description: "The last lines of a server's console output (newest last).",
    input: { server: sid, lines: { type: 'integer', minimum: 1, maximum: 500, description: 'How many lines (default 80).' } },
    required: ['server'],
    run: async (key, a) => clip(consoleText((await localApi(key, 'GET', `${srv(a)}/console?lines=${Math.min(500, Math.max(1, Number(a.lines) || 80))}`))?.lines ?? []), 40_000),
  },
  {
    name: 'sf_send_command',
    title: 'Send console command',
    description: "Types one command into a running server's console. Read the console afterwards to see its output.",
    input: { server: sid, command: { type: 'string', description: 'The command, as typed in the console (no leading slash needed).' } },
    required: ['server', 'command'],
    writes: true,
    run: async (key, a) => {
      await localApi(key, 'POST', `${srv(a)}/command`, { command: String(a.command ?? '') });
      return 'Sent.';
    },
  },
  {
    name: 'sf_server_power',
    title: 'Start, stop or restart',
    description: 'Starts, stops or restarts a server. Stop and restart save the world first and can count down in chat first (countdownMinutes).',
    input: {
      server: sid,
      action: { type: 'string', enum: ['start', 'stop', 'restart'] },
      countdownMinutes: { type: 'integer', minimum: 0, maximum: 60, description: 'Stop/restart only: warn players this many minutes first (0 = now).' },
    },
    required: ['server', 'action'],
    writes: true,
    run: async (key, a) => {
      const action = String(a.action);
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('action must be start, stop or restart.');
      const body: Args = {};
      if (action !== 'start' && Number(a.countdownMinutes) > 0) body.countdownMinutes = Number(a.countdownMinutes);
      await localApi(key, 'POST', `${srv(a)}/${action}`, body, 120_000);
      return `${action} requested.`;
    },
  },
  {
    name: 'sf_players',
    title: 'Players',
    description: 'Players Server Forge has seen on a server: who is online now, when others were last seen, notes and the player actions available.',
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/players`),
  },
  {
    name: 'sf_player_action',
    title: 'Player action',
    description: 'Runs a player action from sf_players "actions" (kick, ban, op, mute...) on one player.',
    input: { server: sid, player: { type: 'string' }, action: { type: 'string' }, reason: { type: 'string' } },
    required: ['server', 'player', 'action'],
    writes: true,
    run: (key, a) => localApi(key, 'POST', `${srv(a)}/players/${enc(String(a.player))}/action`, { action: String(a.action), ...(a.reason ? { reason: String(a.reason) } : {}) }),
  },
  {
    name: 'sf_read_chat',
    title: 'Read chat',
    description: "Recent chat on a server (game and Discord relay), newest last, and whether the chat relay is on.",
    input: { server: sid, limit: { type: 'integer', minimum: 1, maximum: 300 } },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/chat?limit=${Math.min(300, Math.max(1, Number(a.limit) || 50))}`),
  },
  {
    name: 'sf_send_chat',
    title: 'Send chat message',
    description: 'Says a message in game chat on a running server.',
    input: { server: sid, message: { type: 'string', maxLength: 300 } },
    required: ['server', 'message'],
    writes: true,
    run: async (key, a) => {
      await localApi(key, 'POST', `${srv(a)}/chat`, { message: String(a.message ?? ''), source: 'SF Assistant' });
      return 'Sent.';
    },
  },
  {
    name: 'sf_list_files',
    title: 'List files',
    description: "Files and folders in a server's folder. path is relative to the server folder ('' = its top).",
    input: { server: sid, path: { type: 'string' } },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/files?path=${enc(String(a.path ?? ''))}`),
  },
  {
    name: 'sf_read_file',
    title: 'Read file',
    description: "A text file from a server's folder (config files, logs, properties). path is relative to the server folder.",
    input: { server: sid, path: { type: 'string' } },
    required: ['server', 'path'],
    run: async (key, a) => {
      const r = await localApi(key, 'GET', `${srv(a)}/files/content?path=${enc(String(a.path ?? ''))}`);
      if (r && typeof r === 'object' && typeof r.content === 'string') return { ...r, content: clip(r.content, 60_000) };
      return r;
    },
  },
  {
    name: 'sf_write_file',
    title: 'Write file',
    description: "Saves a text file in a server's folder (creates or replaces it). Read it first and keep everything you aren't changing. Most changes need a server restart.",
    input: { server: sid, path: { type: 'string' }, content: { type: 'string' } },
    required: ['server', 'path', 'content'],
    writes: true,
    run: (key, a) => localApi(key, 'PUT', `${srv(a)}/files/content`, { path: String(a.path ?? ''), content: String(a.content ?? '') }),
  },
  {
    name: 'sf_get_properties',
    title: 'Get game settings file',
    description: "The game's settings file as key/value pairs (server.properties and similar), for games that have one.",
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/properties`),
  },
  {
    name: 'sf_set_properties',
    title: 'Change game settings file',
    description: "Changes values in the game's settings file. Only the keys given are changed. Needs a restart to apply.",
    input: { server: sid, values: { type: 'object', additionalProperties: { type: 'string' } } },
    required: ['server', 'values'],
    writes: true,
    run: (key, a) => localApi(key, 'PUT', `${srv(a)}/properties`, { values: a.values ?? {} }),
  },
  {
    name: 'sf_list_backups',
    title: 'List backups',
    description: "A server's backups, newest first.",
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/backups`),
  },
  {
    name: 'sf_backup_now',
    title: 'Back up now',
    description: 'Starts a backup of a server now.',
    input: { server: sid },
    required: ['server'],
    writes: true,
    run: async (key, a) => {
      await localApi(key, 'POST', `${srv(a)}/backups`);
      return 'Backup started.';
    },
  },
  {
    name: 'sf_list_addons',
    title: 'List mods/addons',
    description: 'Mods, plugins or addons installed on a server, with whether each is switched on.',
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/addons`),
  },
  {
    name: 'sf_server_stats',
    title: 'Server performance',
    description: "A server's recent CPU, memory and player history.",
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/stats`),
  },
  {
    name: 'sf_system_stats',
    title: 'System performance',
    description: "This system's whole CPU and memory use.",
    input: {},
    run: (key) => localApi(key, 'GET', '/api/system-stats'),
  },
  {
    name: 'sf_alerts',
    title: 'Alerts',
    description: 'Current alerts and warnings (crashes, port clashes, updates waiting, restart needed...).',
    input: {},
    run: (key) => localApi(key, 'GET', '/api/alerts'),
  },
  {
    name: 'sf_list_tasks',
    title: 'Scheduled tasks',
    description: "A server's scheduled tasks (restarts, backups, commands).",
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/tasks`),
  },
  {
    name: 'sf_port_help',
    title: 'Port forwarding help',
    description: 'Which ports a server needs open or forwarded (TCP/UDP), and this system\'s addresses.',
    input: { server: sid },
    required: ['server'],
    run: (key, a) => localApi(key, 'GET', `${srv(a)}/ports`),
  },
  {
    name: 'sf_activity',
    title: 'Activity log',
    description: 'Who did what in Server Forge recently.',
    input: {},
    run: (key) => localApi(key, 'GET', '/api/activity'),
  },
];

export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: 'object', properties: t.input, ...(t.required?.length ? { required: t.required } : {}) },
    annotations: { title: t.title, readOnlyHint: !t.writes, destructiveHint: !!t.writes, openWorldHint: false },
  }));
}

/** Runs one tool as the holder of `key`. Returns MCP tool-result content. */
export async function callTool(key: string, name: string, args: Args) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
  for (const r of t.required ?? []) if (args?.[r] === undefined || args?.[r] === '') return { content: [{ type: 'text', text: `Missing "${r}".` }], isError: true };
  try {
    const out = await t.run(key, args ?? {});
    const text = typeof out === 'string' ? out : clip(JSON.stringify(out, null, 1), 80_000);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const e = err as ApiError;
    return { content: [{ type: 'text', text: e.status === 403 ? `Not allowed: ${e.message} (this key doesn't have that permission)` : `Failed: ${e.message}` }], isError: true };
  }
}

// ---------- the MCP endpoint (JSON-RPC over HTTP) ----------

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS =
  'Server Forge manages game servers. Start with sf_list_servers to get server ids. Read before changing: check the console, settings file or file before editing it, and tell the user what a change will do (most need a restart). Stopping or restarting kicks players: check sf_players first and use a countdown when people are online.';

function reply(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new Error('Request too large.');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null');
}

async function one(key: string, m: any) {
  const id = m?.id;
  const isRequest = id !== undefined && id !== null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isRequest ? err(-32600, 'Invalid request.') : null;
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'server-forge', title: 'Server Forge', version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: toolList() });
    case 'tools/call':
      return ok(await callTool(key, String(m.params?.name ?? ''), m.params?.arguments ?? {}));
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      if (!isRequest) return null; // notifications (initialized, cancelled...) need no answer
      return err(-32601, `Method not found: ${m.method}`);
  }
}

/**
 * Handles /mcp. `key` is the caller's API key or assistant token (already checked by main.ts: principal is non-null).
 */
export async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, key: string | undefined, principal: Principal | null) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-to-client stream and no sessions to end.
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  if (req.method !== 'POST') return reply(res, 405);
  if (!key || !principal) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="Server Forge"');
    return reply(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Use a Server Forge API key: Authorization: Bearer th_...' } });
  }
  let msg: any;
  try {
    msg = await body(req);
  } catch {
    return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
  }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => one(key, m)))).filter(Boolean);
    return out.length ? reply(res, 200, out) : reply(res, 202);
  }
  const out = await one(key, msg);
  return out ? reply(res, 200, out) : reply(res, 202);
}
