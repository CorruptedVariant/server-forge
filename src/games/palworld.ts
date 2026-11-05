// Palworld dedicated server (Steam app 2394010, anonymous SteamCMD). It runs Pal\Binaries\Win64\
// PalServer-Win64-Shipping-Cmd.exe directly (PalServer.exe only starts that and exits, which would lose the process),
// under the runner so its console output lands in the log. Its settings are one long "OptionSettings=(...)" line in
// Pal\Saved\Config\WindowsServer\PalWorldSettings.ini (created from DefaultPalWorldSettings.ini): Server Forge changes
// only its own keys in it, so every other setting stays as the owner set it.
// Palworld's REST API (switched on here, on this system only, with the admin password) gives the player list,
// announcements for countdowns, and a clean stop: save, then shut down.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameModule, LogParser, LogState, PropertyEntry, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, bool, text, newPassword, steamInstall } from './steam-games.ts';
import { palworldAddons } from './palworld-mods.ts';
import { PAL_MANAGED, PAL_SETTINGS, type PalSetting } from './palworld-settings.ts';

const EXE = path.join('Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping-Cmd.exe');
const SETTINGS = path.join('Pal', 'Saved', 'Config', 'WindowsServer', 'PalWorldSettings.ini');
const SECTION = '[/Script/Pal.PalGameWorldSettings]';

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
      // Server Forge's own access: the REST API on this system only.
      RESTAPIEnabled: 'True',
      RESTAPIPort: String(s.restPort),
      bShowPlayerList: 'True',
      LogFormatType: 'Text',
      bIsShowJoinLeftMessage: 'True',
    }),
  );
}

// ---------- World settings tab: the rest of the OptionSettings line, edited in place ----------

/** What the editor shows for a value in the file: "1.000000" -> "1", "True" -> "true", "\"text\"" -> "text". */
function shownValue(raw: string, type: PalSetting['type']): string {
  if (type === 'bool') return raw.trim().toLowerCase();
  if (type === 'rate' || type === 'decimal' || type === 'int') return Number.isFinite(Number(raw)) && raw.trim() !== '' ? String(Number(raw)) : raw;
  if (type === 'text') return raw.replace(/^"(.*)"$/, '$1');
  return raw;
}

/** The type of a setting that isn't in our list (added by a newer game version), from how it looks in the file. */
function guessType(raw: string): PalSetting['type'] {
  if (/^(true|false)$/i.test(raw)) return 'bool';
  if (/^-?\d+$/.test(raw)) return 'int';
  if (/^-?\d*\.\d+$/.test(raw)) return 'decimal';
  if (raw.startsWith('(')) return 'list';
  return 'text';
}

/** What goes in the file for a value from the editor. Throws a message the owner can act on. */
function fileValue(value: string, info: Pick<PalSetting, 'label' | 'type' | 'options' | 'min' | 'max'>): string {
  const v = value.trim();
  const { label, type } = info;
  if (type === 'bool') {
    if (!/^(true|false)$/i.test(v)) throw new Error(`${label} must be on or off.`);
    return v.toLowerCase() === 'true' ? 'True' : 'False';
  }
  if (type === 'select') {
    if (!info.options?.includes(v)) throw new Error(`${label} must be one of: ${info.options?.join(', ')}.`);
    return v;
  }
  if (type === 'rate' || type === 'decimal' || type === 'int') {
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) throw new Error(`${label} must be a number.`);
    if (type === 'int' && !Number.isInteger(n)) throw new Error(`${label} must be a whole number.`);
    if (info.min !== undefined && n < info.min) throw new Error(`${label} can't be below ${info.min}.`);
    if (info.max !== undefined && n > info.max) throw new Error(`${label} can't be above ${info.max}.`);
    return type === 'int' ? String(n) : n.toFixed(6);
  }
  if (type === 'list') {
    const inner = v.replace(/^\(/, '').replace(/\)$/, '').trim();
    if (!/^[\w ,.-]*$/.test(inner)) throw new Error(`${label} should look like (One,Two).`);
    const items = inner.split(',').map((x) => x.trim()).filter(Boolean);
    return items.length ? `(${items.join(',')})` : '';
  }
  if (/[\r\n]/.test(v)) throw new Error(`${label} can't contain line breaks.`);
  return quote(v);
}

