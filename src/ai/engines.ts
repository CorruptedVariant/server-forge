// AI accounts and engines for the SF Assistant and the player helper, done the way AIDA does them:
// - Claude: through Claude Code ("claude"). Each account has its own CLAUDE_CONFIG_DIR, and signing in is Claude
//   Code's own "claude auth login" in the browser, so Server Forge never sees the tokens.
// - ChatGPT: through OpenAI Codex ("codex app-server", JSON-RPC over stdio). Each account has its own CODEX_HOME,
//   and signing in is Codex's own "Sign in with ChatGPT" in the browser.
// An account can also use this PC's existing Claude Code or Codex sign-in ("system").
//
// Server Forge runs either engine with all of its own tools switched off (no shell, no file access, no web): the
// only tools are Server Forge's MCP tools (src/ai/mcp.ts), acting with the permissions of whoever asked.
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataPath, readJson, writeJson } from '../store.ts';

export type EngineKind = 'claude' | 'codex';

export interface Account {
  id: string;
  name: string;
  engine: EngineKind;
  /** 'system': this PC's own Claude Code / Codex sign-in. Otherwise Server Forge's own folder for it. */
  home?: 'system';
  createdAt: number;
}

export interface Limit {
  label: string;
  percent: number;
  resetsAt: string | null;
  /** Hours the window lasts (5-hour vs weekly), for the limit checks. */
  windowHours: number | null;
}

export interface AccountState {
  loggedIn: boolean | null;
  email: string | null;
  plan: string | null;
  error: string | null;
  signingIn: boolean;
  authUrl: string | null;
  limits: Limit[];
  limitsAt: number;
}

export const events = new EventEmitter(); // 'accounts'

const FILE = 'ai/accounts.json';
let accounts: Account[] = readJson<Account[]>(FILE, []).filter((a) => a && typeof a.id === 'string' && (a.engine === 'claude' || a.engine === 'codex'));
const live = new Map<string, Partial<AccountState>>();
const save = () => writeJson(FILE, accounts);
const changed = () => events.emit('accounts', listAccounts());

// ---------- finding the programs ----------

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth < 0) return null;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return path.join(dir, e.name);
  for (const e of entries) if (e.isDirectory()) {
    const f = findFile(path.join(dir, e.name), name, depth - 1);
    if (f) return f;
  }
  return null;
}

function onPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && existsSync(l)) ?? null;
  } catch {
    return null;
  }
}

const win = process.platform === 'win32';
const cache: Partial<Record<EngineKind, string | null>> = {};

