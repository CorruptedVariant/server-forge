// Factorio dedicated server. Factorio's Windows server is the full game started with --start-server (the "headless"
// build is Linux-only), downloaded from factorio.com as the win64-manual zip with the owner's factorio.com login
// (Settings → Integrations): the "expansion" build for accounts that own Space Age, else "alpha" (the base game).
// Everything the server writes stays in its own folder (config-path.cfg points there, not at %APPDATA%): saves/, mods/,
// config/, the server-*.json lists and factorio-current.log.
// It runs under Server Forge's runner (output captured, commands piped). Factorio commands start with "/" (text without
// one is chat), so commands keep their slash. Stop saves first (/server-save), then /quit.
// Mods come from the Factorio mod portal (needs the same login); players' games download a server's mods by themselves
// when they join, so the share link only carries how to join.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, cpSync, copyFileSync, statSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { downloadFile, extractZip, formatBytes, extractTar } from '../download.ts';
import { factorioLogin, latestReleases } from '../factorio-key.ts';
import { ZipFile } from '../zip.ts';
import type { GameModule, LogParser, LogState, ServerRecord, Settings, AddonSupport } from './types.ts';
import type { Job } from '../jobs.ts';

const execFileAsync = promisify(execFile);
const EXE_REL = path.join('bin', 'x64', bin('factorio.exe', 'factorio'));
const VERSION_FILE = '.tavernhost-version';
const SETTINGS_FILE = 'server-settings.json';
const LISTS = { admins: 'server-adminlist.json', whitelist: 'server-whitelist.json', banned: 'server-banlist.json' } as const;
/** Mods that come with the game (in data/), switched on or off in mod-list.json but never downloaded or removed. */
const BUILT_IN = new Set(['base', 'core', 'space-age', 'quality', 'elevated-rails']);
const EXPANSION_MODS = ['space-age', 'quality', 'elevated-rails'];
const PORTAL = 'https://mods.factorio.com';
const UA = { 'User-Agent': 'TavernHost' };

const PRESETS = [
  { value: 'default', label: 'Default' },
  { value: 'rich-resources', label: 'Rich resources' },
  { value: 'marathon', label: 'Marathon (expensive recipes)' },
  { value: 'death-world', label: 'Death world' },
  { value: 'death-world-marathon', label: 'Death world marathon' },
  { value: 'rail-world', label: 'Rail world' },
  { value: 'ribbon-world', label: 'Ribbon world' },
  { value: 'island', label: 'Island' },
];

const exe = (record: Pick<ServerRecord, 'installDir'>) => path.join(record.installDir, EXE_REL);
const savesDir = (record: ServerRecord) => path.join(record.installDir, 'saves');
const modsDir = (record: ServerRecord) => path.join(record.installDir, 'mods');
const saveFile = (record: ServerRecord) => path.join(savesDir(record), `${record.settings.world}.zip`);

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
const bool = (v: unknown) => v === true || v === 'true';

// ---------- installed version ----------

export function installedFactorio(installDir: string): { version: string; build: string } | null {
  try {
    const v = JSON.parse(readFileSync(path.join(installDir, VERSION_FILE), 'utf-8'));
    return v.version ? { version: String(v.version), build: String(v.build ?? 'alpha') } : null;
  } catch {
    return null;
  }
}

/** The build to download for this server: Space Age only for accounts that own it (and servers that want it). */
function wantedBuild(record: ServerRecord): 'alpha' | 'expansion' {
  if (isLinux) return record.settings.spaceAge ? 'expansion' : 'alpha'; // the headless server contains Space Age: nothing to download or prove
  return record.settings.spaceAge && factorioLogin()?.spaceAge ? 'expansion' : 'alpha';
}

export async function latestFactorio(channel: string, build: string): Promise<string> {
  const r = await latestReleases();
  const v = (channel === 'experimental' ? r.experimental : r.stable)?.[isLinux ? 'headless' : build === 'expansion' ? 'expansion' : 'alpha'];
  if (!v) throw new Error("factorio.com didn't list a current version.");
  return v;
}

// ---------- files the server reads ----------

/** Write data stays in the server folder (saves, mods, config, logs), never in %APPDATA%\Factorio. */
function writeConfigPath(record: ServerRecord) {
  writeFileSync(path.join(record.installDir, 'config-path.cfg'), 'config-path=__PATH__executable__/../../config\nuse-system-read-write-data-directories=false\n'.replace(/\n/g, isLinux ? '\n' : '\r\n'));
}

