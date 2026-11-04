// Palworld mods, through Palworld's own mod loader (PalModLoader, in the game and the dedicated server since 2025).
// Each mod is a folder with an Info.json at its root, kept in Mods\Workshop\ next to PalServer.exe. Mods\PalModSettings.ini
// switches the loader on (bGlobalEnableMod) and lists the active mods (one ActiveModList=<PackageName> line each). When
// the server starts, Palworld copies each active mod's files where they belong (Paks, LogicMods, Lua, UE4SS, PalSchema),
// following the mod's InstallRule list, and records them in Mods\ManagedMods\<PackageName>\InstallManifest.json. Rules
// marked "IsServer": true are the ones the server uses; the others are for players' games, so a mod without any server
// rule does nothing on the server and is only shared with players.
// Found by testing the 1.0.5 server (Pocketpair's docs don't say): the loader skips mod folders whose name isn't a
// number (it reads the folder name as the Steam Workshop ID), and taking a mod off ActiveModList leaves its deployed
// files in place (a .pak there still loads). A DeleteModList=<PackageName> line uninstalls it on the next start, even
// when its folder is gone, and Palworld then drops that line itself.
// Older mods that are only .pak files (made for Pal\Content\Paks\~mods) get an Info.json written for them.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AddonSupport, ServerRecord } from './types.ts';
import { defenderScan } from '../modscan.ts';
import { unzipTo, zipFolder } from '../backups.ts';
import { dataPath } from '../store.ts';

const TYPES = ['Paks', 'Lua', 'LogicMods', 'UE4SS', 'PalSchema'] as const;
const PACKAGE = /^[A-Za-z0-9_-]{1,64}$/;

export interface PalRule {
  Type: string;
  IsServer?: boolean;
  Targets?: string[];
}
export interface PalInfo {
  ModName?: string;
  PackageName: string;
  Version?: string;
  Author?: string;
  Thumbnail?: string;
  Dependencies?: string[];
  Tags?: string[];
  InstallRule: PalRule[];
}
interface PalMod {
  folder: string;
  dir: string;
  info: PalInfo;
}

const modsRoot = (record: ServerRecord) => path.join(record.installDir, 'Mods');
const workshopDir = (record: ServerRecord) => path.join(modsRoot(record), 'Workshop');
const settingsFile = (record: ServerRecord) => path.join(modsRoot(record), 'PalModSettings.ini');

// ---------- Info.json ----------

/** Reads an Info.json, tolerating a BOM, comments and trailing commas (hand-written ones have them). */
export function readInfo(dir: string): PalInfo | null {
  const file = path.join(dir, 'Info.json');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf-8').replace(/^﻿/, '');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      data = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
  const d = data as Partial<PalInfo>;
  if (!d || typeof d.PackageName !== 'string' || !Array.isArray(d.InstallRule)) return null;
  return d as PalInfo;
}

/** Problems that would make Palworld skip the mod (or write outside its folders), or null. */
function infoProblem(info: PalInfo): string | null {
  if (!PACKAGE.test(info.PackageName)) return `its PackageName "${String(info.PackageName).slice(0, 80)}" isn't a valid package name`;
  if (!info.InstallRule.length) return 'its Info.json has no InstallRule';
  for (const r of info.InstallRule) {
    if (!TYPES.includes(r?.Type as (typeof TYPES)[number])) return `its InstallRule has an unknown type "${String(r?.Type).slice(0, 40)}"`;
    for (const t of r.Targets ?? []) if (/(^|[\\/])\.\.([\\/]|$)/.test(String(t)) || path.isAbsolute(String(t))) return 'its InstallRule points outside the mod folder';
  }
  return null;
}

/** Who uses the mod: the server (rules with IsServer), players' games (the other rules), or both. */
export function palSide(info: PalInfo): 'both' | 'server' | 'players' {
  const server = info.InstallRule.some((r) => r.IsServer === true);
  const players = info.InstallRule.some((r) => r.IsServer !== true);
  return server && players ? 'both' : server ? 'server' : 'players';
}

const SIDE_TEXT = { both: 'Server + players', server: 'Server only', players: 'Players only' };

/** Every mod folder in Mods\Workshop (a folder whose Info.json is valid). */
function installed(record: ServerRecord): PalMod[] {
  const root = workshopDir(record);
  if (!existsSync(root)) return [];
  const out: PalMod[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const info = readInfo(dir);
    if (info) out.push({ folder: e.name, dir, info });
  }
  return out;
}

// ---------- PalModSettings.ini ----------