/** Claude Code: its native install, then PATH, then an npm global install, then AIDA's copy. */
export function claudeExe(): string | null {
  if (cache.claude && existsSync(cache.claude)) return cache.claude;
  const exe = win ? 'claude.exe' : 'claude';
  const tries = [path.join(os.homedir(), '.local', 'bin', exe), path.join(os.homedir(), '.claude', 'local', exe)];
  let found = tries.find((f) => existsSync(f)) ?? null;
  if (!found && win) found = onPath('claude.exe');
  if (!found && !win) found = onPath('claude');
  if (!found && win) found = findFile(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai'), 'claude.exe', 5);
  if (!found && win) found = findFile(path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ADA', 'resources'), 'claude.exe', 9);
  return (cache.claude = found);
}

/** Codex: the Codex app's copy (newest), an npm global install, or PATH. */
export function codexExe(): string | null {
  if (cache.codex && existsSync(cache.codex)) return cache.codex;
  let found: string | null = null;
  if (win) {
    const appBin = path.join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin');
    const all: { f: string; at: number }[] = [];
    try {
      for (const d of readdirSync(appBin)) {
        const f = path.join(appBin, d, 'codex.exe');
        if (existsSync(f)) all.push({ f, at: statSync(f).mtimeMs });
      }
    } catch {}
    found = all.sort((a, b) => b.at - a.at)[0]?.f ?? null;
    if (!found) found = findFile(path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex'), 'codex.exe', 6);
    if (!found) found = onPath('codex.exe');
  } else found = onPath('codex');
  return (cache.codex = found);
}

export const MISSING: Record<EngineKind, string> = {
  claude: 'Claude needs Claude Code on the system running Server Forge. Install it from claude.com/claude-code, then try again.',
  codex: 'ChatGPT needs OpenAI Codex on the system running Server Forge. Install the Codex app (or run  npm install -g @openai/codex), then try again.',
};

export function engineInfo() {
  return { claude: { installed: !!claudeExe() }, codex: { installed: !!codexExe() }, canSignIn: win || !!process.env.DISPLAY };
}

// ---------- accounts ----------

export function getAccount(id: string): Account | null {
  return accounts.find((a) => a.id === id) ?? null;
}

/** The account's own sign-in folder (CLAUDE_CONFIG_DIR / CODEX_HOME). */
export function homeOf(a: Account): string {
  if (a.home === 'system') return a.engine === 'claude' ? path.join(os.homedir(), '.claude') : path.join(os.homedir(), '.codex');
  return dataPath('ai', 'homes', a.id);
}

export function listAccounts() {
  return accounts.map((a) => {
    const st = live.get(a.id) ?? {};
    return {
      id: a.id,
      name: a.name,
      engine: a.engine,
      system: a.home === 'system',
      loggedIn: st.loggedIn ?? null,
      email: st.email ?? null,
      plan: st.plan ?? null,
      error: st.error ?? null,
      signingIn: !!st.signingIn,
      authUrl: st.authUrl ?? null,
      limits: st.limits ?? [],
      limitsAt: st.limitsAt ?? 0,
    };
  });
}

function note(id: string, patch: Partial<AccountState>) {
  live.set(id, { ...(live.get(id) ?? {}), ...patch });
  changed();
}

export async function addAccount(input: { name?: string; engine: EngineKind; system?: boolean }) {
  const engine = input.engine === 'codex' ? 'codex' : 'claude';
  if (!(engine === 'claude' ? claudeExe() : codexExe())) throw new Error(MISSING[engine]);
  if (input.system && accounts.some((a) => a.engine === engine && a.home === 'system')) throw new Error("This system's own sign-in is already added.");
  const label = engine === 'claude' ? 'Claude' : 'ChatGPT';
  const a: Account = {
    id: randomBytes(6).toString('hex'),
    name: String(input.name ?? '').trim().slice(0, 60) || (input.system ? `${label} (this system's sign-in)` : `${label} ${accounts.filter((x) => x.engine === engine).length + 1}`),
    engine,
    ...(input.system ? { home: 'system' as const } : {}),
    createdAt: Date.now(),
  };
  if (!input.system) mkdirSync(homeOf(a), { recursive: true });
  accounts.push(a);
  save();
  changed();
  if (input.system) await refreshAccount(a.id);
  return a;
}

export function renameAccount(id: string, name: string) {
  const a = getAccount(id);
  if (!a) throw new Error('No such account.');
  a.name = String(name ?? '').trim().slice(0, 60) || a.name;
  save();
  changed();
}

export async function removeAccount(id: string) {
  const a = getAccount(id);
  if (!a) return;
  if (a.home !== 'system') {
    await logout(id).catch(() => {});
    const dir = homeOf(a);
    setTimeout(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      } catch {}
    }, 2000).unref?.();
  }
  accounts = accounts.filter((x) => x !== a);
  live.delete(id);
  save();
  changed();
}

/** The environment for an engine process of this account: no Server Forge secrets, only its own sign-in folder. */
function envFor(a: Account, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE_SSE') || k.startsWith('PANEL_')) delete env[k];
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.OPENAI_API_KEY;
  if (a.engine === 'claude') {
    if (a.home === 'system') delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = homeOf(a);
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'server-forge/1';
  } else env.CODEX_HOME = homeOf(a);
  return { ...env, ...extra } as NodeJS.ProcessEnv;
}

function run(exe: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, out, err) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: String(out), err: String(err) }));
  });
}