function writeServerSettings(record: ServerRecord) {
  const s = record.settings;
  const login = factorioLogin();
  const settings = {
    name: s.serverName,
    description: s.description,
    tags: ['Server Forge'],
    max_players: Number(s.maxPlayers) || 0,
    // Public listing needs a factorio.com login; without one the server is LAN/direct-connect only.
    visibility: { public: !!(s.public && login), lan: s.lan !== false },
    username: s.public && login ? login.username : '',
    token: s.public && login ? login.token : '',
    password: '',
    game_password: s.password ?? '',
    require_user_verification: s.verifyUsers !== false,
    max_upload_in_kilobytes_per_second: 0,
    max_upload_slots: 5,
    minimum_latency_in_ticks: 0,
    max_heartbeats_per_second: 60,
    ignore_player_limit_for_returning_players: false,
    allow_commands: 'admins-only',
    autosave_interval: Number(s.autosaveMinutes) || 10,
    autosave_slots: Number(s.autosaveSlots) || 5,
    afk_autokick_interval: Number(s.afkKickMinutes) || 0,
    auto_pause: s.autoPause !== false,
    auto_pause_when_players_connect: false,
    only_admins_can_pause_the_game: true,
    autosave_only_on_server: true,
    non_blocking_saving: false,
    minimum_segment_size: 25,
    minimum_segment_size_peer_count: 20,
    maximum_segment_size: 100,
    maximum_segment_size_peer_count: 10,
  };
  writeFileSync(path.join(record.installDir, SETTINGS_FILE), JSON.stringify(settings, null, 2));
}

interface ModList {
  mods: { name: string; enabled: boolean }[];
}
function readModList(record: ServerRecord): ModList {
  try {
    const m = JSON.parse(readFileSync(path.join(modsDir(record), 'mod-list.json'), 'utf-8'));
    return Array.isArray(m?.mods) ? m : { mods: [] };
  } catch {
    return { mods: [] };
  }
}
function writeModList(record: ServerRecord, list: ModList) {
  mkdirSync(modsDir(record), { recursive: true });
  writeFileSync(path.join(modsDir(record), 'mod-list.json'), JSON.stringify(list, null, 2));
}
function setModListEntry(record: ServerRecord, name: string, enabled: boolean | null) {
  const list = readModList(record);
  list.mods = list.mods.filter((m) => m.name !== name);
  if (enabled !== null) list.mods.push({ name, enabled });
  writeModList(record, list);
}

/** Space Age's three mods follow the "Space Age" setting (only on the expansion build). */
function applyExpansion(record: ServerRecord) {
  const on = isLinux ? !!record.settings.spaceAge : installedFactorio(record.installDir)?.build === 'expansion' && !!record.settings.spaceAge;
  const list = readModList(record);
  for (const name of ['base', ...EXPANSION_MODS]) {
    list.mods = list.mods.filter((m) => m.name !== name);
    list.mods.push({ name, enabled: name === 'base' || on });
  }
  writeModList(record, list);
}

