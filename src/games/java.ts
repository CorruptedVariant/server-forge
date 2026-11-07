// Minecraft Java Edition servers: Vanilla, Paper, Fabric, Forge, NeoForge, Spigot, SpongeVanilla and BungeeCord.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync, rmSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import { ZipFile } from '../zip.ts';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { GameModule, LogParser, LogState, Player, PropertyEntry, ServerRecord, Settings, SettingField } from './types.ts';
import { readProperties, writeProperties } from '../properties.ts';
import { ensureJava, javaExe } from '../java-runtime.ts';
import { FLAVORS, listVersions, installFlavor, javaForMinecraft, writeEula, type LaunchSpec } from './java-sources.ts';
import { diagnoseJava } from './java-diagnose.ts';
import { contentKind, contentLinks, listContent, installContent, removeContent, setContentEnabled, contentIcon, setContentSide, MOD_SIDES } from './java-content.ts';
import { listJavaSettings, readJavaSettings, writeJavaSettings } from './java-settings.ts';

const VERSION_FILE = '.tavernhost-version';
const JAVA_VERSIONS = [8, 11, 17, 21, 25];

function s(record: ServerRecord, key: string): string {
  return String(record.settings[key] ?? '');
}
function isProxy(record: ServerRecord) {
  return FLAVORS.find((f) => f.id === s(record, 'flavor'))?.proxy === true;
}
function javaMajor(record: ServerRecord): number {
  return Number(record.settings.javaVersion) || 21;
}

// ---------- server.properties: descriptions for the common settings ----------

type Info = { d: string; t?: 'boolean' | 'number' | 'select'; o?: string[]; def?: string };
const JAVA_PROPS: Record<string, Info> = {
  motd: { d: 'Message shown under the server name in the multiplayer list.', def: 'A Minecraft Server' },
  'server-port': { d: 'Port players connect to (default 25565). Each server on this system needs its own.', t: 'number', def: '25565' },
  'server-ip': { d: 'Leave empty to listen on all network interfaces.', def: '' },
  'max-players': { d: 'Maximum players online at once.', t: 'number', def: '20' },
  gamemode: { d: 'Game mode for new players.', t: 'select', o: ['survival', 'creative', 'adventure', 'spectator'], def: 'survival' },
  difficulty: { d: 'World difficulty.', t: 'select', o: ['peaceful', 'easy', 'normal', 'hard'], def: 'easy' },
  hardcore: { d: 'Players are banned when they die.', t: 'boolean', def: 'false' },
  pvp: { d: 'Players can damage each other.', t: 'boolean', def: 'true' },
  'online-mode': { d: 'Check accounts with Mojang (keep on unless behind a proxy like BungeeCord).', t: 'boolean', def: 'true' },
  'white-list': { d: 'Only whitelisted players can join.', t: 'boolean', def: 'false' },
  'enforce-whitelist': { d: 'Kick players who are not whitelisted when the whitelist is reloaded.', t: 'boolean', def: 'false' },
  'level-name': { d: 'World folder name.', def: 'world' },
  'level-seed': { d: 'Seed for new worlds (empty = random).', def: '' },
  'level-type': { d: 'World type for new worlds, e.g. minecraft\\:normal, minecraft\\:flat.', def: 'minecraft\\:normal' },
  'view-distance': { d: 'How far (in chunks) the server sends terrain.', t: 'number', def: '10' },
  'simulation-distance': { d: 'How far (in chunks) from players the world keeps running.', t: 'number', def: '10' },
  'spawn-protection': { d: 'Radius around spawn that only operators can build in (0 = off).', t: 'number', def: '16' },
  'allow-flight': { d: 'Allow flying in survival (needed by some mods/plugins).', t: 'boolean', def: 'false' },
  'allow-nether': { d: 'Allow travelling to the Nether.', t: 'boolean', def: 'true' },
  'enable-command-block': { d: 'Allow command blocks.', t: 'boolean', def: 'false' },
  'op-permission-level': { d: 'Default permission level for operators (1-4).', t: 'number', def: '4' },
  'player-idle-timeout': { d: 'Kick players idle for this many minutes (0 = never).', t: 'number', def: '0' },
  'force-gamemode': { d: 'Force players into the default game mode when they join.', t: 'boolean', def: 'false' },
  'spawn-monsters': { d: 'Hostile mobs spawn.', t: 'boolean', def: 'true' },
  'generate-structures': { d: 'Generate villages, temples and other structures in new chunks.', t: 'boolean', def: 'true' },
  'enable-rcon': { d: 'Remote console access (not needed with Server Forge; keep off unless you know you need it).', t: 'boolean', def: 'false' },
  'enable-query': { d: 'Answer GameSpy4 status queries (used by some server lists).', t: 'boolean', def: 'false' },
  'max-world-size': { d: 'World border radius in blocks.', t: 'number', def: '29999984' },
  'network-compression-threshold': { d: 'Compress network packets larger than this many bytes.', t: 'number', def: '256' },
  'resource-pack': { d: 'URL of a resource pack players are offered.', def: '' },
  'require-resource-pack': { d: 'Kick players who decline the resource pack.', t: 'boolean', def: 'false' },
  'enforce-secure-profile': { d: 'Require signed chat (players without Mojang-signed keys cannot join).', t: 'boolean', def: 'true' },
};

