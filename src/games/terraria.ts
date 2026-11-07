// Terraria with tModLoader. The server comes from tModLoader's GitHub releases (tModLoader.zip, checked against the
// release's SHA-256); its .NET runtime is downloaded into the server folder the way tModLoader's own script does.
// The server is started directly (its dotnet + tModLoader.dll -server) in its own hidden console: it only reads typed
// commands from a real console (piped input is ignored), so Server Forge types them in (scripts/send-console-input.ps1),
// and reads tModLoader's own log (tModLoader-Logs/server.log) for the Console tab.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, renameSync, statSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { downloadFile, extractTar, extractZip } from '../download.ts';
import type { GameModule, LogParser, LogState, ServerRecord, Settings, AddonSupport } from './types.ts';
import type { Job } from '../jobs.ts';
import { workshopDownload } from '../steamcmd.ts';
import { workshopId, workshopTitle } from '../workshop.ts';

const RELEASES = 'https://api.github.com/repos/tModLoader/tModLoader/releases/latest';
const VERSION_FILE = '.tavernhost-version';
const CONFIG_FILE = 'tavernhost-serverconfig.txt';
const DOTNET = (dir: string) => path.join(dir, 'dotnet', bin('dotnet.exe', 'dotnet'));

export const SIZES = [
  { value: '1', label: 'Small (4200 × 1200)' },
  { value: '2', label: 'Medium (6400 × 1800)' },
  { value: '3', label: 'Large (8400 × 2400)' },
];
export const DIFFICULTIES = [
  { value: '0', label: 'Classic' },
  { value: '1', label: 'Expert' },
  { value: '2', label: 'Master' },
  { value: '3', label: 'Journey' },
];

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export const savesDir = (record: ServerRecord) => String(record.settings.saveDir || path.join(record.installDir, 'saves'));
const worldFile = (record: ServerRecord) => path.join(savesDir(record), 'Worlds', `${String(record.settings.world)}.wld`);
const modsDir = (record: ServerRecord) => path.join(savesDir(record), 'Mods');

/** The serverconfig.txt Server Forge writes before every start (its settings are the truth). Shared with vanilla Terraria. */
export function writeConfig(record: ServerRecord) {
  const s = record.settings;
  const lines = [
    '# Written by Server Forge before every start. Change these in Server Forge (Settings), not here.',
    `world=${worldFile(record)}`,
    `autocreate=${s.worldSize}`,
    `worldname=${s.world}`,
    `difficulty=${s.difficulty}`,
    ...(s.seed ? [`seed=${s.seed}`] : []),
    `maxplayers=${s.maxPlayers}`,
    `port=${s.port}`,
    ...(s.password ? [`password=${s.password}`] : []),
    ...(s.motd ? [`motd=${s.motd}`] : []),
    `worldpath=${path.join(savesDir(record), 'Worlds')}`,
    `banlist=${path.join(savesDir(record), 'banlist.txt')}`,
    `secure=${s.secure ? 1 : 0}`,
    'upnp=0',
    'language=en-US',
  ];
  writeFileSync(path.join(record.installDir, CONFIG_FILE), lines.join('\r\n') + '\r\n');
}

/** The .NET version tModLoader asks for (tModLoader.runtimeconfig.json → runtimeOptions.framework.version). */
function wantedDotnet(installDir: string): string {
  const cfg = JSON.parse(readFileSync(path.join(installDir, 'tModLoader.runtimeconfig.json'), 'utf-8'));
  const v = String(cfg?.runtimeOptions?.framework?.version ?? cfg?.runtimeOptions?.frameworks?.[0]?.version ?? '');
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("Couldn't read which .NET version tModLoader needs.");
  return v;
}

