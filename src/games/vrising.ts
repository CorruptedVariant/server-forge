// V Rising dedicated server (Steam app 1829350, anonymous SteamCMD). Started as the official example does, with
// -persistentDataPath .\save-data so its settings and saves stay in the server folder (not in the Windows profile), and
// a log file Server Forge reads. Server Forge writes its own values into save-data\Settings\ServerHostSettings.json
// (created from the defaults the server ships with) and keeps the rest; ServerGameSettings.json is left to the owner
// (Files tab), with the game preset chosen here. RCON is switched on (this system only) so countdowns can warn players
// in the game. Stop is Ctrl+C (the server saves and shuts down).
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { winePath } from '../platform/host.ts';
import path from 'node:path';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, bool, text, newPassword, steamInstall } from './steam-games.ts';
import { rconCommand } from '../rcon.ts';

const EXE = 'VRisingServer.exe';
const DATA = 'save-data';
const DEFAULTS = path.join('VRisingServer_Data', 'StreamingAssets', 'Settings');

const GAME_PRESETS = [
  { value: 'StandardPvE', label: 'Standard PvE' },
  { value: 'StandardPvP', label: 'Standard PvP' },
  { value: 'StandardPvP_NoSiege', label: 'Standard PvP, no castle sieges' },
  { value: 'StandardPvP_WeekendSiege', label: 'Standard PvP, sieges at weekends' },
  { value: 'StandardPvP_DailySiege', label: 'Standard PvP, daily siege window' },
  { value: 'DuoPvP', label: 'Duo PvP (clans of 2)' },
  { value: 'TrioPvP', label: 'Trio PvP (clans of 3)' },
  { value: 'SoloPvP', label: 'Solo PvP (no clans)' },
  { value: 'HardcorePvP', label: 'Hardcore PvP' },
  ...[30, 40, 50, 60, 70, 80, 90].flatMap((l) => [
    { value: `Level${l}PvE`, label: `Start at level ${l}, PvE` },
    { value: `Level${l}PvP`, label: `Start at level ${l}, PvP` },
  ]),
  { value: '', label: 'Custom (edit save-data\\Settings\\ServerGameSettings.json)' },
];
const DIFFICULTY = [
  { value: 'Difficulty_Easy', label: 'Easy' },
  { value: 'Difficulty_Normal', label: 'Normal' },
  { value: 'Difficulty_Brutal', label: 'Brutal' },
];

const settingsDir = (record: ServerRecord) => path.join(record.installDir, DATA, 'Settings');

function writeHostSettings(record: ServerRecord) {
  const s = record.settings;
  const dir = settingsDir(record);
  mkdirSync(dir, { recursive: true });
  for (const f of ['ServerHostSettings.json', 'ServerGameSettings.json']) {
    const target = path.join(dir, f);
    const source = path.join(record.installDir, DEFAULTS, f);
    if (!existsSync(target) && existsSync(source)) copyFileSync(source, target);
  }
  const file = path.join(dir, 'ServerHostSettings.json');
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(file, 'utf-8').replace(/^﻿/, ''));
  } catch {}
  const next = {
    ...cfg,
    Name: s.serverName,
    Description: s.description,
    Port: Number(s.port),
    QueryPort: Number(s.port) + 1,
    MaxConnectedUsers: Number(s.maxPlayers),
    SaveName: s.world,
    Password: s.password ?? '',
    ListOnSteam: !!s.public,
    ListOnEOS: !!s.public,
    GameSettingsPreset: s.preset,
    GameDifficultyPreset: s.difficulty,
    Rcon: { ...((cfg.Rcon as object) ?? {}), Enabled: true, Port: Number(s.rconPort), Password: s.rconPassword },
  };
  writeFileSync(file, JSON.stringify(next, null, 2));
}

