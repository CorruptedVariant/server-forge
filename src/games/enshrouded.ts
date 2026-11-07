// Enshrouded dedicated server (Steam app 2278520, anonymous SteamCMD). Everything is in enshrouded_server.json next to
// the program (the server makes it on first start, with random group passwords). Server Forge sets its own few values in
// it before every start and keeps the rest (the Custom difficulty settings, bans, extra groups, tags...), which the owner
// can still edit in the Files tab. Players join with a group's password: Admin, Friend, Guest or Visitor, each with its
// own permissions. The log is logs/enshrouded_server.log. Stop is Ctrl+C (the server saves and shuts down).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GameModule, LogParser, LogState, ServerRecord, Settings } from './types.ts';
import { STEAM_APPS, num, bool, text, newPassword, steamInstall } from './steam-games.ts';

const EXE = 'enshrouded_server.exe';
const CONFIG = 'enshrouded_server.json';
const PRESETS = [
  { value: 'Default', label: 'Default' },
  { value: 'Relaxed', label: 'Relaxed (fewer enemies, more loot)' },
  { value: 'Hard', label: 'Hard' },
  { value: 'Survival', label: 'Survival (hunger, harder enemies)' },
  { value: 'Custom', label: 'Custom (edit gameSettings in enshrouded_server.json)' },
];
const GROUPS = {
  Admin: { canKickBan: true, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true },
  Friend: { canKickBan: false, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: false },
  Guest: { canKickBan: false, canAccessInventories: false, canEditWorld: true, canEditBase: false, canExtendBase: false },
  Visitor: { canKickBan: false, canAccessInventories: false, canEditWorld: false, canEditBase: false, canExtendBase: false },
} as const;
const PASSWORD_FIELD: Record<keyof typeof GROUPS, string> = { Admin: 'adminPassword', Friend: 'friendPassword', Guest: 'guestPassword', Visitor: 'visitorPassword' };

function readConfig(record: ServerRecord): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(record.installDir, CONFIG), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(record: ServerRecord) {
  const s = record.settings;
  const cfg = readConfig(record);
  const groups = Array.isArray(cfg.userGroups) ? (cfg.userGroups as Record<string, unknown>[]) : [];
  for (const [name, perms] of Object.entries(GROUPS) as [keyof typeof GROUPS, (typeof GROUPS)[keyof typeof GROUPS]][]) {
    const password = String(s[PASSWORD_FIELD[name]] ?? '');
    const at = groups.findIndex((g) => String(g.name).toLowerCase() === name.toLowerCase());
    // An empty password removes that group (nobody can join with it).
    if (!password) {
      if (at >= 0) groups.splice(at, 1);
      continue;
    }
    if (at >= 0) groups[at] = { ...groups[at], password };
    else groups.push({ name, password, ...perms, reservedSlots: 0 });
  }
  const next = {
    ...cfg,
    name: s.serverName,
    saveDirectory: './savegame',
    logDirectory: './logs',
    ip: cfg.ip ?? '0.0.0.0',
    queryPort: Number(s.port),
    slotCount: Number(s.maxPlayers),
    enableTextChat: !!s.textChat,
    enableVoiceChat: !!s.voiceChat,
    gameSettingsPreset: s.preset,
    userGroups: groups,
  };
  // A pre-2024 single "password" would create an extra "default" group.
  delete (next as Record<string, unknown>).password;
  writeFileSync(path.join(record.installDir, CONFIG), JSON.stringify(next, null, '\t'));
}

function createEnshroudedParser(): LogParser {
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
      // "[Session] 'HostOnline' (up)!" (not the earlier "started transition ... to 'Host_Online'").
      if (/\[Session\] 'HostOnline' \(up\)/.test(line)) st.ready = true;
      if (/\[Session\] started transition from 'Host_Online'/.test(line)) st.ready = false;
      if ((m = /Game Version \(SVN\): (\d+)|Version: ([\d.]+)/i.exec(line)) && !st.version) st.version = m[1] ?? m[2];
      if ((m = /Player '([^']{1,60})' logged in/i.exec(line))) {
        known[m[1]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /(?:Remove|Removed) Player '([^']{1,60})'|Player '([^']{1,60})' (?:left|disconnected)/i.exec(line))) {
        online.delete(m[1] ?? m[2]);
        sync();
      }
      if (/\[server\] Saved\b/.test(line)) st.lastSave = Date.now();
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

