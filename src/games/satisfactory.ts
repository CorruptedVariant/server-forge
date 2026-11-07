// Satisfactory dedicated server. Installed and updated with SteamCMD (app 1690800, anonymous). Satisfactory has its own
// server tools (the in-game Server Manager and an HTTPS API), so Server Forge uses the API instead of duplicating it:
// stopping (save, then shut down), live state for the overview, console commands, and applying the few settings kept
// here. Saves stay where the game keeps them (%LOCALAPPDATA%\FactoryGame\Saved\SaveGames\server), and mods are left to
// Satisfactory Mod Manager (SMM), which can manage a server folder and players' games; the Mods tab lists what's
// installed and how to point SMM at this server.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isLinux } from '../platform/host.ts';
import path from 'node:path';
import os from 'node:os';
import { steamAppUpdate } from '../steamcmd.ts';
import { sfApi, serverState, claimServer } from './satisfactory-api.ts';
import type { GameModule, LogParser, LogState, ServerRecord, Settings, AddonSupport } from './types.ts';

export const SATISFACTORY_APP = 1690800;
const EXE = isLinux ? path.join('Engine', 'Binaries', 'Linux', 'FactoryServer-Linux-Shipping') : 'FactoryServer.exe';

const STARTS = [
  { value: 'Grass Fields', label: 'Grass Fields (easiest)' },
  { value: 'Rocky Desert', label: 'Rocky Desert' },
  { value: 'Northern Forest', label: 'Northern Forest' },
  { value: 'Dune Desert', label: 'Dune Desert (hardest)' },
];
const NETWORK_QUALITY = [
  { value: '0', label: 'Low' },
  { value: '1', label: 'Medium' },
  { value: '2', label: 'High' },
  { value: '3', label: 'Ultra' },
];

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

/** Where the dedicated server keeps its saves (per Windows account: the one Server Forge runs as). */
export const saveFolder = () => isLinux ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Epic', 'FactoryGame', 'Saved', 'SaveGames', 'server') : path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'FactoryGame', 'Saved', 'SaveGames', 'server');
const logFile = (record: ServerRecord) => path.join(record.installDir, 'FactoryGame', 'Saved', 'Logs', 'FactoryGame.log');
const port = (record: ServerRecord) => Number(record.settings.port) || 7777;

function createSatisfactoryParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  return {
    feed(line) {
      let m: RegExpExecArray | null;
      // Unreal logs "[2026.10.05-15.30.00:123][  0]LogXxx: message".
      if (/listening on port \d+|bound to port \d+|Took [\d.]+ seconds to LoadMap/i.test(line)) st.ready = true;
      if ((m = /Net CL: (\d+)/.exec(line)) && !st.version) st.version = `build ${m[1]}`;
      else if ((m = /LogInit: Build: (\S+)/.exec(line)) && !st.version) st.version = m[1];
      if (/Saving game|SaveGame.*(succeeded|saved)/i.test(line)) st.lastSave = Date.now();
      if ((m = /Join succeeded: (.{1,40})$/.exec(line))) {
        const name = m[1].trim();
        known[name] = name;
        if (!st.players.some((p) => p.name === name)) st.players.push({ name, joinedAt: Date.now() } as never);
        st.playerCount = st.players.length;
      }
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

// ---------- mods: listed (from the .uplugin files), managed with Satisfactory Mod Manager ----------

interface InstalledMod {
  id: string;
  name: string;
  version: string;
  author: string;
  enabled: boolean;
  description: string;
  type: string;
  typeLabel: string;
  typeClass: string;
  source: string;
  url: string;
}

export function serverMods(installDir: string): InstalledMod[] {
  const dir = path.join(installDir, 'FactoryGame', 'Mods');
  if (!existsSync(dir)) return [];
  const out: InstalledMod[] = [];
  for (const ref of readdirSync(dir)) {
    const plugin = path.join(dir, ref, `${ref}.uplugin`);
    if (!existsSync(plugin)) continue;
    try {
      const u = JSON.parse(readFileSync(plugin, 'utf-8').replace(/^﻿/, ''));
      out.push({
        id: ref,
        name: String(u.FriendlyName || ref),
        version: String(u.SemVersion || u.VersionName || ''),
        author: String(u.CreatedBy || ''),
        enabled: true,
        description: String(u.Description || ''),
        type: ref === 'SML' ? 'loader' : 'mod',
        typeLabel: ref === 'SML' ? 'Mod loader' : 'Mod',
        typeClass: ref === 'SML' ? 'resource' : 'behavior',
        source: 'Satisfactory Mod Manager',
        url: `https://ficsit.app/mod/${encodeURIComponent(ref)}`,
      });
    } catch {}
  }
  return out.sort((a, b) => (a.id === 'SML' ? -1 : b.id === 'SML' ? 1 : a.name.localeCompare(b.name)));
}

const satisfactoryAddons: AddonSupport = {
  accept: '',
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp: 'Satisfactory mods are managed with <b>Satisfactory Mod Manager</b> (SMM): it installs them on this server and on players’ games, with the right versions and dependencies. See the steps above.',
  }),
  links: [
    { label: 'ficsit.app', url: 'https://ficsit.app/mods', help: 'The Satisfactory mod repository. "Install" opens the mod in Satisfactory Mod Manager.' },
    { label: 'Satisfactory Mod Manager', url: 'https://smm.ficsit.app/', help: 'Manages mods on this server (Manage Servers → this server folder) and on players’ games.' },
  ],
  status: (record) => ({
    ok: true,
    title: 'Mods are managed with Satisfactory Mod Manager',
    text: `In SMM, open Manage Servers and add this server folder as a local path: ${record.installDir}. Stop the server while SMM changes mods. Players install the same mods with SMM (the list below links each one).`,
  }),
  list: (record) => serverMods(record.installDir),
  async install() {
    throw new Error('Satisfactory mods are installed with Satisfactory Mod Manager (Manage Servers → this server folder).');
  },
  remove() {
    throw new Error('Remove Satisfactory mods with Satisfactory Mod Manager, so their dependencies stay right.');
  },
  setEnabled() {
    throw new Error('Switch Satisfactory mods on or off in Satisfactory Mod Manager.');
  },
  icon: () => null,
  readOnly: true,
} as AddonSupport;