function readList(record: ServerRecord, list: keyof typeof LISTS): string[] {
  try {
    const data = JSON.parse(readFileSync(path.join(record.installDir, LISTS[list]), 'utf-8'));
    // The ban list may hold {username, reason} objects.
    return (Array.isArray(data) ? data : []).map((e: unknown) => (typeof e === 'string' ? e : String((e as { username?: string })?.username ?? ''))).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- log ----------

function createFactorioParser(): LogParser {
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
      if ((m = /Factorio (\d+\.\d+\.\d+) \(build \d+/.exec(line)) && !st.version) st.version = m[1];
      if (/changing state from\(\w+\) to\(InGame\)/.test(line)) st.ready = true;
      if (/changing state from\(InGame\) to\(\w+\)|Quitting multiplayer connection|Goodbye/.test(line)) {
        st.ready = false;
        online.clear();
        sync();
      }
      if (/Saving finished|Saving process took/.test(line)) st.lastSave = Date.now();
      if ((m = /\[JOIN\] (.{1,60}?) joined the game/.exec(line))) {
        known[m[1]] = m[1];
        online.set(m[1], Date.now());
        sync();
      } else if ((m = /\[LEAVE\] (.{1,60}?) left the game/.exec(line))) {
        online.delete(m[1]);
        sync();
      }
    },
    state: () => st,
    knownPlayers: () => known,
  };
}

// ---------- mods (Factorio mod portal) ----------

interface ModInfo {
  name: string;
  version: string;
  title: string;
  author: string;
  description: string;
  factorio_version: string;
  dependencies: string[];
}

/** info.json from a mod zip (it sits in the zip's top folder, "<name>_<version>/info.json"). */
function readModZip(file: string): ModInfo {
  const zip = new ZipFile(file);
  try {
    const entry = zip.names().find((n) => /^[^/\\]+[/\\]info\.json$/.test(n) || n === 'info.json');
    const info = entry ? JSON.parse(zip.text(entry) ?? '{}') : null;
    if (!info?.name || !info?.version) throw new Error("That zip has no info.json, so it isn't a Factorio mod.");
    if (!/^[\w -]{1,100}$/.test(info.name) || !/^\d+\.\d+\.\d+$/.test(info.version)) throw new Error("The mod's info.json has an invalid name or version.");
    return {
      name: String(info.name),
      version: String(info.version),
      title: String(info.title ?? info.name),
      author: String(info.author ?? ''),
      description: String(info.description ?? ''),
      factorio_version: String(info.factorio_version ?? ''),
      dependencies: Array.isArray(info.dependencies) ? info.dependencies.map(String) : [],
    };
  } finally {
    zip.close();
  }
}

function modZips(record: ServerRecord): { file: string; info: ModInfo }[] {
  const dir = modsDir(record);
  if (!existsSync(dir)) return [];
  const out: { file: string; info: ModInfo }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.toLowerCase().endsWith('.zip')) continue;
    try {
      out.push({ file: f, info: readModZip(path.join(dir, f)) });
    } catch {}
  }
  return out;
}

/** "? name >= 1.0" → { kind: 'optional', name }; required ones have no prefix (or "~": required, load order free). */
function parseDependency(dep: string): { kind: 'required' | 'optional' | 'incompatible'; name: string } | null {
  const m = /^\s*(\(\?\)|\?|!|~)?\s*([\w -]+?)\s*(?:[<>=]=?\s*[\d.]+)?\s*$/.exec(dep);
  if (!m) return null;
  return { kind: m[1] === '!' ? 'incompatible' : m[1] === '?' || m[1] === '(?)' ? 'optional' : 'required', name: m[2].trim() };
}

const majorMinor = (v: string) => v.split('.').slice(0, 2).join('.');

/** The newest release of a mod for this server's Factorio version, from the mod portal. */
async function portalRelease(name: string, factorioVersion: string) {
  const res = await fetch(`${PORTAL}/api/mods/${encodeURIComponent(name)}/full`, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) throw new Error(`The mod portal has no mod called "${name}".`);
  if (!res.ok) throw new Error(`The mod portal answered ${res.status}.`);
  const mod = (await res.json()) as { name: string; title: string; releases: { version: string; download_url: string; file_name: string; sha1: string; info_json: { factorio_version: string; dependencies?: string[] } }[] };
  const fits = mod.releases.filter((r) => majorMinor(r.info_json.factorio_version) === majorMinor(factorioVersion));
  const release = fits[fits.length - 1];
  if (!release) throw new Error(`${mod.title} has no version for Factorio ${majorMinor(factorioVersion)}.`);
  return { name: mod.name, title: mod.title, ...release };
}

async function downloadMod(record: ServerRecord, release: Awaited<ReturnType<typeof portalRelease>>): Promise<string> {
  const login = factorioLogin();
  if (!login) throw new Error('Downloading from the mod portal needs your factorio.com login (Settings → Integrations). You can still drop mod zips here.');
  if (!/^[\w -]+_\d+\.\d+\.\d+\.zip$/.test(release.file_name)) throw new Error('The mod portal gave an unexpected file name.');
  const dest = path.join(os.tmpdir(), `tavernhost-factorio-mod-${randomBytes(4).toString('hex')}-${release.file_name}`);
  await downloadFile(`${PORTAL}${release.download_url}?username=${encodeURIComponent(login.username)}&token=${encodeURIComponent(login.token)}`, dest);
  return dest;
}

/** Puts a mod zip in mods/ (replacing other versions of it) and switches it on. */
function placeMod(record: ServerRecord, file: string): ModInfo {
  const info = readModZip(file);
  if (BUILT_IN.has(info.name)) throw new Error(`${info.name} comes with the game; it can't be installed as a mod.`);
  mkdirSync(modsDir(record), { recursive: true });
  for (const m of modZips(record)) if (m.info.name === info.name) rmSync(path.join(modsDir(record), m.file), { force: true });
  copyFileSync(file, path.join(modsDir(record), `${info.name}_${info.version}.zip`));
  setModListEntry(record, info.name, true);
  return info;
}