interface ModSettings {
  enabled: boolean;
  active: string[];
  /** Mods Palworld uninstalls on its next start (it removes these lines itself afterwards). */
  remove: string[];
  workshopRoot: string;
  /** Every other line, kept as it was. */
  rest: string[];
}

export function readModSettings(file: string): ModSettings {
  const s: ModSettings = { enabled: false, active: [], remove: [], workshopRoot: '', rest: [] };
  const text = existsSync(file) ? readFileSync(file, 'utf-8').replace(/^﻿/, '') : '';
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([+\-.!]?)(\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[2] === 'bGlobalEnableMod') s.enabled = /^true$/i.test(m[3]);
    else if (m?.[2] === 'ActiveModList' || m?.[2] === 'DeleteModList') {
      const list = m[2] === 'ActiveModList' ? s.active : s.remove;
      if (m[1] !== '-' && m[3] && !list.includes(m[3])) list.push(m[3]);
    } else {
      if (m?.[2] === 'WorkshopRootDir') s.workshopRoot = m[3];
      if (line.trim() && line.trim() !== '[PalModSettings]') s.rest.push(line);
    }
  }
  return s;
}

export function writeModSettings(file: string, s: ModSettings) {
  const rest = [...s.rest];
  if (!rest.some((l) => /^\s*WorkshopRootDir\s*=/.test(l))) rest.push('WorkshopRootDir=');
  if (!rest.some((l) => /^\s*ConfigVersion\s*=/.test(l))) rest.push('ConfigVersion=1.0');
  const lines = [
    '[PalModSettings]',
    `bGlobalEnableMod=${s.enabled ? 'True' : 'False'}`,
    ...rest,
    ...s.active.map((p) => `ActiveModList=${p}`),
    ...s.remove.map((p) => `DeleteModList=${p}`),
  ];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join('\r\n')}\r\n`);
}

/** On: active (and not queued for uninstall). Off: inactive, and its deployed files uninstalled on the next start. */
function setActive(record: ServerRecord, pkg: string, on: boolean) {
  const s = readModSettings(settingsFile(record));
  s.active = s.active.filter((p) => p !== pkg);
  s.remove = s.remove.filter((p) => p !== pkg);
  if (on) s.active.push(pkg);
  else if (existsSync(path.join(modsRoot(record), 'ManagedMods', pkg))) s.remove.push(pkg);
  writeModSettings(settingsFile(record), s);
}

/** The loader only reads mod folders named with a number (it takes the name as the Workshop ID). */
export const WORKSHOP_FOLDER = /^\d{1,19}$/;

/**
 * The folder a mod is kept in: its own Workshop ID when it came from the Workshop, otherwise a fixed number from its
 * PackageName between 1,000,000,000 and 1,899,999,999 (Palworld's Workshop opened in 2025, so its real IDs are far
 * above that range and can't clash).
 */
export function workshopFolder(pkg: string, from?: string): string {
  if (from && WORKSHOP_FOLDER.test(from) && from.length >= 9) return from;
  return String(1_000_000_000 + (parseInt(createHash('sha1').update(pkg).digest('hex').slice(0, 8), 16) % 900_000_000));
}

// ---------- installing ----------

/** Folders (up to 6 levels down) that hold an Info.json; their own subfolders aren't searched. */
export function findPackages(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(path.join(dir, 'Info.json'))) return void out.push(dir);
    if (depth >= 6) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(root, 0);
  return out;
}

function filesIn(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * An older mod that's only .pak files (for Pal\Content\Paks\~mods or LogicMods): wraps it as a loader package with an
 * Info.json. The dedicated server needs paks built for it ("…WindowsServer…" in the name, like the loader's own server
 * mods ship them); other paks are built for the game, so they're only for players. Returns the package folder, or null
 * if it isn't one.
 */
export function wrapLegacyPaks(root: string, name: string, work: string): string | null {
  const files = filesIn(root);
  if (files.some((f) => /\.lua$/i.test(f) || /\.dll$/i.test(f))) {
    throw new Error(
      `${name} is an older UE4SS script mod (it has no Info.json). Palworld's mod loader can't install those by itself: look for a version of it made for the new mod loader (its download has an Info.json), on CurseForge, Nexus Mods or the Steam Workshop.`,
    );
  }
  const paks = files.filter((f) => /\.(pak|ucas|utoc)$/i.test(f));
  if (!paks.some((f) => /\.pak$/i.test(f))) return null;
  const logic = paks.some((f) => /[\\/]LogicMods[\\/]/i.test(f));
  const type = logic ? 'LogicMods' : 'Paks';
  const pkg = name.replace(/\.(zip|pak)$/i, '').replace(/-\d+(-[\d-]+)?$/, '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 60) || 'PakMod';
  const dir = path.join(work, 'wrapped', pkg);
  const server = paks.filter((f) => /WindowsServer/i.test(path.basename(f)));
  const client = paks.filter((f) => !/WindowsServer|LinuxServer/i.test(path.basename(f)));
  const rules: PalRule[] = [];
  for (const [sub, list, isServer] of [['Client', client, false], ['Server', server, true]] as const) {
    if (!list.some((f) => /\.pak$/i.test(f))) continue;
    mkdirSync(path.join(dir, sub), { recursive: true });
    for (const f of list) cpSync(f, path.join(dir, sub, path.basename(f)));
    rules.push({ Type: type, ...(isServer ? { IsServer: true } : {}), Targets: [`./${sub}`] });
  }
  if (!rules.length) return null;
  const info: PalInfo & { ConvertedBy: string } = {
    ModName: name.replace(/\.(zip|pak)$/i, '').replace(/-\d+(-[\d-]+)?$/, ''),
    PackageName: pkg,
    Version: '1.0.0',
    Author: 'unknown',
    InstallRule: rules,
    ConvertedBy: 'Server Forge (from an older .pak mod)',
  };
  writeFileSync(path.join(dir, 'Info.json'), JSON.stringify(info, null, 2));
  return dir;
}

/** Unpacks (or copies) what was dropped and returns the mod folders in it, with the work folder to delete afterwards. */
export async function unpackMods(file: string): Promise<{ work: string; dirs: string[]; wrapped: boolean }> {
  const work = path.join(os.tmpdir(), `sf-palmod-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  try {
    const top = path.join(work, 'top');
    const isDir = statSync(file).isDirectory();
    if (isDir) cpSync(file, top, { recursive: true });
    else if (/\.pak$/i.test(file)) {
      mkdirSync(top, { recursive: true });
      cpSync(file, path.join(top, path.basename(file)));
    } else if (/\.zip$/i.test(file)) {
      const scan = await defenderScan(file);
      if (scan.result === 'threat') throw new Error(`Not installed: Windows Defender found ${scan.threat} in ${path.basename(file)}.`);
      try {
        await unzipTo(file, top);
      } catch {
        throw new Error(`${path.basename(file)} couldn't be unzipped (is it a damaged download?).`);
      }
    } else if (/\.(7z|rar)$/i.test(file)) {
      throw new Error(`${path.basename(file)} is packed as ${path.extname(file).slice(1).toUpperCase()}. Only .zip mods can be installed: unpack it, then drop the folder here (or repack it as a .zip).`);
    } else throw new Error('Palworld mods are .zip files (or a mod folder with an Info.json).');
    let dirs = findPackages(top);
    let wrapped = false;
    if (!dirs.length) {
      const one = wrapLegacyPaks(top, path.basename(file), work);
      if (!one) throw new Error(`No Palworld mod was found in ${path.basename(file)}: there's no Info.json (made for Palworld's mod loader) and no .pak file.`);
      dirs = [one];
      wrapped = true;
    }
    return { work, dirs, wrapped };
  } catch (err) {
    rmSync(work, { recursive: true, force: true });
    throw err;
  }
}

