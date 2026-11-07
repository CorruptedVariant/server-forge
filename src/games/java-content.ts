// Mod manager (Fabric, Forge, NeoForge: mods/) and plugin manager (Paper, Spigot: plugins/) for Java servers.
// Works like the Bedrock addon manager: install from an upload or a download in the addon browser, list, turn on/off
// (renaming to .jar.disabled, which the servers skip), remove. Each jar's metadata is read to show its name/version and
// to warn when it's for another loader or another Minecraft version.
import { existsSync, readdirSync, statSync, renameSync, rmSync, copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import type { ServerRecord } from './types.ts';
import { ZipFile } from '../zip.ts';
import { defenderScan, SCANNER, noScannerIsNormal } from '../modscan.ts';

export type Loader = 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'plugin' | 'paper-plugin' | 'bungee' | 'unknown';
export type ContentKind = 'mods' | 'plugins';

// BungeeCord (the proxy) has plugins too, in its own plugins folder; they're BungeeCord plugins, not Bukkit ones.
const KIND_BY_FLAVOR: Record<string, ContentKind> = { fabric: 'mods', forge: 'mods', neoforge: 'mods', paper: 'plugins', spigot: 'plugins', bungeecord: 'plugins' };
const LOADER_NAMES: Record<Loader, string> = {
  fabric: 'Fabric mod',
  quilt: 'Quilt mod',
  forge: 'Forge mod',
  neoforge: 'NeoForge mod',
  plugin: 'Bukkit/Spigot plugin',
  'paper-plugin': 'Paper plugin',
  bungee: 'BungeeCord plugin',
  unknown: 'Unknown jar',
};
const REGISTRY_FILE = '.tavernhost-content.json';

export function contentKind(record: ServerRecord): ContentKind | null {
  return KIND_BY_FLAVOR[String(record.settings.flavor)] ?? null;
}

// ---------- Minecraft version ranges ----------

function parseVer(v: string): number[] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [];
}
function cmp(a: number[], b: number[]) {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** Fabric-style predicate: "1.20.1", ">=1.20 <1.21", "~1.20", "^1.20", "1.20.x", "*"; arrays mean "any of". */
export function fabricMatches(pred: string | string[], mc: string): boolean {
  const list = Array.isArray(pred) ? pred : [pred];
  const v = parseVer(mc);
  if (!v.length) return true;
  return list.some((p) =>
    String(p)
      .trim()
      .split(/\s+/)
      .every((tok) => {
        if (!tok || tok === '*') return true;
        const m = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(tok)!;
        const op = m[1] ?? '';
        const raw = m[2];
        if (/[xX*]/.test(raw)) {
          const parts = raw.split('.');
          const fixed = parts.slice(0, parts.findIndex((x) => /[xX*]/.test(x)));
          return fixed.every((x, i) => Number(x) === v[i]);
        }
        const w = parseVer(raw);
        if (!w.length) return true;
        const c = cmp(v, w);
        const parts = raw.split('.').length;
        switch (op) {
          case '>=':
            return c >= 0;
          case '<=':
            return c <= 0;
          case '>':
            return c > 0;
          case '<':
            return c < 0;
          case '~':
            return c >= 0 && v[0] === w[0] && (parts < 2 || v[1] === w[1]);
          case '^':
            return c >= 0 && v[0] === w[0];
          default:
            // "1.21" also matches 1.21.0 only; "1.21.1" exactly.
            return c === 0;
        }
      }),
  );
}

/** Forge/Maven range: "[1.20.1,1.21)", "[1.20,)", "(,1.21]", several joined by commas; a bare version = that version. */
export function mavenMatches(range: string, mc: string): boolean {
  const v = parseVer(mc);
  const r = range.trim();
  if (!v.length || !r || r === '*') return true;
  const groups = r.match(/[[(][^\])]*[\])]/g);
  if (!groups) return cmp(v, parseVer(r)) === 0;
  return groups.some((g) => {
    const [lo, hi] = g.slice(1, -1).split(',').map((s) => s.trim());
    const incLo = g.startsWith('[');
    const incHi = g.endsWith(']');
    if (hi === undefined) return cmp(v, parseVer(lo)) === 0; // "[1.20.1]"
    if (lo && (incLo ? cmp(v, parseVer(lo)) < 0 : cmp(v, parseVer(lo)) <= 0)) return false;
    if (hi && (incHi ? cmp(v, parseVer(hi)) > 0 : cmp(v, parseVer(hi)) >= 0)) return false;
    return true;
  });
}

