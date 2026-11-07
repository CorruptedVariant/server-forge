import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { linuxDoorstopEnv } from '../valheim-mods.ts';
import { bin, exampleFolder, isLinux } from '../platform/host.ts';
import path from 'node:path';
import type { GameModule, LogParser, LogState, Player, ServerRecord, Settings } from './types.ts';
import { readWorldInfo } from './valheim-world.ts';
import { steamAppUpdate } from '../steamcmd.ts';
import { valheimAddons } from './valheim-addons.ts';
import * as vm from '../valheim-mods.ts';

const EXE = bin('valheim_server.exe', 'valheim_server.x86_64');
const STEAM_APP_ID = '892970'; // Valheim (the game), which the dedicated server expects in its environment
const VALHEIM_SERVER_APP_ID = 896660; // "Valheim Dedicated Server" on Steam, installable anonymously via SteamCMD

const LIST_FILES: Record<string, string> = {
  admins: 'adminlist.txt',
  banned: 'bannedlist.txt',
  permitted: 'permittedlist.txt',
};

// ---------- Log parsing ----------

// Every line starts "09/22/2026 17:26:29: <message>"
const TIME_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}): (.*)$/;
const P = {
  // Only after the world has loaded. ("Loading: Done" also appears earlier, for the start-up scene.)
  ready: /^Opened Steam server|^Opened PlayFab server|registered with join code|^Game server connected$/,
  stop: /^OnApplicationQuit|^Net scene destroyed/,
  // The running server briefly lost Steam ("Game server disconnected"), then "Game server connected" once it's back.
  // The world and its players carry on, so only new joins are affected: not ready, but nothing else is reset.
  steamLost: /^Game server disconnected/,
  version: /^Valheim version: (\S+)/,
  saved: /^World save \(5\/5\) done/,
  history: /^Player history entry with index \d+:\s+(.+?) \(([^,]+), [^)]*\)$/,
  // Crossplay (PlayFab) sessions report the count on join/leave and periodically.
  count: /server "(.*)" that has join code (\d*), now (\d+) player\(s\)/,
  active: /^Session "(.*)" with join code (\d*) and IP (\S+) is active with (\d+) player\(s\)/,
  registered: /^Session ".*" registered with join code (\d+)/,
  // A connecting client: Steam ("Got connection SteamID 7656...") or crossplay ("Got handshake from client playfab/ABC").
  steamConnect: /^Got connection SteamID (\d+)/,
  handshake: /^Got handshake from client (\S+)/,
  playfabPlatform: /^PlayFab socket with remote ID (\S+) received local Platform ID (\S+)/,
  character: /^Got character ZDOID from (.+?) : (-?\d+):(-?\d+)/,
  closing: /^Closing socket (\S+)/,
  // "Destroying abandoned non persistent zdo -132569154:1 owner -132569154": the player with that session id left.
  // (On crossplay, the session count keeps saying 1 for a while in case they reconnect, so it can't be trusted here.)
  left: /^Destroying abandoned non persistent zdo -?\d+:\d+ owner (-?\d+)/,
  // Periodic "Connections 0 ZDOS:..." line: the real number of connected players.
  connections: /^\s*Connections (\d+) ZDOS:/,
};

