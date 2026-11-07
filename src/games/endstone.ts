// Endstone (github.com/EndstoneMC/endstone): a plugin framework for Bedrock Dedicated Server, like Paper for Java. It's
// a Python package whose launcher downloads the one BDS version it supports into the server folder and starts it with
// Endstone's runtime injected. A Bedrock server set to "Endstone" runs that launcher instead of bedrock_server.exe.
//
// What it needs, all set up by Server Forge (nothing system-wide):
// - Python 3.11+ that isn't the Microsoft Store build: the official python.org build from NuGet, in tools/python.
// - A virtual environment per server (<server>/.endstone-python) with the endstone package. Per server, because a
//   running server keeps Endstone's DLLs locked, and plugins pip-installed into the environment load on every server.
// - The BDS version that Endstone version supports (version.txt in the server folder). Endstone refuses to start a
//   newer BDS, so Mojang's updates aren't installed on these servers: updating Endstone brings the matching BDS.
//
// Plugins: Endstone loads every .whl (Python) and .dll (C++) in <server>/plugins and pip-installs a wheel's
// dependencies into plugins/.local when the server starts. Switched-off plugins wait in plugins/.tavernhost-off.
// Bedrock addons (behavior/resource packs) work as on vanilla servers.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, cpSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddonSupport, ServerRecord } from './types.ts';
import { dataPath } from '../store.ts';
import { downloadFile, extractZip, formatBytes } from '../download.ts';
import { ZipFile } from '../zip.ts';
import type { Job } from '../jobs.ts';
import { defenderScan, SCANNER } from '../modscan.ts';

const PYTHON_SERIES = '3.13';
const PYPI = 'https://pypi.org/pypi';
const GITHUB_API = 'https://api.github.com';
const ENV_DIR = '.endstone-python';
const PLUGINS = 'plugins';
const OFF_DIR = '.tavernhost-off';
const REGISTRY = '.tavernhost-plugins.json';
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function isEndstone(record: Pick<ServerRecord, 'settings'>) {
  return record.settings.software === 'endstone';
}

// ---------- Python ----------

function pythonRoot() {
  return dataPath('tools', 'python');
}

/** The newest Python of PYTHON_SERIES already downloaded, if any. */
function localPython(): string | null {
  const root = pythonRoot();
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith(`python-${PYTHON_SERIES}.`) && existsSync(path.join(root, d, 'tools', 'python.exe')))
    .sort((a, b) => compareVersions(b.slice(7), a.slice(7)));
  return dirs.length ? path.join(root, dirs[0], 'tools', 'python.exe') : null;
}

