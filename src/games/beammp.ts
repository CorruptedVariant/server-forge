// BeamMP: multiplayer for BeamNG.drive. The server is BeamMP's own program (github.com/BeamMP/BeamMP-Server), one file
// for Windows or Linux, with everything else in ServerConfig.toml next to it. Server Forge sets its own values in the
// [General] section before every start and keeps everything else (comments, [Misc], keys added by newer versions).
// The server needs an AuthKey from keymaster.beammp.com (free, Discord login) to start. It reads typed commands from a
// pipe: `exit` stops it, `say`, `kick`, `list` and `status` work from the Console tab. Mods for players (cars, maps) are
// .zip files in Resources/Client, sent to players when they join; Lua server plugins are folders in Resources/Server.
import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { isLinux } from '../platform/host.ts';
import { downloadFile } from '../download.ts';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { num, bool, text } from './steam-games.ts';
import { beammpMods } from './beammp-mods.ts';

export const BEAMMP_CONFIG = 'ServerConfig.toml';
const WIN_EXE = 'BeamMP-Server.exe';
const LINUX_EXE = 'BeamMP-Server';
const VERSION_NOTE = '.sf-beammp.json';
const RELEASES = 'https://api.github.com/repos/BeamMP/BeamMP-Server/releases/latest';

/** BeamNG.drive's own maps (level folder names). Mod maps use "Custom map". */
const MAPS = [
  { value: 'gridmap_v2', label: 'Grid Map' },
  { value: 'west_coast_usa', label: 'West Coast, USA' },
  { value: 'east_coast_usa', label: 'East Coast, USA' },
  { value: 'italy', label: 'Italy' },
  { value: 'utah', label: 'Utah, USA' },
  { value: 'johnson_valley', label: 'Johnson Valley' },
  { value: 'jungle_rock_island', label: 'Jungle Rock Island' },
  { value: 'small_island', label: 'Small Island, USA' },
  { value: 'hirochi_raceway', label: 'Hirochi Raceway' },
  { value: 'automation_test_track', label: 'Automation Test Track' },
  { value: 'industrial', label: 'Industrial Site' },
  { value: 'driver_training', label: 'Driver Training' },
  { value: 'derby', label: 'Derby Arenas' },
  { value: 'smallgrid', label: 'Small Grid' },
  { value: 'custom', label: 'Custom map (from a mod)' },
];
const mapPath = (level: string) => `/levels/${level}/info.json`;

/** The server program in a folder: Server Forge's own name first, then the names BeamMP's downloads have. */
export function beammpExe(dir: string): string | null {
  const names = isLinux ? [LINUX_EXE] : [WIN_EXE];
  for (const n of names) if (existsSync(path.join(dir, n))) return path.join(dir, n);
  if (!existsSync(dir)) return null;
  // Imported Linux folders keep the download's name ("BeamMP-Server.ubuntu.22.04.x86_64").
  const other = readdirSync(dir).find((n) => (isLinux ? /^BeamMP-Server\.[\w.]*x86_64$/ : /^BeamMP-Server.*\.exe$/i).test(n));
  return other ? path.join(dir, other) : null;
}

// ---------- ServerConfig.toml ----------

/** What BeamMP-Server 3.9 writes on its first start (with every key, so it doesn't warn about missing ones). */
const DEFAULT_CONFIG = `# This is the BeamMP-Server config file.
# Help & Documentation: \`https://docs.beammp.com/server/server-maintenance/\`
# IMPORTANT: Fill in the AuthKey with the key you got from \`https://keymaster.beammp.com/\` on the left under "Keys"
[General]
Port = 30814
# AuthKey has to be filled out in order to run the server
AuthKey = ""
# Whether to allow guests
AllowGuests = true
# Whether to log chat messages in the console / log
LogChat = true
Debug = false
# The IP address to bind the server to, this is NOT related to your public IP. Can be used if your machine has multiple network interfaces
IP = "::"
Private = true
# Whether to allow unconnected clients to get the public server information without joining
InformationPacket = true
Name = "BeamMP Server"
# Add custom identifying tags to your server to make it easier to find. Format should be TagA,TagB,TagC. Note the comma seperation.
Tags = "Freeroam"
MaxCars = 1
MaxPlayers = 8
Map = "/levels/gridmap_v2/info.json"
Description = "BeamMP Default Description"
ResourceFolder = "Resources"

[Misc]
# Hides the periodic update message which notifies you of a new server version. You should really keep this on and always update as soon as possible.
ImScaredOfUpdates = true
# Specifies the time between update reminders. You can use any of "s, min, h, d" at the end to specify the units seconds, minutes, hours or days.
UpdateReminderTime = "30s"
`;

const tomlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/g, '')}"`;

/** [General] keys from the file (strings unquoted, numbers and booleans as written). */
export function readGeneral(installDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw = '';
  try {
    raw = readFileSync(path.join(installDir, BEAMMP_CONFIG), 'utf-8');
  } catch {
    return out;
  }
  let section = '';
  for (const line of raw.split(/\r?\n/)) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    if (section !== 'General') continue;
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (q) v = q[1].replace(/\\(["\\])/g, '$1');
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Sets keys in [General], keeping the rest of the file as it is. Makes the file if there isn't one. */
function writeGeneral(installDir: string, values: Record<string, string | number | boolean>) {
  const file = path.join(installDir, BEAMMP_CONFIG);
  const raw = existsSync(file) ? readFileSync(file, 'utf-8') : DEFAULT_CONFIG;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const fmt = (v: string | number | boolean) => (typeof v === 'string' ? tomlString(v) : String(v));
  const left = new Map(Object.entries(values));
  let section = '';
  let generalEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (sec) {
      if (section === 'General' && generalEnd < 0) generalEnd = i;
      section = sec[1].trim();
      continue;
    }
    if (section !== 'General') continue;
    const m = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)/.exec(lines[i]);
    if (m && left.has(m[2])) {
      lines[i] = `${m[1]}${m[2]}${m[3]}${fmt(left.get(m[2])!)}`;
      left.delete(m[2]);
    }
  }
  if (left.size) {
    const add = [...left].map(([k, v]) => `${k} = ${fmt(v)}`);
    if (!lines.some((l) => /^\s*\[General\]\s*$/.test(l))) lines.unshift('[General]', ...add);
    else {
      // Before the next section (or the end), skipping back over blank lines.
      let at = generalEnd >= 0 ? generalEnd : lines.length;
      while (at > 0 && lines[at - 1].trim() === '') at--;
      lines.splice(at, 0, ...add);
    }
  }
  writeFileSync(file, lines.join(eol));
}

/** The resources folder (ResourceFolder in the config), kept inside the server folder. */
export function resourcesDir(record: Pick<ServerRecord, 'installDir'>): string {
  const want = readGeneral(record.installDir).ResourceFolder || 'Resources';
  const root = path.resolve(record.installDir);
  const dir = path.resolve(root, want);
  return dir.startsWith(root + path.sep) ? dir : path.join(root, 'Resources');
}

// ---------- versions ----------

export function installedBeammp(installDir: string): string | null {
  try {
    return String(JSON.parse(readFileSync(path.join(installDir, VERSION_NOTE), 'utf-8')).version ?? '') || null;
  } catch {
    return null;
  }
}

export async function latestBeammp(): Promise<string> {
  const res = await fetch(RELEASES, { headers: { 'User-Agent': 'ServerForge', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the latest BeamMP-Server release.`);
  const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? '');
  if (!/^v?\d+(\.\d+)+$/.test(tag)) throw new Error('Could not read the latest BeamMP-Server version.');
  return tag.replace(/^v/, '');
}

/** Which Linux build fits this system (BeamMP builds for Debian 12/13 and Ubuntu 22.04/24.04). */
function linuxAsset(): string {
  let id = '';
  let ver = '';
  try {
    const os = readFileSync('/etc/os-release', 'utf-8');
    id = /^ID=("?)([^"\n]*)\1$/m.exec(os)?.[2] ?? '';
    ver = /^VERSION_ID=("?)([^"\n]*)\1$/m.exec(os)?.[2] ?? '';
  } catch {}
  if (process.arch !== 'x64') throw new Error('BeamMP-Server for Linux is only offered for x86_64 here.');
  if (id === 'debian') return `BeamMP-Server.debian.${ver === '12' ? '12' : '13'}.x86_64`;
  if (id === 'ubuntu' && ver.startsWith('22.')) return 'BeamMP-Server.ubuntu.22.04.x86_64';
  // Ubuntu 24.04 and anything else (the Docker image is Ubuntu 24.04; other distros with a recent glibc run it too).
  return 'BeamMP-Server.ubuntu.24.04.x86_64';
}

// ---------- log ----------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const clean = (line: string) => line.replace(ANSI, '').replace(/^(?:>\s*)+/, '');

function createBeammpParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  const online = new Map<string, number>();
  const sync = () => {
    st.players = [...online].map(([name, joinedAt]) => ({ name, joinedAt }));
    st.playerCount = online.size;
  };
  return {
    feed(raw) {
      const line = clean(raw);
      let m: RegExpExecArray | null;
      if ((m = /BeamMP Server v(\d+(?:\.\d+)+)/.exec(line))) st.version = m[1];
      if (/ALL SYSTEMS STARTED SUCCESSFULLY/.test(line)) st.ready = true;
      if (/gracefully shutting down/.test(line)) st.ready = false;
      // "[INFO] Name : Connected" / "[INFO] Name Connection Terminated"
      if ((m = /\[INFO\] (.{1,60}?) : Connected\s*$/.exec(line))) {
        known[m[1]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /\[INFO\] (.{1,60}?) Connection Terminated\s*$/.exec(line))) {
        online.delete(m[1]);
        sync();
      }
      if (/\[INFO\] (Authenticated!|Resumed authenticated session!)/.test(line)) st.extra.serverList = 'Listed (key accepted)';
      if ((m = /Backend REFUSED the auth key\. Reason: (.*)$/.exec(line))) st.extra.serverList = `Key refused: ${m[1].trim().slice(0, 200)}`;
      if (/No AuthKey specified/.test(line)) st.extra.serverList = 'No AuthKey: add one in Settings';
    },
    state: () => structuredClone(st),
    knownPlayers: () => known,
  };
}

// ---------- module ----------

export const beammp: GameModule = {
  id: 'beammp',
  name: 'BeamMP (BeamNG.drive)',
  processName: isLinux ? LINUX_EXE : WIN_EXE,
  linux: 'native',

  fields: [
    {
      key: 'serverName',
      label: 'Server name',
      type: 'text',
      help: 'Shown in the BeamMP server list.',
      restart: true,
      section: 'BeamMP server',
      sectionHelp:
        'Players need BeamNG.drive and the free BeamMP launcher (beammp.com). Forward the port for both TCP and UDP. Other options are in ServerConfig.toml (Files tab).',
    },
    { key: 'description', label: 'Description', type: 'text', help: 'Shown under the name in the server list.', restart: true },
    {
      key: 'authKey',
      label: 'AuthKey',
      type: 'password',
      help: 'Required, even for a private server. Get one free at keymaster.beammp.com (sign in with Discord → Keys → New key) and paste it here.',
      restart: true,
    },
    { key: 'public', label: 'Show in the public BeamMP server list (off: players join with Direct Connect)', type: 'boolean', restart: true },
    { key: 'port', label: 'Port (TCP and UDP)', type: 'number', help: 'Default 30814. Forward it for both TCP and UDP in your router.', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', help: '1 to 100.', restart: true },
    { key: 'maxCars', label: 'Cars per player', type: 'number', help: 'How many vehicles each player may spawn at once (1 to 50).', restart: true },
    { key: 'map', label: 'Map', type: 'select', options: MAPS, restart: true },
    {
      key: 'customMap',
      label: 'Custom map path',
      type: 'text',
      help: 'Only for "Custom map": e.g. /levels/my_map/info.json. The map mod must be on the Mods tab. Its path is shown there.',
      restart: true,
    },
    { key: 'tags', label: 'Tags', type: 'text', help: 'Comma-separated, e.g. Freeroam,Racing.', restart: true },
    { key: 'allowGuests', label: 'Allow guests (players without a BeamMP account)', type: 'boolean', restart: true },
  ],
  quickFields: ['serverName', 'authKey', 'public', 'port', 'maxPlayers', 'map'],

  defaults: () => ({
    serverName: 'My BeamMP Server',
    description: 'A BeamMP server run by Server Forge',
    authKey: '',
    public: false,
    port: 30814,
    maxPlayers: 8,
    maxCars: 1,
    map: 'gridmap_v2',
    customMap: '',
    tags: 'Freeroam',
    allowGuests: true,
  }),

  validate(s: Settings): Settings {
    const map = String(s.map || 'gridmap_v2');
    if (!MAPS.some((m) => m.value === map)) throw new Error('Pick a map.');
    const customMap = text(s.customMap, 'Custom map path', 200);
    if (map === 'custom' && !/^\/levels\/[\w.\- ]+\/info\.json$/.test(customMap)) throw new Error('Custom map path must look like /levels/<map folder>/info.json.');
    const authKey = text(s.authKey, 'AuthKey', 100);
    if (authKey && !/^[\w-]+$/.test(authKey)) throw new Error('The AuthKey should only contain letters, numbers and dashes. Copy it again from keymaster.beammp.com.');
    return {
      serverName: text(s.serverName, 'Server name', 100, true),
      description: text(s.description, 'Description', 300),
      authKey,
      public: bool(s.public, false),
      port: num(s.port, 'Port', 1024, 65535),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 100),
      maxCars: num(s.maxCars, 'Cars per player', 1, 50),
      map,
      customMap,
      tags: text(s.tags, 'Tags', 200),
      allowGuests: bool(s.allowGuests, true),
    };
  },

  checkInstall(installDir) {
    if (!beammpExe(installDir)) throw new Error(`${isLinux ? LINUX_EXE : WIN_EXE} was not found in that folder.`);
  },

  /** Import: take the settings from the existing ServerConfig.toml. */
  detect(installDir) {
    const g = readGeneral(installDir);
    const out: Settings = {};
    if (g.Name) out.serverName = g.Name;
    if (g.Description) out.description = g.Description;
    if (g.AuthKey) out.authKey = g.AuthKey;
    if (g.Private) out.public = g.Private === 'false';
    if (g.Port && Number(g.Port)) out.port = Number(g.Port);
    if (g.MaxPlayers && Number(g.MaxPlayers)) out.maxPlayers = Number(g.MaxPlayers);
    if (g.MaxCars && Number(g.MaxCars)) out.maxCars = Number(g.MaxCars);
    if (g.Tags) out.tags = g.Tags;
    if (g.AllowGuests) out.allowGuests = g.AllowGuests === 'true';
    if (g.Map) {
      const level = /^\/levels\/([^/]+)\/info\.json$/.exec(g.Map)?.[1];
      if (level && MAPS.some((m) => m.value === level && level !== 'custom')) out.map = level;
      else {
        out.map = 'custom';
        out.customMap = g.Map;
      }
    }
    return out;
  },

  async prepare(record) {
    const s = record.settings;
    if (!String(s.authKey ?? '').trim())
      throw new Error('BeamMP needs an AuthKey to start, even for a private server. Get one free at keymaster.beammp.com (sign in with Discord → Keys), then paste it in Settings → AuthKey.');
    writeGeneral(record.installDir, {
      Name: String(s.serverName),
      Description: String(s.description ?? ''),
      AuthKey: String(s.authKey),
      Private: !s.public,
      Port: Number(s.port),
      MaxPlayers: Number(s.maxPlayers),
      MaxCars: Number(s.maxCars),
      Map: s.map === 'custom' ? String(s.customMap) : mapPath(String(s.map)),
      Tags: String(s.tags ?? ''),
      AllowGuests: s.allowGuests !== false,
      // The panel's player list and chat come from the log.
      LogChat: true,
    });
  },

  launch(record) {
    const exe = beammpExe(record.installDir);
    if (!exe) throw new Error('BeamMP-Server is missing. Use Settings → Update to download it again.');
    return { exe, args: [], cwd: record.installDir };
  },

  commands: { stop: 'exit' },
  playerCommands: { kick: (name, reason) => `kick ${name}${reason ? ` ${reason}` : ''}` },
  announceCommand: (t) => `say ${t}`,
  // BeamMP prints its built-in default name before reading the config ("Server name set in new impl: BeamMP Server"),
  // which looks like the name setting was ignored.
  hideLine: (line) => clean(line).trim() === '' || /Server name set in new impl:/.test(line),

  createParser: createBeammpParser,

  connection: (record) => ({ port: Number(record.settings.port) || 30814, protocol: 'TCP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  // No world: the config and the mods/plugins are what matter.
  backup: {
    sources: (record) => {
      const res = path.relative(record.installDir, resourcesDir(record)) || 'Resources';
      return { base: record.installDir, include: [BEAMMP_CONFIG, res].filter((p) => existsSync(path.join(record.installDir, p))), world: null };
    },
  },

  addons: beammpMods,

  async install(record, job) {
    job.update('Looking up the latest BeamMP-Server release...', null);
    const version = await latestBeammp();
    const asset = isLinux ? linuxAsset() : WIN_EXE;
    const target = path.join(record.installDir, isLinux ? LINUX_EXE : WIN_EXE);
    const temp = `${target}.download`;
    job.update(`Downloading BeamMP-Server ${version}...`, 0);
    await downloadFile(`https://github.com/BeamMP/BeamMP-Server/releases/download/v${version}/${asset}`, temp, (pct) => job.update(`Downloading BeamMP-Server ${version}...`, pct));
    if (statSync(temp).size < 1024 * 1024) {
      rmSync(temp, { force: true });
      throw new Error('The BeamMP-Server download was incomplete. Try again.');
    }
    if (isLinux) chmodSync(temp, 0o755);
    renameSync(temp, target);
    writeFileSync(path.join(record.installDir, VERSION_NOTE), JSON.stringify({ version, asset, at: Date.now() }, null, 2));
    job.line(`BeamMP-Server ${version} is installed (${asset}).`);
    if (!String(record.settings.authKey ?? '').trim()) job.line('Before starting: add your AuthKey from keymaster.beammp.com in Settings.');
  },
};