/** Asks the engine who is signed in (and, for ChatGPT, how much of the plan is used). Sends no message. */
export async function refreshAccount(id: string) {
  const a = getAccount(id);
  if (!a) return null;
  if (a.engine === 'claude') {
    const exe = claudeExe();
    if (!exe) return note(id, { loggedIn: false, error: MISSING.claude });
    const r = await run(exe, ['auth', 'status', '--json'], envFor(a));
    try {
      const s = JSON.parse(r.out);
      note(id, { loggedIn: !!s.loggedIn, email: s.email ?? null, plan: s.subscriptionType ?? null, error: null });
    } catch {
      note(id, { loggedIn: false, error: 'Could not read the sign-in status.' });
    }
    return live.get(id);
  }
  let srv: AppServer | null = null;
  try {
    srv = await new AppServer(a).init();
    const r = await srv.request('account/read', { refreshToken: false }, 30_000);
    const acct = r?.account;
    const loggedIn = acct?.type === 'chatgpt' || acct?.type === 'apiKey';
    note(id, { loggedIn, email: acct?.email ?? null, plan: acct?.planType ?? null, error: null });
    if (loggedIn) {
      readCodexLimits(id, await srv.request('account/rateLimits/read', {}, 30_000).catch(() => null));
      if (!codexModels.length) await loadCodexModels(srv);
    }
  } catch (err) {
    note(id, { loggedIn: false, error: (err as Error).message });
  } finally {
    srv?.close();
  }
  return live.get(id);
}

export async function refreshAll() {
  await Promise.all(accounts.map((a) => refreshAccount(a.id)));
  return listAccounts();
}

const signIns = new Map<string, { close: () => void }>();

/**
 * Starts the browser sign-in. Claude: Claude Code's own sign-in in a console window on this system (it opens the
 * browser). ChatGPT: returns the sign-in address for the page to open; Codex waits for the answer on this system.
 * Either way the browser has to be on the system running Server Forge.
 */
export async function login(id: string): Promise<{ authUrl?: string; window?: boolean }> {
  const a = getAccount(id);
  if (!a) throw new Error('No such account.');
  signIns.get(id)?.close();
  if (a.engine === 'claude') {
    const exe = claudeExe();
    if (!exe) throw new Error(MISSING.claude);
    if (!win) throw new Error('On Linux, sign in by running  claude auth login  for the account running Server Forge, then add "This system\'s sign-in".');
    spawn('cmd.exe', ['/c', 'start', `"Server Forge sign-in: ${a.name.replace(/"/g, '')}"`, `"${exe}"`, 'auth', 'login', '--claudeai'], {
      env: envFor(a),
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
    note(id, { signingIn: true, error: null });
    // The window finishes by itself; check every few seconds for 10 minutes.
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      const st = await refreshAccount(id);
      if (st?.loggedIn || n > 120) {
        clearInterval(timer);
        signIns.delete(id);
        note(id, { signingIn: false });
      }
    }, 5000);
    timer.unref?.();
    signIns.set(id, { close: () => clearInterval(timer) });
    return { window: true };
  }
  const srv = await new AppServer(a).init();
  let done = false;
  const finish = (error: string | null) => {
    if (done) return;
    done = true;
    signIns.delete(id);
    srv.close();
    note(id, { signingIn: false, authUrl: null, ...(error ? { error } : {}) });
    refreshAccount(id).catch(() => {});
  };
  signIns.set(id, { close: () => finish(null) });
  srv.on('notification', (method: string, p: any) => {
    if (method === 'account/login/completed') finish(p?.success ? null : p?.error || 'Sign-in did not finish.');
  });
  srv.on('exit', () => finish(null));
  setTimeout(() => finish('Sign-in timed out (10 minutes). Try again.'), 10 * 60_000).unref?.();
  try {
    const r = await srv.request('account/login/start', { type: 'chatgpt' }, 30_000);
    if (!r?.authUrl) throw new Error('Codex did not give a sign-in address.');
    note(id, { signingIn: true, authUrl: r.authUrl, error: null });
    return { authUrl: r.authUrl };
  } catch (err) {
    finish((err as Error).message);
    throw err;
  }
}