/** Python from python.org's NuGet package (a full build with pip and venv, no installer, nothing system-wide). */
async function ensurePython(update: (step: string, pct?: number | null) => void, line: (text: string) => void): Promise<string> {
  const have = localPython();
  if (have) return have;
  update(`Finding the latest Python ${PYTHON_SERIES}…`, null);
  const res = await fetch('https://api.nuget.org/v3-flatcontainer/python/index.json', { headers: { 'User-Agent': 'TavernHost' } });
  if (!res.ok) throw new Error(`Couldn't reach nuget.org for Python (HTTP ${res.status}).`);
  const versions = ((await res.json()) as { versions: string[] }).versions.filter((v) => new RegExp(`^${PYTHON_SERIES.replace('.', '\\.')}\\.\\d+$`).test(v));
  const version = versions.sort(compareVersions).pop();
  if (!version) throw new Error(`nuget.org has no Python ${PYTHON_SERIES} package.`);
  const tmp = path.join(os.tmpdir(), `tavernhost-python-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // A .nupkg is a zip; Expand-Archive only takes the .zip extension.
    const zip = path.join(tmp, 'python.zip');
    await downloadFile(`https://api.nuget.org/v3-flatcontainer/python/${version}/python.${version}.nupkg`, zip, (pct, got) => update(`Downloading Python ${version}… ${formatBytes(got)}`, pct));
    update(`Unpacking Python ${version}…`, null);
    const dir = path.join(pythonRoot(), `python-${version}`);
    rmSync(dir, { recursive: true, force: true });
    await extractZip(zip, dir);
    const exe = path.join(dir, 'tools', 'python.exe');
    if (!existsSync(exe)) throw new Error(`Python ${version} was downloaded but python.exe wasn't in it.`);
    line(`Python ${version} is ready (for Endstone).`);
    return exe;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs a program, passing each output line to `line`; throws with the last lines if it fails. */
function run(exe: string, args: string[], opts: { cwd?: string; line?: (text: string) => void; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', NO_COLOR: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    });
    let out = '';
    let partial = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8').replace(ANSI, '');
      out += text;
      partial += text;
      const lines = partial.split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) opts.line?.(l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (partial.trim()) opts.line?.(partial);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(exe)} ${args.slice(0, 3).join(' ')} failed (exit code ${code}): ${out.trim().split(/\r?\n/).slice(-4).join(' ')}`));
    });
  });
}

// ---------- Endstone itself ----------

export function envPython(installDir: string) {
  return path.join(installDir, ENV_DIR, 'Scripts', 'python.exe');
}

/** The endstone package version in this server's environment, e.g. "0.11.14". */
export function installedEndstone(installDir: string): string | null {
  const site = path.join(installDir, ENV_DIR, 'Lib', 'site-packages');
  if (!existsSync(site)) return null;
  const info = readdirSync(site).find((d) => /^endstone-[\d.]+[^-]*\.dist-info$/i.test(d));
  return info ? info.slice('endstone-'.length, -'.dist-info'.length) : null;
}

/** The BDS version Endstone installed (its version.txt, e.g. "26.52"), as Mojang writes it: "1.26.52". */
export function endstoneBedrockVersion(installDir: string): string | null {
  try {
    const v = readFileSync(path.join(installDir, 'version.txt'), 'utf-8').trim();
    return /^\d+\.\d+/.test(v) ? (Number(v.split('.')[0]) > 1 ? `1.${v}` : v) : null;
  } catch {
    return null;
  }
}

/**
 * Notes the Bedrock version in Server Forge's version file (bedrock.ts VERSION_FILE, used for addon checks and, back on
 * vanilla, for Mojang updates). Mojang's fuller "1.26.52.3" is kept when Endstone's "1.26.52" is the same version.
 */
export function recordBedrockVersion(installDir: string, version: string | null) {
  if (!version) return;
  const file = path.join(installDir, '.tavernhost-version');
  let have = '';
  try {
    have = readFileSync(file, 'utf-8').trim();
  } catch {}
  if (have.split('.').slice(0, 3).join('.') !== version.split('.').slice(0, 3).join('.')) writeFileSync(file, version);
}

let latestCache: { version: string; at: number } | null = null;
/** Newest endstone release on PyPI. */
export async function latestEndstone(): Promise<string> {
  if (latestCache && Date.now() - latestCache.at < 10 * 60_000) return latestCache.version;
  const res = await fetch(`${PYPI}/endstone/json`, { headers: { 'User-Agent': 'TavernHost' } });
  if (!res.ok) throw new Error(`Couldn't reach PyPI for Endstone (HTTP ${res.status}).`);
  const version = String(((await res.json()) as { info: { version: string } }).info.version);
  latestCache = { version, at: Date.now() };
  return version;
}

// Downloads the BDS version this Endstone supports and writes its config, without starting the server (the same steps
// `endstone -y` takes before it starts). Uses the launcher's own code so the files match what it expects.
const BOOTSTRAP = `
import sys
from endstone.cli import main
from endstone.cli.windows import WindowsBootstrap
remote = next(p.default for p in main.params if p.name == 'remote')
b = WindowsBootstrap(server_folder=sys.argv[1], no_confirm=True, remote=remote, interactive=False)
b._install()
b._prepare()
import endstone
print('TH-ENDSTONE', endstone.__version__, endstone.__minecraft_version__)
`;

/** The Bedrock version an Endstone release runs, e.g. "1.26.52", without installing it (from the package). */
async function endstoneTarget(python: string): Promise<string | null> {
  try {
    const out = await run(python, ['-c', 'import endstone; print(endstone.__minecraft_version__)'], { timeoutMs: 60_000 });
    const v = out.trim().split(/\s+/).pop() ?? '';
    return /^\d+\.\d+/.test(v) ? (Number(v.split('.')[0]) > 1 ? `1.${v}` : v) : null;
  } catch {
    return null;
  }
}

/**
 * Sets up (or updates) Endstone in a server folder: Python, the server's environment, the endstone package, then the
 * BDS version it supports. `upgrade`: install the newest Endstone even if one is installed. `vanillaVersion`: the BDS a
 * vanilla server has now (Endstone can't run a newer one, and going back a version can break a world).
 */
export async function setupEndstone(
  installDir: string,
  job: Pick<Job, 'update' | 'line'>,
  opts: { upgrade?: boolean; vanillaVersion?: string | null; allowDowngrade?: boolean; version?: string | null } = {},
): Promise<{ endstone: string; bedrock: string | null }> {
  const log = (l: string) => job.line(l);
  const python = await ensurePython((s, p) => job.update(s, p ?? null), log);
  const env = envPython(installDir);
  mkdirSync(installDir, { recursive: true });
  if (!existsSync(env)) {
    job.update('Creating the Python environment for Endstone…', null);
    await run(python, ['-m', 'venv', path.join(installDir, ENV_DIR)], { line: log });
  }
  const before = installedEndstone(installDir);
  // An imported server first gets the Endstone version it ran before (it's offered updates as usual afterwards).
  const pinned = !before && !opts.upgrade ? (opts.version ?? importedVersion(installDir)) : null;
  if (!before || opts.upgrade) {
    job.update(before ? 'Updating Endstone…' : `Installing Endstone${pinned ? ` ${pinned}` : ''} (Python package)…`, null);
    const spec = pinned ? `endstone==${pinned}` : 'endstone';
    await run(env, ['-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', spec], { line: (l) => /^(Successfully|ERROR|WARNING)/.test(l) && log(l) }).catch(async (err) => {
      // That version may no longer install (e.g. no build for this Python): use the newest instead.
      if (!pinned) throw err;
      log(`Endstone ${pinned} didn't install here (${(err as Error).message.slice(0, 160)}); installing the newest Endstone instead.`);
      await run(env, ['-m', 'pip', 'install', '--upgrade', '--no-warn-script-location', 'endstone'], { line: (l) => /^(Successfully|ERROR)/.test(l) && log(l) });
    });
  }
  const version = installedEndstone(installDir);
  if (!version) throw new Error("Endstone didn't install (pip finished but the package isn't there).");
  const target = await endstoneTarget(env);
  const current = endstoneBedrockVersion(installDir) ?? opts.vanillaVersion ?? null;
  // Mojang's "1.26.52.3" is Endstone's "26.52": compare major.minor.patch only.
  const cut = (v: string) => v.split('.').slice(0, 3).join('.');
  if (target && current && compareVersions(cut(current), cut(target)) > 0 && !opts.allowDowngrade) {
    throw new Error(
      `This server runs Bedrock ${current}, but Endstone ${version} supports Bedrock ${target}. Going back a version can break the world, so nothing was changed. ` +
        'Wait for an Endstone release for this Bedrock version, or use "Force reinstall" to go back anyway (make a backup first).',
    );
  }
  job.update(`Downloading Bedrock ${target ?? ''} for Endstone ${version}…`.replace('  ', ' '), null);
  // (Leaves out the progress bar and its "<file> already exists, skipping." line for every file it keeps.)
  await run(env, ['-c', BOOTSTRAP, installDir], { cwd: installDir, line: (l) => !/Downloading|already exists, skipping|^TH-ENDSTONE/.test(l) && log(l.replace(/^\[[\d:]+ \w+\]:\s*/, '')) });
  log(before && before !== version ? `Endstone ${before} → ${version}.` : `Endstone ${version} is installed.`);
  return { endstone: version, bedrock: endstoneBedrockVersion(installDir) };
}

/** How a Bedrock server set to Endstone starts: the launcher (from its environment), no interactive console. */
export function endstoneLaunch(record: ServerRecord) {
  return {
    exe: envPython(record.installDir),
    args: ['-m', 'endstone', '--yes', '--no-interactive', '--server-folder', record.installDir],
    cwd: record.installDir,
    env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', NO_COLOR: '1' },
  };
}

// ---------- plugins ----------

interface PluginEntry {
  source?: string;
  installedAt?: number;
  /** Where updates come from. */
  from?: { kind: 'pypi'; project: string } | { kind: 'github'; repo: string };
}
type Registry = Record<string, PluginEntry>;

function pluginsDir(installDir: string) {
  return path.join(installDir, PLUGINS);
}
function offDir(installDir: string) {
  return path.join(installDir, PLUGINS, OFF_DIR);
}
function loadRegistry(installDir: string): Registry {
  try {
    return JSON.parse(readFileSync(path.join(pluginsDir(installDir), REGISTRY), 'utf-8'));
  } catch {
    return {};
  }
}
function saveRegistry(installDir: string, reg: Registry) {
  mkdirSync(pluginsDir(installDir), { recursive: true });
  writeFileSync(path.join(pluginsDir(installDir), REGISTRY), JSON.stringify(reg, null, 2));
}

/** PyPI's normalised name: "Endstone_Essentials" -> "endstone-essentials". */
const normalise = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

interface WheelInfo {
  name: string;
  version: string;
  summary: string;
  authors: string;
  website: string | null;
  requiresPython: string | null;
}

/** Name, version and description from a wheel's METADATA. */
function readWheel(file: string): WheelInfo {
  const zip = new ZipFile(file);
  try {
    const meta = zip.names().find((n) => /^[^/]+\.dist-info\/METADATA$/.test(ZipFile.normalise(n)));
    const text = meta ? zip.text(meta) : null;
    if (!text) throw new Error(`${path.basename(file)} isn't a Python wheel (no .dist-info/METADATA inside).`);
    const head = text.split(/\r?\n\r?\n/)[0];
    const field = (key: string) => new RegExp(`^${key}: (.*)$`, 'mi').exec(head)?.[1].trim() ?? '';
    const urls = [...head.matchAll(/^Project-URL: [^,]+, (.*)$/gim)].map((m) => m[1].trim());
    const authorEmail = field('Author-email');
    return {
      name: field('Name'),
      version: field('Version'),
      summary: field('Summary'),
      authors: field('Author') || authorEmail.replace(/\s*<[^>]*>/g, ''),
      website: field('Home-page') || urls[0] || null,
      requiresPython: field('Requires-Python') || null,
    };
  } finally {
    zip.close();
  }
}

/** "endstone_essentials-0.0.5-py3-none-any.whl" -> python tags it runs on, e.g. ["py3"] / ["cp313"]. */
function wheelTags(file: string) {
  const parts = path.basename(file, '.whl').split('-');
  return { python: (parts[parts.length - 3] ?? '').split('.'), abi: parts[parts.length - 2] ?? '', platform: parts[parts.length - 1] ?? '' };
}

interface PluginInfo {
  id: string;
  name: string;
  version: string | null;
  description: string;
  authors: string | null;
  file: string;
  enabled: boolean;
  typeLabel: string;
  typeClass: string;
  source: string | null;
  website: string | null;
  hasIcon: false;
  warnings: { level: 'error' | 'warn'; text: string }[];
}

function pluginFiles(installDir: string): { file: string; enabled: boolean }[] {
  const out: { file: string; enabled: boolean }[] = [];
  for (const [dir, enabled] of [[pluginsDir(installDir), true], [offDir(installDir), false]] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.(whl|dll)$/i.test(f) && statSync(path.join(dir, f)).isFile()) out.push({ file: path.join(dir, f), enabled });
  }
  return out;
}

function pluginId(file: string) {
  return /\.whl$/i.test(file) ? normalise(path.basename(file).split('-')[0]) : path.basename(file).toLowerCase();
}

export function listPlugins(installDir: string): PluginInfo[] {
  const reg = loadRegistry(installDir);
  const pyTag = `cp${PYTHON_SERIES.replace('.', '')}`;
  return pluginFiles(installDir)
    .map(({ file, enabled }): PluginInfo => {
      const id = pluginId(file);
      const rel = path.relative(installDir, file).replace(/\\/g, '/');
      const warnings: PluginInfo['warnings'] = [];
      if (/\.dll$/i.test(file)) {
        return { id, name: path.basename(file, '.dll'), version: null, description: 'C++ plugin', authors: null, file: rel, enabled, typeLabel: 'C++ plugin', typeClass: 'plugin', source: reg[id]?.source ?? null, website: null, hasIcon: false, warnings };
      }
      let info: WheelInfo | null = null;
      try {
        info = readWheel(file);
      } catch (err) {
        warnings.push({ level: 'error', text: (err as Error).message });
      }
      const name = info?.name || path.basename(file).split('-')[0];
      if (!normalise(name).startsWith('endstone-')) warnings.push({ level: 'error', text: `Endstone only loads plugins whose package name starts with "endstone-" (this one is "${name}"). It may be a library, not a plugin.` });
      // Pure-Python wheels (py3) run anywhere; compiled ones must match this Python (or be abi3) and Windows.
      const tags = wheelTags(file);
      const pyOk = tags.python.some((t) => t.startsWith('py3') || t === pyTag) || (tags.abi === 'abi3' && tags.python.some((t) => /^cp3\d+$/.test(t)));
      if (tags.python.every((t) => t === 'py2' || t === 'cp2' || /^cp2\d/.test(t))) {
        warnings.push({ level: 'error', text: "Built for Python 2: Endstone can't install it, and while it's switched on no plugins load at all." });
      } else if (!pyOk) warnings.push({ level: 'warn', text: `Built for ${tags.python.join('/')}; Server Forge runs Endstone on Python ${PYTHON_SERIES}, so it may not load.` });
      if (tags.platform !== 'any' && !/win_amd64/.test(tags.platform)) warnings.push({ level: 'error', text: `Built for ${tags.platform}, not Windows.` });
      return {
        id,
        name: info?.name ? info.name.replace(/^endstone[-_]/i, '') : name,
        version: info?.version || null,
        description: info?.summary ?? '',
        authors: info?.authors || null,
        file: rel,
        enabled,
        typeLabel: 'Python plugin',
        typeClass: 'plugin',
        source: reg[id]?.source ?? null,
        website: info?.website ?? null,
        hasIcon: false,
        warnings,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function findPlugin(installDir: string, id: string) {
  const hit = pluginFiles(installDir).find((p) => pluginId(p.file) === id);
  if (!hit) throw new Error('That plugin is no longer installed. Refresh and try again.');
  return hit;
}

/** Installs a .whl or .dll; an older copy of the same plugin is replaced and keeps its on/off state. */
export async function installPluginFile(installDir: string, file: string, source: string | null, from?: PluginEntry['from']) {
  const name = path.basename(file).replace(/^tavernhost-dl-\d+-[0-9a-f]+-/, '');
  if (!/\.(whl|dll)$/i.test(name)) throw new Error('Endstone plugins are .whl files (Python) or .dll files (C++).');
  // Plugins are programs the server runs: Windows Defender first, like addons.
  const scan = await defenderScan(file);
  if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat} in ${name}.`);
  const warnings: string[] = [];
  let version: string | null = null;
  let display = name;
  if (/\.whl$/i.test(name)) {
    const info = readWheel(file);
    version = info.version || null;
    display = info.name || name;
    if (!normalise(info.name).startsWith('endstone-')) warnings.push(`"${info.name}" doesn't look like an Endstone plugin (its name doesn't start with "endstone-"); Endstone won't load it.`);
  }
  const id = pluginId(name);
  const old = pluginFiles(installDir).filter((p) => pluginId(p.file) === id);
  const enabled = old.length ? old.some((p) => p.enabled) : true;
  for (const p of old) rmSync(p.file, { force: true });
  const destDir = enabled ? pluginsDir(installDir) : offDir(installDir);
  mkdirSync(destDir, { recursive: true });
  cpSync(file, path.join(destDir, name));
  const reg = loadRegistry(installDir);
  reg[id] = { ...reg[id], source: source ?? reg[id]?.source, installedAt: Date.now(), ...(from ? { from } : {}) };
  saveRegistry(installDir, reg);
  if (!enabled) warnings.push(`${display} was switched off before, so the new version is switched off too.`);
  return {
    installed: [{ name: display.replace(/^endstone[-_]/i, ''), type: /\.dll$/i.test(name) ? 'C++ plugin' : 'plugin', version, action: old.length ? 'updated' : 'installed' }],
    warnings,
  };
}

export function removePlugin(installDir: string, id: string) {
  rmSync(findPlugin(installDir, id).file, { force: true });
  const reg = loadRegistry(installDir);
  delete reg[id];
  saveRegistry(installDir, reg);
}

export function setPluginEnabled(installDir: string, id: string, enabled: boolean) {
  const p = findPlugin(installDir, id);
  if (p.enabled === enabled) return;
  const dir = enabled ? pluginsDir(installDir) : offDir(installDir);
  mkdirSync(dir, { recursive: true });
  renameSync(p.file, path.join(dir, path.basename(p.file)));
}

// ---------- finding plugins (GitHub + PyPI) ----------

export interface FoundPlugin {
  id: string;
  name: string;
  summary: string;
  author: string | null;
  url: string;
  source: 'GitHub' | 'PyPI';
  stars?: number;
  version?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'TavernHost', Accept: url.startsWith(GITHUB_API) ? 'application/vnd.github+json' : 'application/json' } });
  if (res.status === 403 && url.startsWith(GITHUB_API)) throw new Error('GitHub is rate-limiting searches from this network; try again in a minute.');
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}.`);
  return (await res.json()) as T;
}

// PyPI has no search API: its full project list (about 10 MB compressed) is fetched at most once a day, and only the
// "endstone-*" names are kept.
let pypiNames: { names: string[]; at: number } | null = null;
const pypiInfo = new Map<string, { at: number; info: { version: string; summary: string; author: string; urls: string[] } }>();

async function pypiPluginNames(): Promise<string[]> {
  if (pypiNames && Date.now() - pypiNames.at < 24 * 3600_000) return pypiNames.names;
  const res = await fetch('https://pypi.org/simple/', { headers: { 'User-Agent': 'TavernHost', Accept: 'application/vnd.pypi.simple.v1+json' } });
  if (!res.ok) throw new Error(`PyPI answered HTTP ${res.status}.`);
  const data = (await res.json()) as { projects: { name: string }[] };
  const skip = new Set(['endstone', 'endstone-stubgen', 'endstone-example', 'endstone-test-plugin', 'endstone-my-plugin', 'endstone-plugin']);
  const names = data.projects.map((p) => normalise(p.name)).filter((n) => n.startsWith('endstone-') && !skip.has(n));
  pypiNames = { names, at: Date.now() };
  return names;
}

async function pypiProject(name: string) {
  const cached = pypiInfo.get(name);
  if (cached && Date.now() - cached.at < 3600_000) return cached.info;
  const j = await getJson<{ info: { version: string; summary: string | null; author: string | null; author_email: string | null; project_urls: Record<string, string> | null; home_page: string | null } }>(`${PYPI}/${encodeURIComponent(name)}/json`);
  const info = {
    version: j.info.version,
    summary: j.info.summary ?? '',
    author: j.info.author || (j.info.author_email ?? '').replace(/\s*<[^>]*>/g, ''),
    urls: [j.info.home_page, ...Object.values(j.info.project_urls ?? {})].filter((u): u is string => !!u),
  };
  pypiInfo.set(name, { at: Date.now(), info });
  return info;
}

export async function searchPlugins(query: string): Promise<{ results: FoundPlugin[]; errors: string[] }> {
  const q = query.trim().toLowerCase();
  const errors: string[] = [];
  const results: FoundPlugin[] = [];
  const github = async () => {
    const words = q.replace(/[^\w\s-]/g, ' ').trim();
    const searches = [`${words} topic:endstone-plugin`, `${words} endstone in:name,description fork:false`];
    const seen = new Set<string>();
    for (const s of searches) {
      const j = await getJson<{ items: { full_name: string; name: string; description: string | null; html_url: string; stargazers_count: number; owner: { login: string } }[] }>(
        `${GITHUB_API}/search/repositories?q=${encodeURIComponent(s.trim())}&sort=stars&per_page=30`,
      );
      for (const r of j.items) {
        if (seen.has(r.full_name) || /^endstonemc\/(endstone|.*(docs|template|stub|proxy).*)$/i.test(r.full_name)) continue;
        seen.add(r.full_name);
        results.push({ id: `github:${r.full_name}`, name: r.name, summary: r.description ?? '', author: r.owner.login, url: r.html_url, source: 'GitHub', stars: r.stargazers_count });
      }
    }
  };
  const pypi = async () => {
    const names = (await pypiPluginNames()).filter((n) => !q || n.includes(q.replace(/\s+/g, '-')) || n.includes(q.replace(/\s+/g, '')));
    const infos = await Promise.all(names.slice(0, 40).map(async (n) => ({ n, info: await pypiProject(n).catch(() => null) })));
    for (const { n, info } of infos) {
      results.push({ id: `pypi:${n}`, name: n.replace(/^endstone-/, ''), summary: info?.summary ?? '', author: info?.author || null, url: `https://pypi.org/project/${n}/`, source: 'PyPI', version: info?.version });
    }
  };
  await Promise.all([github().catch((e) => errors.push(`GitHub: ${(e as Error).message}`)), pypi().catch((e) => errors.push(`PyPI: ${(e as Error).message}`))]);
  // The same plugin on both: keep the PyPI entry (it has versions), linked to its GitHub page.
  const pypiUrls = new Set(results.filter((r) => r.source === 'PyPI').flatMap((r) => pypiInfo.get(`endstone-${r.name}`)?.info.urls.map((u) => u.toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')) ?? []));
  const merged = results.filter((r) => r.source === 'PyPI' || !pypiUrls.has(r.url.toLowerCase()));
  // Text matches first, then PyPI (installable with versions), then by stars.
  const score = (r: FoundPlugin) => (q && !r.name.toLowerCase().includes(q) ? 10 : 0) + (r.source === 'PyPI' ? 0 : 1);
  merged.sort((a, b) => score(a) - score(b) || (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name));
  return { results: merged.slice(0, 60), errors };
}

/** Best wheel for Windows + our Python from a list of file names; null if none fits. */
function pickWheel<T extends { name: string }>(files: T[]): T | null {
  const tag = `cp${PYTHON_SERIES.replace('.', '')}`;
  const wheels = files.filter((f) => /\.whl$/i.test(f.name));
  return (
    wheels.find((f) => /-none-any\.whl$/i.test(f.name)) ??
    wheels.find((f) => new RegExp(`-${tag}-${tag}-win_amd64\\.whl$`, 'i').test(f.name)) ??
    wheels.find((f) => /-abi3-win_amd64\.whl$/i.test(f.name)) ??
    null
  );
}

/** The newest installable file of a found plugin: { url, name, version }. */
async function newestFile(from: NonNullable<PluginEntry['from']>): Promise<{ url: string; name: string; version: string }> {
  if (from.kind === 'pypi') {
    const j = await getJson<{ info: { version: string }; urls: { filename: string; url: string; packagetype: string }[] }>(`${PYPI}/${encodeURIComponent(from.project)}/json`);
    const wheel = pickWheel(j.urls.map((u) => ({ ...u, name: u.filename })));
    if (!wheel) throw new Error(`${from.project} ${j.info.version} has no Windows wheel on PyPI.`);
    return { url: wheel.url, name: wheel.filename, version: j.info.version };
  }
  const releases = await getJson<{ tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }[]>(`${GITHUB_API}/repos/${from.repo}/releases?per_page=10`);
  for (const r of releases.filter((x) => !x.draft).sort((a, b) => Number(a.prerelease) - Number(b.prerelease))) {
    const asset = pickWheel(r.assets) ?? r.assets.find((a) => /\.dll$/i.test(a.name)) ?? null;
    if (asset) return { url: asset.browser_download_url, name: asset.name, version: r.tag_name.replace(/^v/i, '') };
  }
  throw new Error(`${from.repo} has no plugin file (.whl or .dll) in its GitHub releases. Open its page to see how to install it.`);
}

/** Installs a search result ("pypi:<name>" / "github:<owner>/<repo>"). */
export async function installFound(installDir: string, id: string) {
  const m = /^(pypi|github):([\w.\-]+(?:\/[\w.\-]+)?)$/.exec(id);
  if (!m) throw new Error('Unknown plugin.');
  const from: NonNullable<PluginEntry['from']> = m[1] === 'pypi' ? { kind: 'pypi', project: m[2] } : { kind: 'github', repo: m[2] };
  return installFrom(installDir, from);
}

async function installFrom(installDir: string, from: NonNullable<PluginEntry['from']>) {
  const file = await newestFile(from);
  const tmp = path.join(os.tmpdir(), `tavernhost-plugin-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const local = path.join(tmp, path.basename(file.name).replace(/[^\w.\-+]/g, '_'));
    await downloadFile(file.url, local);
    return await installPluginFile(installDir, local, from.kind === 'pypi' ? `PyPI: ${from.project}` : `GitHub: ${from.repo}`, from);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Plugins with a newer version: id -> version. Plugins from PyPI or GitHub; others are looked up on PyPI by name. */
async function checkPluginUpdates(installDir: string): Promise<Record<string, string>> {
  const reg = loadRegistry(installDir);
  const out: Record<string, string> = {};
  await Promise.all(
    listPlugins(installDir).map(async (p) => {
      const from = reg[p.id]?.from ?? (p.id.startsWith('endstone-') ? ({ kind: 'pypi', project: p.id } as const) : null);
      if (!from || !p.version) return;
      try {
        const latest = await newestFile(from);
        if (compareVersions(latest.version, p.version) > 0) out[p.id] = latest.version;
      } catch {}
    }),
  );
  return out;
}

async function updatePlugin(installDir: string, id: string) {
  const from = loadRegistry(installDir)[id]?.from ?? (id.startsWith('endstone-') ? ({ kind: 'pypi', project: id } as const) : null);
  if (!from) throw new Error("Server Forge doesn't know where this plugin came from, so it can't update it. Install the new file by hand.");
  return installFrom(installDir, from);
}

// ---------- importing an existing Endstone server ----------
// Someone who ran Endstone by hand has: a folder they ran `endstone` in, with the server in its bedrock_server folder;
// a Python somewhere (a venv next to it, or a system Python) with endstone installed; and plugins either as .whl
// files in plugins/ (they come along as they are) or pip-installed into that Python (they'd be lost: Server Forge gives
// the server its own Python). Those are brought in as .whl files: the same version from PyPI, or else rebuilt from the
// installed files.

const IMPORT_NOTE = '.tavernhost-endstone.json';

/** The Endstone version an imported server ran before (installed instead of the newest on its first start). */
function importedVersion(installDir: string): string | null {
  try {
    return String(JSON.parse(readFileSync(path.join(installDir, IMPORT_NOTE), 'utf-8')).version ?? '') || null;
  } catch {
    return null;
  }
}

/** The server folder inside what was chosen: the folder itself, its bedrock_server folder, or another Endstone subfolder. */
export function findEndstoneFolder(dir: string): string | null {
  const isServer = (d: string) => existsSync(path.join(d, 'bedrock_server.exe')) && existsSync(path.join(d, 'endstone.toml'));
  if (isServer(dir)) return dir;
  const named = path.join(dir, 'bedrock_server');
  if (isServer(named)) return named;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && isServer(path.join(dir, e.name))) return path.join(dir, e.name);
  } catch {}
  return null;
}

// Run with the old Python: its endstone version and the plugins installed into it (Endstone loads every package with an
// "endstone" entry point whose name starts with endstone-).
const PROBE = `
import json, sys
from importlib.metadata import distributions
out = {'python': sys.executable, 'pyver': '%d.%d' % sys.version_info[:2], 'endstone': None, 'plugins': []}
for d in distributions():
    n = (d.metadata['Name'] or '').lower().replace('_', '-')
    if n == 'endstone':
        out['endstone'] = d.version
        continue
    if not n.startswith('endstone-') or not any(ep.group == 'endstone' for ep in d.entry_points):
        continue
    editable = False
    try:
        editable = bool(json.loads(d.read_text('direct_url.json') or '{}').get('dir_info', {}).get('editable'))
    except Exception:
        pass
    out['plugins'].append({'name': n, 'version': d.version, 'editable': editable})
print('TH-PROBE' + json.dumps(out))
`;

// Run with the old Python: packs an installed plugin back into a wheel (its files as installed, with a fresh RECORD).
const REPACK = `
import sys, os, zipfile, hashlib, base64
from importlib.metadata import distribution
d = distribution(sys.argv[1])
name, ver = d.metadata['Name'].replace('-', '_'), d.version
tags = [l.split(':', 1)[1].strip() for l in (d.read_text('WHEEL') or '').splitlines() if l.startswith('Tag:')] or ['py3-none-any']
# One file name for all its tags: "py2-none-any" + "py3-none-any" -> "py2.py3-none-any" (a py2-only name won't install).
groups = {}
for t in tags:
    py, rest = t.split('-', 1)
    groups.setdefault(rest, []).append(py)
rest = next((r for r, pys in groups.items() if any(p.startswith(('py3', 'cp3')) for p in pys)), next(iter(groups)))
tag = '.'.join(sorted(set(groups[rest]))) + '-' + rest
info = next((str(f).split('/')[0] for f in d.files if str(f).replace(os.sep, '/').split('/')[0].endswith('.dist-info')), None)
out = os.path.join(sys.argv[2], '%s-%s-%s.whl' % (name, ver, tag))
record = []
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in d.files:
        p = str(f).replace(os.sep, '/')
        base = p.split('/')[-1]
        if p.startswith('..') or '__pycache__' in p or p.endswith('.pyc') or base in ('RECORD', 'INSTALLER', 'REQUESTED', 'direct_url.json'):
            continue
        src = str(f.locate())
        if not os.path.isfile(src):
            continue
        data = open(src, 'rb').read()
        z.writestr(p, data)
        h = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
        record.append('%s,sha256=%s,%d' % (p, h, len(data)))
    record.append('%s/RECORD,,' % info)
    z.writestr('%s/RECORD' % info, '\\n'.join(record) + '\\n')
print('TH-WHEEL' + out)
`;

/** Pythons that may be the one the server ran with: venvs next to it first, then the ones installed on this PC. */
async function candidatePythons(chosen: string, serverDir: string): Promise<string[]> {
  const out: string[] = [];
  const add = (p: string) => {
    const k = path.resolve(p).toLowerCase();
    if (existsSync(p) && !/\\windowsapps\\/i.test(p) && !out.some((x) => path.resolve(x).toLowerCase() === k)) out.push(p);
  };
  for (const dir of new Set([serverDir, chosen, path.dirname(chosen), path.dirname(path.dirname(chosen))])) {
    for (const v of ['.venv', 'venv', 'env', '.env', 'python']) add(path.join(dir, v, 'Scripts', 'python.exe'));
    try {
      // Any other venv-looking folder next to it (pyvenv.cfg).
      for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory() && existsSync(path.join(dir, e.name, 'pyvenv.cfg'))) add(path.join(dir, e.name, 'Scripts', 'python.exe'));
    } catch {}
  }
  try {
    const listed = await run('py', ['-0p'], { timeoutMs: 15_000 });
    for (const m of listed.matchAll(/([A-Za-z]:\\[^\r\n]*?python(?:w)?\.exe)/gi)) add(m[1].trim());
  } catch {}
  try {
    const where = await run('where.exe', ['python'], { timeoutMs: 10_000 });
    for (const l of where.split(/\r?\n/)) if (l.trim()) add(l.trim());
  } catch {}
  return out;
}

type Probe = { python: string; pyver: string; endstone: string | null; plugins: { name: string; version: string; editable: boolean }[] };

async function probe(python: string): Promise<Probe | null> {
  try {
    const out = await run(python, ['-c', PROBE], { timeoutMs: 30_000 });
    const line = out.split(/\r?\n/).find((l) => l.startsWith('TH-PROBE'));
    return line ? (JSON.parse(line.slice('TH-PROBE'.length)) as Probe) : null;
  } catch {
    return null;
  }
}

/** A wheel of exactly this version from PyPI that runs on Server Forge's Python, or null. */
async function pypiWheel(name: string, version: string) {
  try {
    const j = await getJson<{ urls: { filename: string; url: string }[] }>(`${PYPI}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
    return pickWheel(j.urls.map((u) => ({ ...u, name: u.filename })));
  } catch {
    return null;
  }
}

/**
 * Prepares an existing Endstone server for import: finds its server folder, and brings the plugins pip-installed into
 * its old Python into plugins/ as .whl files. Changes nothing for folders that aren't Endstone servers.
 */
export async function importEndstone(chosen: string): Promise<{ installDir: string; notes: string[]; endstone: boolean }> {
  const dir = findEndstoneFolder(chosen);
  if (!dir) return { installDir: chosen, notes: [], endstone: false };
  const notes: string[] = [];
  if (path.resolve(dir) !== path.resolve(chosen)) notes.push(`Found the Endstone server in ${dir}; that folder was added.`);
  const whls = pluginFiles(dir);
  if (whls.length) notes.push(`${whls.length} plugin file${whls.length === 1 ? '' : 's'} already in its plugins folder came along: ${listPlugins(dir).map((p) => p.name).join(', ')}.`);

  // The Python it ran with: the first one that has endstone installed.
  let found: Probe | null = null;
  for (const py of await candidatePythons(chosen, dir)) {
    const p = await probe(py);
    if (p?.endstone) {
      found = p;
      break;
    }
  }
  if (!found) {
    notes.push("Couldn't find the Python this server ran Endstone with, so only plugins in its plugins folder came along. If it had plugins installed with pip, add their .whl files in the Plugins tab.");
    return { installDir: dir, notes, endstone: true };
  }
  writeFileSync(path.join(dir, IMPORT_NOTE), JSON.stringify({ version: found.endstone, python: found.python, at: Date.now() }, null, 2));
  notes.push(`It ran Endstone ${found.endstone} (${found.python}). Server Forge gives it its own copy of that version on the first start; your old Python isn't changed.`);

  const have = new Set(pluginFiles(dir).map((p) => pluginId(p.file)));
  const brought: string[] = [];
  const failed: string[] = [];
  for (const pl of found.plugins) {
    if (have.has(pl.name)) continue;
    const label = `${pl.name.replace(/^endstone-/, '')} ${pl.version}`;
    const tmp = path.join(os.tmpdir(), `tavernhost-import-${randomBytes(4).toString('hex')}`);
    mkdirSync(tmp, { recursive: true });
    try {
      let file: string | null = null;
      let source = `Imported (PyPI: ${pl.name})`;
      const wheel = pl.editable ? null : await pypiWheel(pl.name, pl.version);
      if (wheel) {
        file = path.join(tmp, wheel.filename);
        await downloadFile(wheel.url, file);
      } else {
        // Not on PyPI (made locally, or installed from a folder): pack the installed files into a wheel.
        const out = await run(found.python, ['-c', REPACK, pl.name, tmp], { timeoutMs: 60_000 });
        const line = out.split(/\r?\n/).find((l) => l.startsWith('TH-WHEEL'));
        file = line ? line.slice('TH-WHEEL'.length).trim() : null;
        source = `Imported (rebuilt from ${found.python})`;
        if (file && found.pyver !== PYTHON_SERIES && !/-none-any\.whl$/i.test(file)) {
          notes.push(`${label} was built for Python ${found.pyver}; Server Forge runs Endstone on Python ${PYTHON_SERIES}, so it may need a new build.`);
        }
      }
      if (!file || !existsSync(file)) throw new Error('no wheel');
      await installPluginFile(dir, file, source, wheel ? { kind: 'pypi', project: pl.name } : undefined);
      brought.push(label);
    } catch (err) {
      failed.push(`${label} (${(err as Error).message.slice(0, 120)})`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (brought.length) notes.push(`Brought in ${brought.length} plugin${brought.length === 1 ? '' : 's'} installed with pip: ${brought.join(', ')}.`);
  if (failed.length) notes.push(`Couldn't bring in: ${failed.join('; ')}. Add their .whl files in the Plugins tab.`);
  if (!found.plugins.length && !whls.length) notes.push('It had no plugins.');
  return { installDir: dir, notes, endstone: true };
}

// ---------- versions ----------

/** Compares dotted versions loosely ("0.11.14" vs "0.11.2", "1.2.0b1"); numbers only, pre-release tags count lower. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : /^\d+/.test(x) ? Number(/^\d+/.exec(x)![0]) - 0.5 : -1));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ---------- the Plugins tab ----------

export const endstonePlugins: AddonSupport = {
  available: isEndstone,
  labels: () => ({
    tab: 'Plugins',
    noun: 'plugin',
    plural: 'plugins',
    dropHelp:
      'Drop an Endstone plugin here: a <b>.whl</b> (Python) or <b>.dll</b> (C++) file. They go in the server\'s <b>plugins</b> folder and load when the server starts; Endstone installs what a plugin needs by itself. Bedrock addons go in the Addons tab.',
  }),
  accept: '.whl,.dll',
  links: [
    { label: 'GitHub', url: 'https://github.com/topics/endstone-plugin', help: 'Projects tagged endstone-plugin. Download the .whl from a project’s Releases.' },
    { label: 'PyPI', url: 'https://pypi.org/search/?q=endstone', help: 'Python plugins published as packages (names start with endstone-). Download the .whl under "Download files".' },
    { label: 'Endstone docs', url: 'https://endstone.dev/latest/', help: 'How plugins, permissions and endstone.toml work.' },
  ],
  status(record) {
    const v = installedEndstone(record.installDir);
    if (!v) return { ok: false, title: "Endstone isn't set up yet", text: 'Server Forge downloads Python, Endstone and the Bedrock version it supports. This also happens by itself on the next start.', setupLabel: 'Set up Endstone' };
    const mc = endstoneBedrockVersion(record.installDir);
    return { ok: true, title: `Endstone ${v}${mc ? ` · Bedrock ${mc}` : ''}`, text: 'Plugins load when the server starts. Their settings are in plugins/<plugin name>/ (Files tab). Type "plugins" in the Console to see which loaded.' };
  },
  async setup(record, log) {
    let vanilla: string | null = null;
    try {
      vanilla = readFileSync(path.join(record.installDir, '.tavernhost-version'), 'utf-8').trim() || null;
    } catch {}
    const r = await setupEndstone(record.installDir, { update: (s) => log(s), line: log }, { vanillaVersion: vanilla });
    recordBedrockVersion(record.installDir, r.bedrock);
    return `Endstone ${r.endstone} is set up${r.bedrock ? ` (Bedrock ${r.bedrock})` : ''}.`;
  },
  list: (record) => listPlugins(record.installDir),
  install: (record, file, source) => installPluginFile(record.installDir, file, source),
  remove: (record, id) => removePlugin(record.installDir, id),
  setEnabled: (record, id, enabled) => setPluginEnabled(record.installDir, id, enabled),
  icon: () => null,
  checkUpdates: (record) => checkPluginUpdates(record.installDir),
  update: (record, id) => updatePlugin(record.installDir, id),
  search: (_record, q) => searchPlugins(q),
  installFound: (record, id) => installFound(record.installDir, id),
};