function createVRisingParser(): LogParser {
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
      // After the whole world has streamed in (a minute or two after start).
      if (/\[Server\] Startup Completed/.test(line)) st.ready = true;
      if ((m = /VRisingServer:? (v[\d.]+)/i.exec(line)) && !st.version) st.version = m[1];
      if ((m = /User '\{Steam (\d+)\}'[^']*'([^']{1,60})'.*connected as/i.exec(line)) || (m = /Character Name '([^']{1,60})' connected/i.exec(line))) {
        const name = m[2] ?? m[1];
        known[name] = name;
        online.set(name, Date.now());
        sync();
      } else if ((m = /User '\{Steam \d+\}' disconnected.*Character: '([^']{1,60})'|Character Name '([^']{1,60})' disconnected/i.exec(line))) {
        online.delete(m[1] ?? m[2]);
        sync();
      }
      if (/Saved Game|Save successful|Saving finished/i.test(line)) st.lastSave = Date.now();
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

export const vrising: GameModule = {
  id: 'vrising',
  name: 'V Rising',
  processName: EXE,
  linux: 'wine',

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', restart: true },
    { key: 'description', label: 'Description', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 9876 (UDP). The query port is the next one up (9877).', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional.', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', restart: true },
    { key: 'public', label: 'List publicly', type: 'boolean', help: 'Show in the in-game server list (Steam and Epic).', restart: true },
    { key: 'preset', label: 'Game mode', type: 'select', options: GAME_PRESETS, restart: true, section: 'World' },
    { key: 'difficulty', label: 'Difficulty', type: 'select', options: DIFFICULTY, restart: true, section: 'World' },
    { key: 'world', label: 'Save name', type: 'text', help: 'save-data\\Saves\\v4\\<name>. A new one starts a new world.', restart: true, section: 'World' },
    { key: 'rconPort', label: 'RCON port (this system only)', type: 'number', help: 'Default 25575. Used by Server Forge to warn players before restarts; no need to forward it.', restart: true, section: 'Advanced' },
  ],
  quickFields: ['serverName', 'port', 'password', 'preset', 'difficulty'],

  defaults: () => ({
    serverName: 'My V Rising Server',
    description: 'Hosted with Server Forge',
    port: 9876,
    password: '',
    maxPlayers: 40,
    public: false,
    preset: 'StandardPvE',
    difficulty: 'Difficulty_Normal',
    world: 'world1',
    rconPort: 25575,
    rconPassword: newPassword(),
  }),

  validate(s: Settings): Settings {
    const preset = String(s.preset ?? 'StandardPvE');
    const difficulty = String(s.difficulty ?? 'Difficulty_Normal');
    if (!GAME_PRESETS.some((p) => p.value === preset)) throw new Error('Pick a game mode.');
    if (!DIFFICULTY.some((p) => p.value === difficulty)) throw new Error('Pick a difficulty.');
    const world = text(s.world || 'world1', 'Save name', 40);
    if (!/^[\w-]+$/.test(world)) throw new Error('Save name can only use letters, numbers, - and _.');
    const port = num(s.port, 'Port', 1024, 65534);
    const rconPort = num(s.rconPort ?? 25575, 'RCON port', 1024, 65535);
    if (rconPort === port || rconPort === port + 1) throw new Error('The RCON port must be different from the game and query ports.');
    return {
      serverName: text(s.serverName, 'Server name', 60, true),
      description: text(s.description, 'Description', 200),
      port,
      password: text(s.password, 'Password', 64),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 128),
      public: bool(s.public),
      preset,
      difficulty,
      world,
      rconPort,
      rconPassword: text(s.rconPassword, 'RCON password', 64) || newPassword(),
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  async prepare(record) {
    mkdirSync(path.join(record.installDir, 'logs'), { recursive: true });
    writeHostSettings(record);
  },

  launch: (record) => ({
    exe: path.join(record.installDir, EXE),
    args: ['-persistentDataPath', winePath(path.join(record.installDir, DATA)), '-logFile', winePath(path.join(record.installDir, 'logs', 'VRisingServer.log'))],
    cwd: record.installDir,
    env: { SteamAppId: '1604030' },
  }),

  gameLog: (record) => path.join(record.installDir, 'logs', 'VRisingServer.log'),

  async say(record, msg) {
    await rconCommand(Number(record.settings.rconPort), String(record.settings.rconPassword), `announce ${msg}`);
  },

  async runCommand(record, command) {
    return rconCommand(Number(record.settings.rconPort), String(record.settings.rconPassword), command);
  },

  createParser: createVRisingParser,

  connection: (record) => ({ port: Number(record.settings.port) || 9876, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: { sources: (record) => ({ base: path.join(record.installDir, DATA), include: ['Saves', 'Settings'].filter((p) => existsSync(path.join(record.installDir, DATA, p))), world: 'Saves' }) },

  install: (record, job) => steamInstall(record, job, STEAM_APPS.vrising, EXE, 'V Rising', { windowsBuild: true }),
};