function createValheimParser(): LogParser {
  let ready = false;
  let version: string | null = null;
  let lastSave: number | null = null;
  let count: number | null = null;
  let joinCode: string | null = null;
  let publicAddress: string | null = null;
  // peer id (steam id or playfab/...) -> who it is
  let peers = new Map<string, { platformId: string | null; name: string | null; joinedAt: number | null; uid?: string }>();
  let lastPeer: string | null = null;
  const known: Record<string, string> = {};

  const reset = () => {
    ready = false;
    count = null;
    joinCode = null;
    peers = new Map();
    lastPeer = null;
  };

  const addPeer = (id: string, platformId: string | null) => {
    const existing = peers.get(id);
    peers.set(id, { platformId: platformId ?? existing?.platformId ?? null, name: existing?.name ?? null, joinedAt: existing?.joinedAt ?? null });
    lastPeer = id;
  };

  return {
    feed(line) {
      const m = TIME_RE.exec(line);
      if (!m) return;
      const [, mo, d, y, h, mi, s, msg] = m;
      const ts = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`).getTime();
      let x: RegExpExecArray | null;

      if (msg.startsWith('ZNet.LoadWorld:')) reset();
      else if (P.stop.test(msg)) reset();
      else if (P.steamLost.test(msg)) ready = false;
      else if (P.ready.test(msg)) ready = true;

      if ((x = P.version.exec(msg))) version = x[1];
      else if (P.saved.test(msg)) lastSave = ts;
      else if ((x = P.history.exec(msg))) known[x[2]] = x[1];
      else if ((x = P.active.exec(msg))) {
        joinCode = x[2] || joinCode;
        publicAddress = x[3];
        count = Number(x[4]);
      } else if ((x = P.count.exec(msg))) {
        joinCode = x[2] || joinCode;
        count = Number(x[3]);
      } else if ((x = P.registered.exec(msg))) joinCode = x[1];
      else if ((x = P.steamConnect.exec(msg))) addPeer(x[1], `Steam_${x[1]}`);
      else if ((x = P.playfabPlatform.exec(msg))) addPeer(x[1], x[2]);
      else if ((x = P.handshake.exec(msg))) addPeer(x[1], null);
      else if ((x = P.character.exec(msg))) {
        // Non-zero id = the character spawned in (0:0 is sent on death/logout). Attach it to the newest unnamed peer.
        if (x[2] !== '0' || x[3] !== '0') {
          const name = x[1];
          const already = [...peers.values()].some((p) => p.name === name);
          const target = lastPeer && !peers.get(lastPeer)?.name ? lastPeer : [...peers.keys()].reverse().find((k) => !peers.get(k)?.name);
          if (!already) {
            const id = target ?? `unknown:${name}`;
            const p = peers.get(id);
            peers.set(id, { platformId: p?.platformId ?? null, name, joinedAt: ts, uid: x[2] });
            if (p?.platformId) known[p.platformId] = name;
          } else {
            // Respawn/reconnect: keep the player, but remember the current session id.
            for (const p of peers.values()) if (p.name === name) p.uid = x[2];
          }
        }
      } else if ((x = P.left.exec(msg))) {
        for (const [id, p] of peers) if (p.uid === x[1]) peers.delete(id);
      } else if ((x = P.connections.exec(msg))) {
        if (Number(x[1]) === 0) peers = new Map();
      } else if ((x = P.closing.exec(msg))) {
        peers.delete(x[1]);
        if (lastPeer === x[1]) lastPeer = null;
      }
    },

    state(): LogState {
      const players: Player[] = [...peers.values()]
        .filter((p) => p.name)
        .map((p) => ({ name: p.name as string, joinedAt: p.joinedAt, platformId: p.platformId }));
      return {
        ready,
        players,
        // Tracked players are reliable (join and leave lines); the session count lags behind on leaves.
        playerCount: players.length,
        version,
        lastSave,
        extra: { joinCode, publicAddress },
      };
    },

    knownPlayers: () => ({ ...known }),
  };
}

// ---------- Settings ----------

function num(value: unknown, label: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function saveDir(record: ServerRecord): string {
  return String(record.settings.saveDir);
}

function listPath(record: ServerRecord, list: string): string {
  const file = LIST_FILES[list];
  if (!file) throw new Error('Unknown list.');
  return path.join(saveDir(record), file);
}

/** Valheim's world presets (the "World modifiers" presets), passed as -preset when the server starts. */
export const VALHEIM_PRESETS = [
  { value: 'keep', label: "Keep the world's own settings", help: 'Starts without a preset: the world keeps whatever difficulty it already has (normal for a new world).' },
  { value: 'casual', label: 'Casual', help: 'The most relaxed preset: very easy combat and a light death penalty.' },
  { value: 'easy', label: 'Easy', help: 'Easier combat than normal.' },
  { value: 'normal', label: 'Normal', help: 'The standard game. Pick this to undo another preset.' },
  { value: 'hard', label: 'Hard', help: 'Tougher combat than normal.' },
  { value: 'hardcore', label: 'Hardcore', help: 'The hardest preset: very hard combat and a harsh death penalty.' },
  { value: 'immersive', label: 'Immersive', help: 'Fewer conveniences (no map) for a more immersive game.' },
  { value: 'hammer', label: 'Hammer mode', help: 'Building costs nothing (for creative building).' },
];

/**
 * Valheim's individual world modifiers (-modifier <name> <level>), applied on top of the preset. "" = leave it to the
 * preset / the world's own setting.
 */
const MODIFIERS: { key: string; name: string; label: string; help: string; levels: [string, string][] }[] = [
  // "normal" is listed too: with a preset like Hardcore, "-modifier deathpenalty normal" puts just that one back.
  { key: 'modCombat', name: 'combat', label: 'Combat', help: 'How hard enemies hit and how much health they have.', levels: [['veryeasy', 'Very easy'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['veryhard', 'Very hard']] },
  { key: 'modDeathPenalty', name: 'deathpenalty', label: 'Death penalty', help: 'What players lose when they die.', levels: [['casual', 'Casual'], ['veryeasy', 'Very easy'], ['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['hardcore', 'Hardcore']] },
  { key: 'modResources', name: 'resources', label: 'Resources', help: 'How much you get from mining, chopping and drops.', levels: [['muchless', 'Much less'], ['less', 'Less'], ['normal', 'Normal'], ['more', 'More'], ['muchmore', 'Much more'], ['most', 'Most']] },
  { key: 'modRaids', name: 'raids', label: 'Raids', help: 'How often enemies raid your bases.', levels: [['none', 'None'], ['muchless', 'Much less'], ['less', 'Less'], ['normal', 'Normal'], ['more', 'More'], ['muchmore', 'Much more']] },
  { key: 'modPortals', name: 'portals', label: 'Portals', help: 'What can go through portals.', levels: [['casual', 'Casual (everything)'], ['normal', 'Normal (no metals)'], ['hard', 'Hard (no boss portals)'], ['veryhard', 'Very hard (no portals)']] },
];
/** One "Other world keys" entry: a key, optionally with a number ("nocraftcost", "skillgainrate 200"). */
const EXTRA_KEY = /^[A-Za-z][A-Za-z0-9_]{1,40}( -?\d{1,6}(\.\d{1,3})?)?$/;
function extraKeys(text: string): string[] {
  return String(text ?? '')
    .split(/[,\r\n]+/)
    .map((k) => k.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}
/** World keys (-setkey <key>): switches that change how the world plays. */
const WORLD_KEYS: { key: string; name: string; label: string; help: string }[] = [
  { key: 'keyNoBuildCost', name: 'nobuildcost', label: 'No build cost', help: 'Building is free.' },
  { key: 'keyPlayerEvents', name: 'playerevents', label: 'Raids based on player progress', help: 'Raids depend on each player’s progress instead of the world’s.' },
  { key: 'keyPassiveMobs', name: 'passivemobs', label: 'Passive enemies', help: 'Enemies don’t attack unless provoked.' },
  { key: 'keyNoMap', name: 'nomap', label: 'No map', help: 'Players can’t use the map or minimap.' },
];
/** Arguments Server Forge sets itself (extra arguments can't change them, so settings stay the truth). */
const MANAGED_ARGS = ['-name', '-port', '-world', '-public', '-savedir', '-saveinterval', '-backups', '-backupshort', '-backuplong', '-logfile', '-password', '-crossplay', '-preset', '-modifier', '-setkey', '-instanceid', '-nographics', '-batchmode'];

/** Splits "-a b "c d"" into ["-a", "b", "c d"]. */
function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

export const valheim: GameModule = {
  id: 'valheim',
  name: 'Valheim',
  processName: EXE,

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the in-game server list.', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Game port. Valheim also uses the next port up (port + 1).', restart: true },
    { key: 'world', label: 'World name', type: 'text', help: 'Created automatically if it does not exist.', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'At least 5 characters, and not part of the server name. Required for public servers.', restart: true },
    { key: 'public', label: 'List publicly', type: 'boolean', help: 'Show in the community server list.', restart: true },
    { key: 'crossplay', label: 'Crossplay', type: 'boolean', help: 'Allow Xbox, PlayStation and Game Pass players (uses a join code).', restart: true },
    { key: 'saveInterval', label: 'Save every (minutes)', type: 'number', restart: true },
    { key: 'backups', label: 'Backups to keep', type: 'number', help: 'Valheim\'s own automatic world backups.', restart: true },
    { key: 'backupShort', label: 'First backup after (minutes)', type: 'number', restart: true },
    { key: 'backupLong', label: 'Then back up every (minutes)', type: 'number', restart: true },
    { key: 'saveDir', label: 'Save folder', type: 'folder', help: 'Worlds, backups and the admin/ban/allow lists live here.', restart: true },
    ...MODIFIERS.map((m, i) => ({
      key: m.key,
      label: m.label,
      type: 'select' as const,
      help: m.help,
      options: [{ value: '', label: 'Default (what the preset gives)' }, ...m.levels.map(([value, label]) => ({ value, label }))],
      restart: true,
      section: 'World modifiers',
      ...(i === 0
        ? {
            sectionHelp:
              'Like a .bat file: start from any difficulty preset (Settings → Difficulty), then change any of these on top of it. "Default" keeps what the preset gives. Applied each time the server starts.',
          }
        : {}),
    })),
    ...WORLD_KEYS.map((k) => ({ key: k.key, label: k.label, type: 'boolean' as const, help: k.help, restart: true, section: 'World modifiers' })),
    {
      key: 'extraKeys',
      label: 'Other world keys (-setkey)',
      type: 'text',
      help: 'Any other world key, separated by commas, each with a number if it takes one. Example: nocraftcost, skillgainrate 200. Each one is passed as -setkey, exactly like in a .bat file.',
      restart: true,
      section: 'World modifiers',
    },
    { key: 'instanceId', label: 'Instance ID', type: 'text', help: 'Only needed when several servers run from the same install folder: give each a different ID (letters and numbers).', restart: true, section: 'Advanced' },
    { key: 'extraArgs', label: 'Extra launch arguments', type: 'text', help: 'Anything else to add to the server’s command line (e.g. for mods). Settings above always win over the same argument here.', restart: true, section: 'Advanced' },
  ],

  defaults: ({ installDir }) => ({
    serverName: 'My Valheim Server',
    port: 2456,
    world: 'Dedicated',
    password: '',
    public: false,
    crossplay: false,
    saveInterval: 30,
    backups: 4,
    backupShort: 120,
    backupLong: 720,
    saveDir: path.join(installDir, 'saves'),
  }),

  validate(s: Settings): Settings {
    const serverName = String(s.serverName ?? '').trim();
    const world = String(s.world ?? '').trim();
    const password = String(s.password ?? '');
    const isPublic = s.public === true || s.public === 'true';
    const dir = String(s.saveDir ?? '').trim();

    if (!serverName || serverName.length > 64) throw new Error('Server name is required (up to 64 characters).');
    if (!/^[\w -]{1,60}$/.test(world)) throw new Error('World name can only use letters, numbers, spaces, - and _.');
    if (password && password.length < 5) throw new Error('Password must be at least 5 characters.');
    if (password && serverName.toLowerCase().includes(password.toLowerCase())) throw new Error('Password cannot be part of the server name.');
    if (isPublic && !password) throw new Error('Public servers need a password.');
    if (!path.isAbsolute(dir)) throw new Error(`Save folder must be a full path, e.g. ${exampleFolder('valheim', 'saves')}`);
    const modifiers: Settings = {};
    for (const m of MODIFIERS) {
      const v = String(s[m.key] ?? '');
      if (v && !m.levels.some(([level]) => level === v)) throw new Error(`World modifier ${m.label}: unknown level "${v}".`);
      if (v) modifiers[m.key] = v;
    }
    const keys: Settings = {};
    for (const k of WORLD_KEYS) if (s[k.key] === true || s[k.key] === 'true') keys[k.key] = true;
    const keyList = extraKeys(String(s.extraKeys ?? ''));
    if (keyList.length > 30) throw new Error('Other world keys: at most 30.');
    const badKey = keyList.find((k) => !EXTRA_KEY.test(k));
    if (badKey) throw new Error(`Other world keys: "${badKey}" isn't a world key. Use a name, optionally with a number, e.g. skillgainrate 200.`);
    const instanceId = String(s.instanceId ?? '').trim();
    if (instanceId && !/^[\w-]{1,32}$/.test(instanceId)) throw new Error('Instance ID can only use letters, numbers, - and _ (up to 32).');
    const extraArgs = String(s.extraArgs ?? '').trim();
    if (extraArgs.length > 500 || /[\r\n]/.test(extraArgs)) throw new Error('Extra launch arguments must be one line (up to 500 characters).');
    const clash = splitArgs(extraArgs).find((a) => MANAGED_ARGS.includes(a.toLowerCase()));
    if (clash) throw new Error(`Extra launch arguments: ${clash} is set by Server Forge. Use the setting for it instead.`);

    return {
      serverName,
      port: num(s.port, 'Port', 1024, 65534),
      world,
      password,
      public: isPublic,
      crossplay: s.crossplay === true || s.crossplay === 'true',
      saveInterval: num(s.saveInterval, 'Save interval', 1, 1440),
      backups: num(s.backups, 'Backups to keep', 0, 100),
      backupShort: num(s.backupShort, 'First backup', 1, 10080),
      backupLong: num(s.backupLong, 'Backup interval', 1, 10080),
      saveDir: dir,
      // World difficulty preset (Settings → Difficulty); "keep" = start without one, so the world keeps its own.
      ...(VALHEIM_PRESETS.some((p) => p.value === s.preset) && s.preset !== 'keep' ? { preset: String(s.preset) } : {}),
      ...modifiers,
      ...keys,
      ...(keyList.length ? { extraKeys: keyList.join(', ') } : {}),
      ...(instanceId ? { instanceId } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      // Only used once, by install() for a brand-new server.
      ...(s.startModded === true || s.startModded === 'true' ? { startModded: true } : {}),
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  launch(record, logFile) {
    const s = record.settings;
    const args = [
      '-nographics', '-batchmode',
      '-name', String(s.serverName),
      '-port', String(s.port),
      '-world', String(s.world),
      '-public', s.public ? '1' : '0',
      '-savedir', saveDir(record),
      '-saveinterval', String(Number(s.saveInterval) * 60),
      '-backups', String(s.backups),
      '-backupshort', String(Number(s.backupShort) * 60),
      '-backuplong', String(Number(s.backupLong) * 60),
      '-logFile', logFile,
    ];
    if (s.password) args.push('-password', String(s.password));
    if (s.crossplay) args.push('-crossplay');
    if (s.preset) args.push('-preset', String(s.preset));
    for (const m of MODIFIERS) if (s[m.key]) args.push('-modifier', m.name, String(s[m.key]));
    for (const k of WORLD_KEYS) if (s[k.key] === true) args.push('-setkey', k.name);
    for (const k of extraKeys(String(s.extraKeys ?? ''))) args.push('-setkey', k.toLowerCase());
    if (s.instanceId) args.push('-instanceid', String(s.instanceId));
    if (s.extraArgs) args.push(...splitArgs(String(s.extraArgs)));
    mkdirSync(saveDir(record), { recursive: true });
    // On Linux there's no winhttp.dll to load BepInEx: Doorstop comes in through the environment, as in its start_server_bepinex.sh.
    const env = isLinux ? { SteamAppId: STEAM_APP_ID, LD_LIBRARY_PATH: './linux64', ...linuxDoorstopEnv(record.installDir) } : { SteamAppId: STEAM_APP_ID };
    return { exe: path.join(record.installDir, EXE), args, cwd: record.installDir, env };
  },

  createParser: createValheimParser,

  quickFields: ['serverName', 'port', 'world', 'password', 'public', 'crossplay'],

  // New servers: the quick fields plus "start modded" (BepInEx right after the download). Vanilla is the default.
  get newFields() {
    const pick = (k: string) => this.fields.find((f: { key: string }) => f.key === k)!;
    return [
      ...['serverName', 'port', 'world', 'password', 'public', 'crossplay'].map(pick),
      {
        key: 'startModded',
        label: 'Modded server',
        type: 'boolean' as const,
        help: 'Installs the BepInEx mod loader so you can add mods from the Mods tab. Leave off for a vanilla server (you can turn modding on later; it can\'t be turned off).',
      },
    ];
  },

  async install(record, job) {
    await steamAppUpdate(VALHEIM_SERVER_APP_ID, record.installDir, job);
    if (!existsSync(path.join(record.installDir, EXE))) throw new Error(`Install finished but ${EXE} is missing.`);
    job.line('Valheim dedicated server is installed.');
    if (record.settings.startModded === true) {
      job.update('Turning on modding (installing BepInEx)…', null);
      if (!vm.bepinexStatus(record.installDir).installed) await vm.installWithDependencies(record.installDir, { ...vm.BEPINEX_PACK }, (l) => job.line(l));
      job.line('Modding is on: add mods from the Mods tab.');
    }
    delete record.settings.startModded;
  },

  async details(record) {
    try {
      const info = await readWorldInfo(path.join(saveDir(record), 'worlds_local'), String(record.settings.world));
      return { world: info ? { savedAt: info.savedAt, bosses: info.bosses } : null };
    } catch (err) {
      return { world: null, worldError: (err as Error).message };
    }
  },

  // Valheim has no "pause saving" command; a running copy is taken as-is (it saves every few minutes, and the
  // 1.0 format marks complete saves). Valheim's own -backups also keep rolling copies.
  backup: {
    sources(record) {
      const world = String(record.settings.world);
      return {
        base: saveDir(record),
        include: [`worlds_local/${world}`, `worlds_local/${world}.db`, `worlds_local/${world}.fwl`, 'adminlist.txt', 'bannedlist.txt', 'permittedlist.txt'],
        world,
      };
    },
  },

  addons: valheimAddons,

  // Valheim uses UDP on the port and the next one up; the game's limit is 10 players.
  connection: (record) => ({ port: Number(record.settings.port) || 2456, protocol: 'UDP', maxPlayers: 10 }),

  accessLists: [
    { id: 'admins', label: 'Admins', help: 'Can use admin console commands in-game (F5).' },
    { id: 'banned', label: 'Banned', help: 'Cannot join.' },
    { id: 'permitted', label: 'Allow list', help: 'If anyone is listed here, only listed players can join.' },
  ],

  readAccessList(record, list) {
    const file = listPath(record, list);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'));
  },

  writeAccessList(record, list, entries) {
    const file = listPath(record, list);
    const header = existsSync(file)
      ? readFileSync(file, 'utf-8').split(/\r?\n/).filter((l) => l.trim().startsWith('//'))
      : [`// List ${list} players ID  ONE per line`];
    const clean = [...new Set(entries.map((e) => e.trim()).filter((e) => e && /^[\w.:-]{3,64}$/.test(e)))];
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, [...header, ...clean].join('\r\n') + '\r\n');
  },
};
