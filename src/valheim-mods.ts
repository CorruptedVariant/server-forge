// Valheim modding (BepInEx + Thunderstore packages), shared by Server Forge (server side) and Tavern Client Mod Manager (the
// players' app). Installs packages the same way r2modman does:
//   BepInExPack_Valheim/*          -> the game folder (winhttp.dll, doorstop_config.ini, BepInEx/core, ...)
//   plugins/*, loose files         -> BepInEx/plugins/<Namespace-Name>/
//   patchers/*                     -> BepInEx/patchers/<Namespace-Name>/
//   config/*                       -> BepInEx/config/ (existing configs are kept)
// Turned-off mods are moved to BepInEx/tavernhost-disabled/ (BepInEx loads everything under plugins/).
// What's installed is recorded in BepInEx/tavernhost-mods.json.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, readdirSync, statSync, createWriteStream } from 'node:fs';
import { trackDownload } from './platform/mod-downloads.ts';
import { isLinux } from './platform/host.ts';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from './zip.ts';

export const THUNDERSTORE = 'https://thunderstore.io';
export const BEPINEX_PACK = { namespace: 'denikson', name: 'BepInExPack_Valheim' };
const UA = { 'User-Agent': 'TavernHost (+https://github.com/)' };
const REGISTRY = 'tavernhost-mods.json';
const DISABLED_DIR = 'tavernhost-disabled';

/** Who needs a mod: both server and players, only the server, or only players. */
export type Side = 'both' | 'server' | 'clients';

export interface ModEntry {
  namespace: string;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  side: Side;
  enabled: boolean;
  installedAt: number;
  /** "thunderstore" / "hexium" (anyone can download it from that site) or "upload" (only this copy exists). */
  source: Source;
  /** Installed only because another mod needs it. */
  asDependency: boolean;
  /** For the players' app: mods it installed from a server link (removed again when the server drops them). */
  syncedFrom?: string | null;
}

interface Registry {
  mods: Record<string, ModEntry>;
  bepinex: { version: string } | null;
}

export const fullName = (m: { namespace: string; name: string }) => `${m.namespace}-${m.name}`;

/** "Namespace-Name-1.2.3" -> parts. Thunderstore namespaces and names never contain "-". */
export function parseRef(ref: string): { namespace: string; name: string; version: string } | null {
  const m = /^([^-]+)-([^-]+)-(\d+\.\d+\.\d+)$/.exec(ref.trim());
  return m ? { namespace: m[1], name: m[2], version: m[3] } : null;
}

export function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------- registry ----------

function bepDir(gameDir: string) {
  return path.join(gameDir, 'BepInEx');
}

export function loadRegistry(gameDir: string): Registry {
  try {
    return JSON.parse(readFileSync(path.join(bepDir(gameDir), REGISTRY), 'utf-8'));
  } catch {
    return { mods: {}, bepinex: null };
  }
}

function saveRegistry(gameDir: string, reg: Registry) {
  mkdirSync(bepDir(gameDir), { recursive: true });
  writeFileSync(path.join(bepDir(gameDir), REGISTRY), JSON.stringify(reg, null, 2));
}

/** BepInEx is installed if its core and the doorstop loader are there. */
export function bepinexStatus(gameDir: string) {
  const installed = existsSync(path.join(bepDir(gameDir), 'core', 'BepInEx.dll')) && (existsSync(path.join(gameDir, 'winhttp.dll')) || (isLinux && existsSync(path.join(gameDir, 'doorstop_libs', 'libdoorstop_x64.so'))));
  return { installed, version: installed ? (loadRegistry(gameDir).bepinex?.version ?? 'unknown') : null };
}

/**
 * What loads BepInEx into a native Linux Valheim (server or game): the same settings as the pack's start_*_bepinex.sh.
 * Empty when it isn't installed or the loader is switched off, so it follows the same switch as on Windows.
 */