/** A world made in the game (or copied from one) keeps its settings in WorldOption.sav, which beats the ini file. */
function worldOptionFile(record: ServerRecord): string | null {
  const saves = path.join(record.installDir, 'Pal', 'Saved', 'SaveGames', '0');
  if (!existsSync(saves)) return null;
  for (const world of readdirSync(saves, { withFileTypes: true })) {
    if (!world.isDirectory()) continue;
    const file = path.join(saves, world.name, 'WorldOption.sav');
    if (existsSync(file)) return file;
  }
  return null;
}

const palworldProperties: NonNullable<GameModule['properties']> = {
  read(record) {
    const file = path.join(record.installDir, SETTINGS);
    const values = readOptions(settingsText(record));
    const def = path.join(record.installDir, 'DefaultPalWorldSettings.ini');
    const defaults = existsSync(def) ? readOptions(readFileSync(def, 'utf-8').split(/\r?\n/).filter((l) => !l.startsWith(';')).join('\r\n')) : new Map<string, string>();
    const entry = (info: PalSetting): PropertyEntry => {
      const raw = values.get(info.key);
      const rawDefault = defaults.get(info.key);
      const defaultValue = rawDefault === undefined ? null : shownValue(rawDefault, info.type);
      const shownDefault = defaultValue === null ? '' : ` Default: ${defaultValue === 'true' ? 'on' : defaultValue === 'false' ? 'off' : defaultValue || 'empty'}.`;
      return {
        key: info.key,
        value: raw === undefined ? null : shownValue(raw, info.type),
        defaultValue,
        description: `${info.desc}${shownDefault}`,
        type: info.type === 'bool' ? 'boolean' : info.type === 'select' ? 'select' : info.type === 'text' || info.type === 'list' ? 'text' : 'number',
        options: info.options,
        known: true,
        optional: false,
        label: info.label,
        section: info.section,
        advanced: info.advanced,
      };
    };
    const listed = new Set(PAL_SETTINGS.map((s) => s.key));
    const others = [...values.keys()].filter((k) => !listed.has(k) && !PAL_MANAGED.has(k));
    const worldOption = worldOptionFile(record);
    return {
      file,
      entries: [
        ...PAL_SETTINGS.map(entry),
        ...others.map((key) => entry({ key, label: key, desc: 'A setting Server Forge has no description for yet.', type: guessType(values.get(key)!), section: 'Other' })),
      ],
      problems: worldOption ? [`This world has a WorldOption.sav, so Palworld ignores most of these settings. To use them, stop the server, back up the world, then delete ${worldOption}.`] : [],
    };
  },
  write(record, changes) {
    const existing = readOptions(settingsText(record));
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (PAL_MANAGED.has(key)) throw new Error(`${key} is set on the Settings tab.`);
      const known = PAL_SETTINGS.find((s) => s.key === key);
      if (!known && !existing.has(key)) throw new Error(`${key} isn't a Palworld setting.`);
      out[key] = fileValue(value, known ?? { label: key, type: guessType(existing.get(key)!) });
    }
    const file = path.join(record.installDir, SETTINGS);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tavernhost-tmp`;
    writeFileSync(tmp, writeOptions(settingsText(record), out));
    renameSync(tmp, file);
  },
};

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
    restPort: 8212,
  }),

  validate(s: Settings): Settings {
    const adminPassword = text(s.adminPassword, 'Admin password', 64, true);
    if (/["\\]/.test(adminPassword + String(s.password ?? ''))) throw new Error('Passwords can\'t contain " or \\.');
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

  properties: palworldProperties,
  propertiesLabel: 'World settings',

  backup: { sources: (record) => ({ base: path.join(record.installDir, 'Pal', 'Saved'), include: ['SaveGames', 'Config'], world: 'SaveGames' }) },

  addons: palworldAddons,

  install: (record, job) => steamInstall(record, job, STEAM_APPS.palworld, EXE, 'Palworld'),
};
