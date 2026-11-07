// Bedrock addon manager: installs .mcaddon/.mcpack/.zip files into a Bedrock server and registers their packs in the
// world's world_behavior_packs.json / world_resource_packs.json (pack UUID + version), which is what makes the world
// load them. Updating a pack replaces its folder and bumps the version in those files; removing undoes both.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync, copyFileSync } from 'node:fs';
import { isLinux } from '../platform/host.ts';
import { unzipFile } from '../platform/archive.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readWorldSettings } from './bedrock-world.ts';
import { defenderScan, SCANNER } from '../modscan.ts';

const execFileAsync = promisify(execFile);

export type PackType = 'behavior' | 'resource';

export interface PackInfo {
  /** "<location>:<uuid>": identifies one copy of a pack. */
  id: string;
  uuid: string;
  location: PackLocation;
  /** The same pack (UUID) is also in the other location. */
  duplicate: boolean;
  version: number[];
  type: PackType;
  name: string;
  description: string;
  /** Folder name inside behavior_packs/ or resource_packs/. */
  folder: string;
  enabled: boolean;
  /** Place in the world's list for its type (0 = top = highest priority, like Bedrock's Active list); null when off. */
  priority: number | null;
  hasIcon: boolean;
  /** Uses Bedrock's beta scripting APIs, which need the world's "Beta APIs" experiment. */
  needsBetaApis: boolean;
  /** Installed by Server Forge (vs. packs that were already there). */
  managed: boolean;
  installedAt: number | null;
  source: string | null;
  /** The CurseForge project this pack is linked to (for update checks). */
  curseforge: { projectId: number; name: string; url: string | null } | null;
  minEngine: number[] | null;
  /** Version/experiment problems (e.g. needs a newer Bedrock than the server runs). */
  warnings: { level: 'error' | 'warn'; text: string }[];
  typeLabel: string;
  typeClass: string;
}

/** The CurseForge project a pack comes from, and the file installed (fileDate: newer files count as updates). */
export interface CurseforgeLink {
  projectId: number;
  name: string;
  url: string | null;
  fileId: number | null;
  fileDate: string;
}

interface Registry {
  packs: Record<string, { installedAt: number; source: string | null; curseforge?: CurseforgeLink }>;
  /** Where new addons go. */
  location?: PackLocation;
  /** Addon updates from CurseForge: which files count (release / + beta / + alpha) and whether to install them by itself. */
  updates?: { channel: 'release' | 'beta' | 'alpha'; auto: boolean };
}

const REGISTRY_FILE = '.tavernhost-addons.json';
// Bedrock's built-in packs live in the same folders; never list or touch them.
const BUILTIN_FOLDERS = /^(vanilla(_[\d.]+|_base)?|chemistry(_[\d.]+)?|experimental_.*|editor.*|server_(\w+_)?library)$/i;

// ---------- small helpers ----------

/** Pack manifests are "JSON" that often contains comments and trailing commas; strip those, keeping strings intact. */
export function parseLenientJson(text: string): any {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1'));
}

function versionArray(v: unknown): number[] {
  if (Array.isArray(v)) return v.map((n) => Number(n) || 0);
  if (typeof v === 'string') return v.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  return [0, 0, 0];
}

export function versionText(v: number[]) {
  return v.join('.');
}

function compareVersions(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

async function unzip(zip: string, dest: string) {
  try {
    if (isLinux) return await unzipFile(zip, dest);
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TH_SRC, $env:TH_DEST)'],
      { env: { ...process.env, TH_SRC: zip, TH_DEST: dest }, windowsHide: true, timeout: 10 * 60_000 },
    );
  } catch {
    throw new Error(`${path.basename(zip)} isn't a valid .mcaddon/.mcpack/.zip file (it couldn't be unzipped).`);
  }
}

