// 7 Days to Die dedicated server (Steam app 294420, anonymous SteamCMD). Settings go in tavernhost-serverconfig.xml, a
// copy of the shipped serverconfig.xml (Steam's file check would put the original back on every update), with Tavern
// Host's values set in its <property> lines and everything else kept. -UserDataFolder points into the server folder, so
// worlds and saves stay there (not in %APPDATA%\7DaysToDie). The server writes the log Server Forge reads.
// Its telnet console (on this system only: no telnet password) is used for console commands, chat warnings before
// restarts, player actions, and a clean stop ("shutdown" saves the world first).
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import net from 'node:net';
import path from 'node:path';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, bool, text, steamInstall } from './steam-games.ts';

const EXE = bin('7DaysToDieServer.exe', '7DaysToDieServer.x86_64');
const CONFIG = 'tavernhost-serverconfig.xml';
const WORLDS = [
  { value: 'Navezgane', label: 'Navezgane (the hand-made map)' },
  { value: 'Pregen06k01', label: 'Pregenerated 6k #1' },
  { value: 'Pregen06k02', label: 'Pregenerated 6k #2' },
  { value: 'Pregen08k01', label: 'Pregenerated 8k #1' },
  { value: 'Pregen08k02', label: 'Pregenerated 8k #2' },
  { value: 'RWG', label: 'Random world (uses the seed and size below)' },
];
const VISIBILITY = [
  { value: '2', label: 'Public' },
  { value: '1', label: 'Friends only' },
  { value: '0', label: 'Not listed (join by IP)' },
];
const KILLING = [
  { value: '0', label: 'No player killing' },
  { value: '1', label: 'Allies only' },
  { value: '2', label: 'Strangers only' },
  { value: '3', label: 'Everyone' },
];

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Sets <property name="X" value="…"/> values (uncommenting or adding ones that aren't active), keeping the rest. */
export function setProperties(xml: string, values: Record<string, string>): string {
  let out = xml;
  for (const [name, value] of Object.entries(values)) {
    // Only a line that starts with <property counts (the shipped file has commented-out examples: "<!-- <property ...").
    const active = new RegExp(`^(\\s*<property\\s+name="${name}"\\s+value=")[^"]*(")`, 'm');
    if (active.test(out)) {
      out = out.replace(active, `$1${xmlEscape(value)}$2`);
      continue;
    }
    const line = `\t<property name="${name}" value="${xmlEscape(value)}"/>`;
    const commented = new RegExp(`<!--\\s*<property\\s+name="${name}"[^>]*/>\\s*-->`);
    out = commented.test(out) ? out.replace(commented, line.trim()) : out.replace(/<\/ServerSettings>/, `${line}\n</ServerSettings>`);
  }
  return out;
}

function writeConfig(record: ServerRecord) {
  const s = record.settings;
  const file = path.join(record.installDir, CONFIG);
  if (!existsSync(file)) copyFileSync(path.join(record.installDir, 'serverconfig.xml'), file);
  mkdirSync(path.join(record.installDir, 'UserData'), { recursive: true });
  writeFileSync(
    file,
    setProperties(readFileSync(file, 'utf-8'), {
      ServerName: String(s.serverName),
      ServerDescription: String(s.description ?? ''),
      ServerPassword: String(s.password ?? ''),
      ServerPort: String(s.port),
      ServerVisibility: String(s.visibility),
      ServerMaxPlayerCount: String(s.maxPlayers),
      GameWorld: String(s.world),
      WorldGenSeed: String(s.seed),
      WorldGenSize: String(s.size),
      GameName: String(s.gameName),
      PlayerKillingMode: String(s.killing),
      // Server Forge's console access: telnet on this system only (no password = loopback only).
      TelnetEnabled: 'true',
      TelnetPort: String(s.telnetPort),
      TelnetPassword: '',
      TerminalWindowEnabled: 'false',
    }),
  );
}

// ---------- telnet console ----------

/** Sends one command to the server's telnet console and returns what it printed in reply. */
export function telnetCommand(port: number, command: string, waitMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let out = '';
    let sent = false;
    const timer = setTimeout(() => {
      socket.end('exit\r\n');
      socket.destroy();
      resolve(out);
    }, waitMs + 1500);
    socket.setEncoding('utf-8');
    socket.on('data', (d: string) => {
      if (sent) out += d;
      // The banner ends with an empty line; send the command once it has arrived.
      else if (/Press 'help' to get a list of all commands|\r?\n\r?\n/.test(d)) {
        sent = true;
        socket.write(`${command}\r\n`);
        setTimeout(() => {
          clearTimeout(timer);
          socket.end('exit\r\n');
          resolve(out);
        }, waitMs);
      }
    });
    socket.on('connect', () => setTimeout(() => !sent && ((sent = true), socket.write(`${command}\r\n`)), 800));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't reach the server's telnet console: ${err.message}`));
    });
  });
}

// ---------- log ----------

function createSevenDaysParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  const online = new Map<string, number>();
  const sync = () => {
    st.players = [...online].map(([name, joinedAt]) => ({ name, joinedAt }));
    st.playerCount = online.size;
  };
  return {
    feed(line) {
      let m: RegExpExecArray | null;
      if (/GameServer\.LogOn successful|\[EOS\] Server registered|StartGame done/i.test(line)) st.ready = true;
      if ((m = /Version: (V\s?[\d.]+(?: \(b\d+\))?)/i.exec(line)) && !st.version) st.version = m[1];
      if ((m = /PlayerSpawnedInWorld \(reason: (?:JoinMultiplayer|EnterMultiplayer)[^)]*\).*PlayerName='([^']{1,60})'/.exec(line))) {
        known[m[1]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /Player disconnected: .*PlayerName='([^']{1,60})'/.exec(line))) {
        online.delete(m[1]);
        sync();
      }
      if (/World saved|Saving world|SaveAndCleanupWorld/i.test(line)) st.lastSave = Date.now();
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

const q = (s: string) => `"${String(s).replace(/"/g, '')}"`;

