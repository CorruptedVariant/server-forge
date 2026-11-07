// Minecraft Bedrock Dedicated Server (BDS).
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import path from 'node:path';
import os from 'node:os';
import type { GameModule, LogParser, LogState, Player, PropertyEntry, ServerRecord, Settings, SettingField } from './types.ts';
import { parseTemplate, readProperties, writeProperties, backupFile, type PropertyInfo } from '../properties.ts';
import { downloadFile, extractZip, formatBytes } from '../download.ts';
import { rootDir } from '../store.ts';
import { readWorldSettings, writeWorldSettings } from './bedrock-world.ts';
import { chatStatus, setChatRelay, chatSayCommand } from './bedrock-chat.ts';
import { listPacks, installAddonFile, removePack, setPackEnabled, reorderPacks, packIcon, movePack, getInstallLocation, setInstallLocation, type PackLocation, type PackType } from './bedrock-addons.ts';
import { checkPackUpdates, installPackUpdate } from './bedrock-updates.ts';
import { diagnoseBedrock, missingVcDlls } from './bedrock-diagnose.ts';
import { isEndstone, setupEndstone, endstoneLaunch, endstonePlugins, installedEndstone, endstoneBedrockVersion, envPython, recordBedrockVersion, importEndstone } from './endstone.ts';

const EXE = bin('bedrock_server.exe', 'bedrock_server');
const LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const VERSION_FILE = '.tavernhost-version';
// The server's own settings and data: never overwritten by an update if they already exist.
const KEEP_ON_UPDATE = new Set(['server.properties', 'allowlist.json', 'permissions.json', 'whitelist.json', 'packetlimitconfig.json', 'profanity_filter.wlist', 'worlds']);
const PROP_PREFIX = 'prop:';

// ---------- server.properties schema (from Mojang's official file, bundled in assets/) ----------

let schema: PropertyInfo[] | null = null;
function getSchema(): PropertyInfo[] {
  schema ??= parseTemplate(readFileSync(path.join(rootDir, 'assets', 'bedrock-server.properties'), 'utf-8'));
  return schema;
}
function schemaFor(key: string) {
  return getSchema().find((p) => p.key === key);
}

