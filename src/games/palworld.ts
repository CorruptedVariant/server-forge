// Palworld dedicated server (Steam app 2394010, anonymous SteamCMD). It runs Pal\Binaries\Win64\
// PalServer-Win64-Shipping-Cmd.exe directly (PalServer.exe only starts that and exits, which would lose the process),
// under the runner so its console output lands in the log. Its settings are one long "OptionSettings=(...)" line in
// Pal\Saved\Config\WindowsServer\PalWorldSettings.ini (created from DefaultPalWorldSettings.ini): Server Forge changes
// only its own keys in it, so every other setting stays as the owner set it.
// Palworld's REST API (switched on here, on this system only, with the admin password) gives the player list,
// announcements for countdowns, and a clean stop: save, then shut down.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, decimal, bool, text, newPassword, steamInstall } from './steam-games.ts';
import { palworldAddons } from './palworld-mods.ts';

const EXE = path.join('Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');
const SETTINGS = path.join('Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');
const SECTION = '[/Script/Pal.PalGameWorldSettings]';

const DIFFICULTY = [
  { value: 'None', label: 'Normal (use the rates below)' },
  { value: 'Casual', label: 'Casual' },
  { value: 'Hard', label: 'Hard' },
];
const DEATH = [
  { value: 'None', label: 'Keep everything' },
  { value: 'Item', label: 'Drop items (not equipment)' },
  { value: 'ItemAndEquipment', label: 'Drop items and equipment' },
  { value: 'All', label: 'Drop everything, including Pals in the party' },
];

// ---------- the OptionSettings line ----------

/** Splits "A=1,B="x,y",C=(P,Q)" at the top-level commas. */
function splitOptions(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.filter((p) => p.length);
}

export function readOptions(text: string): Map<string, string> {
  const m = /^OptionSettings=\((.*)\)\s*$/m.exec(text);
  const map = new Map<string, string>();
  for (const part of m ? splitOptions(m[1]) : []) {
    const eq = part.indexOf('=');
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return map;
}

/** Sets values (already formatted: "True", "1.000000", "\"text\"") in the OptionSettings line, keeping the order. */
export function writeOptions(text: string, values: Record<string, string>): string {
  const m = /^OptionSettings=\((.*)\)\s*$/m.exec(text);
  const parts = m ? splitOptions(m[1]) : [];
  const done = new Set<string>();
  const next = parts.map((part) => {
    const key = part.slice(0, part.indexOf('='));
    if (key in values) {
      done.add(key);
      return `${key}=${values[key]}`;
    }
    return part;
  });
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) next.push(`${k}=${v}`);
  const line = `OptionSettings=(${next.join(',')})`;
  if (m) return text.replace(/^OptionSettings=\(.*\)\s*$/m, line);
  return `${SECTION}\r\n${line}\r\n`;
}

const quote = (s: string) => `"${String(s).replace(/"/g, "'")}"`;
const flt = (n: unknown) => Number(n).toFixed(6);
const tf = (b: unknown) => (b ? 'True' : 'False');

function settingsText(record: ServerRecord): string {
  const file = path.join(record.installDir, SETTINGS);
  if (existsSync(file) && readOptions(readFileSync(file, 'utf-8')).size) return readFileSync(file, 'utf-8');
  const def = path.join(record.installDir, 'DefaultPalWorldSettings.ini');
  return existsSync(def) ? readFileSync(def, 'utf-8').split(/\r?\n/).filter((l) => !l.startsWith(';')).join('\r\n') : `${SECTION}\r\nOptionSettings=()\r\n`;
}

function writeSettings(record: ServerRecord) {
  const s = record.settings;
  const file = path.join(record.installDir, SETTINGS);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    writeOptions(settingsText(record), {
      ServerName: quote(String(s.serverName)),
      ServerDescription: quote(String(s.description ?? '')),
      AdminPassword: quote(String(s.adminPassword)),
      ServerPassword: quote(String(s.password ?? '')),
      PublicPort: String(s.port),
      ServerPlayerMaxNum: String(s.maxPlayers),
      Difficulty: String(s.difficulty),
      DeathPenalty: String(s.deathPenalty),
      ExpRate: flt(s.expRate),
      PalCaptureRate: flt(s.captureRate),
      bIsPvP: tf(s.pvp),
      bEnablePlayerToPlayerDamage: tf(s.pvp),
      // Server Forge's own access: the REST API on this system only.
      RESTAPIEnabled: 'True',
      RESTAPIPort: String(s.restPort),
      bShowPlayerList: 'True',
      LogFormatType: 'Text',
      bIsShowJoinLeftMessage: 'True',
    }),
  );
}