// ---------- console log (Vanilla-style "[12:34:56] [Server thread/INFO]: ..." and Forge's longer prefix) ----------

function createJavaParser(): LogParser {
  let ready = false;
  let version: string | null = null;
  let lastSave: number | null = null;
  let players = new Map<string, Player>();
  const uuids = new Map<string, string>();
  const known: Record<string, string> = {};
  return {
    feed(line) {
      let x: RegExpExecArray | null;
      if (/\]: Done \([\d.,]+s\)!|Listening on \//.test(line)) ready = true;
      else if (/\]: Stopping (the )?server|\]: Closing listener/.test(line)) {
        ready = false;
        players = new Map();
      } else if ((x = /Starting minecraft server version (\S+)/.exec(line))) version = x[1];
      else if ((x = /UUID of player (\S+) is ([0-9a-f-]{32,36})/i.exec(line))) {
        uuids.set(x[1], x[2]);
        known[x[2]] = x[1];
      } else if ((x = /\]: (\S+) joined the game$/.exec(line))) players.set(x[1], { name: x[1], joinedAt: Date.now(), platformId: uuids.get(x[1]) ?? null });
      else if ((x = /\]: (\S+) left the game$/.exec(line))) players.delete(x[1]);
      else if (/\]: Saved the game/.test(line)) lastSave = Date.now();
    },
    state(): LogState {
      const list = [...players.values()];
      return { ready, players: list, playerCount: list.length, version, lastSave, extra: {} };
    },
    knownPlayers: () => ({ ...known }),
  };
}

// ---------- lists (whitelist/ops/bans) ----------

const LISTS: Record<string, { file: string; add: string; remove: string; label: string; help: string }> = {
  whitelist: { file: 'whitelist.json', add: 'whitelist add', remove: 'whitelist remove', label: 'Whitelist', help: 'Players allowed to join when "white-list" is on (Properties).' },
  ops: { file: 'ops.json', add: 'op', remove: 'deop', label: 'Operators', help: 'Players with operator permission (commands, building at spawn).' },
  banned: { file: 'banned-players.json', add: 'ban', remove: 'pardon', label: 'Banned', help: 'Players who cannot join.' },
};

function readList(record: ServerRecord, list: string): { name: string; uuid?: string }[] {
  const file = path.join(record.installDir, LISTS[list].file);
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf-8').replace(/^﻿/, '') || '[]');
  return Array.isArray(data) ? data : [];
}

async function mojangUuid(name: string): Promise<string> {
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
  if (res.status === 404 || res.status === 204) throw new Error(`"${name}" isn't a Minecraft Java account name.`);
  if (!res.ok) throw new Error(`Couldn't look up "${name}" with Mojang (HTTP ${res.status}). Try again with the server running.`);
  const id = ((await res.json()) as { id: string }).id;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function walkFiles(root: string, base: string, out: { rel: string; length: number }[]) {
  if (!existsSync(root)) return;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(full, base, out);
    else if (e.name !== 'session.lock') out.push({ rel: path.relative(base, full), length: statSync(full).size });
  }
}

/** Reads version.json from inside a server jar (Mojang includes the Minecraft version and required Java there). */
function readVersionJson(jarPath: string): { id?: string; java?: number } | null {
  if (isLinux) {
    try {
      const zip = new ZipFile(jarPath);
      try {
        const entry = zip.get('version.json');
        if (!entry) return null;
        const v = JSON.parse(entry.toString('utf-8')) as { id?: string; java_version?: number };
        return { id: v.id, java: v.java_version };
      } finally {
        zip.close();
      }
    } catch {
      return null;
    }
  }
  try {
    const script =
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = [IO.Compression.ZipFile]::OpenRead($env:TH_JAR); ' +
      "try { $e = $z.GetEntry('version.json'); if ($e) { $r = New-Object IO.StreamReader($e.Open()); $r.ReadToEnd(); $r.Close() } } finally { $z.Dispose() }";
    const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, TH_JAR: jarPath },
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 20_000,
    }).trim();
    if (!text) return null;
    const v = JSON.parse(text) as { id?: string; java_version?: number };
    return { id: v.id, java: v.java_version };
  } catch {
    return null;
  }
}