// ---------- reading jar metadata ----------

/** Just enough TOML for mods.toml: [[tables]], key = "string" | '''multi''' | bool | number. */
function parseModsToml(text: string) {
  const out: { root: Record<string, string>; mods: Record<string, string>[]; deps: Record<string, Record<string, string>[]> } = { root: {}, mods: [], deps: {} };
  let current: Record<string, string> = out.root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\[\[\s*([\w.-]+)\s*\]\]/.exec(line))) {
      current = {};
      if (m[1] === 'mods') out.mods.push(current);
      else if (m[1].startsWith('dependencies.')) (out.deps[m[1].slice(13)] ??= []).push(current);
      continue;
    }
    if (/^\[/.test(line)) {
      current = {};
      continue;
    }
    if (!(m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line))) continue;
    const key = m[1];
    let val = m[2];
    const triple = /^('''|""")/.exec(val)?.[1];
    if (triple) {
      let body = val.slice(3);
      while (!body.includes(triple) && i + 1 < lines.length) body += '\n' + lines[++i];
      val = body.slice(0, body.indexOf(triple));
    } else if (/^["']/.test(val)) {
      const q = val[0];
      val = val.slice(1, val.indexOf(q, 1) > 0 ? val.indexOf(q, 1) : undefined);
    } else val = val.replace(/\s+#.*$/, '').trim();
    current[key] = val;
  }
  return out;
}

/** Top-level "key: value" lines of plugin.yml. */
function parseYamlTop(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m && m[2] && !out[m[1]]) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export interface JarInfo {
  loader: Loader;
  id: string;
  name: string;
  version: string;
  description: string;
  authors: string;
  /** Minecraft versions it says it supports (as written in the jar), or null. */
  mcRange: string | null;
  mcCheck: ((mc: string) => boolean) | null;
  /** Client-only mods do nothing on a server (and can crash it). */
  clientOnly: boolean;
  /** Server-side only mods: players don't need them (Fabric "environment": "server", Forge IGNORE_SERVER_VERSION). */
  serverOnly: boolean;
  iconEntry: string | null;
  /** Has a bungee.yml (a BungeeCord plugin, possibly alongside a Bukkit plugin.yml in one jar). */
  bungee: boolean;
}

const infoCache = new Map<string, JarInfo>();

export function readJar(file: string): JarInfo {
  const st = statSync(file);
  const cacheKey = `${file}|${st.size}|${st.mtimeMs}`;
  const cached = infoCache.get(cacheKey);
  if (cached) return cached;
  const base = path.basename(file).replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
  const info: JarInfo = { loader: 'unknown', id: base.toLowerCase(), name: base, version: '', description: '', authors: '', mcRange: null, mcCheck: null, clientOnly: false, serverOnly: false, iconEntry: null, bungee: false };
  const zip = new ZipFile(file);
  try {
    const manifestVersion = /Implementation-Version:\s*(\S+)/.exec(zip.text('META-INF/MANIFEST.MF') ?? '')?.[1] ?? '';
    const fabric = zip.text('fabric.mod.json');
    const quilt = zip.text('quilt.mod.json');
    const neoToml = zip.text('META-INF/neoforge.mods.toml');
    const forgeToml = zip.text('META-INF/mods.toml');
    const paperYml = zip.text('paper-plugin.yml');
    const pluginYml = zip.text('plugin.yml');
    const bungeeYml = zip.text('bungee.yml');
    info.bungee = !!bungeeYml;
    if (fabric) {
      const j = JSON.parse(fabric.replace(/[\u0000-\u001f]+/g, ' '));
      const mcDep = j.depends?.minecraft;
      Object.assign(info, {
        loader: 'fabric',
        id: String(j.id ?? info.id),
        name: String(j.name ?? j.id ?? info.name),
        version: String(j.version ?? ''),
        description: String(j.description ?? ''),
        authors: (j.authors ?? []).map((a: unknown) => (typeof a === 'string' ? a : (a as { name?: string })?.name)).filter(Boolean).join(', '),
        // Fabric ranges often end in "-" (a semver trick to include pre-releases); drop it for display.
        mcRange: mcDep ? (Array.isArray(mcDep) ? mcDep.join(' or ') : String(mcDep)).replace(/-(?=\s|$)/g, '') : null,
        mcCheck: mcDep ? (mc: string) => fabricMatches(mcDep, mc) : null,
        clientOnly: j.environment === 'client',
        serverOnly: j.environment === 'server',
        iconEntry: typeof j.icon === 'string' ? j.icon : j.icon && typeof j.icon === 'object' ? (Object.values(j.icon).at(-1) as string) : null,
      });
    } else if (quilt) {
      const j = JSON.parse(quilt).quilt_loader ?? {};
      Object.assign(info, { loader: 'quilt', id: String(j.id ?? info.id), name: String(j.metadata?.name ?? j.id ?? info.name), version: String(j.version ?? ''), description: String(j.metadata?.description ?? '') });
    } else if (neoToml || forgeToml) {
      const t = parseModsToml((neoToml ?? forgeToml)!);
      const mod = t.mods[0] ?? {};
      const id = mod.modId ?? info.id;
      const deps = t.deps[id] ?? Object.values(t.deps).flat();
      const mcDep = deps.find((d) => d.modId === 'minecraft');
      const onNeo = !!neoToml || deps.some((d) => d.modId === 'neoforge');
      let version = mod.version ?? '';
      if (/\$\{/.test(version)) version = manifestVersion;
      Object.assign(info, {
        loader: onNeo ? 'neoforge' : 'forge',
        id,
        name: mod.displayName ?? id,
        version,
        description: (mod.description ?? '').trim(),
        authors: mod.authors ?? '',
        mcRange: mcDep?.versionRange ?? null,
        mcCheck: mcDep?.versionRange ? (mc: string) => mavenMatches(mcDep.versionRange, mc) : null,
        clientOnly: /true/i.test(t.root.clientSideOnly ?? ''),
        serverOnly: /IGNORE_SERVER_VERSION/.test(mod.displayTest ?? t.root.displayTest ?? ''),
        iconEntry: mod.logoFile ?? t.root.logoFile ?? null,
      });
    } else if (paperYml || pluginYml) {
      const y = parseYamlTop((paperYml ?? pluginYml)!);
      const api = y['api-version'];
      Object.assign(info, {
        loader: paperYml && !pluginYml ? 'paper-plugin' : 'plugin',
        id: (y.name ?? info.id).toLowerCase(),
        name: y.name ?? info.name,
        version: y.version ?? '',
        description: y.description ?? '',
        authors: y.author ?? (y.authors ?? '').replace(/^\[|\]$/g, '').replace(/["']/g, '').replace(/\s*,\s*/g, ', '),
        // api-version is the oldest server version the plugin was built for.
        mcRange: api ? `${api} or newer` : null,
        mcCheck: api ? (mc: string) => cmp(parseVer(mc), parseVer(api)) >= 0 : null,
      });
    } else if (bungeeYml) {
      const y = parseYamlTop(bungeeYml);
      Object.assign(info, { loader: 'bungee', id: (y.name ?? info.id).toLowerCase(), name: y.name ?? info.name, version: y.version ?? '', description: y.description ?? '' });
    }
    if (!info.version) info.version = manifestVersion;
  } finally {
    zip.close();
  }
  info.id = info.id.toLowerCase();
  infoCache.set(cacheKey, info);
  return info;
}

// ---------- compatibility ----------

export interface Warning {
  level: 'error' | 'warn';
  text: string;
}

function checkCompat(info: JarInfo, flavor: string, mc: string): Warning[] {
  const w: Warning[] = [];
  // BungeeCord: it loads bungee.yml (or a plugin.yml when there's no bungee.yml); one proxy serves many Minecraft
  // versions, so no version checks.
  if (flavor === 'bungeecord') {
    if (info.loader === 'bungee' || info.bungee) return w;
    if (info.loader === 'unknown') w.push({ level: 'error', text: "This jar isn't a plugin Server Forge recognises (no bungee.yml or plugin.yml inside)." });
    else if (['fabric', 'quilt', 'forge', 'neoforge'].includes(info.loader)) w.push({ level: 'error', text: `This is a ${LOADER_NAMES[info.loader]}; BungeeCord runs BungeeCord plugins, not mods. It won't load.` });
    else if (info.loader === 'paper-plugin') w.push({ level: 'error', text: "This is a Paper plugin; it goes on a Paper server behind the proxy, not on BungeeCord." });
    else w.push({ level: 'warn', text: 'This jar has a plugin.yml but no bungee.yml. Most of these are Bukkit/Paper plugins for the servers behind the proxy, not for BungeeCord; check it says it supports BungeeCord or Waterfall.' });
    return w;
  }
  const serverName = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', paper: 'Paper', spigot: 'Spigot' }[flavor] ?? flavor;
  const kind = KIND_BY_FLAVOR[flavor];
  const isMod = ['fabric', 'quilt', 'forge', 'neoforge'].includes(info.loader);
  const isPlugin = ['plugin', 'paper-plugin', 'bungee'].includes(info.loader);
  if (info.loader === 'unknown') w.push({ level: 'error', text: `This jar isn't a mod or plugin Server Forge recognises (no fabric.mod.json, mods.toml or plugin.yml inside).` });
  else if (kind === 'plugins' && isMod) w.push({ level: 'error', text: `This is a ${LOADER_NAMES[info.loader]}, but this is a ${serverName} server, which runs plugins, not mods. It won't load.` });
  else if (kind === 'mods' && isPlugin) w.push({ level: 'error', text: `This is a ${LOADER_NAMES[info.loader]}, but ${serverName} runs mods, not plugins. It won't load.` });
  else if (info.loader === 'bungee') w.push({ level: 'error', text: 'This is a BungeeCord proxy plugin; it only works on a BungeeCord server.' });
  else if (flavor === 'spigot' && info.loader === 'paper-plugin') w.push({ level: 'error', text: 'This plugin needs Paper; Spigot servers can\'t load it.' });
  else if (kind === 'mods' && info.loader !== flavor) {
    if (flavor === 'neoforge' && info.loader === 'forge') {
      w.push(
        mc === '1.20.1'
          ? { level: 'warn', text: 'This is a Forge mod. NeoForge for 1.20.1 can run most Forge mods, but not all.' }
          : { level: 'error', text: `This is a Forge mod. NeoForge for ${mc || 'this version'} can't run Forge mods; look for a NeoForge version.` },
      );
    } else if (flavor === 'fabric' && info.loader === 'quilt') w.push({ level: 'error', text: 'This is a Quilt mod; Fabric servers can\'t load Quilt-only mods.' });
    else w.push({ level: 'error', text: `This is a ${LOADER_NAMES[info.loader]}, but this is a ${serverName} server. It won't load; look for the ${serverName} version.` });
  }
  if (mc && info.mcCheck && !info.mcCheck(mc)) {
    // Fabric and Bukkit refuse these outright. Forge/NeoForge mods often declare sloppy ranges (e.g. JEI for 1.21.1 says
    // "[1.21, 1.21.1)"), so there it's a warning.
    const strict = info.loader === 'fabric' || info.loader === 'plugin' || info.loader === 'paper-plugin';
    w.push(
      strict
        ? { level: 'error', text: `Made for Minecraft ${info.mcRange}, but this server runs ${mc}.` }
        : { level: 'warn', text: `Says it's for Minecraft ${info.mcRange}, but this server runs ${mc}. It may not load; check the console after starting.` },
    );
  }
  if (info.clientOnly) w.push({ level: 'warn', text: 'This is a client-only mod (for players\' game, not servers). It isn\'t needed here and may stop the server from starting.' });
  return w;
}

// ---------- the server's mods/plugins ----------

interface Registry {
  files: Record<string, { installedAt: number; source: string | null; side?: 'both' | 'server' }>;
}

function folderOf(record: ServerRecord) {
  return path.join(record.installDir, contentKind(record) ?? 'mods');
}
function loadRegistry(record: ServerRecord): Registry {
  try {
    return JSON.parse(readFileSync(path.join(record.installDir, REGISTRY_FILE), 'utf-8'));
  } catch {
    return { files: {} };
  }
}
function saveRegistry(record: ServerRecord, reg: Registry) {
  writeFileSync(path.join(record.installDir, REGISTRY_FILE), JSON.stringify(reg, null, 2));
}

export interface ContentItem {
  id: string; // file name without .disabled
  name: string;
  version: string;
  description: string;
  authors: string;
  typeLabel: string;
  typeClass: string;
  enabled: boolean;
  hasIcon: boolean;
  source: string | null;
  mcRange: string | null;
  warnings: Warning[];
  file: string;
  side?: string;
  sideHelp?: string;
}

export function listContent(record: ServerRecord): ContentItem[] {
  const dir = folderOf(record);
  if (!existsSync(dir)) return [];
  const reg = loadRegistry(record);
  const flavor = String(record.settings.flavor);
  const mc = String(record.settings.mcVersion ?? '');
  const out: ContentItem[] = [];
  for (const f of readdirSync(dir)) {
    if (!/\.jar(\.disabled)?$/i.test(f)) continue;
    const full = path.join(dir, f);
    if (!statSync(full).isFile()) continue;
    const id = f.replace(/\.disabled$/i, '');
    let info: JarInfo;
    try {
      info = readJar(full);
    } catch {
      out.push({ id, name: id, version: '', description: '', authors: '', typeLabel: 'Damaged jar', typeClass: 'bad', enabled: !/\.disabled$/i.test(f), hasIcon: false, source: null, mcRange: null, warnings: [{ level: 'error', text: "This file isn't a valid jar (couldn't be opened)." }], file: f });
      continue;
    }
    out.push({
      id,
      name: info.name,
      version: info.version,
      description: info.description,
      authors: info.authors,
      typeLabel: LOADER_NAMES[info.loader],
      typeClass: info.loader,
      enabled: !/\.disabled$/i.test(f),
      hasIcon: !!info.iconEntry,
      source: reg.files[id]?.source ?? null,
      mcRange: info.mcRange,
      warnings: checkCompat(info, flavor, mc),
      file: f,
      // Mod servers only: whether players need it too (shared with the Tavern Client Mod Manager).
      ...(contentKind(record) === 'mods' ? sideOf(reg, id, info) : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const MOD_SIDES = [
  { value: 'both', label: 'Server + players' },
  { value: 'server', label: 'Server only' },
];
const MOD_SIDE_HELP: Record<string, string> = {
  both: 'Players need it too: it is shared with the Tavern Client Mod Manager.',
  server: "Only the server runs it; players don't need it.",
};

function sideOf(reg: Registry, id: string, info: JarInfo) {
  const side = reg.files[id]?.side ?? (info.serverOnly ? 'server' : 'both');
  return { side, sideHelp: MOD_SIDE_HELP[side] + (reg.files[id]?.side ? '' : info.serverOnly ? ' (the mod says it is server-side only)' : '') };
}

export function setContentSide(record: ServerRecord, id: string, side: string) {
  if (contentKind(record) !== 'mods') throw new Error('Only mods are shared with players.');
  if (!MOD_SIDE_HELP[side]) throw new Error('Unknown side.');
  const item = findItem(record, id);
  const reg = loadRegistry(record);
  reg.files[item.id] = { installedAt: reg.files[item.id]?.installedAt ?? Date.now(), source: reg.files[item.id]?.source ?? null, side: side as 'both' | 'server' };
  saveRegistry(record, reg);
}

/** Enabled mods players need (Fabric/Forge/NeoForge servers), for the share link. */
export function sharedMods(record: ServerRecord) {
  if (contentKind(record) !== 'mods') return [];
  return listContent(record)
    .filter((m) => m.enabled && m.side !== 'server' && m.typeClass !== 'bad')
    .map((m) => ({ id: m.id, name: m.name, version: m.version, file: m.file, size: statSync(path.join(folderOf(record), m.file)).size }));
}

/** Full path of a mod jar players may download (only enabled, shared ones). */
export function sharedModFile(record: ServerRecord, name: string): string | null {
  const m = sharedMods(record).find((x) => x.file === name);
  return m ? path.join(folderOf(record), m.file) : null;
}

function findItem(record: ServerRecord, id: string) {
  const item = listContent(record).find((x) => x.id === id);
  if (!item) throw new Error('That file is not installed.');
  return item;
}

export function setContentEnabled(record: ServerRecord, id: string, enabled: boolean) {
  const item = findItem(record, id);
  if (item.enabled === enabled) return;
  const dir = folderOf(record);
  renameSync(path.join(dir, item.file), path.join(dir, enabled ? item.id : `${item.id}.disabled`));
}

export function removeContent(record: ServerRecord, id: string) {
  const item = findItem(record, id);
  rmSync(path.join(folderOf(record), item.file), { force: true });
  const reg = loadRegistry(record);
  delete reg.files[item.id];
  saveRegistry(record, reg);
}

export function contentIcon(record: ServerRecord, id: string): Buffer | null {
  const item = findItem(record, id);
  const full = path.join(folderOf(record), item.file);
  const info = readJar(full);
  if (!info.iconEntry) return null;
  const zip = new ZipFile(full);
  try {
    return zip.get(info.iconEntry.replace(/^\//, ''), 2 * 1024 * 1024);
  } finally {
    zip.close();
  }
}

/** Jars inside an uploaded .zip (some plugins are shipped zipped), extracted to temp files. */
function jarsInZip(file: string, work: string): string[] {
  const zip = new ZipFile(file);
  try {
    // A jar is itself a zip: if it has metadata at the top it's the jar itself.
    if (['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'plugin.yml', 'paper-plugin.yml', 'bungee.yml'].some((n) => zip.has(n))) return [file];
    const out: string[] = [];
    for (const name of zip.entries.keys()) {
      if (!/\.jar$/i.test(name) || name.includes('__MACOSX')) continue;
      const data = zip.get(name, 512 * 1024 * 1024);
      if (!data) continue;
      const dest = path.join(work, `${out.length}-${path.basename(name)}`);
      writeFileSync(dest, data);
      out.push(dest);
    }
    return out;
  } finally {
    zip.close();
  }
}

export async function installContent(record: ServerRecord, file: string, source: string | null) {
  const kind = contentKind(record);
  if (!kind) throw new Error('This server type has no mods or plugins.');
  if (!/\.(jar|zip)$/i.test(file)) throw new Error('Mods and plugins are .jar files (or a .zip containing .jar files).');
  const work = path.join(os.tmpdir(), `tavernhost-jar-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  const result = { installed: [] as { name: string; type: string; version: string; action: string }[], warnings: [] as string[] };
  try {
    let jars: string[];
    try {
      jars = jarsInZip(file, work);
    } catch {
      throw new Error(`${path.basename(file)} isn't a valid .jar or .zip file.`);
    }
    if (!jars.length) throw new Error('No .jar files were found in that zip.');
    const dir = folderOf(record);
    mkdirSync(dir, { recursive: true });
    const existing = listContent(record);
    const reg = loadRegistry(record);
    const flavor = String(record.settings.flavor);
    const mc = String(record.settings.mcVersion ?? '');
    for (const jar of jars) {
      // Windows Defender first: a detection stops the install.
      const scan = await defenderScan(jar);
      if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat} in ${path.basename(jar).replace(/^\d+-/, '')}.`);
      if (scan.result !== 'clean' && !noScannerIsNormal) result.warnings.push(`⚠ Windows Defender couldn't scan ${path.basename(jar).replace(/^\d+-/, '')} (another antivirus may be in charge).`);
      const info = readJar(jar);
      const fileName = path.basename(file) === path.basename(jar) || jar === file ? path.basename(file).replace(/\.zip$/i, '.jar') : path.basename(jar).replace(/^\d+-/, '');
      const target = fileName.replace(/[^\w.\-+ ]/g, '_');
      // Same mod/plugin already installed (maybe under another file name): replace it = update.
      const old = existing.find((x) => x.id === target || (info.loader !== 'unknown' && readSafe(path.join(dir, x.file))?.id === info.id && readSafe(path.join(dir, x.file))?.loader === info.loader));
      if (old) rmSync(path.join(dir, old.file), { force: true });
      // Clear mismatches are installed switched off, so a wrong download can't stop the server from starting.
      const problems = checkCompat(info, flavor, mc);
      const blocked = problems.some((w) => w.level === 'error');
      copyFileSync(jar, path.join(dir, blocked ? `${target}.disabled` : target));
      // An update keeps the side chosen for the old file.
      const keptSide = reg.files[old?.id ?? '']?.side;
      delete reg.files[old?.id ?? ''];
      reg.files[target] = { installedAt: Date.now(), source, ...(keptSide ? { side: keptSide } : {}) };
      const action = !old ? 'installed' : old.version && info.version && old.version !== info.version ? 'updated' : 'reinstalled';
      result.installed.push({ name: info.name, type: LOADER_NAMES[info.loader], version: info.version, action: blocked ? `${action}-off` : action });
      for (const w of problems) result.warnings.push(`${w.level === 'error' ? '⛔' : '⚠'} ${info.name}: ${w.text}`);
      if (blocked) result.warnings.push(`${info.name} was installed switched OFF because it doesn't match this server. Use "Force on" in the list if you want it anyway.`);
    }
    saveRegistry(record, reg);
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function readSafe(file: string) {
  try {
    return readJar(file);
  } catch {
    return null;
  }
}

// ---------- sites ----------

export function contentLinks(record: ServerRecord) {
  const flavor = String(record.settings.flavor);
  const mc = String(record.settings.mcVersion ?? '');
  const v = mc ? `&v=${encodeURIComponent(mc)}` : '';
  if (contentKind(record) === 'mods') {
    return [
      { label: 'Modrinth', url: `https://modrinth.com/mods?g=categories:${flavor}${v}`, help: `Mods filtered for ${flavor}${mc ? ` ${mc}` : ''}. Pick the file marked for your loader and version.` },
      { label: 'CurseForge', url: `https://www.curseforge.com/minecraft/search?class=mc-mods${mc ? `&gameVersion=${encodeURIComponent(mc)}` : ''}`, help: 'The biggest mod site. Check the file list for your loader and version.' },
    ];
  }
  if (flavor === 'bungeecord') {
    return [
      { label: 'SpigotMC (BungeeCord)', url: 'https://www.spigotmc.org/resources/categories/bungee-proxy.2/', help: 'Plugins for BungeeCord proxies (some downloads need a SpigotMC account).' },
      { label: 'Modrinth', url: 'https://modrinth.com/plugins?g=categories:bungeecord', help: 'BungeeCord plugins on Modrinth.' },
      { label: 'Hangar', url: 'https://hangar.papermc.io/?platform=WATERFALL', help: 'Waterfall (BungeeCord-compatible) plugins on PaperMC’s site; most also run on BungeeCord.' },
    ];
  }
  return [
    { label: 'Hangar', url: `https://hangar.papermc.io/${mc ? `?version=${encodeURIComponent(mc)}&platform=PAPER` : ''}`, help: "PaperMC's official plugin site." },
    { label: 'Modrinth', url: `https://modrinth.com/plugins?g=categories:${flavor}${v}`, help: 'Plugins filtered for this server type.' },
    { label: 'SpigotMC', url: 'https://www.spigotmc.org/resources/', help: 'The classic plugin site (some downloads need a SpigotMC account).' },
    { label: 'CurseForge', url: 'https://www.curseforge.com/minecraft/search?class=bukkit-plugins', help: 'Bukkit plugins on CurseForge.' },
  ];
}