export async function logout(id: string) {
  const a = getAccount(id);
  if (!a) throw new Error('No such account.');
  if (a.home === 'system') throw new Error("This is the system's own sign-in: sign out in Claude Code or Codex itself.");
  if (a.engine === 'claude') {
    const exe = claudeExe();
    if (exe) await run(exe, ['auth', 'logout'], envFor(a));
  } else {
    let srv: AppServer | null = null;
    try {
      srv = await new AppServer(a).init();
      await srv.request('account/logout', {}, 30_000);
    } finally {
      srv?.close();
    }
  }
  note(id, { loggedIn: false, email: null, plan: null, limits: [] });
}

// ---------- usage limits ----------

/** ChatGPT plan windows (5-hour, weekly...) from Codex. */
export function readCodexLimits(id: string, rl: any) {
  const snap = rl?.rateLimitsByLimitId?.codex ?? rl?.rateLimits ?? rl;
  if (!snap) return;
  const label = (m: number) => (!m ? 'Limit' : m <= 360 ? `${Math.round(m / 60)}-hour` : m <= 1440 ? 'Daily' : m <= 10_080 ? 'Weekly' : 'Monthly');
  const limits: Limit[] = [snap.primary, snap.secondary].filter(Boolean).map((w: any) => ({
    label: label(w.windowDurationMins),
    percent: Number(w.usedPercent ?? 0),
    resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
    windowHours: w.windowDurationMins ? w.windowDurationMins / 60 : null,
  }));
  note(id, { limits, limitsAt: Date.now(), ...(rl?.ordinaryUsageAllowed === false ? { error: 'Out of usage on this plan.' } : {}) });
}

/** Claude plan windows from Claude Code's rate_limit events (stream-json). */
function readClaudeLimit(id: string, info: any) {
  if (!info || typeof info !== 'object') return;
  const kind = String(info.rateLimitType ?? info.type ?? '');
  const hours = /five_hour|session/.test(kind) ? 5 : /seven_day|weekly/.test(kind) ? 168 : null;
  const label = hours === 5 ? '5-hour' : hours === 168 ? (/opus/.test(kind) ? 'Weekly (Opus)' : /sonnet/.test(kind) ? 'Weekly (Sonnet)' : 'Weekly') : kind || 'Limit';
  const pct = info.utilization != null ? Number(info.utilization) * (Number(info.utilization) <= 1 ? 100 : 1) : info.status === 'rejected' ? 100 : null;
  if (pct == null) return;
  const prev = (live.get(id)?.limits ?? []).filter((l) => l.label !== label);
  const resetsAt = info.resetsAt ? new Date(Number(info.resetsAt) * (Number(info.resetsAt) < 1e12 ? 1000 : 1)).toISOString() : null;
  note(id, { limits: [...prev, { label, percent: Math.round(pct), resetsAt, windowHours: hours }], limitsAt: Date.now() });
}

/**
 * null if the account may be used now under these caps (percent of the 5-hour window / of longer windows), otherwise
 * why not. Unknown usage counts as allowed for Claude (Claude Code only reports it while working).
 */
export function limitBlock(id: string, maxShort: number, maxLong: number): string | null {
  const st = live.get(id);
  if (!st) return null;
  if (st.loggedIn === false) return 'not signed in';
  for (const l of st.limits ?? []) {
    const short = (l.windowHours ?? 999) <= 6;
    const cap = short ? maxShort : maxLong;
    if (l.percent >= cap) return `${l.label} usage at ${l.percent}% (stops at ${cap}%)`;
  }
  return null;
}

export function accountState(id: string) {
  return listAccounts().find((a) => a.id === id) ?? null;
}

// ---------- models ----------

let codexModels: { id: string; name: string; efforts: string[] }[] = [];
async function loadCodexModels(srv: AppServer) {
  try {
    const r = await srv.request('model/list', {}, 30_000);
    codexModels = (r?.data ?? []).filter((m: any) => !m.hidden).map((m: any) => ({ id: m.model ?? m.id, name: m.displayName || m.id, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e) }));
  } catch {}
}