export const sevenDays: GameModule = {
  id: 'sevendays',
  name: '7 Days to Die',
  processName: EXE,

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', restart: true },
    { key: 'description', label: 'Description', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 26900 (TCP and UDP; UDP 26901-26902 too).', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional.', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', restart: true },
    { key: 'visibility', label: 'Server list', type: 'select', options: VISIBILITY, restart: true },
    { key: 'world', label: 'World', type: 'select', options: WORLDS, restart: true, section: 'World' },
    { key: 'gameName', label: 'Save name', type: 'text', help: 'A new name starts a new save on the same world.', restart: true, section: 'World' },
    { key: 'seed', label: 'Random world seed', type: 'text', help: 'For "Random world" only.', restart: true, section: 'World' },
    { key: 'size', label: 'Random world size', type: 'select', options: ['6144', '8192', '10240'].map((v) => ({ value: v, label: v })), restart: true, section: 'World' },
    { key: 'killing', label: 'Player killing', type: 'select', options: KILLING, restart: true, section: 'World' },
    { key: 'telnetPort', label: 'Telnet port (this system only)', type: 'number', help: 'Default 8081. Used by Server Forge for the console; no need to forward it.', restart: true, section: 'Advanced' },
  ],
  quickFields: ['serverName', 'port', 'password', 'maxPlayers', 'world', 'gameName'],

  defaults: () => ({
    serverName: 'My 7 Days to Die Server',
    description: 'Hosted with Server Forge',
    port: 26900,
    password: '',
    maxPlayers: 8,
    visibility: '2',
    world: 'Navezgane',
    gameName: 'TavernGame',
    seed: 'TavernSeed',
    size: '6144',
    killing: '3',
    telnetPort: 8081,
  }),

  validate(s: Settings): Settings {
    const world = String(s.world ?? 'Navezgane');
    if (!WORLDS.some((w) => w.value === world)) throw new Error('Pick a world.');
    const gameName = text(s.gameName || 'TavernGame', 'Save name', 40);
    if (!/^[A-Za-z0-9_.\- ]+$/.test(gameName)) throw new Error('Save name can only use letters, numbers, spaces, _ - and .');
    const visibility = String(s.visibility ?? '2');
    const killing = String(s.killing ?? '3');
    const size = String(s.size ?? '6144');
    if (!VISIBILITY.some((v) => v.value === visibility) || !KILLING.some((v) => v.value === killing) || !['6144', '8192', '10240'].includes(size)) throw new Error('Check the world settings.');
    return {
      serverName: text(s.serverName, 'Server name', 60, true),
      description: text(s.description, 'Description', 200),
      port: num(s.port, 'Port', 1024, 65533),
      password: text(s.password, 'Password', 64),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 64),
      visibility,
      world,
      gameName,
      seed: text(s.seed || 'TavernSeed', 'Seed', 40),
      size,
      killing,
      telnetPort: num(s.telnetPort ?? 8081, 'Telnet port', 1024, 65535),
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  async prepare(record) {
    writeConfig(record);
  },

  launch: (record) => ({
    exe: path.join(record.installDir, EXE),
    // -UserDataFolder keeps worlds, saves and serveradmin.xml in the server folder (the serverconfig.xml property is
    // ignored by current versions).
    args: ['-logfile', path.join(record.installDir, 'tavernhost-server.log'), '-quit', '-batchmode', '-nographics', `-configfile=${CONFIG}`, `-UserDataFolder=${path.join(record.installDir, 'UserData')}`, '-dedicated'],
    cwd: record.installDir,
    env: { SteamAppId: '251570', SteamGameId: '251570', ...(isLinux ? { LD_LIBRARY_PATH: '.' } : {}) },
  }),

  gameLog: (record) => path.join(record.installDir, 'tavernhost-server.log'),

  async runCommand(record, command) {
    return telnetCommand(Number(record.settings.telnetPort), command);
  },

  async say(record, msg) {
    await telnetCommand(Number(record.settings.telnetPort), `say ${q(msg)}`, 500);
  },

  /** Stop: "shutdown" through telnet saves the world and quits. */
  async gracefulStop(record, note) {
    try {
      await telnetCommand(Number(record.settings.telnetPort), 'saveworld', 3000);
      note('Saved the world.');
      await telnetCommand(Number(record.settings.telnetPort), 'shutdown', 500);
      return true;
    } catch (err) {
      note(`${(err as Error).message}; trying Ctrl+C.`);
      return false;
    }
  },

  playerCommands: {
    kick: (n, r) => `kick ${q(n)}${r ? ` ${q(r)}` : ''}`,
    ban: (n, r) => `ban add ${q(n)} 10 years ${q(r || 'Banned')}`,
    pardon: (n) => `ban remove ${q(n)}`,
    op: (n) => `admin add ${q(n)} 0`,
    deop: (n) => `admin remove ${q(n)}`,
  },

  createParser: createSevenDaysParser,

  connection: (record) => ({ port: Number(record.settings.port) || 26900, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: { sources: (record) => ({ base: record.installDir, include: ['UserData', CONFIG].filter((p) => existsSync(path.join(record.installDir, p))), world: 'UserData' }) },

  install: (record, job) => steamInstall(record, job, STEAM_APPS.sevendays, EXE, '7 Days to Die'),
};
