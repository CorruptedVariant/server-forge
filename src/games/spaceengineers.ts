// Space Engineers dedicated server. Installed and updated with SteamCMD (app 298740, anonymous). Runs in console mode
// with its own instance folder (-path), where SpaceEngineers-Dedicated.cfg, the logs and the saves live. Server Forge
// writes only its own settings into that file (everything else in it is kept), and turns on the game's Remote API
// (VRage Remote API, HMAC-signed) with a random key on 127.0.0.1-only use: live players, chat warnings before a restart
// or update, admins/bans and a clean stop. Steam Workshop mods are listed in the config by ID; the server downloads
// them and players' games download them by themselves when they join.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { steamAppUpdate } from '../steamcmd.ts';
import { workshopId, workshopTitle } from '../workshop.ts';
import type { GameModule, LogParser, LogState, ServerRecord, Settings, AddonSupport } from './types.ts';

export const SPACE_ENGINEERS_APP = 298740;
const SE_GAME_APP = 244850; // the game itself: Workshop items must belong to it
const EXE = path.join('DedicatedServer64', 'SpaceEngineersDedicated.exe');
const CFG = 'SpaceEngineers-Dedicated.cfg';

const MODES = [
  { value: 'Survival', label: 'Survival' },
  { value: 'Creative', label: 'Creative' },
];
const ONLINE = [
  { value: 'PUBLIC', label: 'Public (server list)' },
  { value: 'FRIENDS', label: 'Friends only' },
  { value: 'PRIVATE', label: 'Private (invite / direct IP)' },
];

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