// ---------- module ----------

/** The arguments file Forge and NeoForge's installers write for this system. */
const ARGS_FILE = bin('win_args.txt', 'unix_args.txt');

const flavorField: SettingField = {
  key: 'flavor',
  label: 'Server type',
  type: 'select',
  options: FLAVORS.map((f) => ({ value: f.id, label: f.name, help: f.description })),
};

export const java: GameModule = {
  id: 'java',
  name: 'Minecraft Java',
  processName: bin('java.exe', 'java'),
  commands: { stop: (record) => (isProxy(record) ? 'end' : 'stop') },
  eula: { label: 'I agree to the Minecraft End User License Agreement', url: 'https://aka.ms/MinecraftEULA' },

  fields: [
    { key: 'memoryMb', label: 'Memory (MB)', type: 'number', help: 'Maximum RAM for the server, e.g. 4096 = 4 GB. Modpacks usually need 6-10 GB.', restart: true },
    {
      key: 'javaVersion',
      label: 'Java version',
      type: 'select',
      options: JAVA_VERSIONS.map((v) => ({ value: String(v), label: `Java ${v}` })),
      help: 'Chosen automatically for new servers from what Mojang says the Minecraft version needs. Server Forge downloads it if missing.',
      restart: true,
    },
    { key: 'jar', label: 'Server jar', type: 'text', help: 'The .jar to run (not used by modern Forge/NeoForge, which use an args file).', restart: true },
    { key: 'jvmArgs', label: 'Extra Java arguments', type: 'text', help: 'Advanced. For example -XX:+UseG1GC.', restart: true },
  ],

  newFields: [
    flavorField,
    { key: 'mcVersion', label: 'Minecraft version', type: 'select', optionsFrom: 'flavor' },
    { key: 'memoryMb', label: 'Memory (MB)', type: 'number', help: '4096 = 4 GB. Modpacks usually need 6-10 GB.' },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 25565 (BungeeCord 25577). Each server on this system needs its own.' },
  ],

  defaults: () => ({ flavor: 'custom', mcVersion: '', memoryMb: 4096, javaVersion: 21, jar: '', argsFile: '', jvmArgs: '' }),

  validate(input: Settings): Settings {
    const flavor = String(input.flavor ?? 'custom');
    if (flavor !== 'custom' && !FLAVORS.some((f) => f.id === flavor)) throw new Error('Unknown server type.');
    const memory = Number(input.memoryMb);
    if (!Number.isInteger(memory) || memory < 512 || memory > 262144) throw new Error('Memory must be 512-262144 MB.');
    const javaVersion = Number(input.javaVersion);
    if (!JAVA_VERSIONS.includes(javaVersion)) throw new Error(`Java version must be one of ${JAVA_VERSIONS.join(', ')}.`);
    const jar = String(input.jar ?? '').trim();
    if (jar && (/[\\/]/.test(jar) && !/^[\w .\-\\/]+$/.test(jar))) throw new Error('Server jar should be a file name like server.jar.');
    const jvmArgs = String(input.jvmArgs ?? '').trim();
    if (/[\r\n]/.test(jvmArgs)) throw new Error('Java arguments must be on one line.');
    const out: Settings = {
      flavor,
      mcVersion: String(input.mcVersion ?? '').trim(),
      memoryMb: memory,
      javaVersion,
      jar,
      argsFile: String(input.argsFile ?? '').trim(),
      jvmArgs,
    };
    if (input.port !== undefined && input.port !== '') {
      const port = Number(input.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535.');
      out.port = port;
    }
    if (input.eulaAccepted === true) out.eulaAccepted = true;
    return out;
  },

  checkInstall(installDir) {
    if (!existsSync(installDir)) throw new Error('That folder does not exist.');
    const hasJar = readdirSync(installDir).some((f) => f.toLowerCase().endsWith('.jar'));
    const hasArgs = existsSync(path.join(installDir, 'libraries'));
    if (!hasJar && !hasArgs) throw new Error('No server .jar was found in that folder.');
  },

  detect(installDir) {
    const out: Settings = {};
    // Servers Server Forge installed record what they are.
    const marker = path.join(installDir, VERSION_FILE);
    if (existsSync(marker)) {
      try {
        const m = JSON.parse(readFileSync(marker, 'utf-8'));
        Object.assign(out, { flavor: m.flavor, mcVersion: m.mc, javaVersion: m.java });
      } catch {}
    }
    // Modern Forge/NeoForge installs launch through an args file.
    for (const group of ['net/minecraftforge/forge', 'net/neoforged/neoforge']) {
      const root = path.join(installDir, 'libraries', ...group.split('/'));
      if (!existsSync(root)) continue;
      for (const v of readdirSync(root)) {
        if (existsSync(path.join(root, v, ARGS_FILE))) {
          out.argsFile = path.join('libraries', ...group.split('/'), v, ARGS_FILE);
          out.flavor ??= group.includes('neoforged') ? 'neoforge' : 'forge';
        }
      }
    }
    // Otherwise pick the server jar, and read the Minecraft/Java version Mojang stores inside it (version.json).
    const jars = readdirSync(installDir).filter((f) => f.toLowerCase().endsWith('.jar') && !/installer/i.test(f));
    const jar = jars.find((f) => /^server\.jar$/i.test(f)) ?? jars.find((f) => /paper|spigot|forge|fabric|sponge|bungee|purpur|minecraft_server/i.test(f)) ?? jars[0];
    if (jar && !out.argsFile) out.jar = jar;
    if (jar && !out.javaVersion) {
      const info = readVersionJson(path.join(installDir, jar));
      const needed = info?.java;
      if (needed) out.javaVersion = JAVA_VERSIONS.includes(needed) ? needed : (JAVA_VERSIONS.find((v) => v >= needed) ?? 21);
      if (info?.id) out.mcVersion ??= info.id;
    }
    return out;
  },

  async listVersions(flavor) {
    return listVersions(flavor);
  },

  async prepare(record, note) {
    const major = javaMajor(record);
    if (!javaExe(major)) {
      note(`Downloading Java ${major} (first start only)…`);
      await ensureJava(major, () => {});
    }
  },

  launch(record) {
    const java = javaExe(javaMajor(record));
    if (!java) throw new Error(`Java ${javaMajor(record)} isn't installed yet.`);
    const memory = Number(record.settings.memoryMb) || 4096;
    const extra = s(record, 'jvmArgs').split(/\s+/).filter(Boolean);
    const args = [`-Xms${Math.min(1024, memory)}M`, `-Xmx${memory}M`, ...extra];
    const argsFile = s(record, 'argsFile');
    if (argsFile) {
      // Modern Forge/NeoForge: java @user_jvm_args.txt @libraries/.../win_args.txt nogui
      if (existsSync(path.join(record.installDir, 'user_jvm_args.txt'))) args.push('@user_jvm_args.txt');
      args.push(`@${argsFile}`, 'nogui');
    } else {
      const jar = s(record, 'jar') || readdirSync(record.installDir).find((f) => /^server\.jar$/i.test(f)) || readdirSync(record.installDir).find((f) => f.toLowerCase().endsWith('.jar'));
      if (!jar) throw new Error('No server .jar found. Set "Server jar" in Settings.');
      args.push('-jar', jar);
      if (!isProxy(record)) args.push('nogui');
    }
    return { exe: java, args, cwd: record.installDir };
  },

  createParser: createJavaParser,

  addons: {
    available: (record) => contentKind(record) !== null,
    labels: (record) =>
      isProxy(record)
        ? { tab: 'Plugins', noun: 'plugin', plural: 'plugins', dropHelp: 'Drop BungeeCord plugin <b>.jar</b> files here, or choose files. They go in the proxy’s plugins folder. (Plugins for the servers behind the proxy go on those servers.)' }
        : contentKind(record) === 'plugins'
        ? { tab: 'Plugins', noun: 'plugin', plural: 'plugins', dropHelp: 'Drop plugin <b>.jar</b> files here, or choose files. They go in the plugins folder.' }
        : { tab: 'Mods', noun: 'mod', plural: 'mods', dropHelp: 'Drop mod <b>.jar</b> files here, or choose files. They go in the mods folder.' },
    accept: '.jar,.zip',
    links: contentLinks,
    list: listContent,
    install: installContent,
    remove: removeContent,
    setEnabled: setContentEnabled,
    icon: contentIcon,
    // Shown only on mod servers (the list gives each mod a side there).
    sides: MOD_SIDES,
    setSide: setContentSide,
    settings: { list: listJavaSettings, read: readJavaSettings, write: (record, file, values) => writeJavaSettings(record, file, values) },
  },

  diagnose: (record, logFile, since) => diagnoseJava(record, logFile, since),

  connection(record) {
    if (isProxy(record)) {
      // BungeeCord: config.yml "host: 0.0.0.0:25577" and "max_players: 1".
      const file = path.join(record.installDir, 'config.yml');
      const text = existsSync(file) ? readFileSync(file, 'utf-8') : '';
      const host = /^\s*-?\s*host:\s*['"]?[^'"\s]*:(\d+)/m.exec(text)?.[1];
      const max = /^\s*max_players:\s*(-?\d+)/m.exec(text)?.[1];
      return { port: Number(host) || 25577, protocol: 'TCP', maxPlayers: Number(max) > 0 ? Number(max) : null };
    }
    const { values } = readProperties(path.join(record.installDir, 'server.properties'));
    return { port: Number(values.get('server-port')) || 25565, protocol: 'TCP', maxPlayers: Number(values.get('max-players')) || null };
  },

  memoryLimit: (record) => ({
    mb: Number(record.settings.memoryMb) || 4096,
    label: 'Java heap limit',
    note: 'Change it with Memory in Settings (restart to apply). The process can use a bit more than this: Java needs some memory outside the heap.',
  }),

  async install(record, job) {
    const flavor = s(record, 'flavor');
    const mc = s(record, 'mcVersion');
    if (flavor === 'custom') throw new Error('This server was imported with its own jar; update it by replacing the jar.');
    if (!mc) throw new Error('No Minecraft version chosen.');
    const major = FLAVORS.find((f) => f.id === flavor)?.proxy ? 21 : await javaForMinecraft(mc);
    record.settings.javaVersion = JAVA_VERSIONS.includes(major) ? major : 21;
    job.update(`Getting Java ${record.settings.javaVersion}…`, null);
    const progress = (step: string, pct?: number | null) => job.update(step, pct);
    const java = await ensureJava(Number(record.settings.javaVersion), progress, (t) => job.line(t));
    // Spigot is compiled from source, which needs the full JDK; the server itself still runs on the JRE above.
    const builder = flavor === 'spigot' ? await ensureJava(Number(record.settings.javaVersion), progress, (t) => job.line(t), 'jdk') : java;
    const firstInstall = !existsSync(path.join(record.installDir, VERSION_FILE));
    const { launch, build } = await installFlavor(flavor, mc, record.installDir, builder, job);
    record.settings.jar = launch.kind === 'jar' ? launch.jar : '';
    record.settings.argsFile = launch.kind === 'argsfile' ? (launch as Extract<LaunchSpec, { kind: 'argsfile' }>).argsFile : '';
    if (record.settings.eulaAccepted === true) writeEula(record.installDir);
    if (firstInstall && record.settings.port && !isProxy(record)) {
      writeProperties(path.join(record.installDir, 'server.properties'), { 'server-port': String(record.settings.port) });
    }
    writeFileSync(path.join(record.installDir, VERSION_FILE), JSON.stringify({ flavor, mc, build, java: record.settings.javaVersion }));
    job.line(`${FLAVORS.find((f) => f.id === flavor)?.name} ${build} is installed (Java ${record.settings.javaVersion}).`);
  },

  async details(record) {
    const { values } = readProperties(path.join(record.installDir, 'server.properties'));
    const flavor = FLAVORS.find((f) => f.id === s(record, 'flavor'))?.name ?? 'Custom jar';
    const facts: [string, string | null][] = [
      ['Type', flavor],
      ['Minecraft version', s(record, 'mcVersion') || null],
      ['Java', `Java ${javaMajor(record)}`],
      ['Memory', `${Number(record.settings.memoryMb) || 4096} MB`],
      ['Port', values.get('server-port') ?? null],
      ['World', values.get('level-name') ?? null],
      ['Whitelist only', values.get('white-list') ?? null],
    ];
    return { facts: facts.filter(([, v]) => v != null && v !== '') };
  },

  properties: {
    read(record) {
      const file = path.join(record.installDir, 'server.properties');
      const { values } = readProperties(file);
      const entries: PropertyEntry[] = [];
      const add = (key: string, value: string | null) => {
        const info = JAVA_PROPS[key];
        entries.push({
          key,
          value,
          defaultValue: info?.def ?? null,
          description: info?.d ?? '',
          type: info?.t ?? (value === 'true' || value === 'false' ? 'boolean' : 'text'),
          options: info?.o,
          known: true,
          optional: !info,
        });
      };
      for (const key of Object.keys(JAVA_PROPS)) add(key, values.get(key) ?? null);
      for (const [key, value] of values) if (!JAVA_PROPS[key]) add(key, value);
      const problems = existsSync(file) ? [] : ['There is no server.properties yet; the server creates it on first start (or when you save here).'];
      if (isProxy(record)) problems.push('BungeeCord is configured in config.yml, not server.properties.');
      return { file, entries, problems };
    },
    write(record, changes) {
      for (const [key, value] of Object.entries(changes)) {
        if (/[\r\n]/.test(value)) throw new Error(`${key}: line breaks are not allowed.`);
        const info = JAVA_PROPS[key];
        if (info?.t === 'boolean' && !['true', 'false'].includes(value)) throw new Error(`${key} must be true or false.`);
        if (info?.t === 'number' && !/^-?\d+$/.test(value)) throw new Error(`${key} must be a whole number.`);
        if (info?.t === 'select' && info.o && !info.o.includes(value)) throw new Error(`${key} must be one of: ${info.o.join(', ')}.`);
      }
      writeProperties(path.join(record.installDir, 'server.properties'), changes, (k) => JAVA_PROPS[k]?.d);
    },
  },

  backup: {
    sources(record) {
      const level = readProperties(path.join(record.installDir, 'server.properties')).values.get('level-name') || 'world';
      // Bukkit-style servers (Paper/Spigot) keep the Nether and End in their own folders.
      return {
        base: record.installDir,
        include: [level, `${level}_nether`, `${level}_the_end`, 'server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'],
        world: level,
      };
    },
    async resume(io) {
      await io.command('save-on');
    },
    // Pause autosaving, force a full save to disk, copy, then turn saving back on.
    async hot(record, io) {
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        await io.command('save-on').catch(() => {});
      };
      try {
        await io.command('save-off');
        const saved = io.waitForLine(/Saved the game|Saved the world/i, 120_000);
        await io.command('save-all flush');
        await saved;
        const level = readProperties(path.join(record.installDir, 'server.properties')).values.get('level-name') || 'world';
        const files: { rel: string; length: number }[] = [];
        for (const dir of [level, `${level}_nether`, `${level}_the_end`]) walkFiles(path.join(record.installDir, dir), record.installDir, files);
        return { files, finish };
      } catch (err) {
        await finish();
        throw err;
      }
    },
  },

  accessLists: Object.entries(LISTS).map(([id, l]) => ({ id, label: l.label, help: l.help, entryLabel: 'Minecraft name' })),

  readAccessList(record, list) {
    if (!LISTS[list]) throw new Error('Unknown list.');
    return readList(record, list).map((e) => e.name);
  },

  async writeAccessList(record, list, entries, running) {
    const def = LISTS[list];
    if (!def) throw new Error('Unknown list.');
    const current = readList(record, list);
    const wanted = [...new Set(entries.map((e) => e.trim()).filter(Boolean))];
    for (const n of wanted) if (!/^[A-Za-z0-9_.]{2,16}$/.test(n)) throw new Error(`"${n}" isn't a valid Minecraft name.`);
    const lower = (x: string) => x.toLowerCase();
    const added = wanted.filter((n) => !current.some((c) => lower(c.name) === lower(n)));
    const removed = current.filter((c) => !wanted.some((n) => lower(n) === lower(c.name))).map((c) => c.name);
    if (running) {
      // The server owns these files while running; change them through its own commands.
      return [...added.map((n) => `${def.add} ${n}`), ...removed.map((n) => `${def.remove} ${n}`)];
    }
    const kept = current.filter((c) => !removed.includes(c.name));
    const newEntries = [];
    for (const name of added) {
      const uuid = await mojangUuid(name);
      if (list === 'ops') newEntries.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
      else if (list === 'banned') newEntries.push({ uuid, name, created: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' +0000', source: 'Server Forge', expires: 'forever', reason: 'Banned by an operator.' });
      else newEntries.push({ uuid, name });
    }
    const file = path.join(record.installDir, def.file);
    const tmp = `${file}.tavernhost-tmp`;
    writeFileSync(tmp, JSON.stringify([...kept, ...newEntries], null, 2) + '\n');
    cpSync(tmp, file);
    rmSync(tmp, { force: true });
    return [];
  },
};
