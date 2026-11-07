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
import { defenderScan, SCANNER } from '../modscan.ts';
import { workshopDownload } from '../steamcmd.ts';
import { workshopId, workshopTitle } from '../workshop.ts';
import { unzipTo, zipFolder } from '../backups.ts';
import { dataPath } from '../store.ts';
import { filesIn, findPackages, infoProblem, isUe4ssDep, palSide, readInfo, UE4SS_URL, wrapLegacyPaks, wrapLuaMods, wrapUe4ss, type PalInfo } from '../modsync/palworld-pkg.ts';

export { findPackages, palSide, readInfo, wrapLegacyPaks, wrapLuaMods, wrapUe4ss };
export type { PalInfo, PalRule } from '../modsync/palworld-pkg.ts';

interface PalMod {
  folder: string;
  dir: string;
  info: PalInfo;
}

const modsRoot = (record: ServerRecord) => path.join(record.installDir, 'Mods');
const workshopDir = (record: ServerRecord) => path.join(modsRoot(record), 'Workshop');
const settingsFile = (record: ServerRecord) => path.join(modsRoot(record), 'PalModSettings.ini');

// ---------- Info.json ----------

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
      if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat} in ${path.basename(file)}.`);
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
      const ue4ss = wrapUe4ss(top, work);
      if (ue4ss) dirs = [ue4ss];
      else {
        const pak = wrapLegacyPaks(top, path.basename(file), work);
        dirs = [...wrapLuaMods(top, path.basename(file), work), ...(pak ? [pak] : [])];
      }
      if (!dirs.length) throw new Error(`No Palworld mod was found in ${path.basename(file)}: there's no Info.json (made for Palworld's mod loader), UE4SS, UE4SS script mod (Scripts\\main.lua) or .pak file.`);
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

/** Active mods players need (any rule that isn't server-only). UE4SS only goes along when a shared mod depends on it. */
function playerMods(all: PalMod[], active: string[]): PalMod[] {
  const isUe4ss = (m: PalMod) => m.info.InstallRule.some((r) => r.Type === 'UE4SS');
  const mods = all.filter((m) => active.includes(m.info.PackageName) && palSide(m.info) !== 'server');
  const needed = mods.some((m) => !isUe4ss(m) && (m.info.Dependencies ?? []).some(isUe4ssDep));
  return mods.filter((m) => needed || !isUe4ss(m));
}

/** The mods for the share link. */
export function palSharedMods(record: ServerRecord) {
  const s = readModSettings(settingsFile(record));
  if (!s.enabled) return [];
  return playerMods(installed(record), s.active)
    .map((m) => ({ id: m.info.PackageName, name: m.info.ModName || m.info.PackageName, version: String(m.info.Version ?? ''), file: `${m.info.PackageName}.zip`, stamp: modStamp(m.dir) }));
}

/** What the share card says about the mods that aren't shared. */
export function palShareSummary(record: ServerRecord) {
  const s = readModSettings(settingsFile(record));
  const all = installed(record);
  const active = (m: PalMod) => s.active.includes(m.info.PackageName);
  return {
    shared: s.enabled ? playerMods(all, s.active).length : 0,
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

const PALWORLD_GAME_APP = 1623730; // the game itself: Workshop items belong to it

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
      'Drop a Palworld mod <b>.zip</b> (or its unpacked folder) here. Mods made for Palworld\'s mod loader have an <b>Info.json</b>; <b>UE4SS</b>, older UE4SS script mods and mods that are only <b>.pak</b> files are converted. Palworld sets the mods up when the server starts.',
  }),
  links: [
    { label: 'CurseForge', url: 'https://www.curseforge.com/palworld', help: 'Palworld mods on CurseForge.' },
    { label: 'Nexus Mods', url: 'https://www.nexusmods.com/games/palworld/mods', help: 'Use "Manual download", or "Mod Manager Download" with your Nexus API key.' },
  ],
  workshop: { url: 'https://steamcommunity.com/app/1623730/workshop/', needsLogin: true },
  async addById(record, input) {
    const id = workshopId(input);
    await workshopTitle(id, PALWORLD_GAME_APP, 'Palworld');
    const { root, dir } = await workshopDownload(PALWORLD_GAME_APP, id, 'Palworld');
    try {
      const scan = await defenderScan(dir);
      if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat} in that mod.`);
      // From the folder above the item's, so the mod keeps its Workshop ID as its folder name.
      return await palworldAddons.install(record, path.dirname(dir), 'Steam Workshop') as { installed: unknown[]; warnings: string[] };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
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
    const hasUe4ss = all.some((m) => m.info.InstallRule.some((r) => r.Type === 'UE4SS' && r.IsServer === true));
    const manualUe4ss = existsSync(path.join(record.installDir, 'Pal', 'Binaries', 'Win64', 'dwmapi.dll'));
    return all
      .map(({ folder, info }) => {
        const side = palSide(info);
        const warnings: { level: 'error' | 'warn'; text: string }[] = [];
        const problem = infoProblem(info);
        if (problem) warnings.push({ level: 'error', text: `Palworld will skip it: ${problem}.` });
        const deps = (info.Dependencies ?? []).map(String);
        const ue4ssDep = deps.some(isUe4ssDep);
        const missing = deps.filter((d) => !isUe4ssDep(d) && !have.has(d));
        if (process.platform === 'linux' && info.InstallRule.some((r) => r.Type === 'UE4SS' && r.IsServer !== false) && side !== 'players') warnings.push({ level: 'error', text: "Palworld's Linux server can't run UE4SS mods: UE4SS here is Windows code. It won't do anything on this server. Players can still use it if it's a mod for their games." });
        if (missing.length) warnings.push({ level: 'error', text: `Needs ${missing.join(', ')}, which ${missing.length === 1 ? "isn't" : "aren't"} installed.` });
        // A players-only mod runs in the players' games, which get UE4SS through the share link once it's installed here.
        if (ue4ssDep && side === 'players' && !hasUe4ss) warnings.push({ level: 'warn', text: `Players need UE4SS for this. Download UE4SS-Palworld.zip from ${UE4SS_URL} and drop it here: players get it through the share link.` });
        else if (ue4ssDep && side !== 'players' && !hasUe4ss) warnings.push({ level: 'error', text: `Needs UE4SS on the server, which isn't installed. Download UE4SS-Palworld.zip from ${UE4SS_URL} and drop it here.` });
        if (manualUe4ss && info.InstallRule.some((r) => r.Type === 'UE4SS' && r.IsServer === true)) {
          warnings.push({ level: 'error', text: 'Pal\\Binaries\\Win64 also has a dwmapi.dll from a manual UE4SS install. Delete it: two copies of UE4SS crash the server.' });
        }
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
          description: `${SIDE_TEXT[side]} · ${types}${(info as { ConvertedBy?: string }).ConvertedBy ? ' · converted by Server Forge' : ''}${pending}`,
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
        // UE4SS packaged only for players' games still works here: the server loads it the same way.
        const ue4ssRules = info.InstallRule.filter((r) => r.Type === 'UE4SS');
        if (ue4ssRules.length && !info.InstallRule.some((r) => r.IsServer === true)) {
          info.InstallRule.push(...ue4ssRules.map((r) => ({ ...r, IsServer: true })));
          writeFileSync(path.join(dest, 'Info.json'), JSON.stringify(info, null, 2));
        }
        setActive(record, info.PackageName, true);
        const name = info.ModName || info.PackageName;
        result.installed.push({ name, type: 'mod', version: String(info.Version ?? ''), action: old.length ? 'updated' : 'installed' });
        if (palSide(info) === 'players') result.warnings.push(`${name} is for players' games only, so the server doesn't use it. Players get it through the share link.`);
      }
      const now = installed(record);
      const have = new Set(now.map((m) => m.info.PackageName));
      const hasUe4ss = now.some((m) => m.info.InstallRule.some((r) => r.Type === 'UE4SS' && r.IsServer === true));
      for (const dir of dirs) {
        const info = readInfo(dir);
        if (!info) continue;
        const name = info.ModName || info.PackageName;
        const deps = (info.Dependencies ?? []).map(String);
        const missing = deps.filter((d) => !isUe4ssDep(d) && !have.has(d));
        if (missing.length) result.warnings.push(`${name} needs ${missing.join(', ')}. Install ${missing.length === 1 ? 'it' : 'them'} too.`);
        if (deps.some(isUe4ssDep)) {
          if (palSide(info) === 'players' && !hasUe4ss) result.warnings.push(`Players need UE4SS for ${name}. Download UE4SS-Palworld.zip from ${UE4SS_URL} and drop it here: players get it through the share link.`);
          else if (palSide(info) !== 'players' && !hasUe4ss) result.warnings.push(`${name} needs UE4SS on the server. Download UE4SS-Palworld.zip from ${UE4SS_URL} and drop it here too.`);
        }
      }
      if (wrapped) {
        const kinds = dirs.map((d) => readInfo(d)?.InstallRule[0]?.Type);
        if (kinds.includes('UE4SS')) result.warnings.push("Server Forge packaged UE4SS for Palworld's mod loader, without dwmapi.dll (the game and server load it directly). Players get it through the share link when a shared mod needs it.");
        if (kinds.includes('Lua')) result.warnings.push('That was a UE4SS script mod without an Info.json, so Server Forge wrote one. It runs on the server and reaches players through the share link.');
        if (kinds.includes('Paks') || kinds.includes('LogicMods')) {
          result.warnings.push(
            "That was an older .pak mod without an Info.json, so Server Forge wrote one. Paks built for the server (\"WindowsServer\" in the name) are used on the server; the others are for players' games and reach players through the share link.",
          );
        }
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