export const satisfactory: GameModule = {
  id: 'satisfactory',
  name: 'Satisfactory',
  processName: path.basename(EXE),

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the in-game Server Manager.', restart: false },
    { key: 'port', label: 'Game port', type: 'number', help: 'Default 7777 (TCP and UDP; the HTTPS API uses it too).', restart: true },
    { key: 'reliablePort', label: 'Reliable messaging port', type: 'number', help: 'Default 8888 (TCP).', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', help: 'Default 4.', restart: true },
    { key: 'adminPassword', label: 'Admin password', type: 'password', help: 'Used to claim a new server (first start). Afterwards change it in the in-game Server Manager.', restart: false },
    { key: 'clientPassword', label: 'Player password', type: 'password', help: 'Optional. Applied while the server runs.', restart: false },
    { key: 'startingLocation', label: 'Starting location (new game)', type: 'select', options: STARTS, help: 'Used once, when the server has no game yet.', restart: false },
    { key: 'sessionName', label: 'Session name (new game)', type: 'text', restart: false },
    { key: 'autoPause', label: 'Pause when nobody is online', type: 'boolean', restart: false },
    { key: 'autoSaveOnDisconnect', label: 'Save when a player leaves', type: 'boolean', restart: false },
    { key: 'autosaveMinutes', label: 'Autosave every (minutes)', type: 'number', restart: false },
    { key: 'networkQuality', label: 'Network quality', type: 'select', options: NETWORK_QUALITY, restart: false },
  ],
  quickFields: ['serverName', 'port', 'adminPassword', 'clientPassword', 'startingLocation', 'maxPlayers'],

  defaults: () => ({
    serverName: 'My Satisfactory Server',
    port: 7777,
    reliablePort: 8888,
    maxPlayers: 4,
    adminPassword: '',
    clientPassword: '',
    startingLocation: 'Grass Fields',
    sessionName: 'Tavern Factory',
    autoPause: true,
    autoSaveOnDisconnect: true,
    autosaveMinutes: 5,
    networkQuality: '3',
  }),

  validate(s: Settings): Settings {
    const serverName = String(s.serverName ?? '').trim();
    if (!serverName || serverName.length > 60) throw new Error('Server name is required (up to 60 characters).');
    const adminPassword = String(s.adminPassword ?? '');
    const clientPassword = String(s.clientPassword ?? '');
    if (/[\r\n]/.test(adminPassword + clientPassword)) throw new Error('Passwords must be one line.');
    const start = String(s.startingLocation ?? 'Grass Fields');
    if (!STARTS.some((o) => o.value === start)) throw new Error('Pick a starting location.');
    const sessionName = String(s.sessionName ?? '').trim() || 'Tavern Factory';
    if (!/^[\w -]{1,40}$/.test(sessionName)) throw new Error('Session name can only use letters, numbers, spaces, - and _ (up to 40).');
    const quality = String(s.networkQuality ?? '3');
    if (!NETWORK_QUALITY.some((o) => o.value === quality)) throw new Error('Pick a network quality.');
    return {
      serverName,
      port: num(s.port, 'Game port', 1024, 65535),
      reliablePort: num(s.reliablePort, 'Reliable messaging port', 1024, 65535),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 127),
      adminPassword,
      clientPassword,
      startingLocation: start,
      sessionName,
      autoPause: s.autoPause === true || s.autoPause === 'true',
      autoSaveOnDisconnect: s.autoSaveOnDisconnect === true || s.autoSaveOnDisconnect === 'true',
      autosaveMinutes: num(s.autosaveMinutes, 'Autosave interval', 1, 120),
      networkQuality: quality,
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  launch(record) {
    const s = record.settings;
    return {
      exe: path.join(record.installDir, EXE),
      args: [
        ...(isLinux ? ['FactoryGame'] : []), // FactoryServer.sh passes the project name first on Linux
        '-log',
        '-unattended',
        `-Port=${s.port}`,
        `-ReliablePort=${s.reliablePort}`,
        // Lets Server Forge (on this system) use the server's API without a token: clean stops, live state, commands.
        '-ini:Engine:[SystemSettings]:FG.DedicatedServer.AllowInsecureLocalAccess=1',
        `-ini:Game:[/Script/Engine.GameSession]:MaxPlayers=${s.maxPlayers}`,
      ],
      cwd: record.installDir,
    };
  },

  gameLog: logFile,

  /** Ready: claim a new server, create its first game, and apply the settings kept in Server Forge. */
  async onReady(record, note) {
    const p = port(record);
    const s = record.settings;
    try {
      const state = await serverState(p);
      // A brand-new server is "unclaimed": claim it with the admin password from Settings.
      if (s.adminPassword) {
        try {
          await claimServer(p, String(s.serverName), String(s.adminPassword));
          note('Claimed the server with the admin password from Settings (change it later in the in-game Server Manager).');
        } catch {}
      }
      if (!state.isGameRunning) {
        const sessions = await sfApi<{ sessions: unknown[] }>(p, 'EnumerateSessions').catch(() => ({ sessions: [] }));
        if (!sessions.sessions?.length) {
          await sfApi(p, 'CreateNewGame', { NewGameData: { SessionName: s.sessionName, MapName: '', StartingLocation: s.startingLocation, SkipOnboarding: false, bSkipOnboarding: false } }, 60_000);
          note(`Created a new game "${s.sessionName}" at ${s.startingLocation}.`);
        }
      }
      await sfApi(p, 'RenameServer', { ServerName: s.serverName }).catch(() => {});
      await sfApi(p, 'SetClientPassword', { Password: s.clientPassword ?? '' }).catch(() => {});
      await sfApi(p, 'ApplyServerOptions', {
        UpdatedServerOptions: {
          'FG.DSAutoPause': s.autoPause ? 'True' : 'False',
          'FG.DSAutoSaveOnDisconnect': s.autoSaveOnDisconnect ? 'True' : 'False',
          'FG.AutosaveInterval': String(Number(s.autosaveMinutes) * 60),
          'FG.NetworkQuality': String(s.networkQuality),
        },
      }).catch((err) => note(`Couldn't apply the server options: ${err.message}`));
    } catch (err) {
      note(`Couldn't reach the server's API: ${(err as Error).message}`);
    }
  },

  /** Stop: save the session, then ask the server to shut down. */
  async gracefulStop(record, note) {
    const p = port(record);
    try {
      const state = await serverState(p);
      if (state.isGameRunning && state.activeSessionName) {
        await sfApi(p, 'SaveGame', { SaveName: `${state.activeSessionName}_tavernhost` }, 60_000);
        note(`Saved "${state.activeSessionName}" (as ${state.activeSessionName}_tavernhost).`);
      }
      await sfApi(p, 'Shutdown');
      return true;
    } catch (err) {
      note(`The server's API didn't answer (${(err as Error).message}); trying Ctrl+C.`);
      return false;
    }
  },

  /** Console box: the server's console commands, through its API. */
  async runCommand(record, command) {
    const r = await sfApi<{ commandResult?: string; returnValue?: boolean }>(port(record), 'RunCommand', { Command: command }, 15_000);
    return r.commandResult || (r.returnValue === false ? 'The server did not accept that command.' : '');
  },

  async details(record) {
    try {
      const st = await serverState(port(record));
      return {
        facts: [
          ['Session', st.activeSessionName || 'none yet'],
          ['Players', `${st.numConnectedPlayers} / ${st.playerLimit}`],
          ['Tech tier', st.techTier],
          ['Game', st.isGameRunning ? (st.isGamePaused ? 'Paused (nobody online)' : 'Running') : 'No game loaded'],
          ['Tick rate', st.averageTickRate ? `${st.averageTickRate.toFixed(1)}/s` : null],
          ['Play time', st.totalGameDuration ? `${Math.floor(st.totalGameDuration / 3600)} h ${Math.floor((st.totalGameDuration % 3600) / 60)} min` : null],
        ],
      };
    } catch {
      return {};
    }
  },

  createParser: createSatisfactoryParser,

  connection: (record) => ({ port: port(record), protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: {
    sources: () => ({ base: saveFolder(), include: ['.'], world: null }),
  },

  addons: satisfactoryAddons,

  async install(record, job) {
    await steamAppUpdate(SATISFACTORY_APP, record.installDir, job);
    if (!existsSync(path.join(record.installDir, EXE))) throw new Error(`Install finished but ${EXE} is missing.`);
    job.line('Satisfactory dedicated server is installed.');
  },
};