export function models() {
  return {
    claude: [
      { id: 'default', name: "The account's default" },
      { id: 'opus', name: 'Opus (latest)' },
      { id: 'sonnet', name: 'Sonnet (latest)' },
      { id: 'haiku', name: 'Haiku (latest)' },
    ],
    codex: [{ id: 'default', name: "The account's default" }, ...codexModels],
    efforts: ['low', 'medium', 'high'],
  };
}

// ---------- Codex app-server ----------

/** One `codex app-server` process (JSON-RPC over stdio, the interface OpenAI's editor extensions use). */
export class AppServer extends EventEmitter {
  proc: ChildProcess;
  closed = false;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null }>();
  private stderr = '';
  onRequest: (method: string, params: any) => Promise<unknown> = async () => {
    throw new Error('Not available in Server Forge.');
  };

  constructor(a: Account, extraEnv: Record<string, string> = {}) {
    super();
    const exe = codexExe();
    if (!exe) throw new Error(MISSING.codex);
    mkdirSync(homeOf(a), { recursive: true });
    this.proc = spawn(exe, ['app-server'], { env: envFor(a, extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stderr!.on('data', (d) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    this.proc.on('error', (err) => this.fail(err));
    this.proc.on('exit', (code) => this.fail(new Error(`Codex stopped (exit code ${code}).${this.stderr.trim() ? ` ${this.stderr.trim().split('\n').at(-1)}` : ''}`)));
    readline.createInterface({ input: this.proc.stdout! }).on('line', (line) => this.line(line));
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiting.clear();
    this.emit('exit', err);
  }

  private line(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && !m.method) {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (!w) return;
      if (w.timer) clearTimeout(w.timer);
      return m.error ? w.reject(new Error(m.error.message ?? JSON.stringify(m.error))) : w.resolve(m.result);
    }
    if (m.id != null && m.method) {
      Promise.resolve()
        .then(() => this.onRequest(m.method, m.params ?? {}))
        .then(
          (result) => this.write({ jsonrpc: '2.0', id: m.id, result }),
          (err) => this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: err?.message ?? String(err) } }),
        );
      return;
    }
    if (m.method) this.emit('notification', m.method, m.params ?? {});
  }

  private write(obj: unknown) {
    if (this.closed) return;
    try {
      this.proc.stdin!.write(JSON.stringify(obj) + '\n');
    } catch {}
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.waiting.delete(id);
            reject(new Error(`Codex did not answer ${method} in time.`));
          }, timeoutMs)
        : null;
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async init() {
    await this.request('initialize', { clientInfo: { name: 'server-forge', title: 'Server Forge', version: '1' }, capabilities: null }, 30_000);
    this.write({ jsonrpc: '2.0', method: 'initialized' });
    return this;
  }

  close() {
    if (this.closed) return;
    try {
      this.proc.stdin!.end();
    } catch {}
    const p = this.proc;
    setTimeout(() => {
      try {
        if (p.exitCode == null) p.kill();
      } catch {}
    }, 3000).unref?.();
  }
}

/** Every Codex feature that gives the model a tool or reaches outside the conversation, switched off. */
const CODEX_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'multi_agent_v2', 'goals', 'memories', 'hooks', 'in_app_browser', 'sleep_tool', 'tool_suggest', 'skill_search', 'remote_plugin', 'workspace_dependencies', 'skill_mcp_dependency_install', 'request_permissions_tool', 'apps_mcp_path_override', 'code_mode', 'code_mode_host', 'standalone_web_search', 'default_mode_request_user_input', 'in_app_local_automation'];

/** Codex thread settings: no tools of its own; Server Forge's MCP tools only when mcp is given. */
export function codexThreadConfig(mcp?: { url: string; tokenEnv: string }) {
  const config: Record<string, unknown> = { mcp_servers: mcp ? { serverforge: { url: mcp.url, bearer_token_env_var: mcp.tokenEnv, startup_timeout_sec: 30, tool_timeout_sec: 300 } } : {}, web_search: 'disabled', 'tools.web_search': false, 'tools.view_image': false };
  for (const f of CODEX_OFF) config[`features.${f}`] = false;
  return config;
}