// ---------- REST API ----------

async function rest<T = unknown>(record: ServerRecord, method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${record.settings.restPort}/v1/api/${route}`, {
    method,
    headers: { Authorization: `Basic ${Buffer.from(`admin:${record.settings.adminPassword}`).toString('base64')}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Palworld's API answered ${res.status}${res.status === 401 ? ' (admin password changed outside Server Forge?)' : ''}.`);
  const t = await res.text();
  try {
    return JSON.parse(t) as T;
  } catch {
    return t as T;
  }
}

// ---------- log ----------

function createPalworldParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  const online = new Map<string, number>();
  const sync = () => {
    st.players = [...online].map(([name, joinedAt]) => ({ name, joinedAt }));
    st.playerCount = online.size;
  };
  return {
    feed(raw) {
      let m: RegExpExecArray | null;
      // Palworld writes its "Game version is v…" line in UTF-16, which arrives as CJK-looking characters: decode it.
      const line = /[　-鿿]{4,}/.test(raw) ? raw.replace(/[Ā-￿]+/g, (s) => Buffer.from(s, 'utf16le').toString('latin1')) : raw;
      if (/Running Palworld dedicated server on|REST API started/i.test(line)) st.ready = true;
      if ((m = /Game version is (v[\d.]+)/i.exec(line))) st.version = m[1];
      if ((m = /\]\s*(?:\[LOG\]\s*)?(.{1,60}?) joined the server\.?\s*\(User id: ([^)]+)\)/i.exec(line))) {
        known[m[2]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /\]\s*(?:\[LOG\]\s*)?(.{1,60}?) left the server\.?/i.exec(line))) {
        online.delete(m[1]);
        sync();
      }
      if (/World save|saved the world|Save complete/i.test(line)) st.lastSave = Date.now();
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