function readJsonList(file: string): { pack_id: string; version: number[] }[] {
  if (!existsSync(file)) return [];
  try {
    const data = parseLenientJson(readFileSync(file, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON; fix or delete it first.`);
  }
}

function writeJsonList(file: string, list: unknown[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.tavernhost-backup`)) copyFileSync(file, `${file}.tavernhost-backup`);
  writeFileSync(file, JSON.stringify(list, null, 2) + '\n');
}

// ---------- reading packs ----------

interface ManifestInfo {
  uuid: string;
  version: number[];
  type: PackType;
  name: string;
  description: string;
  needsBetaApis: boolean;
  /** Oldest Bedrock version the pack says it works on (header.min_engine_version). */
  minEngine: number[] | null;
}

/** "pack.name" style names are looked up in the pack's texts/en_US.lang. */
function localize(dir: string, text: string): string {
  if (!/^[\w.]+$/.test(text) || !text.includes('.')) return text;
  const lang = path.join(dir, 'texts', 'en_US.lang');
  if (!existsSync(lang)) return text;
  const line = readFileSync(lang, 'utf-8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${text}=`));
  return line ? line.slice(text.length + 1).replace(/\s*#.*$/, '').trim() : text;
}

function readManifest(dir: string): ManifestInfo | null {
  const file = path.join(dir, 'manifest.json');
  if (!existsSync(file)) return null;
  let m: any;
  try {
    m = parseLenientJson(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const header = m?.header;
  if (!header?.uuid) return null;
  const modules: { type?: string }[] = Array.isArray(m.modules) ? m.modules : [];
  const type: PackType = modules.some((x) => x.type === 'resources') ? 'resource' : 'behavior';
  const deps: { module_name?: string; version?: string }[] = Array.isArray(m.dependencies) ? m.dependencies : [];
  const needsBetaApis = deps.some((d) => d.module_name?.startsWith('@minecraft/') && /beta/i.test(String(d.version ?? '')));
  return {
    uuid: String(header.uuid).toLowerCase(),
    version: versionArray(header.version),
    type,
    name: localize(dir, String(header.name ?? 'Unnamed pack')).replace(/§./g, ''),
    description: localize(dir, String(header.description ?? '')).replace(/§./g, ''),
    needsBetaApis,
    minEngine: header.min_engine_version ? versionArray(header.min_engine_version) : null,
  };
}

/** Every folder under `root` (any depth) that holds a pack manifest. */
function findPackDirs(root: string, depth = 0): string[] {
  if (depth > 5 || !existsSync(root)) return [];
  if (existsSync(path.join(root, 'manifest.json'))) return [root];
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) out.push(...findPackDirs(path.join(root, e.name), depth + 1));
  return out;
}

// ---------- the server's packs ----------

// Bedrock loads packs from two places: the server folder's behavior_packs/resource_packs (shared by every world) and the
// world's own worlds/<level>/behavior_packs + resource_packs (travel with the world). Either way the world's
// world_*_packs.json decides what is switched on. Server Forge manages both; the owner picks where new addons go.
export type PackLocation = 'server' | 'world';
export const LOCATIONS: PackLocation[] = ['server', 'world'];

function worldDir(installDir: string, level: string) {
  return path.join(installDir, 'worlds', level);
}

function folders(installDir: string, level: string, location: PackLocation) {
  const base = location === 'world' ? worldDir(installDir, level) : installDir;
  return { behavior: path.join(base, 'behavior_packs'), resource: path.join(base, 'resource_packs') };
}

/** "world:<uuid>" / "server:<uuid>" (a bare UUID matches whichever copy is found first). */
function parseId(id: string): { location: PackLocation | null; uuid: string } {
  const m = /^(server|world):(.+)$/.exec(String(id));
  return m ? { location: m[1] as PackLocation, uuid: m[2].toLowerCase() } : { location: null, uuid: String(id).toLowerCase() };
}

function findPack(installDir: string, level: string, id: string): PackInfo {
  const { location, uuid } = parseId(id);
  const pack = listPacks(installDir, level).find((p) => p.uuid === uuid && (!location || p.location === location));
  if (!pack) throw new Error('That pack is not installed.');
  return pack;
}

function packDir(installDir: string, level: string, pack: Pick<PackInfo, 'location' | 'type' | 'folder'>) {
  return path.join(folders(installDir, level, pack.location)[pack.type], pack.folder);
}

/** Folder of an installed pack (for other modules that read a pack's files). */
export function packFolderPath(installDir: string, level: string, pack: Pick<PackInfo, 'location' | 'type' | 'folder'>) {
  return packDir(installDir, level, pack);
}

function worldListFile(installDir: string, level: string, type: PackType) {
  return path.join(worldDir(installDir, level), type === 'behavior' ? 'world_behavior_packs.json' : 'world_resource_packs.json');
}

function loadRegistry(installDir: string): Registry {
  const file = path.join(installDir, REGISTRY_FILE);
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : { packs: {} };
  } catch {
    return { packs: {} };
  }
}

function saveRegistry(installDir: string, reg: Registry) {
  writeFileSync(path.join(installDir, REGISTRY_FILE), JSON.stringify(reg, null, 2));
}

/** Where new addons are installed on this server (default: the server folder). */
export function getInstallLocation(installDir: string): PackLocation {
  return loadRegistry(installDir).location === 'world' ? 'world' : 'server';
}

export function setInstallLocation(installDir: string, location: PackLocation) {
  if (!LOCATIONS.includes(location)) throw new Error('Location must be "server" or "world".');
  const reg = loadRegistry(installDir);
  reg.location = location;
  saveRegistry(installDir, reg);
}

/** The Bedrock version Server Forge installed (".tavernhost-version"), e.g. [1, 26, 51]. */
function serverVersion(installDir: string): number[] | null {
  try {
    const v = readFileSync(path.join(installDir, '.tavernhost-version'), 'utf-8').trim();
    return /^\d+(\.\d+)+/.test(v) ? v.split('.').map(Number) : null;
  } catch {
    return null;
  }
}

function betaApisOn(installDir: string, level: string): boolean | null {
  try {
    return readWorldSettings(installDir, level).experiments.find((e) => e.key === 'gametest')?.enabled ?? null;
  } catch {
    return null;
  }
}

/** Problems with a pack on this server: needs a newer Bedrock, or Beta APIs while the world has them off. */
function packWarnings(m: ManifestInfo, server: number[] | null, betaOn: boolean | null) {
  const w: { level: 'error' | 'warn'; text: string }[] = [];
  if (m.minEngine && server && compareVersions(m.minEngine, server) > 0) {
    w.push({ level: 'error', text: `Needs Bedrock ${versionText(m.minEngine)} or newer, but this server runs ${versionText(server)}. Update the server (Settings → Update) or find an older version of the addon.` });
  }
  if (m.needsBetaApis && betaOn === false) {
    w.push({ level: 'warn', text: 'Uses beta scripting APIs: turn on "Beta APIs" in the World tab or it won\'t work.' });
  }
  return w;
}

/** Installed (non-built-in) packs in both locations, with whether the world has them switched on. */
export function listPacks(installDir: string, level: string): PackInfo[] {
  const server = serverVersion(installDir);
  const betaOn = betaApisOn(installDir, level);
  const reg = loadRegistry(installDir);
  const order = { behavior: new Map<string, number>(), resource: new Map<string, number>() };
  for (const type of ['behavior', 'resource'] as const) {
    readJsonList(worldListFile(installDir, level, type)).forEach((e, i) => {
      const uuid = String(e.pack_id).toLowerCase();
      if (!order[type].has(uuid)) order[type].set(uuid, i);
    });
  }
  const enabled = new Set([...order.behavior.keys(), ...order.resource.keys()]);
  const result: PackInfo[] = [];
  for (const location of LOCATIONS) {
    for (const [type, root] of Object.entries(folders(installDir, level, location)) as [PackType, string][]) {
      if (!existsSync(root)) continue;
      for (const folder of readdirSync(root)) {
        // Bedrock's own packs only live in the server folder.
        if (location === 'server' && BUILTIN_FOLDERS.test(folder)) continue;
        const dir = path.join(root, folder);
        if (!statSync(dir).isDirectory()) continue;
        const m = readManifest(dir);
        if (!m) continue;
        const managed = reg.packs[m.uuid];
        result.push({
          ...m,
          id: `${location}:${m.uuid}`,
          type,
          location,
          folder,
          enabled: enabled.has(m.uuid),
          priority: order[type].get(m.uuid) ?? null,
          duplicate: false,
          hasIcon: existsSync(path.join(dir, 'pack_icon.png')),
          managed: !!managed,
          installedAt: managed?.installedAt ?? null,
          source: managed?.source ?? null,
          curseforge: managed?.curseforge ? { projectId: managed.curseforge.projectId, name: managed.curseforge.name, url: managed.curseforge.url } : null,
          warnings: packWarnings(m, server, betaOn),
          typeLabel: type === 'behavior' ? 'Behavior pack' : 'Resource pack',
          typeClass: type,
        });
      }
    }
  }
  for (const p of result) p.duplicate = result.some((q) => q !== p && q.uuid === p.uuid);
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location));
}

export function packIcon(installDir: string, level: string, id: string): string | null {
  try {
    const icon = path.join(packDir(installDir, level, findPack(installDir, level, id)), 'pack_icon.png');
    return existsSync(icon) ? icon : null;
  } catch {
    return null;
  }
}

/** Moves a pack between the server folder and the world folder (its world JSON entry stays as it is). */
export function movePack(installDir: string, level: string, id: string, to: PackLocation) {
  if (!LOCATIONS.includes(to)) throw new Error('Location must be "server" or "world".');
  const pack = findPack(installDir, level, id);
  if (pack.location === to) return pack;
  if (listPacks(installDir, level).some((p) => p.uuid === pack.uuid && p.location === to)) {
    throw new Error(`There's already a copy of "${pack.name}" in the ${to === 'world' ? 'world' : 'server'} folder. Remove one of them first.`);
  }
  const src = packDir(installDir, level, pack);
  const destRoot = folders(installDir, level, to)[pack.type];
  mkdirSync(destRoot, { recursive: true });
  let folder = pack.folder;
  if (existsSync(path.join(destRoot, folder))) folder = safeFolderName(pack.name, pack.uuid);
  if (existsSync(path.join(destRoot, folder))) throw new Error(`A folder named "${folder}" already exists there.`);
  cpSync(src, path.join(destRoot, folder), { recursive: true });
  rmSync(src, { recursive: true, force: true });
  return { ...pack, location: to, folder };
}

function setEnabledIn(installDir: string, level: string, type: PackType, uuid: string, version: number[] | null) {
  const file = worldListFile(installDir, level, type);
  const all = readJsonList(file);
  const at = all.findIndex((e) => String(e.pack_id).toLowerCase() === uuid);
  const list = all.filter((_, i) => i !== at);
  // An update keeps the pack's place; new packs go first (Bedrock gives the top of the list the highest priority).
  if (version) list.splice(at >= 0 ? at : 0, 0, { pack_id: uuid, version });
  writeJsonList(file, list);
}

/**
 * Rewrites the world's list for one pack type in the given order (pack ids, top = highest priority). Entries that
 * weren't mentioned (e.g. packs whose files are missing) keep their relative order below the ones that were.
 */
export function reorderPacks(installDir: string, level: string, type: PackType, ids: string[]) {
  if (type !== 'behavior' && type !== 'resource') throw new Error('Type must be "behavior" or "resource".');
  const file = worldListFile(installDir, level, type);
  const list = readJsonList(file);
  const uuids = [...new Set(ids.map((id) => parseId(id).uuid))];
  const byUuid = new Map(list.map((e) => [String(e.pack_id).toLowerCase(), e]));
  const missing = uuids.filter((u) => !byUuid.has(u));
  if (missing.length) throw new Error('Some of those packs are not switched on in this world. Refresh and try again.');
  const listed = uuids.map((u) => byUuid.get(u)!);
  const rest = list.filter((e) => !uuids.includes(String(e.pack_id).toLowerCase()));
  writeJsonList(file, [...listed, ...rest]);
}

export function setPackEnabled(installDir: string, level: string, id: string, enabled: boolean) {
  const pack = findPack(installDir, level, id);
  setEnabledIn(installDir, level, pack.type, pack.uuid, enabled ? pack.version : null);
}

export function removePack(installDir: string, level: string, id: string) {
  const pack = findPack(installDir, level, id);
  rmSync(packDir(installDir, level, pack), { recursive: true, force: true });
  // Only take it out of the world (and forget it) when no other copy is left.
  if (!listPacks(installDir, level).some((p) => p.uuid === pack.uuid)) {
    setEnabledIn(installDir, level, pack.type, pack.uuid, null);
    const reg = loadRegistry(installDir);
    delete reg.packs[pack.uuid];
    saveRegistry(installDir, reg);
  }
  return pack;
}

function safeFolderName(name: string, uuid: string) {
  const base = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'pack';
  return `${base}_${uuid.slice(0, 8)}`;
}

// ---------- CurseForge links and update settings ----------

/** Links packs (e.g. a behavior + resource pack from one .mcaddon) to a CurseForge project. */
export function linkPacks(installDir: string, uuids: string[], link: CurseforgeLink) {
  const reg = loadRegistry(installDir);
  for (const uuid of uuids) reg.packs[uuid] = { ...(reg.packs[uuid] ?? { installedAt: Date.now(), source: `CurseForge: ${link.name}` }), curseforge: link };
  saveRegistry(installDir, reg);
}

/** Removes a pack's CurseForge link (and that of the other packs from the same project). */
export function unlinkPack(installDir: string, uuid: string) {
  const reg = loadRegistry(installDir);
  const projectId = reg.packs[uuid]?.curseforge?.projectId;
  for (const entry of Object.values(reg.packs)) if (projectId && entry.curseforge?.projectId === projectId) delete entry.curseforge;
  saveRegistry(installDir, reg);
}

/** Every linked CurseForge project with the packs (UUIDs) that came from it. */
export function linkedProjects(installDir: string): { link: CurseforgeLink; uuids: string[] }[] {
  const byProject = new Map<number, { link: CurseforgeLink; uuids: string[] }>();
  for (const [uuid, entry] of Object.entries(loadRegistry(installDir).packs)) {
    const l = entry.curseforge;
    if (!l) continue;
    const g = byProject.get(l.projectId) ?? { link: l, uuids: [] };
    g.uuids.push(uuid);
    // The newest record of the installed file wins (packs of one project are updated together).
    if (l.fileDate > g.link.fileDate) g.link = l;
    byProject.set(l.projectId, g);
  }
  return [...byProject.values()];
}

export function getUpdateSettings(installDir: string): { channel: 'release' | 'beta' | 'alpha'; auto: boolean } {
  return { channel: 'release', auto: false, ...loadRegistry(installDir).updates };
}

export function setUpdateSettings(installDir: string, input: { channel?: unknown; auto?: unknown }) {
  const reg = loadRegistry(installDir);
  const current = getUpdateSettings(installDir);
  const channel = input.channel === undefined ? current.channel : String(input.channel);
  if (!['release', 'beta', 'alpha'].includes(channel)) throw new Error('Pick release, beta or alpha.');
  reg.updates = { channel: channel as 'release' | 'beta' | 'alpha', auto: input.auto === undefined ? current.auto : !!input.auto };
  saveRegistry(installDir, reg);
  return reg.updates;
}

export interface InstallResult {
  installed: { name: string; type: PackType; version: string; action: 'installed' | 'updated' | 'reinstalled'; location: string }[];
  warnings: string[];
  /** UUIDs of the packs in the file (to link them to where they came from). */
  uuids?: string[];
}

/**
 * Installs every pack found in an .mcaddon / .mcpack / .zip file (or a folder). Packs whose UUID is already installed
 * are replaced (updated) in place. All packs are switched on in the world.
 */
export async function installAddonFile(installDir: string, level: string, file: string, source: string | null): Promise<InstallResult> {
  const work = path.join(os.tmpdir(), `tavernhost-addon-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  try {
    // Windows Defender first: a detection stops the install.
    if (!statSync(file).isDirectory()) {
      const scan = await defenderScan(file);
      if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat} in ${path.basename(file)}.`);
    }
    const top = path.join(work, 'top');
    if (statSync(file).isDirectory()) cpSync(file, top, { recursive: true });
    else await unzip(file, top);
    // .mcaddon files often contain .mcpack files (which are zips themselves).
    const nested = [];
    const stack = [top];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.(mcpack|mcaddon|zip)$/i.test(e.name)) nested.push(p);
      }
    }
    for (const [i, zip] of nested.entries()) await unzip(zip, path.join(work, `nested-${i}`));

    const packDirs = findPackDirs(work);
    if (!packDirs.length) throw new Error("No Bedrock packs were found in that file (no manifest.json). Make sure it's a .mcaddon or .mcpack.");

    const existing = listPacks(installDir, level);
    const reg = loadRegistry(installDir);
    const preferred = getInstallLocation(installDir);
    const result: InstallResult = { installed: [], warnings: [] };
    const seen = new Set<string>();
    for (const dir of packDirs) {
      const m = readManifest(dir);
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      if (!existsSync(worldDir(installDir, level))) mkdirSync(worldDir(installDir, level), { recursive: true });
      // Updates replace every existing copy where it is; new packs go to the chosen location.
      const copies = existing.filter((p) => p.uuid === m.uuid);
      const targets = copies.length ? copies.map((p) => ({ location: p.location, type: p.type, folder: p.folder })) : [{ location: preferred, type: m.type, folder: safeFolderName(m.name, m.uuid) }];
      for (const t of targets) {
        const dest = packDir(installDir, level, t);
        mkdirSync(path.dirname(dest), { recursive: true });
        rmSync(dest, { recursive: true, force: true });
        cpSync(dir, dest, { recursive: true });
      }
      setEnabledIn(installDir, level, m.type, m.uuid, m.version);
      // Keep its CurseForge link through updates.
      reg.packs[m.uuid] = { ...reg.packs[m.uuid], installedAt: Date.now(), source };
      (result.uuids ??= []).push(m.uuid);
      const old = copies[0];
      const action = !old ? 'installed' : compareVersions(m.version, old.version) > 0 ? 'updated' : 'reinstalled';
      result.installed.push({ name: m.name, type: m.type, version: versionText(m.version), action, location: targets.map((t) => t.location).join(' + ') });
      const server = serverVersion(installDir);
      if (m.minEngine && server && compareVersions(m.minEngine, server) > 0) {
        // Too new for this server: keep it installed but switched off, so the world still loads.
        setEnabledIn(installDir, level, m.type, m.uuid, null);
        result.warnings.push(
          `⛔ "${m.name}" needs Bedrock ${versionText(m.minEngine)} or newer, but this server runs ${versionText(server)}. It was installed switched OFF; update the server, use an older version of the addon, or use "Force on" in the list to try it anyway.`,
        );
      }
      if (m.needsBetaApis) {
        const on = betaApisOn(installDir, level);
        result.warnings.push(
          on
            ? `"${m.name}" uses beta scripting APIs; Beta APIs is already on for this world.`
            : `⚠ "${m.name}" uses beta scripting APIs. Turn on "Beta APIs" in the World tab or it won't work.`,
        );
      }
    }
    saveRegistry(installDir, reg);
    if (result.installed.some((p) => p.type === 'resource')) {
      result.warnings.push('This includes a resource pack. To make players download it automatically, set texturepack-required=true in Properties.');
    }
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