export function linuxDoorstopEnv(gameDir: string): Record<string, string> {
  if (!existsSync(path.join(gameDir, 'doorstop_libs', 'libdoorstop_x64.so')) || !existsSync(path.join(bepDir(gameDir), 'core', 'BepInEx.Preloader.dll'))) return {};
  try {
    if (/^\s*enabled\s*=\s*false/im.test(readFileSync(path.join(gameDir, 'doorstop_config.ini'), 'utf-8'))) return {};
  } catch {}
  return {
    DOORSTOP_ENABLED: '1',
    DOORSTOP_TARGET_ASSEMBLY: './BepInEx/core/BepInEx.Preloader.dll',
    LD_LIBRARY_PATH: './doorstop_libs:./linux64',
    LD_PRELOAD: 'libdoorstop_x64.so',
  };
}

/**
 * The Steam launch option a Linux player needs once for mods to load, or null if none is needed yet. Under Proton the
 * game has to be told to use BepInEx's winhttp.dll; the native game starts through a small script, which reads the same
 * loader switch as everything else (so Vanilla stays vanilla).
 */
export function linuxLaunchOption(gameDir: string): { mode: 'proton' | 'native'; option: string } | null {
  if (!bepinexStatus(gameDir).installed) return null;
  if (existsSync(path.join(gameDir, 'valheim.exe'))) return { mode: 'proton', option: 'WINEDLLOVERRIDES="winhttp=n,b" %command%' };
  const script = path.join(gameDir, 'sf-start.sh');
  writeFileSync(
    script,
    `#!/bin/sh
# Written by SF Mod Manager: loads BepInEx into native Linux Valheim, unless the loader is switched off.
cd "$(dirname "$0")"
if ! grep -qiE '^[[:space:]]*enabled[[:space:]]*=[[:space:]]*false' doorstop_config.ini 2>/dev/null; then
  export DOORSTOP_ENABLED=1 DOORSTOP_TARGET_ASSEMBLY="$PWD/BepInEx/core/BepInEx.Preloader.dll"
  export LD_LIBRARY_PATH="$PWD/doorstop_libs:$LD_LIBRARY_PATH" LD_PRELOAD="libdoorstop_x64.so:$LD_PRELOAD"
fi
exec "$@"
`,
    { mode: 0o755 },
  );
  return { mode: 'native', option: `"${script}" %command%` };
}

// ---------- the loader switch (vanilla vs modded) ----------
// BepInEx starts through Unity Doorstop (winhttp.dll), which reads doorstop_config.ini's `enabled`. Turning that off
// makes the game start completely vanilla (from Steam too) without moving or deleting any mod.

const doorstopFile = (gameDir: string) => path.join(gameDir, 'doorstop_config.ini');
const ENABLED_LINE = /^(\s*enabled\s*=\s*)(true|false)\s*$/im;

/** Whether BepInEx loads when the game starts (null: BepInEx isn't installed). */
export function loaderEnabled(gameDir: string): boolean | null {
  try {
    const m = ENABLED_LINE.exec(readFileSync(doorstopFile(gameDir), 'utf-8'));
    return m ? m[2].toLowerCase() === 'true' : true;
  } catch {
    return null;
  }
}

/** Turns BepInEx (every mod) on or off for the next game start. Does nothing if BepInEx isn't installed. */
export function setLoaderEnabled(gameDir: string, on: boolean) {
  const file = doorstopFile(gameDir);
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf-8');
  const next = ENABLED_LINE.test(text) ? text.replace(ENABLED_LINE, `$1${on}`) : text.replace(/^\[General\][^\n]*\n/im, (h) => `${h}enabled = ${on}\n`);
  if (next !== text) writeFileSync(file, next);
}

// ---------- Thunderstore and Hexium ----------
// Hexium (valheim.hexium.gg) is a newer Valheim mod site with a Thunderstore-compatible API: same package format,
// dependency strings and zip layout. Its download links can't be built from a name, so they come from the API.

/** Where a mod came from: a mod site anyone can download from, or an uploaded file only this copy has. */
export type Source = 'thunderstore' | 'hexium' | 'upload';
/** The mod sites. */
export type ModSite = 'thunderstore' | 'hexium';
export const HEXIUM = 'https://valheim.hexium.gg';
const REGISTRY_URL: Record<ModSite, string> = { thunderstore: 'https://thunderstore.io', hexium: HEXIUM };
export const REGISTRY_NAME: Record<ModSite, string> = { thunderstore: 'Thunderstore', hexium: 'Hexium' };
export const registryOf = (source: Source | undefined): ModSite | null => (source === 'hexium' ? 'hexium' : source === 'upload' ? null : 'thunderstore');