/** Downloads Microsoft's portable .NET runtime into <server>/dotnet, like tModLoader's InstallDotNet.sh. */
async function ensureDotnet(installDir: string, note: (m: string) => void) {
  const version = wantedDotnet(installDir);
  const have = path.join(installDir, 'dotnet', 'shared', 'Microsoft.NETCore.App', version);
  if (existsSync(DOTNET(installDir)) && existsSync(have)) return;
  note(`Downloading the .NET ${version} runtime tModLoader needs (once)…`);
  const work = path.join(os.tmpdir(), `tavernhost-dotnet-${randomBytes(4).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = path.join(work, isLinux ? 'dotnet.tar.gz' : 'dotnet.zip');
    const name = isLinux ? `dotnet-runtime-${version}-linux-x64.tar.gz` : `dotnet-runtime-${version}-win-x64.zip`;
    let last: Error | null = null;
    for (const base of ['https://builds.dotnet.microsoft.com/dotnet/Runtime', 'https://dotnetcli.azureedge.net/dotnet/Runtime']) {
      try {
        await downloadFile(`${base}/${version}/${name}`, zip);
        last = null;
        break;
      } catch (err) {
        last = err as Error;
      }
    }
    if (last) throw new Error(`Couldn't download .NET ${version}: ${last.message}`);
    rmSync(path.join(installDir, 'dotnet'), { recursive: true, force: true });
    if (isLinux) await extractTar(zip, path.join(installDir, 'dotnet'));
    else await extractZip(zip, path.join(installDir, 'dotnet'));
    if (!existsSync(DOTNET(installDir))) throw new Error('The .NET runtime download looked wrong (no dotnet.exe).');
    note(`.NET ${version} is ready.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

interface Release {
  version: string;
  url: string;
  digest: string | null;
}
async function latestRelease(): Promise<Release> {
  const res = await fetch(RELEASES, { headers: { 'User-Agent': 'TavernHost', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for tModLoader's releases.`);
  const r = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] };
  const asset = r.assets.find((a) => a.name === 'tModLoader.zip');
  if (!asset) throw new Error("tModLoader's latest release has no tModLoader.zip.");
  return { version: r.tag_name.replace(/^v/, ''), url: asset.browser_download_url, digest: asset.digest ?? null };
}