/** Installs a mod from the portal with the mods it requires (built-in ones excepted). */
async function installFromPortal(record: ServerRecord, name: string) {
  const version = installedFactorio(record.installDir)?.version;
  if (!version) throw new Error('Install the server first.');
  const have = new Set(modZips(record).map((m) => m.info.name));
  const installed: { name: string; type: string; version: string; action: string }[] = [];
  const warnings: string[] = [];
  const queue = [name];
  const seen = new Set<string>();
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next) || BUILT_IN.has(next)) continue;
    seen.add(next);
    const release = await portalRelease(next, version);
    const file = await downloadMod(record, release);
    try {
      const info = placeMod(record, file);
      installed.push({ name: release.title, type: next === name ? 'mod' : 'dependency', version: info.version, action: have.has(info.name) ? 'updated' : 'installed' });
    } finally {
      rmSync(file, { force: true });
    }
    for (const d of release.info_json.dependencies ?? []) {
      const dep = parseDependency(d);
      if (!dep) continue;
      if (dep.kind === 'required' && !have.has(dep.name)) queue.push(dep.name);
      if (dep.kind === 'incompatible' && (have.has(dep.name) || seen.has(dep.name))) warnings.push(`${release.title} says it doesn't work with ${dep.name}.`);
      if (EXPANSION_MODS.includes(dep.name) && dep.kind === 'required' && !record.settings.spaceAge) warnings.push(`${release.title} needs Space Age (${dep.name}); turn Space Age on in Settings.`);
    }
  }
  return { installed, warnings };
}