export interface PackageInfo {
  namespace: string;
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  downloadUrl: string;
  packageUrl: string;
  categories: string[];
  deprecated: boolean;
}

const infoCache = new Map<string, { at: number; info: PackageInfo }>();

const pkgPath = (namespace: string, name: string, version?: string) =>
  `/api/experimental/package/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${version ? `${encodeURIComponent(version)}/` : ''}`;

/** Latest version of a package on Thunderstore or Hexium (cached for 10 minutes). */
export async function latestPackage(namespace: string, name: string, registry: ModSite = 'thunderstore'): Promise<PackageInfo> {
  const key = `${registry}:${namespace}-${name}`.toLowerCase();
  const hit = infoCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.info;
  const res = await fetch(`${REGISTRY_URL[registry]}${pkgPath(namespace, name)}`, { headers: UA });
  if (res.status === 404) throw Object.assign(new Error(`${namespace}-${name} isn't on ${REGISTRY_NAME[registry]}.`), { notFound: true });
  if (!res.ok) throw new Error(`${REGISTRY_NAME[registry]} didn't answer (HTTP ${res.status}).`);
  const p = (await res.json()) as any;
  const listing = (p.community_listings ?? []).find((c: any) => c.community === 'valheim') ?? p.community_listings?.[0];
  const info: PackageInfo = {
    namespace: p.namespace,
    name: p.name,
    version: p.latest.version_number,
    description: p.latest.description ?? '',
    dependencies: p.latest.dependencies ?? [],
    downloadUrl: p.latest.download_url,
    packageUrl: p.package_url,
    categories: listing?.categories ?? p.categories ?? [],
    deprecated: !!p.is_deprecated,
  };
  infoCache.set(key, { at: Date.now(), info });
  return info;
}

/**
 * Is this exact version still listed on the site it came from? Removed versions (e.g. taken down as harmful) give
 * active=false. null = couldn't check (offline).
 */
export async function versionStatus(namespace: string, name: string, version: string, registry: ModSite = 'thunderstore'): Promise<{ active: boolean | null; deprecated: boolean }> {
  try {
    const res = await fetch(`${REGISTRY_URL[registry]}${pkgPath(namespace, name, version)}`, { headers: UA });
    if (res.status === 404) return { active: false, deprecated: false };
    if (!res.ok) return { active: null, deprecated: false };
    const v = (await res.json()) as { is_active?: boolean };
    let deprecated = false;
    try {
      deprecated = (await latestPackage(namespace, name, registry)).deprecated;
    } catch {}
    return { active: v.is_active !== false, deprecated };
  } catch {
    return { active: null, deprecated: false };
  }
}

/** Guess who needs a mod from its categories (Thunderstore: "Client-side"/"Server-side"; Hexium: "Client & Server" etc.). */
export function sideFromCategories(categories: string[]): Side {
  const c = categories.map((x) => x.toLowerCase());
  if (c.some((x) => x.includes('client') && x.includes('server'))) return 'both';
  const client = c.some((x) => x === 'client-side' || x === 'client side' || x === 'client only' || x === 'client');
  const server = c.some((x) => x === 'server-side' || x === 'server side' || x === 'server only' || x === 'server');
  if (client && !server) return 'clients';
  if (server && !client) return 'server';
  return 'both';
}

/** Thunderstore's download address for an exact version (Hexium's come from its API: see packageDownloadUrl). */
export function downloadUrl(namespace: string, name: string, version: string) {
  return `${THUNDERSTORE}/package/download/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/`;
}

/** Download address of an exact version on either site. */
export async function packageDownloadUrl(namespace: string, name: string, version: string, registry: ModSite = 'thunderstore'): Promise<string> {
  if (registry === 'thunderstore') return downloadUrl(namespace, name, version);
  const res = await fetch(`${HEXIUM}${pkgPath(namespace, name, version)}`, { headers: UA });
  if (res.status === 404) throw new Error(`${namespace}-${name} ${version} isn't on Hexium.`);
  if (!res.ok) throw new Error(`Hexium didn't answer (HTTP ${res.status}).`);
  const v = (await res.json()) as { download_url?: string };
  if (!v.download_url) throw new Error(`Hexium has no download for ${namespace}-${name} ${version}.`);
  return v.download_url;
}