/** Codex items the assistant may produce; anything else (commands, file changes, web search) stops the turn. */
export const CODEX_ALLOWED_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'mcpToolCall']);

// ---------- one Claude turn ----------

export interface TurnEvent {
  type: 'text' | 'tool' | 'tool_result' | 'status';
  text?: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
}

/**
 * Runs one Claude Code turn with no built-in tools, only Server Forge's MCP server, and Server Forge's own system
 * prompt (no CLAUDE.md, no user settings, no other MCP servers). resume continues an earlier conversation.
 * Returns the conversation id to resume next time.
 */
export function claudeTurn(opts: {
  account: Account;
  prompt: string;
  system: string;
  cwd: string;
  model?: string;
  effort?: string;
  resume?: string | null;
  mcp?: { url: string; token: string } | null;
  jsonSchema?: unknown;
  onEvent?: (e: TurnEvent) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ sessionId: string | null; text: string; structured: unknown; costUsd: number | null; isError: boolean }> {
  const exe = claudeExe();
  if (!exe) return Promise.reject(new Error(MISSING.claude));
  mkdirSync(opts.cwd, { recursive: true });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'text', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--system-prompt', opts.system, '--permission-mode', 'default'];
  if (opts.mcp) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: { serverforge: { type: 'http', url: opts.mcp.url, headers: { Authorization: `Bearer ${opts.mcp.token}` } } } }));
    args.push('--allowedTools', 'mcp__serverforge');
  } else args.push('--mcp-config', '{"mcpServers":{}}');
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.resume) args.push('--resume', opts.resume);
  if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd: opts.cwd, env: envFor(opts.account, { MCP_TOOL_TIMEOUT: String(5 * 60_000) }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.stdin!.end(opts.prompt);
    let sessionId: string | null = null;
    let text = '';
    let structured: unknown = null;
    let costUsd: number | null = null;
    let isError = false;
    let resultSeen = false;
    let errText = '';
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 10 * 60_000);
    opts.signal?.addEventListener('abort', () => proc.kill(), { once: true });
    proc.stderr!.on('data', (d) => (errText = (errText + d.toString()).slice(-4000)));
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.session_id) sessionId = m.session_id;
      if (m.type === 'rate_limit_event') readClaudeLimit(opts.account.id, m.rate_limit_info ?? m);
      if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'text' && b.text) opts.onEvent?.({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') opts.onEvent?.({ type: 'tool', tool: String(b.name).replace(/^mcp__serverforge__/, ''), input: b.input });
        }
      } else if (m.type === 'user') {
        for (const b of m.message?.content ?? []) if (b.type === 'tool_result') opts.onEvent?.({ type: 'tool_result', isError: !!b.is_error, text: typeof b.content === 'string' ? b.content.slice(0, 2000) : Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? '').join('\n').slice(0, 2000) : '' });
      } else if (m.type === 'result') {
        resultSeen = true;
        text = typeof m.result === 'string' ? m.result : '';
        structured = m.structured_output ?? null;
        costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
        isError = !!m.is_error;
        if (isError && !text) text = (m.errors ?? []).join(' ') || m.subtype || 'Claude stopped with an error.';
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (opts.signal?.aborted) return reject(new Error('Stopped.'));
      if (!resultSeen) return reject(new Error(errText.trim().split('\n').at(-1) || `Claude Code stopped (exit code ${code}).`));
      if (/not logged in|please run \/login|invalid api key|oauth token/i.test(text)) note(opts.account.id, { loggedIn: false, error: text });
      resolve({ sessionId, text, structured, costUsd, isError });
    });
  });
}

/** A fresh empty working folder for an engine process (nothing in it for the AI to find). */
export function scratchDir(name: string) {
  const d = dataPath('ai', 'work', name);
  mkdirSync(d, { recursive: true });
  return d;
}