// ---------- sharing ----------

/** Changes when any file in the mod changes (name, size or time), so players' apps know to fetch it again. */
export function modStamp(dir: string): string {
  const h = createHash('sha1');
  for (const f of filesIn(dir).sort()) {
    const st = statSync(f);
    h.update(`${path.relative(dir, f)}|${st.size}|${Math.round(st.mtimeMs)}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

/** Active mods players need (any rule that isn't server-only), for the share link. */
export function palSharedMods(record: ServerRecord) {
  const s = readModSettings(settingsFile(record));
  if (!s.enabled) return [];
  return installed(record)
    .filter((m) => s.active.includes(m.info.PackageName) && palSide(m.info) !== 'server')
    .map((m) => ({ id: m.info.PackageName, name: m.info.ModName || m.info.PackageName, version: String(m.info.Version ?? ''), file: `${m.info.PackageName}.zip`, stamp: modStamp(m.dir) }));
}

/** What the share card says about the mods that aren't shared. */
export function palShareSummary(record: ServerRecord) {
  const s = readModSettings(settingsFile(record));
  const all = installed(record);
  const active = (m: PalMod) => s.active.includes(m.info.PackageName);
  return {
    shared: s.enabled ? all.filter((m) => active(m) && palSide(m.info) !== 'server').length : 0,
    serverOnly: all.filter((m) => active(m) && palSide(m.info) === 'server').map((m) => m.info.ModName || m.info.PackageName),
    off: all.filter((m) => !active(m) || !s.enabled).map((m) => m.info.ModName || m.info.PackageName),
    loaderOff: !s.enabled,
  };
}

/** A shared mod as a zip for players' apps: built once per version of its files, kept under data\palworld-share. */
export async function palSharedZip(record: ServerRecord, name: string): Promise<string | null> {
  const m = /^([A-Za-z0-9_-]{1,64})\.zip$/.exec(name);
  if (!m) return null;
  const mod = palSharedMods(record).find((x) => x.id === m[1]);
  const dir = mod && installed(record).find((x) => x.info.PackageName === mod.id)?.dir;
  if (!mod || !dir) return null;
  const cache = dataPath('palworld-share', record.id);
  const zip = path.join(cache, `${mod.id}-${mod.stamp}.zip`);
  if (existsSync(zip)) return zip;
  mkdirSync(cache, { recursive: true });
  for (const old of readdirSync(cache)) if (old.startsWith(`${mod.id}-`)) rmSync(path.join(cache, old), { force: true });
  const tmp = `${zip}.part`;
  rmSync(tmp, { force: true });
  await zipFolder(dir, tmp);
  cpSync(tmp, zip);
  rmSync(tmp, { force: true });
  return zip;
}

// ---------- the Mods tab ----------

export const palworldAddons: AddonSupport = {
  accept: '.zip,.pak',
  folders: true,
  // The server sets mods up and rewrites PalModSettings.ini as it starts, so changes are made while it's stopped.
  needsStopped: true,
  curseforgeGame: 'palworld',
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp:
      'Drop a Palworld mod <b>.zip</b> (or its unpacked folder) here. Mods made for Palworld\'s mod loader have an <b>Info.json</b>; older mods that are only <b>.pak</b> files are converted. Palworld sets the mods up when the server starts.',
  }),
  links: [
    { label: 'CurseForge', url: 'https://www.curseforge.com/palworld', help: 'Palworld mods on CurseForge.' },
    { label: 'Nexus Mods', url: 'https://www.nexusmods.com/games/palworld/mods', help: 'Use "Manual download", or "Mod Manager Download" with your Nexus API key.' },
  ],
  isOn: (record) => readModSettings(settingsFile(record)).enabled,
  async setup(record, log) {
    const s = readModSettings(settingsFile(record));
    s.enabled = true;
    writeModSettings(settingsFile(record), s);
    mkdirSync(workshopDir(record), { recursive: true });
    log('Switched on Palworld\'s mod loader (Mods\\PalModSettings.ini).');
    return 'Palworld\'s mod loader is on. Add mods below; they\'re set up when the server starts.';
  },
  status(record) {
    const s = readModSettings(settingsFile(record));
    if (!s.enabled) {
      return {
        ok: false,
        title: 'Mods are off on this server',
        text: 'Palworld has its own mod loader. Switch it on to add mods; Palworld sets them up each time the server starts.',
        setupLabel: 'Switch mods on',
      };
    }
    const custom = s.workshopRoot && path.resolve(record.installDir, s.workshopRoot).toLowerCase() !== workshopDir(record).toLowerCase();
    return {
      ok: !custom,
      title: 'Palworld\'s mod loader is on',
      text: custom
        ? `PalModSettings.ini sets WorkshopRootDir to "${s.workshopRoot}", so Palworld may look for mods there instead of Mods\\Workshop, where Server Forge puts them. Clear that line if mods added here don't load.`
        : 'Mods are kept in Mods\\Workshop. Palworld sets up new mods, and removes switched-off ones, the next time the server starts. Players get the mods marked "players" through the share link.',
    };
  },
  list(record) {
    const s = readModSettings(settingsFile(record));
    const all = installed(record);
    const have = new Set(all.map((m) => m.info.PackageName));
    return all
      .map(({ folder, info }) => {
        const side = palSide(info);
        const warnings: { level: 'error' | 'warn'; text: string }[] = [];
        const problem = infoProblem(info);
        if (problem) warnings.push({ level: 'error', text: `Palworld will skip it: ${problem}.` });
        const missing = (info.Dependencies ?? []).filter((d) => !have.has(String(d)));
        if (missing.length) warnings.push({ level: 'error', text: `Needs ${missing.join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} installed.` });
        if (!WORKSHOP_FOLDER.test(folder)) warnings.push({ level: 'error', text: `Palworld skips it: its folder (Mods\\Workshop\\${folder}) isn't named with a number. Remove it and add it again.` });
        if (side === 'players') warnings.push({ level: 'warn', text: "Players only: the server doesn't use it. Players get it through the share link." });
        const types = [...new Set(info.InstallRule.map((r) => r.Type))].join(', ');
        const on = s.active.includes(info.PackageName);
        const deployed = existsSync(path.join(modsRoot(record), 'ManagedMods', info.PackageName));
        // Palworld only changes what's installed when the server starts.
        const pending = side === 'players' ? '' : on && !deployed && s.enabled ? ' · set up when the server next starts' : !on && deployed ? ' · removed when the server next starts' : '';
        return {
          id: info.PackageName,
          name: info.ModName || info.PackageName,
          version: String(info.Version ?? ''),
          authors: info.Author ? String(info.Author) : null,
          description: `${SIDE_TEXT[side]} · ${types}${(info as { ConvertedBy?: string }).ConvertedBy ? ' · converted from an older .pak mod' : ''}${pending}`,
          typeLabel: SIDE_TEXT[side],
          typeClass: 'mod',
          enabled: on,
          hasIcon: !!info.Thumbnail,
          file: `Mods\\Workshop\\${folder}`,
          source: null,
          warnings,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  async install(record, file) {
    const { work, dirs, wrapped } = await unpackMods(file);
    try {
      const result = { installed: [] as unknown[], warnings: [] as string[] };
      const before = installed(record);
      for (const dir of dirs) {
        const info = readInfo(dir);
        if (!info) {
          result.warnings.push(`Skipped ${path.basename(dir)}: its Info.json couldn't be read.`);
          continue;
        }
        const problem = infoProblem(info);
        if (problem) {
          result.warnings.push(`Skipped ${info.ModName || path.basename(dir)}: ${problem}.`);
          continue;
        }
        // An update replaces the old copy, whatever its folder is called. A new Version in Info.json makes Palworld
        // reinstall it on the next start.
        const old = before.filter((m) => m.info.PackageName === info.PackageName);
        for (const o of old) rmSync(o.dir, { recursive: true, force: true });
        const dest = path.join(workshopDir(record), workshopFolder(info.PackageName, path.basename(dir)));
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(path.dirname(dest), { recursive: true });
        cpSync(dir, dest, { recursive: true });
        setActive(record, info.PackageName, true);
        const name = info.ModName || info.PackageName;
        result.installed.push({ name, type: 'mod', version: String(info.Version ?? ''), action: old.length ? 'updated' : 'installed' });
        if (palSide(info) === 'players') result.warnings.push(`${name} is for players' games only, so the server doesn't use it. Players get it through the share link.`);
      }
      const have = new Set(installed(record).map((m) => m.info.PackageName));
      for (const dir of dirs) {
        const info = readInfo(dir);
        const missing = (info?.Dependencies ?? []).filter((d) => !have.has(String(d)));
        if (info && missing.length) result.warnings.push(`${info.ModName || info.PackageName} needs ${missing.join(', ')}. Install ${missing.length === 1 ? 'it' : 'them'} too.`);
      }
      if (wrapped) {
        result.warnings.push(
          "That was an older .pak mod without an Info.json, so Server Forge wrote one. Paks built for the server (\"WindowsServer\" in the name) are used on the server; the others are for players' games and reach players through the share link.",
        );
      }
      if (!result.installed.length && !result.warnings.length) throw new Error('No Palworld mod was found in that file.');
      return result;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  remove(record, id) {
    const mods = installed(record).filter((m) => m.info.PackageName === id);
    if (!mods.length) throw new Error('That mod is not installed.');
    for (const m of mods) rmSync(m.dir, { recursive: true, force: true });
    setActive(record, id, false);
  },
  setEnabled(record, id, enabled) {
    if (!installed(record).some((m) => m.info.PackageName === id)) throw new Error('That mod is not installed.');
    setActive(record, id, enabled);
  },
  icon(record, id) {
    const m = installed(record).find((x) => x.info.PackageName === id);
    if (!m?.info.Thumbnail) return null;
    const file = path.resolve(m.dir, String(m.info.Thumbnail));
    return file.startsWith(m.dir + path.sep) && existsSync(file) ? file : null;
  },
};