/** "https://valheim.hexium.gg/mods/Author/ModName" (optionally /versions/1.2.3) -> the package. */
export function parseHexiumUrl(text: string): { namespace: string; name: string; version: string | null } | null {
  const m = /^https?:\/\/(?:valheim\.)?hexium\.gg\/(?:c\/valheim\/)?mods\/([^/?#]+)\/([^/?#]+)(?:\/versions?\/(\d+\.\d+\.\d+))?\/?(?:[?#].*)?$/i.exec(text.trim());
  return m ? { namespace: decodeURIComponent(m[1]), name: decodeURIComponent(m[2]), version: m[3] ?? null } : null;
}

export async function downloadTo(url: string, dest: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  mkdirSync(path.dirname(dest), { recursive: true });
  const tracked = trackDownload(dest);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, done) {
      received += chunk.length;
      tracked.progress(received, total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
    tracked.done();
  } catch (err) {
    tracked.failed();
    throw err;
  }
}

// ---------- installing a package zip ----------

export interface ZipManifest {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  isBepInExPack: boolean;
}

export function readPackageZip(zipFile: string): ZipManifest {
  const zip = new ZipFile(zipFile);
  try {
    const names = zip.names().map((n) => [ZipFile.normalise(n), n] as const);
    const manifestName = names.find(([n]) => n.toLowerCase() === 'manifest.json')?.[1];
    const isBepInExPack = names.some(([n]) => n.startsWith('BepInExPack_Valheim/'));
    let m: any = {};
    if (manifestName) {
      try {
        m = JSON.parse(zip.text(manifestName) ?? '{}');
      } catch {}
    }
    const hasDll = names.some(([n]) => n.toLowerCase().endsWith('.dll'));
    if (!manifestName && !hasDll) throw new Error("That zip isn't a Valheim mod (no manifest.json or .dll inside).");
    return {
      name: String(m.name ?? ''),
      version: String(m.version_number ?? ''),
      description: String(m.description ?? ''),
      dependencies: Array.isArray(m.dependencies) ? m.dependencies.map(String) : [],
      isBepInExPack,
    };
  } finally {
    zip.close();
  }
}

// Limits for unpacking (a real mod is a few MB; these stop "zip bombs" from filling the disk or memory).
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

/** Writes one zip entry to disk; returns its size. */
function extractEntry(zip: ZipFile, entry: string, dest: string): number {
  const data = zip.get(entry, MAX_ENTRY_BYTES);
  if (!data) throw new Error(`The mod contains a file that couldn't be unpacked (${path.basename(ZipFile.normalise(entry))}: damaged, or over 512 MB). It was not installed.`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, data);
  return data.length;
}

function countBytes(total: { n: number }, add: number) {
  total.n += add;
  if (total.n > MAX_PACKAGE_BYTES) throw new Error('That mod unpacks to more than 2 GB, which no real mod does. It was not installed.');
}

function safeJoin(root: string, rel: string) {
  const full = path.resolve(root, rel);
  if (!full.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep) && full.toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw new Error(`Unsafe path in the mod zip: ${rel}`);
  }
  return full;
}

/** Installs BepInExPack_Valheim into the game (or server) folder. Existing BepInEx configs are kept. */
export function installBepInExZip(gameDir: string, zipFile: string, version: string) {
  const zip = new ZipFile(zipFile);
  const total = { n: 0 };
  try {
    for (const raw of zip.names()) {
      const n = ZipFile.normalise(raw);
      if (!n.startsWith('BepInExPack_Valheim/') || n.endsWith('/')) continue;
      const rel = n.slice('BepInExPack_Valheim/'.length);
      if (!rel || (!isLinux && /\.(sh|dylib|so)$/i.test(rel))) continue; // Linux/macOS launchers aren't needed on Windows
      const dest = safeJoin(gameDir, rel);
      if (/^BepInEx\/config\//i.test(rel) && existsSync(dest)) continue;
      countBytes(total, extractEntry(zip, raw, dest));
    }
  } finally {
    zip.close();
  }
  const reg = loadRegistry(gameDir);
  reg.bepinex = { version };
  saveRegistry(gameDir, reg);
}

/**
 * A mod's folder name ("Author-ModName"), checked before it's used to create or delete a folder: names can come from
 * a server's shared list, a zip or a web page, and one like "..\..\x" must never reach outside BepInEx.
 */
function modFolder(full: string): string {
  if (!/^[\w .-]{1,200}$/.test(full) || full.includes('..') || /^[. ]|[. ]$/.test(full)) throw new Error(`"${full}" isn't a valid mod name.`);
  return full;
}
function pluginDir(gameDir: string, full: string) {
  return path.join(bepDir(gameDir), 'plugins', modFolder(full));
}
function disabledDir(gameDir: string, full: string) {
  return path.join(bepDir(gameDir), DISABLED_DIR, modFolder(full));
}
function patcherDir(gameDir: string, full: string) {
  return path.join(bepDir(gameDir), 'patchers', modFolder(full));
}

/** Installs (or replaces) one mod package. `namespace` comes from the download's file name or Thunderstore. */
export function installModZip(gameDir: string, zipFile: string, meta: Omit<ModEntry, 'installedAt' | 'enabled'> & { enabled?: boolean }) {
  const full = fullName(meta);
  // Replacing: remove the old files first (both the on and off locations).
  for (const dir of [pluginDir(gameDir, full), disabledDir(gameDir, full), patcherDir(gameDir, full)]) rmSync(dir, { recursive: true, force: true });
  const enabled = meta.enabled ?? true;
  const target = enabled ? pluginDir(gameDir, full) : disabledDir(gameDir, full);
  const zip = new ZipFile(zipFile);
  const total = { n: 0 };
  try {
    for (const raw of zip.names()) {
      let n = ZipFile.normalise(raw);
      if (!n || n.endsWith('/')) continue;
      n = n.replace(/^BepInEx\//i, '');
      let dest: string;
      if (/^plugins\//i.test(n)) dest = safeJoin(target, n.slice(8));
      else if (/^patchers\//i.test(n)) dest = safeJoin(patcherDir(gameDir, full), n.slice(9));
      else if (/^config\//i.test(n)) {
        dest = safeJoin(path.join(bepDir(gameDir), 'config'), n.slice(7));
        if (existsSync(dest)) continue; // keep the owner's settings
      } else dest = safeJoin(target, n);
      countBytes(total, extractEntry(zip, raw, dest));
    }
  } finally {
    zip.close();
  }
  const reg = loadRegistry(gameDir);
  reg.mods[full] = { ...meta, enabled, installedAt: Date.now() };
  saveRegistry(gameDir, reg);
  return reg.mods[full];
}

export function setModEnabled(gameDir: string, full: string, enabled: boolean) {
  const reg = loadRegistry(gameDir);
  const mod = reg.mods[full];
  if (!mod) throw new Error('That mod is not installed.');
  if (mod.enabled === enabled) return;
  const from = enabled ? disabledDir(gameDir, full) : pluginDir(gameDir, full);
  const to = enabled ? pluginDir(gameDir, full) : disabledDir(gameDir, full);
  if (existsSync(from)) {
    mkdirSync(path.dirname(to), { recursive: true });
    rmSync(to, { recursive: true, force: true });
    renameSync(from, to);
  }
  mod.enabled = enabled;
  saveRegistry(gameDir, reg);
}

/**
 * Puts a mod's files where BepInEx loads them (plugins/) or not (tavernhost-disabled/) without changing its settings.
 * The server uses this for "players only" mods: kept and shared, but not loaded by the server itself.
 */
export function placeMod(gameDir: string, full: string, load: boolean) {
  const from = load ? disabledDir(gameDir, full) : pluginDir(gameDir, full);
  const to = load ? pluginDir(gameDir, full) : disabledDir(gameDir, full);
  if (!existsSync(from)) return;
  mkdirSync(path.dirname(to), { recursive: true });
  rmSync(to, { recursive: true, force: true });
  renameSync(from, to);
}

/** Marks a mod as installed by a server link (the players' app removes it again when the server drops it). */
export function markSynced(gameDir: string, full: string, linkId: string | null) {
  const reg = loadRegistry(gameDir);
  if (!reg.mods[full]) return;
  reg.mods[full].syncedFrom = linkId;
  saveRegistry(gameDir, reg);
}

export function setModSide(gameDir: string, full: string, side: Side) {
  const reg = loadRegistry(gameDir);
  if (!reg.mods[full]) throw new Error('That mod is not installed.');
  if (!['both', 'server', 'clients'].includes(side)) throw new Error('Unknown side.');
  reg.mods[full].side = side;
  saveRegistry(gameDir, reg);
}

export function removeMod(gameDir: string, full: string) {
  const reg = loadRegistry(gameDir);
  for (const dir of [pluginDir(gameDir, full), disabledDir(gameDir, full), patcherDir(gameDir, full)]) rmSync(dir, { recursive: true, force: true });
  delete reg.mods[full];
  saveRegistry(gameDir, reg);
}

export function modIcon(gameDir: string, full: string): string | null {
  for (const dir of [pluginDir(gameDir, full), disabledDir(gameDir, full)]) {
    const f = path.join(dir, 'icon.png');
    if (existsSync(f)) return f;
  }
  return null;
}

/** Names (without .dll) of a mod's plugin DLLs, wherever it is (on or off). Used to tell which config file is whose. */
export function modDlls(gameDir: string, full: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f.toLowerCase().endsWith('.dll')) out.push(f.slice(0, -4));
      else if (statSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  for (const dir of [pluginDir(gameDir, full), disabledDir(gameDir, full)]) walk(dir, 0);
  return out;
}

/** Mods that are required by other installed mods (can't be removed without breaking them). */
export function dependents(gameDir: string, full: string): string[] {
  const reg = loadRegistry(gameDir);
  return Object.values(reg.mods)
    .filter((m) => m.dependencies.some((d) => parseRef(d) && fullName(parseRef(d)!).toLowerCase() === full.toLowerCase()))
    .map((m) => m.name);
}

/** DLLs someone dropped straight into BepInEx/plugins (not installed through Server Forge). */
export function looseMods(gameDir: string): string[] {
  const dir = path.join(bepDir(gameDir), 'plugins');
  if (!existsSync(dir)) return [];
  const reg = loadRegistry(gameDir);
  const known = new Set(Object.keys(reg.mods).map((k) => k.toLowerCase()));
  return readdirSync(dir).filter((f) => !known.has(f.toLowerCase()) && (f.toLowerCase().endsWith('.dll') || statSync(path.join(dir, f)).isDirectory()));
}

/**
 * Takes over mods that were put in BepInEx/plugins without Server Forge (by r2modman or another mod manager, or by
 * hand): a folder named "Author-ModName" with the package's manifest.json inside is recognised, looked up on
 * Thunderstore (then Hexium) and recorded like a mod Server Forge installed, so it can be switched, updated and shared.
 * Lone DLLs, and packages neither site has, are left as they are (with the reason).
 */
export async function adoptLooseMods(gameDir: string): Promise<{ adopted: string[]; skipped: { name: string; reason: string }[] }> {
  const adopted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const pluginsDir = path.join(bepDir(gameDir), 'plugins');
  for (const loose of looseMods(gameDir)) {
    const dir = path.join(pluginsDir, loose);
    if (!statSync(dir).isDirectory()) {
      skipped.push({ name: loose, reason: 'a single DLL with no package information: reinstall it from Thunderstore, Hexium or its zip' });
      continue;
    }
    let manifest: any = null;
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf-8').replace(/^﻿/, ''));
    } catch {}
    const m = /^([^-]+)-([^-]+)$/.exec(loose);
    const name = String(manifest?.name ?? m?.[2] ?? '');
    if (!manifest || !m || m[2].toLowerCase() !== name.toLowerCase()) {
      skipped.push({ name: loose, reason: "no manifest.json with the author in the folder name, so it can't be identified: reinstall it from Thunderstore, Hexium or its zip" });
      continue;
    }
    const namespace = m[1];
    let site: ModSite | null = null;
    let info: PackageInfo | null = null;
    for (const s of ['thunderstore', 'hexium'] as ModSite[]) {
      try {
        info = await latestPackage(namespace, name, s);
        site = s;
        break;
      } catch {}
    }
    if (!site) {
      skipped.push({ name: loose, reason: "not on Thunderstore or Hexium, so players couldn't download it: add it as a zip instead" });
      continue;
    }
    const full = `${namespace}-${name}`;
    const reg = loadRegistry(gameDir);
    reg.mods[full] = {
      namespace,
      name,
      version: String(manifest.version_number || info!.version),
      description: String(manifest.description ?? ''),
      dependencies: Array.isArray(manifest.dependencies) ? manifest.dependencies.map(String) : [],
      side: sideFromCategories(info!.categories),
      enabled: true,
      installedAt: Date.now(),
      source: site,
      asDependency: false,
      syncedFrom: null,
    };
    saveRegistry(gameDir, reg);
    adopted.push(`${name} ${reg.mods[full].version}${site === 'hexium' ? ' (Hexium)' : ''}`);
  }
  // Mods another mod needs count as dependencies (listed after the mods themselves).
  const reg = loadRegistry(gameDir);
  const needed = new Set(Object.values(reg.mods).flatMap((x) => x.dependencies.map((d) => parseRef(d)).filter(Boolean).map((r) => fullName(r!).toLowerCase())));
  for (const mod of Object.values(reg.mods)) if (!mod.asDependency && needed.has(fullName(mod).toLowerCase()) && adopted.some((a) => a.startsWith(`${mod.name} `))) mod.asDependency = true;
  saveRegistry(gameDir, reg);
  return { adopted, skipped };
}

// ---------- installing from Thunderstore with dependencies ----------

export interface InstallReport {
  installed: { full: string; name: string; version: string; action: 'installed' | 'updated' | 'reinstalled' | 'kept'; asDependency: boolean }[];
  warnings: string[];
}

/**
 * Installs a mod and everything it depends on (newest versions from Thunderstore, never downgrading). BepInEx itself
 * is installed if missing. `zipFile` = an already-downloaded zip of the main package (e.g. from the addon browser).
 */
export interface InstallOptions {
  /** Called with every package file before it's installed; throw to stop the install (safety checks). */
  check?: (zipFile: string, pkg: { namespace: string; name: string; version: string; asDependency: boolean; source: Source }) => Promise<void>;
  /** Install only this package, not what it depends on (the players' app installs each shared mod separately). */
  noDependencies?: boolean;
}

export async function installWithDependencies(
  gameDir: string,
  main: { namespace: string; name: string; version?: string; zipFile?: string; side?: Side; source?: Source; syncedFrom?: string | null },
  log: (line: string) => void = () => {},
  opts: InstallOptions = {},
): Promise<InstallReport> {
  const report: InstallReport = { installed: [], warnings: [] };
  const work = path.join(os.tmpdir(), `tavernhost-valheim-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  const seen = new Set<string>();
  try {
    const queue: { namespace: string; name: string; version?: string; zipFile?: string; asDependency: boolean; side?: Side; source?: Source }[] = [
      { ...main, asDependency: false },
    ];
    while (queue.length) {
      const item = queue.shift()!;
      const full = fullName(item);
      if (seen.has(full.toLowerCase())) continue;
      seen.add(full.toLowerCase());
      const isBep = item.namespace === BEPINEX_PACK.namespace && item.name === BEPINEX_PACK.name;
      const reg = loadRegistry(gameDir);
      const existing = Object.values(reg.mods).find((m) => fullName(m).toLowerCase() === full.toLowerCase());
      // Dependencies: keep what's there if it's new enough.
      if (item.asDependency) {
        if (isBep && bepinexStatus(gameDir).installed) continue;
        if (existing && (!item.version || compareVersions(existing.version, item.version) >= 0)) {
          report.installed.push({ full, name: existing.name, version: existing.version, action: 'kept', asDependency: true });
          continue;
        }
      }
      let zipFile = item.zipFile;
      let version = item.version ?? '';
      let description = '';
      let dependencies: string[] = [];
      let categories: string[] = [];
      if (!zipFile) {
        // Newest from the mod's site unless an exact version was asked for (the players' app mirrors the server exactly).
        // Hexium mods often depend on mods that are only on Thunderstore: dependencies not found on Hexium come from there.
        let registry: ModSite = registryOf(item.source) ?? 'thunderstore';
        let info: PackageInfo | null = null;
        try {
          info = await latestPackage(item.namespace, item.name, registry);
        } catch (err) {
          if (registry === 'hexium' && item.asDependency && (err as { notFound?: boolean }).notFound) {
            registry = 'thunderstore';
            try {
              info = await latestPackage(item.namespace, item.name, registry);
            } catch (err2) {
              if (!version) throw err2;
            }
          } else if (!version) throw err;
        }
        if (!version || (item.asDependency && info && compareVersions(info.version, version) > 0)) version = info!.version;
        categories = info?.categories ?? [];
        item.source = registry;
        zipFile = path.join(work, `${full}-${version}.zip`);
        log(`Downloading ${full} ${version}${registry === 'hexium' ? ' from Hexium' : ''}…`);
        await downloadTo(info && info.version === version ? info.downloadUrl : await packageDownloadUrl(item.namespace, item.name, version, registry), zipFile);
      }
      const manifest = readPackageZip(zipFile);
      version = manifest.version || version;
      description = manifest.description;
      dependencies = manifest.dependencies;
      if (opts.check) await opts.check(zipFile, { namespace: item.namespace, name: item.name, version, asDependency: item.asDependency, source: item.source ?? 'thunderstore' });
      if (isBep || manifest.isBepInExPack) {
        installBepInExZip(gameDir, zipFile, version);
        report.installed.push({ full, name: 'BepInEx', version, action: 'installed', asDependency: item.asDependency });
        log(`BepInEx ${version} installed.`);
        continue;
      }
      const side = item.side ?? existing?.side ?? sideFromCategories(categories);
      installModZip(gameDir, zipFile, {
        namespace: item.namespace,
        name: item.name,
        version,
        description,
        dependencies,
        side,
        source: item.source ?? 'thunderstore',
        asDependency: existing ? existing.asDependency && item.asDependency : item.asDependency,
        syncedFrom: main.syncedFrom ?? existing?.syncedFrom ?? null,
        enabled: existing?.enabled ?? true,
      });
      const action = !existing ? 'installed' : compareVersions(version, existing.version) > 0 ? 'updated' : 'reinstalled';
      report.installed.push({ full, name: item.name, version, action, asDependency: item.asDependency });
      log(`${item.name} ${version} ${action}.`);
      for (const dep of opts.noDependencies ? [] : dependencies) {
        const ref = parseRef(dep);
        if (!ref) {
          report.warnings.push(`${item.name} lists a dependency Server Forge can't read: "${dep}".`);
          continue;
        }
        // A Hexium mod's dependencies are looked up on Hexium first.
        queue.push({ ...ref, asDependency: true, source: item.source === 'hexium' ? 'hexium' : undefined });
      }
    }
    if (!bepinexStatus(gameDir).installed) {
      log('Installing BepInEx (needed for all mods)…');
      const bep = await latestPackage(BEPINEX_PACK.namespace, BEPINEX_PACK.name);
      const zip = path.join(work, 'bepinex.zip');
      await downloadTo(bep.downloadUrl, zip);
      if (opts.check) await opts.check(zip, { ...BEPINEX_PACK, version: bep.version, asDependency: true, source: 'thunderstore' });
      installBepInExZip(gameDir, zip, bep.version);
      report.installed.push({ full: fullName(BEPINEX_PACK), name: 'BepInEx', version: bep.version, action: 'installed', asDependency: true });
    }
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Namespace/name/version from a Thunderstore download's file name ("Author-ModName-1.2.3.zip"). */
export function refFromFileName(file: string) {
  return parseRef(path.basename(file).replace(/\.zip$/i, '').replace(/\s*\(\d+\)$/, ''));
}