/** Installed tModLoader version (written by Server Forge after each install). */
export function installedTmlVersion(installDir: string): string | null {
  try {
    return readFileSync(path.join(installDir, VERSION_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
export const latestTmlVersion = async () => (await latestRelease()).version;

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

export function createTerrariaParser(): LogParser {
  const st: LogState = { ready: false, players: [], playerCount: 0, version: null, lastSave: null, extra: {} };
  const known: Record<string, string> = {};
  let tml: string | null = null;
  return {
    feed(line) {
      // "[15:04:58.896] [Main Thread/INFO] [StatusText]: Server started" → the message after the last "]: ".
      const msg = line.includes(']: ') ? line.slice(line.lastIndexOf(']: ') + 3).trim() : line.trim().replace(/^(: )+/, ''); // piped output has the server's ': ' prompt in front
      let m: RegExpExecArray | null;
      if (/^Server started$/.test(msg)) st.ready = true;
      else if ((m = /^Terraria Server v(\S+)/.exec(msg))) st.version = tml ? `${m[1]} (tModLoader ${tml})` : m[1];
      // "Adding Content: ModLoader (tModLoader) v2026.8.3.0"
      else if ((m = /tModLoader\)? v(\d[\d.]+)/.exec(msg)) && !tml) {
        tml = m[1];
        // The log names tModLoader's version; Terraria's own only shows in the console window.
        st.version = st.version && !st.version.includes('tModLoader') ? `${st.version} (tModLoader ${tml})` : `tModLoader ${tml}`;
      } else if (/^Saving world data/.test(msg)) st.lastSave = Date.now();
      else if ((m = /^(.{1,40}?) has joined\.?$/.exec(msg))) {
        const name = m[1];
        known[name] = name;
        if (!st.players.some((p) => p.name === name)) st.players.push({ name, joinedAt: Date.now() } as never);
        st.playerCount = st.players.length;
      } else if ((m = /^(.{1,40}?) has left\.?$/.exec(msg))) {
        st.players = st.players.filter((p) => p.name !== m![1]);
        st.playerCount = st.players.length;
      }
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

// ---------- mods (.tmod files in <saves>/Mods, switched on in enabled.json) ----------

function readEnabled(record: ServerRecord): string[] {
  try {
    const list = JSON.parse(readFileSync(path.join(modsDir(record), 'enabled.json'), 'utf-8'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}
function writeEnabled(record: ServerRecord, names: string[]) {
  mkdirSync(modsDir(record), { recursive: true });
  writeFileSync(path.join(modsDir(record), 'enabled.json'), JSON.stringify([...new Set(names)].sort(), null, 2));
}
const modName = (file: string) => path.basename(file, '.tmod');
/** An installed mod's file; the id comes from the request, so only plain names that exist are accepted. */
function installedMod(record: ServerRecord, id: string): string {
  const file = path.join(modsDir(record), `${id}.tmod`);
  if (!/^[\w.-]{1,100}$/.test(id) || !existsSync(file)) throw new Error('That mod is not installed.');
  return file;
}

const TML_GAME_APP = 1281930; // tModLoader on Steam: Workshop items belong to it

/**
 * The .tmod to use from a downloaded Workshop item. Items keep one build per tModLoader version (2026.1\\Mod.tmod ...),
 * and the newest one not newer than this server's tModLoader is the one that loads.
 */
function pickTmod(dir: string, serverVersion: string | null): string {
  const parts = (v: string) => (/\d+(\.\d+)*/.exec(v)?.[0] ?? '').split('.').slice(0, 2).map(Number);
  const newer = (a: number[], b: number[]) => (a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0)) > 0;
  const builds = readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isFile() && e.name.toLowerCase().endsWith('.tmod')) return [{ file: path.join(dir, e.name), version: [0, 0] }];
    if (!e.isDirectory() || !/^\d+\.\d+/.test(e.name)) return [];
    const sub = path.join(dir, e.name);
    return readdirSync(sub).filter((f) => f.toLowerCase().endsWith('.tmod')).map((f) => ({ file: path.join(sub, f), version: parts(e.name) }));
  });
  if (!builds.length) throw new Error("That Workshop item has no .tmod file. It may be a resource pack or something else that isn't a tModLoader mod.");
  const server = serverVersion ? parts(serverVersion) : null;
  const usable = server ? builds.filter((b) => !newer(b.version, server)) : builds;
  if (!usable.length) throw new Error(`That mod only has builds for newer tModLoader versions than this server's (${serverVersion}). Update the server first.`);
  return usable.sort((a, b) => (newer(a.version, b.version) ? -1 : 1))[0].file;
}

/**
 * The mods a .tmod can't load without. A .tmod is: "TMOD", the tModLoader version, a 20-byte hash, a 256-byte signature,
 * the data length, its name and version, then a file table and the files. Its Info file lists "modReferences". Best
 * effort: anything unexpected returns [] and tModLoader's log still names what's missing.
 */
function tmodRequires(file: string): string[] {
  try {
    const b = readFileSync(file);
    let at = 4;
    const str = (buf: Buffer) => {
      let len = 0;
      for (let shift = 0; ; shift += 7) {
        const byte = buf[at++];
        len |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
      }
      at += len;
      return buf.toString('utf-8', at - len, at);
    };
    if (b.toString('latin1', 0, 4) !== 'TMOD') return [];
    str(b);
    at += 20 + 256 + 4;
    str(b);
    str(b);
    const count = b.readInt32LE(at);
    at += 4;
    const files = [];
    for (let i = 0; i < count; i++) {
      const name = str(b);
      files.push({ name, length: b.readInt32LE(at), stored: b.readInt32LE(at + 4) });
      at += 8;
    }
    for (const f of files) {
      if (f.name === 'Info') {
        const raw = b.subarray(at, at + f.stored);
        const info = f.stored < f.length ? inflateRawSync(raw) : raw;
        const refs: string[] = [];
        at = 0;
        while (at < info.length) {
          const tag = str(info);
          if (tag === 'modReferences') {
            for (let r = str(info); r; r = str(info)) refs.push(r.split('@')[0]);
            return refs;
          }
          // Lists of names end with an empty string; other tags here hold a single value or nothing.
          if (tag.endsWith('References') || tag === 'sortAfter' || tag === 'sortBefore') while (str(info));
          else if (/^(author|version|displayName|homepage|description|modSide|eacPath|buildVersion)$/.test(tag)) str(info);
        }
        return refs;
      }
      at += f.stored;
    }
  } catch {}
  return [];
}

const terrariaAddons: AddonSupport = {
  accept: '.tmod',
  labels: () => ({ tab: 'Mods', noun: 'mod', plural: 'mods', dropHelp: 'Get mods from the Steam Workshop below, or add <b>.tmod</b> files. Players’ games download the server’s mods by themselves when they join. Restart the server to apply.' }),
  links: [],
  workshop: { url: 'https://steamcommunity.com/app/1281930/workshop/', needsLogin: true },
  list(record) {
    const dir = modsDir(record);
    if (!existsSync(dir)) return [];
    const enabled = new Set(readEnabled(record));
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.tmod'))
      .map((f) => ({ id: modName(f), name: modName(f), file: f, enabled: enabled.has(modName(f)), size: statSync(path.join(dir, f)).size, type: 'mod', typeLabel: 'tModLoader mod', typeClass: 'behavior' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  async install(record, file, source) {
    if (!file.toLowerCase().endsWith('.tmod')) throw new Error('tModLoader mods are .tmod files.');
    const name = modName(file).replace(/[^\w.-]/g, '_');
    mkdirSync(modsDir(record), { recursive: true });
    cpSync(file, path.join(modsDir(record), `${name}.tmod`));
    writeEnabled(record, [...readEnabled(record), name]);
    return { installed: [{ name, action: 'installed', source }], warnings: [] };
  },
  async addById(record, input) {
    const id = workshopId(input);
    await workshopTitle(id, TML_GAME_APP, 'tModLoader');
    const { root, dir } = await workshopDownload(TML_GAME_APP, id, 'tModLoader');
    try {
      const file = pickTmod(dir, installedTmlVersion(record.installDir));
      const { installed } = await terrariaAddons.install(record, file, 'Steam Workshop');
      const have = new Set((terrariaAddons.list(record) as { id: string }[]).map((m) => m.id));
      const missing = tmodRequires(file).filter((m) => !have.has(m));
      const warnings = ['Restart the server to load it.'];
      if (missing.length) warnings.push(`It needs ${missing.join(', ')}, or tModLoader will switch it off. Add ${missing.length === 1 ? 'that mod' : 'those mods'} too (on its Workshop page: Required Items).`);
      return { installed, warnings };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  remove(record, id) {
    rmSync(installedMod(record, id), { force: true });
    writeEnabled(record, readEnabled(record).filter((n) => n !== id));
  },
  setEnabled(record, id, enabled) {
    installedMod(record, id);
    writeEnabled(record, enabled ? [...readEnabled(record), id] : readEnabled(record).filter((n) => n !== id));
  },
  icon: () => null,
} as AddonSupport;

export const terraria: GameModule = {
  id: 'terraria',
  name: 'Terraria (tModLoader)',
  processName: bin('dotnet.exe', 'dotnet'),

  fields: [
    { key: 'world', label: 'World name', type: 'text', help: 'Created automatically the first time (with the size and difficulty below).', restart: true },
    { key: 'worldSize', label: 'World size (new worlds)', type: 'select', options: SIZES, restart: true },
    { key: 'difficulty', label: 'Difficulty (new worlds)', type: 'select', options: DIFFICULTIES, restart: true },
    { key: 'seed', label: 'Seed (new worlds, optional)', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 7777 (TCP).', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional.', restart: true },
    { key: 'motd', label: 'Message of the day', type: 'text', restart: true },
    { key: 'secure', label: 'Cheat protection', type: 'boolean', help: 'Kicks players for suspicious actions.', restart: true },
    { key: 'saveDir', label: 'Save folder', type: 'folder', help: 'Worlds, mods (Mods folder) and settings live here.', restart: true },
  ],
  quickFields: ['world', 'worldSize', 'difficulty', 'port', 'maxPlayers', 'password'],

  defaults: ({ installDir }) => ({ world: 'Terraria', worldSize: '2', difficulty: '0', seed: '', port: 7777, maxPlayers: 8, password: '', motd: '', secure: false, saveDir: path.join(installDir, 'saves') }),

  validate(s: Settings): Settings {
    const world = String(s.world ?? '').trim();
    if (!/^[\w -]{1,40}$/.test(world)) throw new Error('World name can only use letters, numbers, spaces, - and _ (up to 40).');
    const size = String(s.worldSize ?? '2');
    if (!SIZES.some((o) => o.value === size)) throw new Error('Pick a world size.');
    const difficulty = String(s.difficulty ?? '0');
    if (!DIFFICULTIES.some((o) => o.value === difficulty)) throw new Error('Pick a difficulty.');
    const seed = String(s.seed ?? '').trim();
    if (seed.length > 60 || /[\r\n]/.test(seed)) throw new Error('Seed: one line, up to 60 characters.');
    const password = String(s.password ?? '');
    const motd = String(s.motd ?? '').trim();
    if (/[\r\n]/.test(password + motd)) throw new Error('Password and message of the day must be one line.');
    const dir = String(s.saveDir ?? '').trim();
    if (!path.isAbsolute(dir)) throw new Error('Save folder must be a full path.');
    return {
      world,
      worldSize: size,
      difficulty,
      seed,
      port: num(s.port, 'Port', 1024, 65535),
      maxPlayers: num(s.maxPlayers, 'Max players', 1, 255),
      password,
      motd: motd.slice(0, 200),
      secure: s.secure === true || s.secure === 'true',
      saveDir: dir,
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, 'tModLoader.dll'))) throw new Error('tModLoader.dll was not found in that folder (use a tModLoader server folder).');
  },

  async prepare(record, note) {
    await ensureDotnet(record.installDir, note);
    mkdirSync(path.join(savesDir(record), 'Worlds'), { recursive: true });
    writeConfig(record);
    // tModLoader starts a fresh server.log each run; move the old one aside so its lines aren't read again.
    const log = path.join(record.installDir, 'tModLoader-Logs', 'server.log');
    try {
      if (existsSync(log)) renameSync(log, log.replace(/\.log$/, '.tavernhost-previous.log'));
    } catch {}
  },

  launch(record) {
    return {
      exe: DOTNET(record.installDir),
      args: ['tModLoader.dll', '-server', '-config', CONFIG_FILE, '-tmlsavedirectory', savesDir(record)],
      cwd: record.installDir,
    };
  },

  consoleCommands: { stop: 'exit' },
  gameLog: (record) => path.join(record.installDir, 'tModLoader-Logs', 'server.log'),
  // World generation and mod loading print hundreds of progress lines; keep them out of the Console tab.
  hideLine: (line) => /\]: \d{1,3}(\.\d)?% - |\/DEBUG\]|^\s*$/.test(line),

  createParser: createTerrariaParser,

  connection: (record) => ({ port: Number(record.settings.port) || 7777, protocol: 'TCP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: {
    sources: (record) => ({ base: savesDir(record), include: ['Worlds', 'ModConfigs', 'Mods/enabled.json'], world: 'Worlds' }),
  },

  addons: terrariaAddons,

  async install(record, job: Job, opts) {
    job.update('Looking up the latest tModLoader…', null);
    const rel = await latestRelease();
    if (!opts?.force && installedTmlVersion(record.installDir) === rel.version && existsSync(path.join(record.installDir, 'tModLoader.dll'))) {
      job.line(`tModLoader ${rel.version} is already installed.`);
      return;
    }
    const work = path.join(os.tmpdir(), `tavernhost-tml-${randomBytes(4).toString('hex')}`);
    mkdirSync(work, { recursive: true });
    try {
      const zip = path.join(work, 'tModLoader.zip');
      job.update(`Downloading tModLoader ${rel.version}…`, null);
      await downloadFile(rel.url, zip);
      const digest = /^sha256:([0-9a-f]{64})$/i.exec(rel.digest ?? '');
      if (digest && digest[1].toLowerCase() !== (await sha256(zip))) throw new Error("The download doesn't match the release's checksum, so it wasn't installed.");
      job.update('Unpacking…', null);
      await extractZip(zip, path.join(work, 'tml'));
      mkdirSync(record.installDir, { recursive: true });
      // Replace tModLoader's files; the downloaded runtime (dotnet), saves and Server Forge's config stay.
      cpSync(path.join(work, 'tml'), record.installDir, { recursive: true, force: true });
      writeFileSync(path.join(record.installDir, VERSION_FILE), rel.version);
      job.line(`tModLoader ${rel.version} is installed.`);
      await ensureDotnet(record.installDir, (m) => job.line(m));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};