/** "https://mods.factorio.com/mod/Krastorio2", "mods.factorio.com/mod/Krastorio2/downloads" or just "Krastorio2". */
function modNameFrom(input: string): string {
  const s = input.trim();
  const m = /mods\.factorio\.com\/mod\/([^/?#]+)/i.exec(s);
  const name = decodeURIComponent(m ? m[1] : s);
  if (!/^[\w -]{1,100}$/.test(name)) throw new Error('Paste a mod page address from mods.factorio.com, or the mod\'s name.');
  return name;
}

const factorioAddons: AddonSupport = {
  accept: '.zip',
  needsStopped: true,
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp: 'Drop a Factorio mod <b>.zip</b> here, or add one from the mod portal by name or link above. Players\' games download the server\'s mods by themselves when they join.',
  }),
  links: [{ label: 'Factorio mod portal', url: 'https://mods.factorio.com/', help: 'Copy a mod page address and paste it in the box above, or download the zip.' }],
  status(record) {
    const login = factorioLogin();
    return login
      ? { ok: true, title: `Mod portal: signed in as ${login.username}`, text: 'Paste a mod page address (or name) to install it with the mods it needs. Players\' games download the same mods by themselves when they join.' }
      : { ok: false, title: 'Mod portal downloads need your factorio.com login', text: 'Add it in Settings → Integrations to install mods by name or link and to check for updates. Mod zips can still be dropped here.' };
  },
  list(record) {
    const enabled = new Map(readModList(record).mods.map((m) => [m.name, m.enabled]));
    return modZips(record)
      .map(({ file, info }) => ({
        id: info.name,
        name: info.title,
        version: info.version,
        description: info.description,
        authors: info.author,
        typeLabel: 'Mod',
        typeClass: 'mod',
        enabled: enabled.get(info.name) !== false,
        hasIcon: true,
        source: `for Factorio ${info.factorio_version || '?'}`,
        file,
        warnings: (() => {
          const v = installedFactorio(record.installDir)?.version;
          return v && info.factorio_version && majorMinor(v) !== majorMinor(info.factorio_version) ? [{ level: 'error', text: `Made for Factorio ${info.factorio_version}; this server runs ${majorMinor(v)}.` }] : [];
        })(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  async install(record, file) {
    if (!/\.zip$/i.test(file)) throw new Error('Factorio mods are .zip files.');
    const info = placeMod(record, file);
    const warnings: string[] = [];
    const have = new Set(modZips(record).map((m) => m.info.name));
    const missing = info.dependencies.map(parseDependency).filter((d) => d?.kind === 'required' && !BUILT_IN.has(d.name) && !have.has(d.name)).map((d) => d!.name);
    if (missing.length) warnings.push(`${info.title} needs ${missing.join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} installed. Add ${missing.length === 1 ? 'it' : 'them'} by name above.`);
    return { installed: [{ name: info.title, type: 'mod', version: info.version, action: 'installed' }], warnings };
  },
  addById: (record, input) => installFromPortal(record, modNameFrom(input)),
  addByIdPlaceholder: 'Mod portal link or mod name, e.g. https://mods.factorio.com/mod/even-distribution',
  remove(record, id) {
    const m = modZips(record).find((x) => x.info.name === id);
    if (!m) throw new Error('That mod is not installed.');
    rmSync(path.join(modsDir(record), m.file), { force: true });
    setModListEntry(record, id, null);
  },
  setEnabled(record, id, enabled) {
    if (!modZips(record).some((x) => x.info.name === id)) throw new Error('That mod is not installed.');
    setModListEntry(record, id, enabled);
  },
  icon(record, id) {
    const m = modZips(record).find((x) => x.info.name === id);
    if (!m) return null;
    const zip = new ZipFile(path.join(modsDir(record), m.file));
    try {
      const entry = zip.names().find((n) => /^[^/\\]+[/\\]thumbnail\.png$/.test(n));
      return entry ? zip.get(entry, 2 * 1024 * 1024) : null;
    } finally {
      zip.close();
    }
  },
  async checkUpdates(record) {
    const version = installedFactorio(record.installDir)?.version;
    if (!version) return {};
    const out: Record<string, string> = {};
    await Promise.all(
      modZips(record).map(async ({ info }) => {
        try {
          const r = await portalRelease(info.name, version);
          if (r.version !== info.version && r.version.localeCompare(info.version, undefined, { numeric: true }) > 0) out[info.name] = r.version;
        } catch {}
      }),
    );
    return out;
  },
  update: (record, id) => installFromPortal(record, id),
};

// ---------- access lists ----------

/** Factorio rewrites its list files from memory when it shuts down, so while it runs lists change through commands. */
function listCommands(list: string, added: string[], removed: string[]): string[] {
  if (list === 'admins') return [...added.map((n) => `/promote ${n}`), ...removed.map((n) => `/demote ${n}`)];
  if (list === 'whitelist') return [...added.map((n) => `/whitelist add ${n}`), ...removed.map((n) => `/whitelist remove ${n}`)];
  return [...added.map((n) => `/ban ${n} Banned in Server Forge`), ...removed.map((n) => `/unban ${n}`)];
}

// ---------- install ----------

/** Unpacks with Windows' tar (much faster than Expand-Archive on Factorio's ~1.5 GB zip); Expand-Archive if tar fails. */
async function unzipFast(zip: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  try {
    await execFileAsync('tar.exe', ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 30 * 60_000 });
  } catch {
    await extractZip(zip, dest);
  }
}

/** Linux has Factorio's headless server: a free download, no factorio.com login, and it includes Space Age's content. */
async function installHeadless(record: ServerRecord, job: Job, opts?: { force?: boolean }) {
  const build = wantedBuild(record);
  job.update('Looking up the latest Factorio version…', null);
  const version = await latestFactorio(String(record.settings.channel ?? 'stable'), build);
  const have = installedFactorio(record.installDir);
  if (!opts?.force && have?.version === version && existsSync(exe(record))) {
    job.line(`Factorio ${version} is already installed.`);
    return;
  }
  const work = path.join(os.tmpdir(), `tavernhost-factorio-${randomBytes(4).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  try {
    const archive = path.join(work, 'factorio.tar.xz');
    job.update(`Downloading Factorio ${version}…`, 0);
    await downloadFile(`https://www.factorio.com/get-download/${version}/headless/linux64`, archive, (pct, got) => job.update(`Downloading Factorio ${version}… ${formatBytes(got)}`, pct));
    job.update('Unpacking…', null);
    await extractTar(archive, path.join(work, 'x'));
    const top = readdirSync(path.join(work, 'x')).map((d) => path.join(work, 'x', d)).find((d) => existsSync(path.join(d, EXE_REL)));
    if (!top) throw new Error('The download has no Factorio server in it.');
    mkdirSync(record.installDir, { recursive: true });
    for (const d of ['bin', 'data']) rmSync(path.join(record.installDir, d), { recursive: true, force: true });
    cpSync(top, record.installDir, { recursive: true, force: true });
    writeConfigPath(record);
    writeFileSync(path.join(record.installDir, VERSION_FILE), JSON.stringify({ version, build, at: Date.now() }, null, 2));
    job.line(`Factorio ${version} is installed.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function install(record: ServerRecord, job: Job, opts?: { force?: boolean }) {
  if (isLinux) return installHeadless(record, job, opts);
  const login = factorioLogin();
  if (!login) throw new Error("Factorio's server download needs your factorio.com login: add it in Settings → Integrations (paste your username and token, or import it from this PC), then try again.");
  const build = wantedBuild(record);
  job.update('Looking up the latest Factorio version…', null);
  const version = await latestFactorio(String(record.settings.channel ?? 'stable'), build);
  const have = installedFactorio(record.installDir);
  if (!opts?.force && have?.version === version && have.build === build && existsSync(exe(record))) {
    job.line(`Factorio ${version} is already installed.`);
    return;
  }
  const work = path.join(os.tmpdir(), `tavernhost-factorio-${randomBytes(4).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  try {
    const zip = path.join(work, 'factorio.zip');
    const label = `Factorio ${version}${build === 'expansion' ? ' (Space Age)' : ''}`;
    job.update(`Downloading ${label}…`, 0);
    const url = `https://www.factorio.com/get-download/${version}/${build}/win64-manual?username=${encodeURIComponent(login.username)}&token=${encodeURIComponent(login.token)}`;
    await downloadFile(url, zip, (pct, got) => job.update(`Downloading ${label}… ${formatBytes(got)}`, pct)).catch((err) => {
      throw new Error(/HTTP 403/.test(err.message) ? "factorio.com refused the download: check your login in Settings → Integrations (and that the account owns this build)." : err.message);
    });
    job.update('Unpacking (this takes a minute)…', null);
    await unzipFast(zip, path.join(work, 'x'));
    rmSync(zip, { force: true });
    const top = readdirSync(path.join(work, 'x')).map((d) => path.join(work, 'x', d)).find((d) => existsSync(path.join(d, EXE_REL)));
    if (!top) throw new Error('The download has no factorio.exe in it.');
    mkdirSync(record.installDir, { recursive: true });
    // The game's own folders are replaced; saves, mods, config and the player lists stay.
    for (const d of ['bin', 'data']) rmSync(path.join(record.installDir, d), { recursive: true, force: true });
    job.update('Copying files…', null);
    cpSync(top, record.installDir, { recursive: true, force: true });
    writeConfigPath(record);
    writeFileSync(path.join(record.installDir, VERSION_FILE), JSON.stringify({ version, build, at: Date.now() }, null, 2));
    job.line(`${label} is installed.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------- the module ----------

export const factorio: GameModule = {
  id: 'factorio',
  name: 'Factorio',
  processName: bin('factorio.exe', 'factorio'),

  fields: [
    { key: 'serverName', label: 'Server name', type: 'text', help: 'Shown in the server browser.', restart: true },
    { key: 'description', label: 'Description', type: 'text', restart: true },
    { key: 'port', label: 'Port', type: 'number', help: 'Default 34197 (UDP).', restart: true },
    { key: 'password', label: 'Password', type: 'password', help: 'Optional. Players type it to join.', restart: true },
    { key: 'maxPlayers', label: 'Max players', type: 'number', help: '0 = no limit.', restart: true },
    { key: 'public', label: 'List publicly', type: 'boolean', help: "In Factorio's public server browser (uses your factorio.com login from Settings → Integrations).", restart: true },
    { key: 'lan', label: 'Show on the local network', type: 'boolean', restart: true },
    { key: 'verifyUsers', label: 'Only verified factorio.com players', type: 'boolean', help: 'Players must be logged in to factorio.com (needed for bans and lists to mean anything).', restart: true },
    { key: 'spaceAge', label: 'Space Age', type: 'boolean', help: 'Use the Space Age expansion (your factorio.com account must own it; players need it too). Changing it reinstalls the game files.', restart: true },
    {
      key: 'channel',
      label: 'Versions',
      type: 'select',
      options: [
        { value: 'stable', label: 'Stable' },
        { value: 'experimental', label: 'Experimental (newest, may have bugs)' },
      ],
      help: "Players' games must run the same version.",
      restart: true,
    },
    { key: 'world', label: 'Save name', type: 'text', help: 'saves/<name>.zip. Created when the server first starts.', restart: true, section: 'World' },
    { key: 'preset', label: 'Map preset (new map)', type: 'select', options: PRESETS, help: 'Used once, when the save is created.', restart: false, section: 'World' },
    { key: 'seed', label: 'Map seed (new map)', type: 'text', help: 'Optional number. Empty = random.', restart: false, section: 'World' },
    { key: 'autosaveMinutes', label: 'Autosave every (minutes)', type: 'number', restart: true, section: 'World' },
    { key: 'autosaveSlots', label: 'Autosave slots', type: 'number', restart: true, section: 'World' },
    { key: 'autoPause', label: 'Pause when nobody is online', type: 'boolean', restart: true, section: 'World' },
    { key: 'afkKickMinutes', label: 'Kick AFK players after (minutes)', type: 'number', help: '0 = never.', restart: true, section: 'World' },
  ],
  quickFields: ['serverName', 'port', 'password', 'spaceAge', 'world', 'preset', 'seed'],

  defaults: () => ({
    serverName: 'My Factorio Server',
    description: 'Hosted with Server Forge',
    port: 34197,
    password: '',
    maxPlayers: 0,
    public: false,
    lan: true,
    verifyUsers: true,
    spaceAge: !!factorioLogin()?.spaceAge,
    channel: 'stable',
    world: 'tavern',
    preset: 'default',
    seed: '',
    autosaveMinutes: 10,
    autosaveSlots: 5,
    autoPause: true,
    afkKickMinutes: 0,
  }),

  validate(s: Settings): Settings {
    const serverName = String(s.serverName ?? '').trim();
    if (!serverName || serverName.length > 60) throw new Error('Server name is required (up to 60 characters).');
    const world = String(s.world ?? '').trim() || 'tavern';
    if (!/^[\w -]{1,40}$/.test(world)) throw new Error('Save name can only use letters, numbers, spaces, - and _ (up to 40).');
    const seed = String(s.seed ?? '').trim();
    if (seed && !/^\d{1,10}$/.test(seed)) throw new Error('Map seed must be a number (or empty for random).');
    const preset = String(s.preset ?? 'default');
    if (!PRESETS.some((p) => p.value === preset)) throw new Error('Pick a map preset.');
    const password = String(s.password ?? '');
    if (/[\r\n]/.test(password)) throw new Error('The password must be one line.');
    if (bool(s.spaceAge) && factorioLogin() && !factorioLogin()!.spaceAge) throw new Error("Your factorio.com account doesn't own Space Age, so the server can't download it.");
    return {
      serverName,
      description: String(s.description ?? '').trim().slice(0, 500),
      port: num(s.port, 'Port', 1024, 65535),
      password,
      maxPlayers: num(s.maxPlayers ?? 0, 'Max players', 0, 65535),
      public: bool(s.public),
      lan: s.lan === undefined ? true : bool(s.lan),
      verifyUsers: s.verifyUsers === undefined ? true : bool(s.verifyUsers),
      spaceAge: bool(s.spaceAge),
      channel: s.channel === 'experimental' ? 'experimental' : 'stable',
      world,
      preset,
      seed,
      autosaveMinutes: num(s.autosaveMinutes ?? 10, 'Autosave interval', 1, 1440),
      autosaveSlots: num(s.autosaveSlots ?? 5, 'Autosave slots', 1, 100),
      autoPause: s.autoPause === undefined ? true : bool(s.autoPause),
      afkKickMinutes: num(s.afkKickMinutes ?? 0, 'AFK kick', 0, 1440),
    };
  },

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE_REL))) throw new Error('bin\\x64\\factorio.exe was not found in that folder (pick the Factorio folder itself).');
  },

  detect(installDir) {
    const saves = path.join(installDir, 'saves');
    const newest = existsSync(saves)
      ? readdirSync(saves)
          .filter((f) => f.endsWith('.zip') && !f.startsWith('_autosave'))
          .sort((a, b) => statSync(path.join(saves, b)).mtimeMs - statSync(path.join(saves, a)).mtimeMs)[0]
      : undefined;
    return { spaceAge: existsSync(path.join(installDir, 'data', 'space-age')), ...(newest ? { world: newest.replace(/\.zip$/, '') } : {}) };
  },

  /** Before every start: settings file, Space Age switch, lists, and a new map if there's no save yet. */
  async prepare(record, note) {
    const have = installedFactorio(record.installDir);
    if (!isLinux && have && (have.build === 'expansion') !== (wantedBuild(record) === 'expansion') && factorioLogin()) {
      note(`Space Age was switched ${record.settings.spaceAge ? 'on' : 'off'}: use "Update server software" (Force) to download the ${record.settings.spaceAge ? 'Space Age' : 'base game'} build.`);
    }
    writeConfigPath(record);
    writeServerSettings(record);
    applyExpansion(record);
    for (const f of Object.values(LISTS)) if (!existsSync(path.join(record.installDir, f))) writeFileSync(path.join(record.installDir, f), '[]');
    if (!existsSync(saveFile(record))) {
      mkdirSync(savesDir(record), { recursive: true });
      note(`Creating a new map "${record.settings.world}" (${PRESETS.find((p) => p.value === record.settings.preset)?.label ?? 'Default'}${record.settings.seed ? `, seed ${record.settings.seed}` : ''})…`);
      const args = ['--create', saveFile(record)];
      if (record.settings.preset && record.settings.preset !== 'default') args.push('--preset', String(record.settings.preset));
      if (record.settings.seed) args.push('--map-gen-seed', String(record.settings.seed));
      await execFileAsync(exe(record), args, { cwd: record.installDir, windowsHide: true, timeout: 10 * 60_000 }).catch((err) => {
        throw new Error(`Factorio couldn't create the map: ${String(err.stderr || err.stdout || err.message).trim().split('\n').slice(-3).join(' ')}`);
      });
      note('Map created.');
    }
  },

  launch(record) {
    const s = record.settings;
    const whitelist = readList(record, 'whitelist');
    return {
      exe: exe(record),
      args: [
        '--start-server', saveFile(record),
        '--server-settings', path.join(record.installDir, SETTINGS_FILE),
        '--port', String(s.port),
        '--server-adminlist', path.join(record.installDir, LISTS.admins),
        '--server-banlist', path.join(record.installDir, LISTS.banned),
        '--server-whitelist', path.join(record.installDir, LISTS.whitelist),
        '--use-server-whitelist', whitelist.length ? 'true' : 'false',
      ],
      cwd: record.installDir,
    };
  },

  // Under the runner. Commands keep their "/" (text without one is chat). Stop saves, then quits.
  commands: { stop: '/quit', saveFirst: { command: '/server-save', done: /Saving finished|Saving process took/, timeoutMs: 120_000 } },
  slashCommands: true,
  // Text without "/" is chat from the server.
  announceCommand: (text) => `[Server] ${text}`,
  playerCommands: {
    kick: (n, r) => `/kick ${n}${r ? ` ${r}` : ''}`,
    ban: (n, r) => `/ban ${n} ${r || 'Banned'}`,
    pardon: (n) => `/unban ${n}`,
    op: (n) => `/promote ${n}`,
    deop: (n) => `/demote ${n}`,
    'whitelist-add': (n) => `/whitelist add ${n}`,
    'whitelist-remove': (n) => `/whitelist remove ${n}`,
  },
  hideLine: (line) => /Info (Checksum|Loading mod|ModManager)|Info .*\.cpp:\d+: (Mod|Loading)/.test(line),

  createParser: createFactorioParser,

  connection: (record) => ({ port: Number(record.settings.port) || 34197, protocol: 'UDP', maxPlayers: Number(record.settings.maxPlayers) || null }),

  backup: {
    sources: (record) => ({
      base: record.installDir,
      include: ['saves', 'mods', 'config', ...Object.values(LISTS), SETTINGS_FILE].filter((p) => existsSync(path.join(record.installDir, p))),
      world: 'saves',
    }),
  },

  addons: factorioAddons,

  accessLists: [
    { id: 'admins', label: 'Admins', help: 'factorio.com usernames that can use admin commands in the game.', entryLabel: 'factorio.com username' },
    { id: 'whitelist', label: 'Whitelist', help: 'When anyone is on it, only these players can join.', entryLabel: 'factorio.com username' },
    { id: 'banned', label: 'Banned', help: "Players who can't join.", entryLabel: 'factorio.com username' },
  ],
  readAccessList: (record, list) => readList(record, list as keyof typeof LISTS),
  writeAccessList(record, list, entries, running) {
    if (!(list in LISTS)) throw new Error('Unknown list.');
    const clean = [...new Set(entries.map((e) => e.trim()).filter((e) => /^[\w.-]{1,60}$/.test(e)))];
    if (running) {
      const before = readList(record, list as keyof typeof LISTS);
      const lower = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
      const was = lower(before);
      const now = lower(clean);
      return listCommands(list, clean.filter((e) => !was.has(e.toLowerCase())), before.filter((e) => !now.has(e.toLowerCase())));
    }
    writeFileSync(path.join(record.installDir, LISTS[list as keyof typeof LISTS]), JSON.stringify(clean, null, 2));
  },

  install,
};
