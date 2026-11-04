// Palworld mod packages (a folder with an Info.json for Palworld's own mod loader): reading them, and packaging downloads
// that don't have one yet. Shared by Server Forge and SF Mod Manager.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

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
export function infoProblem(info: PalInfo): string | null {
  if (!PACKAGE.test(info.PackageName)) return `its PackageName "${String(info.PackageName).slice(0, 80)}" isn't a valid package name`;
  if (!info.InstallRule.length) return 'its Info.json has no InstallRule';
  for (const r of info.InstallRule) {
    if (!TYPES.includes(r?.Type as (typeof TYPES)[number])) return `its InstallRule has an unknown type "${String(r?.Type).slice(0, 40)}"`;
    for (const t of r.Targets ?? []) if (/(^|[\\/])\.\.([\\/]|$)/.test(String(t)) || path.isAbsolute(String(t))) return 'its InstallRule points outside the mod folder';
  }
  return null;
}

/** Who uses the mod: the server (rules with IsServer), players' games (the other rules), or both. UE4SS is always both. */
export function palSide(info: PalInfo): 'both' | 'server' | 'players' {
  if (info.InstallRule.some((r) => r.Type === 'UE4SS')) return 'both';
  const server = info.InstallRule.some((r) => r.IsServer === true);
  const players = info.InstallRule.some((r) => r.IsServer !== true);
  return server && players ? 'both' : server ? 'server' : 'players';
}

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

export function filesIn(root: string): string[] {
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

/** The name Lua mods list UE4SS under in their Dependencies. */
const UE4SS_PACKAGE = 'UE4SSExperimentalPW';
export const UE4SS_URL = 'https://github.com/Okaetsu/RE-UE4SS/releases/tag/experimental-palworld';
export const isUe4ssDep = (dep: unknown) => /^ue4ss/i.test(String(dep));

/** Changes with the files' contents: Palworld only reinstalls a mod when its Version changes. */
function contentVersion(dir: string): string {
  const h = createHash('sha1');
  for (const f of filesIn(dir).sort()) {
    h.update(path.relative(dir, f));
    h.update(readFileSync(f));
  }
  return `1.0.${parseInt(h.digest('hex').slice(0, 6), 16)}`;
}

/**
 * A plain UE4SS download (UE4SS.dll, usually in a ue4ss folder beside dwmapi.dll): wraps it as a server package. The
 * server loads UE4SS.dll from Mods\NativeMods\UE4SS itself, so dwmapi.dll is left out (with it, UE4SS would load twice
 * and crash). A rule's target keeps its own name there, so the targets are the files themselves, not a folder around
 * them. Players get it through the share link when a shared mod needs it; SF Mod Manager skips it if they have their own.
 */
export function wrapUe4ss(root: string, work: string): string | null {
  const dll = filesIn(root).find((f) => path.basename(f).toLowerCase() === 'ue4ss.dll');
  if (!dll) return null;
  const from = path.dirname(dll);
  const dir = path.join(work, 'wrapped', UE4SS_PACKAGE);
  mkdirSync(dir, { recursive: true });
  const entries = readdirSync(from).filter((e) => e.toLowerCase() !== 'dwmapi.dll');
  for (const e of entries) cpSync(path.join(from, e), path.join(dir, e), { recursive: true });
  const targets = entries.map((e) => `./${e}`);
  const info: PalInfo & { ConvertedBy: string } = {
    ModName: 'UE4SS',
    PackageName: UE4SS_PACKAGE,
    Version: contentVersion(dir),
    Author: 'UE4SS team',
    InstallRule: [
      { Type: 'UE4SS', Targets: targets },
      { Type: 'UE4SS', IsServer: true, Targets: targets },
    ],
    ConvertedBy: 'Server Forge (from a UE4SS download)',
  };
  writeFileSync(path.join(dir, 'Info.json'), JSON.stringify(info, null, 2));
  return dir;
}

/**
 * Older UE4SS script mods (a folder with Scripts\main.lua or dlls\main.dll, no Info.json): wraps each as a package.
 * Nothing says whether such a mod does its work on the server or in the game, so it goes to both. UE4SS turns it on from
 * the mods.txt Palworld writes; enabled.txt would load it a second time, so it's left out.
 */
export function wrapLuaMods(root: string, name: string, work: string): string[] {
  const homes = new Set<string>();
  for (const f of filesIn(root)) {
    const m = /^(.*)[\\/](?:scripts[\\/]main\.lua|dlls[\\/]main\.dll)$/i.exec(f);
    if (m) homes.add(m[1]);
  }
  const out: string[] = [];
  for (const home of homes) {
    const label = home === root ? name.replace(/\.(zip|pak)$/i, '').replace(/-\d+(-[\d-]+)?$/, '') : path.basename(home);
    const pkg = label.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 60) || 'LuaMod';
    const dir = path.join(work, 'wrapped', pkg);
    mkdirSync(dir, { recursive: true });
    const entries = readdirSync(home).filter((e) => e.toLowerCase() !== 'enabled.txt');
    for (const e of entries) cpSync(path.join(home, e), path.join(dir, e), { recursive: true });
    const targets = entries.map((e) => `./${e}`);
    const info: PalInfo & { ConvertedBy: string } = {
      ModName: label,
      PackageName: pkg,
      Version: contentVersion(dir),
      Author: 'unknown',
      Dependencies: [UE4SS_PACKAGE],
      InstallRule: [
        { Type: 'Lua', Targets: targets },
        { Type: 'Lua', IsServer: true, Targets: targets },
      ],
      ConvertedBy: 'Server Forge (from an older UE4SS mod)',
    };
    writeFileSync(path.join(dir, 'Info.json'), JSON.stringify(info, null, 2));
    out.push(dir);
  }
  return out;
}