const instanceDir = (record: ServerRecord) => String(record.settings.instanceDir || path.join(record.installDir, 'Instance'));
const cfgFile = (record: ServerRecord) => path.join(instanceDir(record), CFG);
const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- the config file (edited in place: only Server Forge's own elements change) ----------

function readCfg(record: ServerRecord): string {
  try {
    return readFileSync(cfgFile(record), 'utf-8');
  } catch {
    return '<?xml version="1.0"?>\r\n<MyConfigDedicated xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\r\n  <SessionSettings>\r\n  </SessionSettings>\r\n</MyConfigDedicated>\r\n';
  }
}

/** Sets <name>…</name> (raw inner XML) inside `parent` ("MyConfigDedicated" or "SessionSettings"), adding it if missing. */
function setElement(xml: string, parent: 'MyConfigDedicated' | 'SessionSettings', name: string, innerXml: string): string {
  const scope = parent === 'SessionSettings' ? /<SessionSettings>([\s\S]*?)<\/SessionSettings>/ : null;
  const re = new RegExp(`<${name}(\\s*/>|>[\\s\\S]*?</${name}>)`);
  const element = innerXml === '' ? `<${name} />` : `<${name}>${innerXml}</${name}>`;
  if (scope) {
    const m = scope.exec(xml);
    if (!m) return xml.replace('</MyConfigDedicated>', `  <SessionSettings>\r\n    ${element}\r\n  </SessionSettings>\r\n</MyConfigDedicated>`);
    const body = re.test(m[1]) ? m[1].replace(re, element) : `${m[1].replace(/\s*$/, '')}\r\n    ${element}\r\n  `;
    return xml.replace(m[0], `<SessionSettings>${body}</SessionSettings>`);
  }
  // Top level: only match outside SessionSettings.
  const ss = /<SessionSettings>[\s\S]*?<\/SessionSettings>/.exec(xml);
  const outside = ss ? xml.slice(0, ss.index) + '\u0000'.repeat(ss[0].length) + xml.slice(ss.index + ss[0].length) : xml;
  const hit = re.exec(outside);
  if (hit) return xml.slice(0, hit.index) + element + xml.slice(hit.index + hit[0].length);
  return xml.replace('</MyConfigDedicated>', `  ${element}\r\n</MyConfigDedicated>`);
}

function getElement(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

/** The Remote API key Server Forge put in the config (base64), creating one if needed. */
function remoteKey(record: ServerRecord): string | null {
  return getElement(readCfg(record), 'RemoteSecurityKey');
}

/** Writes Server Forge's settings into the config before each start (everything else in it stays as it is). */
function writeCfg(record: ServerRecord) {
  const s = record.settings;
  mkdirSync(instanceDir(record), { recursive: true });
  let xml = readCfg(record);
  xml = setElement(xml, 'MyConfigDedicated', 'ServerName', xmlEscape(String(s.serverName)));
  xml = setElement(xml, 'MyConfigDedicated', 'WorldName', xmlEscape(String(s.world)));
  xml = setElement(xml, 'MyConfigDedicated', 'ServerPort', String(s.port));
  xml = setElement(xml, 'MyConfigDedicated', 'IP', '0.0.0.0');
  xml = setElement(xml, 'MyConfigDedicated', 'PauseGameWhenEmpty', s.pauseWhenEmpty ? 'true' : 'false');
  // The world: keep loading the saved one; a new one starts from the chosen scenario.
  const save = path.join(instanceDir(record), 'Saves', String(s.world));
  if (existsSync(path.join(save, 'Sandbox.sbc'))) xml = setElement(xml, 'MyConfigDedicated', 'LoadWorld', xmlEscape(save));
  else {
    xml = setElement(xml, 'MyConfigDedicated', 'LoadWorld', '');
    xml = setElement(xml, 'MyConfigDedicated', 'PremadeCheckpointPath', xmlEscape(path.join(record.installDir, 'Content', 'CustomWorlds', String(s.scenario))));
  }
  xml = setElement(xml, 'SessionSettings', 'GameMode', String(s.gameMode));
  xml = setElement(xml, 'SessionSettings', 'MaxPlayers', String(s.maxPlayers));
  xml = setElement(xml, 'SessionSettings', 'OnlineMode', String(s.onlineMode));
  // Remote API for Server Forge only: a random key the first time, kept afterwards.
  const key = getElement(xml, 'RemoteSecurityKey') || randomBytes(24).toString('base64');
  xml = setElement(xml, 'MyConfigDedicated', 'RemoteApiEnabled', 'true');
  xml = setElement(xml, 'MyConfigDedicated', 'RemoteSecurityKey', key);
  xml = setElement(xml, 'MyConfigDedicated', 'RemoteApiPort', String(s.remotePort));
  writeFileSync(cfgFile(record), xml);
}

// ---------- the Remote API (HMAC-SHA1 signed, as in Keen's example) ----------

export async function seApi<T = unknown>(record: ServerRecord, method: 'GET' | 'POST' | 'DELETE', resource: string, body?: unknown): Promise<T> {
  const key = remoteKey(record);
  if (!key) throw new Error('The Remote API key is missing (start the server from Server Forge once).');
  const url = `/vrageremote/${resource.replace(/^\//, '')}`;
  const nonce = String(randomBytes(4).readUInt32BE());
  const date = new Date().toUTCString();
  const hash = createHmac('sha1', Buffer.from(key, 'base64')).update(`${url}\r\n${nonce}\r\n${date}\r\n`).digest('base64');
  const res = await fetch(`http://127.0.0.1:${Number(record.settings.remotePort) || 8080}${url}`, {
    method,
    headers: { Date: date, Authorization: `${nonce}:${hash}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`The server's Remote API answered ${res.status}.`);
  const text = await res.text();
  return (text ? (JSON.parse(text) as { data?: T }).data : undefined) as T;
}

// ---------- log ----------

/** The newest SpaceEngineersDedicated_*.log in the instance folder (a new one each start). */
function newestLog(record: ServerRecord): string {
  const dir = instanceDir(record);
  try {
    const logs = readdirSync(dir).filter((f) => /^SpaceEngineersDedicated.*\.log$/i.test(f));
    const newest = logs.map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    if (newest) return path.join(dir, newest.f);
  } catch {}
  return path.join(dir, 'SpaceEngineersDedicated.log');
}

function createSeParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  return {
    feed(line) {
      let m: RegExpExecArray | null;
      if (/Game ready|Server started|Dedicated server successfully started/i.test(line)) st.ready = true;
      if ((m = /Version:\s*([\d.]+)/i.exec(line)) && !st.version) st.version = m[1];
      if (/World saved|Saving world|Session saved/i.test(line)) st.lastSave = Date.now();
      if ((m = /(?:Player|User) (.{1,40}?)(?: \((\d{17})\))? (?:connected|joined)/i.exec(line))) {
        const name = m[1].trim();
        known[m[2] ?? name] = name;
        if (!st.players.some((p) => p.name === name)) st.players.push({ name, joinedAt: Date.now() } as never);
        st.playerCount = st.players.length;
      } else if ((m = /(?:Player|User) (.{1,40}?)(?: \(\d{17}\))? (?:disconnected|left)/i.exec(line))) {
        st.players = st.players.filter((p) => p.name !== m![1].trim());
        st.playerCount = st.players.length;
      }
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

// ---------- mods: Steam Workshop IDs in the config ----------

interface WorkshopMod {
  id: string;
  name: string;
}

function readMods(record: ServerRecord): WorkshopMod[] {
  const block = getElement(readCfg(record), 'Mods') ?? '';
  return [...block.matchAll(/<ModItem\b([^>]*)>([\s\S]*?)<\/ModItem>/g)]
    .map((m) => {
      const id = /<PublishedFileId>(\d+)<\/PublishedFileId>/.exec(m[2])?.[1] ?? '';
      const name = /FriendlyName="([^"]*)"/.exec(m[1])?.[1] ?? id;
      return { id, name: name.replace(/&quot;/g, '"').replace(/&amp;/g, '&') };
    })
    .filter((x) => x.id);
}

function writeMods(record: ServerRecord, mods: WorkshopMod[]) {
  const inner = mods
    .map((m) => `\r\n    <ModItem FriendlyName="${xmlEscape(m.name)}">\r\n      <Name>${m.id}.sbm</Name>\r\n      <PublishedFileId>${m.id}</PublishedFileId>\r\n      <PublishedServiceName>Steam</PublishedServiceName>\r\n    </ModItem>`)
    .join('');
  mkdirSync(instanceDir(record), { recursive: true });
  writeFileSync(cfgFile(record), setElement(readCfg(record), 'MyConfigDedicated', 'Mods', inner ? `${inner}\r\n  ` : ''));
}

const seAddons: AddonSupport = {
  accept: '',
  readOnly: false,
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp: 'Add Steam Workshop mods by their ID or link (below). The server downloads them when it starts, and players’ games download them by themselves when they join. Restart the server to apply changes.',
  }),
  links: [],
  // The server downloads these itself, so no Steam sign-in.
  workshop: { url: 'https://steamcommunity.com/app/244850/workshop/', needsLogin: false },
  list: (record) => readMods(record).map((m, i) => ({ id: m.id, name: m.name, enabled: true, source: 'Steam Workshop', version: '', type: 'mod', typeLabel: 'Workshop mod', typeClass: 'behavior', url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${m.id}`, priority: i })),
  async install() {
    throw new Error('Add Space Engineers mods by their Workshop ID or link.');
  },
  async addById(record, input) {
    const id = workshopId(input);
    const mods = readMods(record);
    if (mods.some((m) => m.id === id)) throw new Error('That mod is already on the list.');
    const name = await workshopTitle(id, SE_GAME_APP, 'Space Engineers');
    writeMods(record, [...mods, { id, name }]);
    return { installed: [{ name, action: 'installed' }], warnings: ['Restart the server to load it.'] };
  },
  remove(record, id) {
    const mods = readMods(record);
    if (!mods.some((m) => m.id === id)) throw new Error('That mod is not on the list.');
    writeMods(record, mods.filter((m) => m.id !== id));
  },
  setEnabled() {
    throw new Error('Remove the mod to stop using it (Space Engineers has no switched-off mods).');
  },
  icon: () => null,
} as AddonSupport;

// ---------- admins and bans (config lists; applied live through the Remote API too) ----------

function readList(record: ServerRecord, list: 'admins' | 'banned'): string[] {
  const block = getElement(readCfg(record), list === 'admins' ? 'Administrators' : 'Banned') ?? '';
  return [...block.matchAll(/<(?:string|unsignedLong)>(\d{17})<\/(?:string|unsignedLong)>/g)].map((m) => m[1]);
}

export const spaceEngineers: GameModule = {
  id: 'spaceengineers',
  name: 'Space Engineers',
  processName: 'SpaceEngineersDedicated.exe',
  linux: 'unavailable',

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the server list.', restart: true },
    { key: 'world', label: 'World name', type: 'text', help: 'A new world is made from the scenario below the first time.', restart: true },
    { key: 'scenario', label: 'Scenario (new world)', type: 'text', help: 'A folder in Content\\CustomWorlds of the server, e.g. "Star System" or "Earth Planet".', restart: true },
    { key: 'gameMode', label: 'Game mode', type: 'select', options: MODES, restart: true },
    { key: 'onlineMode', label: 'Who can join', type: 'select', options: ONLINE, restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 27016 (UDP).', restart: true },
    { key: 'pauseWhenEmpty', label: 'Pause when nobody is online', type: 'boolean', restart: true },
    { key: 'remotePort', label: 'Remote API port (this system only)', type: 'number', help: 'Default 8080. Server Forge uses it for players, chat and stopping. Don’t forward it on your router.', restart: true },
    { key: 'instanceDir', label: 'Instance folder', type: 'folder', help: 'The config, logs and saves live here.', restart: true },
  ],
  quickFields: ['serverName', 'world', 'scenario', 'gameMode', 'maxPlayers', 'port'],

  defaults: ({ installDir }) => ({
    serverName: 'My Space Engineers Server',
    world: 'Tavern Space',
    scenario: 'Star System',
    gameMode: 'Survival',
    onlineMode: 'PUBLIC',
    maxPlayers: 8,
    port: 27016,
    pauseWhenEmpty: false,
    remotePort: 8080,
    instanceDir: path.join(installDir, 'Instance'),
  }),

  validate(s: Settings): Settings {
    const serverName = String(s.serverName ?? '').trim();
    if (!serverName || serverName.length > 60 || /[<>]/.test(serverName)) throw new Error('Server name is required (up to 60 characters, no < or >).');
    const world = String(s.world ?? '').trim();
    if (!/^[\w -]{1,40}$/.test(world)) throw new Error('World name can only use letters, numbers, spaces, - and _ (up to 40).');
    const scenario = String(s.scenario ?? '').trim();
    if (!/^[\w -]{1,60}$/.test(scenario)) throw new Error('Scenario: a folder name from Content\\CustomWorlds.');
    const gameMode = String(s.gameMode ?? 'Survival');
    if (!MODES.some((o) => o.value === gameMode)) throw new Error('Pick a game mode.');
    const onlineMode = String(s.onlineMode ?? 'PUBLIC');
    if (!ONLINE.some((o) => o.value === onlineMode)) throw new Error('Pick who can join.');
    const dir = String(s.instanceDir ?? '').trim();
    if (!path.isAbsolute(dir)) throw new Error('Instance folder must be a full path.');
    return {
      serverName,
      world,
      scenario,
      gameMode,
      onlineMode,
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 64),
      port: num(s.port, 'Port', 1024, 65535),
      pauseWhenEmpty: s.pauseWhenEmpty === true || s.pauseWhenEmpty === 'true',
      remotePort: num(s.remotePort, 'Remote API port', 1024, 65535),
      instanceDir: dir,
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  async prepare(record) {
    writeCfg(record);
  },

  launch(record) {
    return { exe: path.join(record.installDir, EXE), args: ['-console', '-ignorelastsession', '-path', instanceDir(record)], cwd: path.join(record.installDir, 'DedicatedServer64') };
  },

  gameLog: newestLog,

  /** Messages to everyone (countdown warnings before restarts and updates). */
  async say(record, text) {
    await seApi(record, 'POST', 'v1/session/chat', text);
  },

  /** Stop through the Remote API (the server saves on the way out). */
  async gracefulStop(record, note) {
    try {
      await seApi(record, 'DELETE', 'v1/server');
      return true;
    } catch (err) {
      note(`The Remote API didn't answer (${(err as Error).message}); asking the server to close.`);
      return false;
    }
  },

  async details(record) {
    try {
      const players = await seApi<{ Players?: { DisplayName: string; SteamID: number; Ping?: number }[] }>(record, 'GET', 'v1/session/players');
      const list = players?.Players ?? [];
      return { facts: [['World', record.settings.world], ['Players online', `${list.length}${list.length ? `: ${list.map((p) => p.DisplayName).join(', ')}` : ''}`]] };
    } catch {
      return { facts: [['World', record.settings.world]] };
    }
  },

  createParser: createSeParser,

  connection: (record) => ({ port: Number(record.settings.port) || 27016, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: {
    sources: (record) => ({ base: instanceDir(record), include: ['Saves', CFG], world: 'Saves' }),
  },

  addons: seAddons,

  accessLists: [
    { id: 'admins', label: 'Admins', help: 'Steam IDs of players with admin rights on this server.', entryLabel: 'Steam ID (17 digits)' },
    { id: 'banned', label: 'Banned', help: 'Steam IDs that can’t join.', entryLabel: 'Steam ID (17 digits)' },
  ],
  readAccessList: (record, list) => (list === 'admins' || list === 'banned' ? readList(record, list) : []),
  async writeAccessList(record, list, entries, running) {
    if (list !== 'admins' && list !== 'banned') throw new Error('Unknown list.');
    const ids = [...new Set(entries.map((e) => e.trim()).filter((e) => /^\d{17}$/.test(e)))];
    const before = readList(record, list);
    const tag = list === 'admins' ? 'string' : 'unsignedLong';
    const inner = ids.map((id) => `\r\n    <${tag}>${id}</${tag}>`).join('');
    mkdirSync(instanceDir(record), { recursive: true });
    writeFileSync(cfgFile(record), setElement(readCfg(record), 'MyConfigDedicated', list === 'admins' ? 'Administrators' : 'Banned', inner ? `${inner}\r\n  ` : ''));
    // Running: apply the changes straight away too.
    if (running) {
      const res = list === 'admins' ? 'v1/admin/promotedPlayers' : 'v1/admin/bannedPlayers';
      for (const id of ids.filter((x) => !before.includes(x))) await seApi(record, 'POST', `${res}/${id}`).catch(() => {});
      for (const id of before.filter((x) => !ids.includes(x))) await seApi(record, 'DELETE', `${res}/${id}`).catch(() => {});
    }
  },

  async install(record, job) {
    await steamAppUpdate(SPACE_ENGINEERS_APP, record.installDir, job);
    if (!existsSync(path.join(record.installDir, EXE))) throw new Error(`Install finished but ${EXE} is missing.`);
    job.line('Space Engineers dedicated server is installed.');
  },
};