// Java Edition keys that tools like MCSS write into Bedrock files; Bedrock ignores them.
const JAVA_TO_BEDROCK: Record<string, string> = { motd: 'server-name', 'white-list': 'allow-list' };
const NUMERIC_ENUMS: Record<string, string[]> = {
  gamemode: ['survival', 'creative', 'adventure'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};

function propertiesFile(record: ServerRecord) {
  return path.join(record.installDir, 'server.properties');
}

function levelName(record: ServerRecord) {
  return readProperties(propertiesFile(record)).values.get('level-name') || 'Bedrock level';
}

function checkValue(key: string, value: string) {
  const info = schemaFor(key);
  if (/[\r\n]/.test(value)) throw new Error(`${key}: line breaks are not allowed.`);
  if (!info) return;
  if (info.type === 'boolean' && !['true', 'false'].includes(value)) throw new Error(`${key} must be true or false.`);
  if (info.type === 'select' && info.options && !info.options.includes(value)) throw new Error(`${key} must be one of: ${info.options.join(', ')}.`);
  if (info.type === 'number' && value !== '' && !/^-?\d+$/.test(value)) throw new Error(`${key} must be a whole number.`);
  if (['server-port', 'server-portv6'].includes(key) && !(Number(value) >= 1 && Number(value) <= 65535)) throw new Error(`${key} must be 1-65535.`);
  if (['server-name', 'level-name'].includes(key) && value.includes(';')) throw new Error(`${key} can't contain a semicolon.`);
  if (key === 'level-name' && /[/\\`?*<>|":]/.test(value)) throw new Error('level-name contains characters that are not allowed in folder names.');
}

// ---------- console log parsing ----------

// "[2026-09-22 15:28:07:282 INFO] Player connected: CorVariant, xuid: 2535..."
const TIME_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}):\d+ \w+\] (.*)$/;
// Endstone's logger: "[18:05:49 INFO]: Player connected: ..." (time only).
const ENDSTONE_TIME_RE = /^\[(\d{2}):(\d{2}):(\d{2}) \w+\]: (.*)$/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** A console line's time and message, in either format; null for lines without a time. */
function parseLine(raw: string): { ts: number; msg: string } | null {
  const line = raw.replace(ANSI, '');
  const m = TIME_RE.exec(line);
  if (m) return { ts: new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime(), msg: m[7] };
  const e = ENDSTONE_TIME_RE.exec(line);
  if (!e) return null;
  const d = new Date();
  d.setHours(Number(e[1]), Number(e[2]), Number(e[3]), 0);
  return { ts: d.getTime(), msg: e[4] };
}

function createBedrockParser(): LogParser {
  let ready = false;
  let version: string | null = null;
  let levelName: string | null = null;
  let port: string | null = null;
  let players = new Map<string, Player>();
  const known: Record<string, string> = {};

  return {
    feed(line) {
      const parsed = parseLine(line);
      if (!parsed) return;
      const { ts, msg } = parsed;
      let x: RegExpExecArray | null;
      if (/^Starting Server/.test(msg)) {
        ready = false;
        players = new Map();
      } else if (/^Server started\./.test(msg)) ready = true;
      else if (/^(Stopping server|Quit correctly)/.test(msg)) {
        ready = false;
        players = new Map();
      } else if ((x = /^Version:? (\S+)/.exec(msg))) version = x[1];
      else if ((x = /^Level Name: (.+)$/.exec(msg))) levelName = x[1];
      else if ((x = /^IPv4 supported, port: (\d+)/.exec(msg))) port = x[1];
      else if ((x = /^Accepting clients on .*:(\d+)$/.exec(msg)) && !port) port = x[1];
      else if ((x = /^Player connected: (.+?), xuid: (\d*)/.exec(msg))) {
        players.set(x[1], { name: x[1], joinedAt: ts, platformId: x[2] || null });
        if (x[2]) known[x[2]] = x[1];
      } else if ((x = /^Player disconnected: (.+?), xuid: (\d*)/.exec(msg))) players.delete(x[1]);
    },
    state(): LogState {
      const list = [...players.values()];
      return { ready, players: list, playerCount: list.length, version, lastSave: null, extra: { levelName, port } };
    },
    knownPlayers: () => ({ ...known }),
  };
}

// ---------- install / update ----------

export async function latestDownload(): Promise<{ url: string; version: string }> {
  const res = await fetch(LINKS_API, { headers: { 'User-Agent': 'TavernHost' } });
  if (!res.ok) throw new Error(`Couldn't reach Mojang's download service (HTTP ${res.status}).`);
  const data = (await res.json()) as { result?: { links?: { downloadType: string; downloadUrl: string }[] } };
  const url = data.result?.links?.find((l) => l.downloadType === (isLinux ? 'serverBedrockLinux' : 'serverBedrockWindows'))?.downloadUrl;
  const version = url && /bedrock-server-([\d.]+)\.zip/.exec(url)?.[1];
  if (!url || !version) throw new Error(`Mojang's download service didn't list a ${isLinux ? 'Linux' : 'Windows'} Bedrock server.`);
  return { url, version };
}

export function installedVersion(installDir: string): string | null {
  const file = path.join(installDir, VERSION_FILE);
  return existsSync(file) ? readFileSync(file, 'utf-8').trim() : null;
}

/** Initial server.properties values chosen in the "New server" form. */
function applyInitialProperties(record: ServerRecord) {
  const changes: Record<string, string> = {};
  for (const [k, v] of Object.entries(record.settings)) if (k.startsWith(PROP_PREFIX)) changes[k.slice(PROP_PREFIX.length)] = String(v);
  const port = Number(changes['server-port'] ?? 19132);
  // A second server on this system needs its own IPv6 port too, and LAN discovery would grab the default ports.
  changes['server-portv6'] ??= String(port + 1);
  if (port !== 19132) changes['enable-lan-visibility'] ??= 'false';
  writeProperties(propertiesFile(record), changes, (k) => schemaFor(k)?.description);
}

// ---------- access lists (allowlist.json / permissions.json) ----------

function readJsonList<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf-8').replace(/^﻿/, '') || '[]');
  if (!Array.isArray(data)) throw new Error(`${path.basename(file)} is not a list; fix or delete it first.`);
  return data as T[];
}

function writeJsonList(file: string, list: unknown[]) {
  const tmp = `${file}.tavernhost-tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  cpSync(tmp, file);
  rmSync(tmp, { force: true });
}

interface AllowEntry {
  name: string;
  xuid?: string;
  ignoresPlayerLimit?: boolean;
}
interface PermissionEntry {
  permission: string;
  xuid: string;
}

// ---------- module ----------

const softwareField: SettingField = {
  key: 'software',
  label: 'Server software',
  type: 'select',
  options: [
    { value: 'vanilla', label: 'Vanilla (Mojang)', help: "Mojang's Bedrock Dedicated Server. Addons only." },
    // Endstone's setup here is written for Windows; not offered on Linux yet.
    ...(isLinux ? [] : [{
      value: 'endstone',
      label: 'Endstone (plugins)',
      help: 'Endstone runs the Bedrock server with plugin support (Python and C++ plugins) and still loads addons. Server Forge downloads Python and Endstone itself. Endstone supports one Bedrock version at a time, so new Bedrock versions arrive with Endstone updates, usually a few days after Mojang releases them.',
    }]),
  ],
  help: 'Switching takes effect at the next start (Server Forge sets Endstone up then). Worlds, settings and addons are kept.',
  restart: true,
};

const newFields: SettingField[] = [
  softwareField,
  { key: 'prop:server-name', label: 'Server name', type: 'text', help: 'Shown in the Minecraft server list.' },
  { key: 'prop:server-port', label: 'Port', type: 'number', help: 'Default 19132. Each Bedrock server on this system needs its own port.' },
  { key: 'prop:level-name', label: 'World name', type: 'text' },
  { key: 'prop:gamemode', label: 'Game mode (survival, creative or adventure)', type: 'text' },
  { key: 'prop:difficulty', label: 'Difficulty (peaceful, easy, normal or hard)', type: 'text' },
  { key: 'prop:max-players', label: 'Max players', type: 'number' },
  { key: 'prop:allow-list', label: 'Only allow players on the allowlist', type: 'boolean' },
  { key: 'prop:allow-cheats', label: 'Allow cheats (commands)', type: 'boolean' },
];

export const bedrock: GameModule = {
  id: 'bedrock',
  name: 'Minecraft Bedrock',
  processName: EXE,
  commands: { stop: 'stop' },
  eula: { label: 'I agree to the Minecraft End User License Agreement and Privacy Policy', url: 'https://www.minecraft.net/eula' },
  // Bedrock's settings live in server.properties (Properties tab); the panel only keeps which software runs it.
  fields: [softwareField],
  newFields,

  defaults: () => ({ software: 'vanilla' }),

  validate(s: Settings): Settings {
    const software = String(s.software ?? 'vanilla');
    if (!['vanilla', 'endstone'].includes(software)) throw new Error('Server software must be Vanilla or Endstone.');
    const out: Settings = { software };
    for (const [k, v] of Object.entries(s)) {
      if (!k.startsWith(PROP_PREFIX)) continue;
      const key = k.slice(PROP_PREFIX.length);
      if (!newFields.some((f) => f.key === k)) continue;
      const value = typeof v === 'boolean' ? String(v) : String(v ?? '').trim();
      if (value === '') continue;
      checkValue(key, value);
      out[k] = value;
    }
    return out;
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  // An imported Endstone server (it has Endstone's config) keeps running on Endstone.
  detect: (installDir) => ({ software: existsSync(path.join(installDir, 'endstone.toml')) ? 'endstone' : 'vanilla' }),

  // Import: an Endstone server may be in the chosen folder's bedrock_server folder, and its pip-installed plugins are
  // brought in (see endstone.ts). Addons stay where they are, so they just need listing.
  async prepareImport(chosen) {
    const r = await importEndstone(chosen);
    const notes = [...r.notes];
    if (existsSync(path.join(r.installDir, EXE))) {
      try {
        const level = readProperties(path.join(r.installDir, 'server.properties')).values.get('level-name') || 'Bedrock level';
        const packs = listPacks(r.installDir, level);
        const on = packs.filter((p) => p.enabled).length;
        if (packs.length) notes.push(`${packs.length} addon pack${packs.length === 1 ? '' : 's'} came along (${on} switched on in "${level}"), in the same load order.`);
      } catch {}
    }
    if (r.endstone) notes.unshift('This is an Endstone server: it keeps running on Endstone, with its plugins in the Plugins tab.');
    return { installDir: r.installDir, notes };
  },

  launch(record) {
    if (isEndstone(record)) return endstoneLaunch(record);
    return { exe: path.join(record.installDir, EXE), args: [], cwd: record.installDir, ...(isLinux ? { env: { LD_LIBRARY_PATH: '.' } } : {}) };
  },

  // Endstone servers: set Endstone up the first time (also after switching an existing server to Endstone).
  async prepare(record, note) {
    // Without the Visual C++ runtime Windows refuses to start bedrock_server.exe (exit code 3221225781): say so now.
    const missing = missingVcDlls(record.installDir);
    if (missing.length) {
      throw new Error(`This system is missing the Microsoft Visual C++ runtime the Bedrock server needs (${missing.join(', ')}). Use "Install Visual C++ runtime" on the Overview tab, then start again.`);
    }
    if (isLinux && isEndstone(record)) throw new Error("Endstone isn't supported on Linux in Server Forge yet. Set Server software to Vanilla in Settings.");
    if (!isEndstone(record) || (existsSync(envPython(record.installDir)) && installedEndstone(record.installDir))) return;
    note('Setting up Endstone (first start only): Python, Endstone and the Bedrock version it supports…');
    const r = await setupEndstone(record.installDir, { update: () => {}, line: note }, { vanillaVersion: installedVersion(record.installDir) });
    recordBedrockVersion(record.installDir, r.bedrock);
  },

  createParser: createBedrockParser,

  async install(record, job, opts) {
    if (isEndstone(record)) {
      const firstInstall = !existsSync(propertiesFile(record));
      const r = await setupEndstone(record.installDir, job, { upgrade: true, vanillaVersion: installedVersion(record.installDir), allowDowngrade: !!opts?.force });
      if (firstInstall) applyInitialProperties(record);
      recordBedrockVersion(record.installDir, r.bedrock);
      job.line(`Endstone ${r.endstone} with Bedrock ${r.bedrock ?? '(version unknown)'} is installed.`);
      return;
    }
    job.update("Checking Mojang's latest Bedrock server…", null);
    const { url, version } = await latestDownload();
    const current = installedVersion(record.installDir);
    const upToDate = current === version && existsSync(path.join(record.installDir, EXE));
    if (upToDate && !opts?.force) {
      job.line(`Already on the latest version (${version}).`);
      return;
    }
    job.line(upToDate ? `Reinstalling Bedrock server ${version} (forced)` : current ? `Updating ${current} → ${version}` : `Installing Bedrock server ${version}`);

    const tmp = path.join(os.tmpdir(), `tavernhost-bedrock-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const zip = path.join(tmp, 'bedrock-server.zip');
      await downloadFile(url, zip, (pct, received) => job.update(`Downloading Bedrock server ${version}… ${formatBytes(received)}`, pct));
      job.update('Unpacking…', null);
      const extracted = path.join(tmp, 'files');
      await extractZip(zip, extracted);

      const firstInstall = !existsSync(propertiesFile(record));
      job.update('Copying files (your worlds and settings are kept)…', null);
      mkdirSync(record.installDir, { recursive: true });
      for (const name of readdirSync(extracted)) {
        const src = path.join(extracted, name);
        const dest = path.join(record.installDir, name);
        if (KEEP_ON_UPDATE.has(name) && existsSync(dest)) continue;
        // config/ can hold your own edits (e.g. script permissions): only add files that are missing.
        if (name === 'config' && existsSync(dest)) cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
        else cpSync(src, dest, { recursive: true, force: true });
      }
      if (firstInstall) applyInitialProperties(record);
      writeFileSync(path.join(record.installDir, VERSION_FILE), version);
      job.line(`Bedrock server ${version} is installed.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },

  async details(record) {
    const { values } = readProperties(propertiesFile(record));
    const endstone = isEndstone(record) ? installedEndstone(record.installDir) : null;
    const facts: [string, string | null][] = [
      ['Installed version', (isEndstone(record) && endstoneBedrockVersion(record.installDir)) || installedVersion(record.installDir)],
      ['Server software', isEndstone(record) ? (endstone ? `Endstone ${endstone}` : 'Endstone (set up at the next start)') : null],
      ['Server name', values.get('server-name') ?? values.get('motd') ?? null],
      ['World', values.get('level-name') ?? null],
      ['Port', values.get('server-port') ?? null],
      ['Game mode', values.get('gamemode') ?? null],
      ['Difficulty', values.get('difficulty') ?? null],
      ['Allowlist only', values.get('allow-list') ?? values.get('white-list') ?? null],
    ];
    return { facts: facts.filter(([, v]) => v != null && v !== '') };
  },

  properties: {
    read(record) {
      const file = propertiesFile(record);
      const { values } = readProperties(file);
      const entries: PropertyEntry[] = getSchema().map((p) => ({
        key: p.key,
        value: values.get(p.key) ?? null,
        defaultValue: p.defaultValue,
        description: p.description,
        type: p.type,
        options: p.options,
        known: true,
        optional: p.optional,
      }));
      const unknown = [...values.keys()].filter((k) => !schemaFor(k));
      for (const key of unknown) {
        entries.push({ key, value: values.get(key)!, defaultValue: null, description: '', type: 'text', known: false, optional: false });
      }
      const problems: string[] = [];
      if (!existsSync(file)) problems.push('This server has no server.properties yet; it will be created when you save.');
      const javaKeys = unknown.filter((k) => ['motd', 'white-list', 'rcon.port', 'enable-rcon', 'spawn-animals', 'query.port', 'op-permission-level'].includes(k));
      if (javaKeys.length) {
        problems.push(
          `This file is in Java Edition format (it has ${javaKeys.slice(0, 3).join(', ')}…), probably written by another tool such as MCSS. ` +
            'Bedrock ignores those settings and uses defaults for its own. Use "Repair file" to convert it (a backup is kept).',
        );
      }
      return { file, entries, problems };
    },

    write(record, changes) {
      for (const [key, value] of Object.entries(changes)) checkValue(key, value);
      writeProperties(propertiesFile(record), changes, (k) => schemaFor(k)?.description);
    },

    repair(record) {
      const file = propertiesFile(record);
      const { values } = readProperties(file);
      const backup = backupFile(file);
      const carried: string[] = [];
      const valueFor = (key: string): string | undefined => {
        if (values.has(key)) return values.get(key);
        const javaKey = Object.entries(JAVA_TO_BEDROCK).find(([, b]) => b === key)?.[0];
        if (javaKey && values.has(javaKey)) {
          carried.push(`${javaKey} → ${key}`);
          return values.get(javaKey);
        }
        return undefined;
      };
      const template = readFileSync(path.join(rootDir, 'assets', 'bedrock-server.properties'), 'utf-8').replace(/^﻿/, '');
      const out = template.split(/\r?\n/).map((line) => {
        const m = /^(#\s*)?([a-z0-9][a-z0-9.\-_]*)=(.*)$/i.exec(line);
        if (!m || !schemaFor(m[2])) return line;
        let value = valueFor(m[2]);
        if (value === undefined) return line; // keep the official default (or leave optional keys commented out)
        if (NUMERIC_ENUMS[m[2]] && /^\d+$/.test(value)) value = NUMERIC_ENUMS[m[2]][Number(value)] ?? m[3];
        try {
          checkValue(m[2], value);
        } catch {
          return m[1] ? line : `${m[2]}=${m[3]}`; // invalid old value: use the default
        }
        return `${m[2]}=${value}`;
      });
      writeFileSync(file, out.join('\r\n'));
      const dropped = [...values.keys()].filter((k) => !schemaFor(k) && !JAVA_TO_BEDROCK[k]);
      return [
        'Rebuilt server.properties from the official Bedrock template, keeping your values.',
        carried.length ? `Converted: ${carried.join(', ')}.` : '',
        dropped.length ? `Removed settings Bedrock doesn't use: ${dropped.join(', ')}.` : '',
        backup ? `Backup: ${path.basename(backup)}.` : '',
        'Restart the server to apply.',
      ]
        .filter(Boolean)
        .join(' ');
    },
  },

  backup: {
    sources(record) {
      const level = readProperties(propertiesFile(record)).values.get('level-name') || 'Bedrock level';
      return { base: record.installDir, include: [`worlds/${level}`, 'server.properties', 'allowlist.json', 'permissions.json'], world: level };
    },

    async resume(io) {
      await io.command('save resume');
    },

    // Bedrock's documented way to back up a running world: "save hold" pauses writes, "save query" lists exactly which
    // files (and how many bytes of each) make a consistent copy, and "save resume" continues.
    async hot(_record, io) {
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        await io.command('save resume').catch(() => {});
      };
      await io.command('save hold');
      let released = false;
      try {
        for (let attempt = 0; attempt < 60; attempt++) {
          const reply = io.waitForLine(/Data saved\. Files are now ready to be copied\.|A previous save has not been completed/, 5000, 1).catch(() => null);
          await io.command('save query');
          const lines = await reply;
          // Bedrock answers "A previous save has not been completed" for a few seconds while it gets ready. Still that
          // after ~15 s means an earlier hold that never finished (e.g. Server Forge closed during a backup): release
          // it once and start again, instead of waiting for a save that won't complete.
          if (lines && /A previous save has not been completed/.test(lines[0]) && !released && attempt >= 15) {
            released = true;
            await io.command('save resume');
            await new Promise((r) => setTimeout(r, 2000));
            await io.command('save hold');
            continue;
          }
          if (lines && /Data saved/.test(lines[0]) && lines[1]) {
            // "Bedrock level/db/000005.ldb:1234, Bedrock level/db/CURRENT:16, ..." (Endstone puts "[12:00:00 INFO]: " first)
            const files = [...lines[1].replace(ANSI, '').replace(/^\[[\d:]+ \w+\]:\s*/, '').matchAll(/\s*(.+?):(\d+)(?:,|$)/g)].map((m) => ({ rel: path.join('worlds', m[1].trim()), length: Number(m[2]) }));
            if (!files.length) throw new Error("Couldn't read the file list Bedrock sent back.");
            return { files, finish };
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error("Bedrock didn't get the world ready for a backup in time.");
      } catch (err) {
        await finish();
        throw err;
      }
    },
  },

  addons: {
    accept: '.mcaddon,.mcpack,.zip',
    curseforgeGame: 'minecraft-bedrock',
    links: [
      { label: 'MCPEDL', url: 'https://mcpedl.com/category/mods/', help: 'The biggest site for Bedrock addons. Downloads often go through a link page first.' },
      { label: 'CurseForge', url: 'https://www.curseforge.com/minecraft-bedrock/addons', help: 'Addons, maps and texture packs, with direct downloads.' },    ],
    list: (record) => listPacks(record.installDir, levelName(record)),
    install: (record, file, source) => installAddonFile(record.installDir, levelName(record), file, source),
    // Updates from CurseForge for packs linked to a project (see bedrock-updates.ts).
    checkUpdates: async (record) => (await checkPackUpdates(record.installDir, levelName(record))).labels,
    async update(record, id) {
      const pack = listPacks(record.installDir, levelName(record)).find((p) => p.id === id);
      if (!pack?.curseforge) throw new Error('That addon isn’t linked to a CurseForge project. Use "Link to CurseForge" first.');
      return installPackUpdate(record.installDir, levelName(record), pack.curseforge.projectId);
    },
    remove: (record, id) => void removePack(record.installDir, levelName(record), id),
    setEnabled: (record, id, enabled) => setPackEnabled(record.installDir, levelName(record), id, enabled),
    reorder: (record, type, ids) => reorderPacks(record.installDir, levelName(record), type as PackType, ids),
    folders: true,
    icon: (record, id) => packIcon(record.installDir, levelName(record), id),
    locations: {
      options: [
        { value: 'server', label: 'Server folder', help: 'behavior_packs / resource_packs next to the server. Shared by every world on this server.' },
        { value: 'world', label: 'World folder', help: "Inside the world (worlds/<world>/...). The addons travel with the world if you copy or swap it." },
      ],
      get: (record) => getInstallLocation(record.installDir),
      set: (record, location) => setInstallLocation(record.installDir, location as PackLocation),
      move: (record, id, to) => void movePack(record.installDir, levelName(record), id, to as PackLocation),
      describe: (record) => ({ server: record.installDir, world: path.join(record.installDir, 'worlds', levelName(record)) }),
    },
  },

  // Endstone servers also take plugins (see endstone.ts).
  plugins: endstonePlugins,

  // Crash checker: Windows exit codes (e.g. missing Visual C++ runtime), port clashes, world/addon/plugin errors.
  diagnose: (record, logFile, since) => diagnoseBedrock(record, logFile, since),

  connection(record) {
    const { values } = readProperties(path.join(record.installDir, 'server.properties'));
    return { port: Number(values.get('server-port')) || 19132, protocol: 'UDP', maxPlayers: Number(values.get('max-players')) || null };
  },

  chat: {
    status: (record) => chatStatus(record.installDir, levelName(record)),
    setRelay: (record, on, moduleVersion) => setChatRelay(record.installDir, levelName(record), on, moduleVersion),
    sayCommand: chatSayCommand,
  },

  world: {
    read: (record) => readWorldSettings(record.installDir, levelName(record)),
    write: (record, changes) => writeWorldSettings(record.installDir, levelName(record), changes),
  },

  accessLists: [
    { id: 'allowlist', label: 'Allowlist', help: 'Players allowed to join when "allow-list" is on. Add by gamertag; the server fills in their ID when they first join.', entryLabel: 'Gamertag' },
    { id: 'operators', label: 'Operators', help: 'Players with operator permission (can use commands). Added by Xbox ID (XUID), shown as their name once they have joined.', entryLabel: 'XUID (pick a known player)' },
  ],

  readAccessList(record, list) {
    if (list === 'allowlist') return readJsonList<AllowEntry>(path.join(record.installDir, 'allowlist.json')).map((e) => e.name);
    if (list === 'operators') {
      return readJsonList<PermissionEntry>(path.join(record.installDir, 'permissions.json'))
        .filter((e) => e.permission === 'operator')
        .map((e) => e.xuid);
    }
    throw new Error('Unknown list.');
  },

  writeAccessList(record, list, entries) {
    if (list === 'allowlist') {
      const file = path.join(record.installDir, 'allowlist.json');
      const existing = readJsonList<AllowEntry>(file);
      const names = [...new Set(entries.map((e) => e.trim()).filter(Boolean))];
      for (const n of names) if (n.length > 32 || /[\\"]/.test(n)) throw new Error(`"${n}" doesn't look like a gamertag.`);
      // Keep each player's existing record (their XUID and settings); add new players by name only.
      const next = names.map((n) => existing.find((e) => e.name.toLowerCase() === n.toLowerCase()) ?? { ignoresPlayerLimit: false, name: n });
      writeJsonList(file, next);
      return ['allowlist reload'];
    }
    if (list === 'operators') {
      const file = path.join(record.installDir, 'permissions.json');
      const existing = readJsonList<PermissionEntry>(file);
      const xuids = [...new Set(entries.map((e) => e.trim()).filter(Boolean))];
      for (const x of xuids) if (!/^\d{5,20}$/.test(x)) throw new Error(`"${x}" is not an Xbox ID (XUID). Pick a player who has joined before.`);
      // Everyone else keeps their permission; removed operators drop back to the default level.
      const others = existing.filter((e) => e.permission !== 'operator' && !xuids.includes(e.xuid));
      writeJsonList(file, [...others, ...xuids.map((xuid) => ({ permission: 'operator', xuid }))]);
      return ['permission reload'];
    }
    throw new Error('Unknown list.');
  },
};