export const enshrouded: GameModule = {
  id: 'enshrouded',
  name: 'Enshrouded',
  processName: EXE,
  linux: 'wine',

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the in-game server list.', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 15637 (UDP).', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', help: '1 to 16.', restart: true },
    { key: 'preset', label: 'Difficulty', type: 'select', options: PRESETS, restart: true },
    { key: 'textChat', label: 'Text chat', type: 'boolean', restart: true },
    { key: 'voiceChat', label: 'Voice chat', type: 'boolean', restart: true },
    {
      key: 'adminPassword',
      label: 'Admin password',
      type: 'password',
      help: 'Players who join with this can build, open chests, extend bases and kick/ban.',
      restart: true,
      section: 'Join passwords',
      sectionHelp: 'Each password joins as a different group. Leave one empty to remove that group.',
    },
    { key: 'friendPassword', label: 'Friend password', type: 'password', help: 'Can build in bases and open chests.', restart: true, section: 'Join passwords' },
    { key: 'guestPassword', label: 'Guest password', type: 'password', help: "Can explore and fight, but can't change bases or open chests.", restart: true, section: 'Join passwords' },
    { key: 'visitorPassword', label: 'Visitor password', type: 'password', help: "Can look around only: can't change the world or bases.", restart: true, section: 'Join passwords' },
  ],
  quickFields: ['serverName', 'port', 'maxPlayers', 'preset', 'adminPassword', 'friendPassword'],

  defaults: () => ({
    serverName: 'My Enshrouded Server',
    port: 15637,
    maxPlayers: 16,
    preset: 'Default',
    textChat: true,
    voiceChat: false,
    adminPassword: newPassword(),
    friendPassword: newPassword(),
    guestPassword: '',
    visitorPassword: '',
  }),

  validate(s: Settings): Settings {
    const preset = String(s.preset ?? 'Default');
    if (!PRESETS.some((p) => p.value === preset)) throw new Error('Pick a difficulty.');
    const out: Settings = {
      serverName: text(s.serverName, 'Server name', 60, true),
      port: num(s.port, 'Port', 1024, 65535),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 16),
      preset,
      textChat: bool(s.textChat, true),
      voiceChat: bool(s.voiceChat),
    };
    for (const field of Object.values(PASSWORD_FIELD)) out[field] = text(s[field], 'Passwords', 64);
    const pw = Object.values(PASSWORD_FIELD).map((f) => String(out[f])).filter(Boolean);
    if (!pw.length) throw new Error('Set at least one join password.');
    if (new Set(pw).size !== pw.length) throw new Error('Each group needs a different password.');
    return out;
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  /** Import: take the name, port, slots and group passwords from the existing enshrouded_server.json. */
  detect(installDir) {
    try {
      const cfg = JSON.parse(readFileSync(path.join(installDir, CONFIG), 'utf-8'));
      const pw = (name: string) => (cfg.userGroups ?? []).find((g: { name?: string }) => String(g.name).toLowerCase() === name.toLowerCase())?.password ?? '';
      return {
        ...(cfg.name ? { serverName: cfg.name } : {}),
        ...(cfg.queryPort ? { port: cfg.queryPort } : {}),
        ...(cfg.slotCount ? { maxPlayers: cfg.slotCount } : {}),
        ...(cfg.gameSettingsPreset ? { preset: cfg.gameSettingsPreset } : {}),
        adminPassword: pw('Admin'),
        friendPassword: pw('Friend') || pw('default'),
        guestPassword: pw('Guest'),
        visitorPassword: pw('Visitor'),
      };
    } catch {
      return {};
    }
  },

  async prepare(record) {
    mkdirSync(path.join(record.installDir, 'logs'), { recursive: true });
    writeConfig(record);
  },

  launch: (record) => ({ exe: path.join(record.installDir, EXE), args: [], cwd: record.installDir }),

  gameLog: (record) => path.join(record.installDir, 'logs', 'enshrouded_server.log'),

  createParser: createEnshroudedParser,

  connection: (record) => ({ port: Number(record.settings.port) || 15637, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: { sources: (record) => ({ base: record.installDir, include: ['savegame', CONFIG].filter((p) => existsSync(path.join(record.installDir, p))), world: 'savegame' }) },

  install: (record, job) => steamInstall(record, job, STEAM_APPS.enshrouded, EXE, 'Enshrouded', { windowsBuild: true }),
};