export const palworld: GameModule = {
  id: 'palworld',
  name: 'Palworld',
  processName: 'PalServer-Win64-Shipping-Cmd.exe',

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', restart: true },
    { key: 'description', label: 'Description', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 8211 (UDP).', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional. Players type it to join.', restart: true },
    { key: 'adminPassword', label: 'Admin password', type: 'password', help: 'For /AdminPassword in the game. Server Forge also uses it for the server API (players, warnings, clean stops).', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', help: 'Up to 32.', restart: true },
    { key: 'public', label: 'List as a community server', type: 'boolean', help: 'Show in the in-game community server list.', restart: true },
    { key: 'difficulty', label: 'Difficulty', type: 'select', options: DIFFICULTY, restart: true, section: 'World' },
    { key: 'deathPenalty', label: 'On death', type: 'select', options: DEATH, restart: true, section: 'World' },
    { key: 'expRate', label: 'XP rate', type: 'number', help: '1 = normal.', restart: true, section: 'World' },
    { key: 'captureRate', label: 'Capture rate', type: 'number', help: '1 = normal.', restart: true, section: 'World' },
    { key: 'pvp', label: 'PvP', type: 'boolean', restart: true, section: 'World' },
    { key: 'restPort', label: 'API port (this system only)', type: 'number', help: 'Default 8212. Used by Server Forge; no need to forward it.', restart: true, section: 'Advanced' },
  ],
  quickFields: ['serverName', 'port', 'password', 'adminPassword', 'maxPlayers'],

  defaults: () => ({
    serverName: 'My Palworld Server',
    description: 'Hosted with Server Forge',
    port: 8211,
    password: '',
    adminPassword: newPassword(),
    maxPlayers: 32,
    public: false,
    difficulty: 'None',
    deathPenalty: 'Item',
    expRate: 1,
    captureRate: 1,
    pvp: false,
    restPort: 8212,
  }),

  validate(s: Settings): Settings {
    const adminPassword = text(s.adminPassword, 'Admin password', 64, true);
    if (/["\\]/.test(adminPassword + String(s.password ?? ''))) throw new Error('Passwords can\'t contain " or \\.');
    const difficulty = String(s.difficulty ?? 'None');
    const deathPenalty = String(s.deathPenalty ?? 'Item');
    if (!DIFFICULTY.some((d) => d.value === difficulty)) throw new Error('Pick a difficulty.');
    if (!DEATH.some((d) => d.value === deathPenalty)) throw new Error('Pick what happens on death.');
    const port = num(s.port, 'Port', 1024, 65535);
    const restPort = num(s.restPort ?? 8212, 'API port', 1024, 65535);
    if (port === restPort) throw new Error('The API port must be different from the game port.');
    return {
      serverName: text(s.serverName, 'Server name', 60, true),
      description: text(s.description, 'Description', 200),
      port,
      password: text(s.password, 'Password', 64),
      adminPassword,
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 32),
      public: bool(s.public),
      difficulty,
      deathPenalty,
      expRate: decimal(s.expRate ?? 1, 'XP rate', 0.1, 20),
      captureRate: decimal(s.captureRate ?? 1, 'Capture rate', 0.5, 2),
      pvp: bool(s.pvp),
      restPort,
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder (pick the folder with PalServer.exe).`);
  },

  async prepare(record) {
    writeSettings(record);
  },

  launch(record) {
    const s = record.settings;
    return {
      exe: path.join(record.installDir, EXE),
      args: [`-port=${s.port}`, `-players=${s.maxPlayers}`, ...(s.public ? ['-publiclobby'] : [])],
      cwd: record.installDir,
    };
  },

  captureOutput: true,
  // Server Forge's own API calls (every overview refresh) and the UTF-16 version line.
  hideLine: (line) => /REST accessed endpoint|^\s*REST API stopped/.test(line) || /[　-鿿]{4,}/.test(line),

  /** Stop: save the world, then shut down (Palworld's own way, through its API). */
  async gracefulStop(record, note) {
    try {
      await rest(record, 'POST', 'save', {}, 60_000);
      note('Saved the world.');
      await rest(record, 'POST', 'shutdown', { waittime: 1, message: 'Server shutting down.' });
      return true;
    } catch (err) {
      note(`Palworld's API didn't answer (${(err as Error).message}); trying Ctrl+C.`);
      return false;
    }
  },

  async say(record, msg) {
    await rest(record, 'POST', 'announce', { message: msg });
  },

  async details(record) {
    try {
      const [info, metrics, players] = await Promise.all([
        rest<{ version?: string; worldguid?: string }>(record, 'GET', 'info'),
        rest<{ serverfps?: number; currentplayernum?: number; maxplayernum?: number; days?: number; uptime?: number }>(record, 'GET', 'metrics'),
        rest<{ players?: { name: string; level: number }[] }>(record, 'GET', 'players'),
      ]);
      return {
        facts: [
          ['Version', info.version ?? null],
          ['Players', metrics.currentplayernum != null ? `${metrics.currentplayernum} / ${metrics.maxplayernum}` : null],
          ['In-game day', metrics.days ?? null],
          ['Server FPS', metrics.serverfps ?? null],
          ['Online', (players.players ?? []).map((p) => `${p.name} (Lv ${p.level})`).join(', ') || null],
        ],
      };
    } catch {
      return {};
    }
  },

  createParser: createPalworldParser,

  async probeReady(record) {
    try {
      const info = await rest<{ version?: string }>(record, 'GET', 'info', undefined, 2500);
      return typeof info?.version === 'string' && info.version.length > 0;
    } catch {
      return false;
    }
  },

  connection: (record) => ({ port: Number(record.settings.port) || 8211, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: { sources: (record) => ({ base: path.join(record.installDir, 'Pal', 'Saved'), include: ['SaveGames', 'Config'], world: 'SaveGames' }) },

  addons: palworldAddons,

  install: (record, job) => steamInstall(record, job, STEAM_APPS.palworld, EXE, 'Palworld'),
};
