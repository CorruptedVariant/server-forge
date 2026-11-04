// SF Mod Manager: Palworld. Keeps the player's game matched to a Server Forge server's player-side mods, through
// Palworld's own mod loader: each mod is a folder (named with a number, which the loader reads as its Workshop ID) with
// an Info.json, and Mods\PalModSettings.ini switches the loader on and lists the active mods. The game sets them up when
// it starts.
// Found by testing the game (1.0.5): the loader reads mods from WorkshopRootDir when it's set (the game sets it to
// Steam's Workshop folder as soon as the player subscribes to anything), and from Mods\Workshop only when it's empty.
// A mod in the folder it isn't reading is silently uninstalled and dropped from ActiveModList. So the app always puts
// the server's mods where the game is looking right now, and moves them if that changes. Switching a mod off only
// leaves its files installed (and loading): DeleteModList uninstalls it on the next start.
// Server mods this app installed are listed in Mods\.sf-mod-manager.json and only change with the server. The player's
// own mods added here are listed there too, so they follow the game if its mod folder changes. Steam's own Workshop
// mods can be switched on and off, never deleted (Steam would only put them back).
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, renameSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { defenderScan, type ScanResult } from '../modscan.ts';
import { pinnedGet, steamPath, type Link, type AnyManifest } from './sync.ts';
import { findPackages, infoProblem, isUe4ssDep, palSide, readInfo, UE4SS_URL, wrapLegacyPaks, wrapLuaMods, wrapUe4ss, type PalInfo } from './palworld-pkg.ts';

export const PALWORLD_APP_ID = 1623730;

export interface PalMod {
  id: string;
  name: string;
  version: string;
  file: string;
  stamp: string;
}
export interface PalManifest {
  server: string;
  mods: PalMod[];
}

const PACKAGE = /^[A-Za-z0-9_-]{1,64}$/;

/** The Palworld part of a share link, checked (names end up as folder names on this PC). */
export function checkPalManifest(any: AnyManifest): PalManifest {
  const list = Array.isArray(any.raw.mods) ? (any.raw.mods as Record<string, unknown>[]) : [];
  if (list.length > 1000) throw new Error('The server sent more than 1000 mods, which is not a real mod list.');
  const seen = new Set<string>();
  const mods = list.map((x): PalMod => {
    const id = String(x?.id ?? '');
    if (!PACKAGE.test(id) || String(x.file) !== `${id}.zip`) throw new Error('The server sent a mod with an invalid name, so nothing was changed. Ask the server owner to check their mods.');
    if (seen.has(id.toLowerCase())) throw new Error(`The server listed ${id} twice, so nothing was changed.`);
    seen.add(id.toLowerCase());
    const stamp = String(x.stamp ?? '');
    if (!/^[0-9a-f]{1,32}$/.test(stamp)) throw new Error('The server sent a damaged mod list, so nothing was changed.');
    return { id, name: String(x.name ?? id).slice(0, 100), version: String(x.version ?? '').slice(0, 60), file: `${id}.zip`, stamp };
  });
  return { server: any.server, mods };
}

// ---------- finding Palworld ----------

/** Palworld's game folder from Steam's library list, or null. */
export function findPalworld(): string | null {
  const steam = steamPath();
  const libraries = new Set<string>();
  if (steam) {
    libraries.add(steam);
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (existsSync(vdf)) for (const m of readFileSync(vdf, 'utf-8').matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const drive of ['C', 'D', 'E', 'F']) libraries.add(`${drive}:\\Program Files (x86)\\Steam`), libraries.add(`${drive}:\\SteamLibrary`);
  for (const lib of libraries) {
    const acf = path.join(lib, 'steamapps', `appmanifest_${PALWORLD_APP_ID}.acf`);
    const installdir = existsSync(acf) ? (/"installdir"\s+"([^"]+)"/.exec(readFileSync(acf, 'utf-8'))?.[1] ?? 'Palworld') : 'Palworld';
    const dir = path.join(lib, 'steamapps', 'common', installdir);
    if (isPalworldFolder(dir)) return dir;
  }
  return null;
}

export const isPalworldFolder = (dir: string) => existsSync(path.join(dir, 'Palworld.exe'));

// ---------- Mods\PalModSettings.ini ----------

interface ModSettings {
  enabled: boolean;
  active: string[];
  remove: string[];
  workshopRoot: string;
  rest: string[];
}
const settingsFile = (gameDir: string) => path.join(gameDir, 'Mods', 'PalModSettings.ini');

function readModSettings(gameDir: string): ModSettings {
  const s: ModSettings = { enabled: false, active: [], remove: [], workshopRoot: '', rest: [] };
  const file = settingsFile(gameDir);
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

function writeModSettings(gameDir: string, s: ModSettings) {
  const rest = [...s.rest];
  if (!rest.some((l) => /^\s*WorkshopRootDir\s*=/.test(l))) rest.push('WorkshopRootDir=');
  if (!rest.some((l) => /^\s*ConfigVersion\s*=/.test(l))) rest.push('ConfigVersion=1.0');
  const lines = ['[PalModSettings]', `bGlobalEnableMod=${s.enabled ? 'True' : 'False'}`, ...rest, ...s.active.map((p) => `ActiveModList=${p}`), ...s.remove.map((p) => `DeleteModList=${p}`)];
  mkdirSync(path.dirname(settingsFile(gameDir)), { recursive: true });
  writeFileSync(settingsFile(gameDir), `${lines.join('\r\n')}\r\n`);
}

/** Where the game reads mods from right now. */
export function modRoot(gameDir: string): string {
  const s = readModSettings(gameDir);
  return s.workshopRoot ? path.resolve(gameDir, s.workshopRoot) : path.join(gameDir, 'Mods', 'Workshop');
}

/** The same fixed number Server Forge uses for a mod without a Workshop ID (far below Palworld's real Workshop IDs). */
export function workshopFolder(pkg: string): string {
  return String(1_000_000_000 + (parseInt(createHash('sha1').update(pkg).digest('hex').slice(0, 8), 16) % 900_000_000));
}

// ---------- what this app installed ----------

interface Registry {
  /** PackageName -> where it went and which version of the server's files it is. */
  mods: Record<string, { stamp: string; version: string; name: string; folder: string; root: string; link: string }>;
  /** The player's own mods added in this app: PackageName -> folder and the mod folder it's in. */
  own: Record<string, { folder: string; root: string }>;
}
const registryFile = (gameDir: string) => path.join(gameDir, 'Mods', '.sf-mod-manager.json');
function loadRegistry(gameDir: string): Registry {
  try {
    const r = JSON.parse(readFileSync(registryFile(gameDir), 'utf-8'));
    return { mods: r && typeof r.mods === 'object' ? r.mods : {}, own: r && typeof r.own === 'object' ? r.own : {} };
  } catch {
    return { mods: {}, own: {} };
  }
}
function saveRegistry(gameDir: string, reg: Registry) {
  mkdirSync(path.dirname(registryFile(gameDir)), { recursive: true });
  writeFileSync(registryFile(gameDir), JSON.stringify(reg, null, 2));
}
const linkKey = (link: Link) => `${link.host}:${link.port}/${link.token.slice(0, 6)}`;

// ---------- syncing ----------

export interface PalPlan {
  add: PalMod[];
  update: (PalMod & { from: string })[];
  remove: string[];
  same: number;
  /** Mods are installed, but the loader is off or one isn't on its active list (a reinstall fixes both). */
  needsFix: boolean;
}

/** A manual UE4SS install: it reads other folders, and a second copy alongside it crashes the game. */
const manualUe4ss = (gameDir: string) => existsSync(path.join(gameDir, 'Pal', 'Binaries', 'Win64', 'dwmapi.dll'));
const isUe4ssId = (id: string) => /^ue4ss/i.test(id);

/** The player already has a UE4SS this app didn't install (manual, or from the Workshop), so the server's copy stays out. */
function ownUe4ss(gameDir: string, reg: Registry): boolean {
  if (manualUe4ss(gameDir)) return true;
  const root = modRoot(gameDir);
  if (!existsSync(root)) return false;
  const ours = new Set(Object.entries(reg.mods).filter(([id]) => isUe4ssId(id)).map(([, r]) => r.folder));
  return readdirSync(root).some((f) => {
    if (ours.has(f)) return false;
    try {
      return isUe4ssId(String(JSON.parse(readFileSync(path.join(root, f, 'Info.json'), 'utf-8').replace(/^\uFEFF/, '')).PackageName));
    } catch {
      return false;
    }
  });
}

export function planPal(gameDir: string, m: PalManifest, link: Link): PalPlan {
  const reg = loadRegistry(gameDir);
  const root = modRoot(gameDir);
  const s = readModSettings(gameDir);
  const plan: PalPlan = { add: [], update: [], remove: [], same: 0, needsFix: false };
  const wanted = new Set(m.mods.map((x) => x.id));
  const skipUe4ss = ownUe4ss(gameDir, reg);
  for (const mod of m.mods) {
    if (isUe4ssId(mod.id) && skipUe4ss) {
      plan.same++;
      continue;
    }
    const have = reg.mods[mod.id];
    const there = have && path.resolve(have.root).toLowerCase() === root.toLowerCase() && existsSync(path.join(root, have.folder, 'Info.json'));
    if (!there) plan.add.push(mod);
    else if (have.stamp !== mod.stamp) plan.update.push({ ...mod, from: have.version || 'an older copy' });
    else {
      plan.same++;
      if (!s.enabled || !s.active.includes(mod.id)) plan.needsFix = true;
    }
  }
  for (const [id, r] of Object.entries(reg.mods)) if (r.link === linkKey(link) && !wanted.has(id)) plan.remove.push(id);
  return plan;
}

export interface PalChange {
  key: string;
  mod: PalMod;
  action: 'add' | 'update';
  from: string | null;
  dir: string;
  scan: ScanResult;
  needsApproval: boolean;
  blocked: boolean;
}
export interface PalPrepared {
  kind: 'palworld';
  gameDir: string;
  link: Link;
  manifest: PalManifest;
  workDir: string;
  changes: PalChange[];
  removals: string[];
  same: number;
  unavailable: string[];
}

function unzip(zip: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TH_SRC, $env:TH_DEST)'],
      { env: { ...process.env, TH_SRC: zip, TH_DEST: dest }, windowsHide: true, timeout: 10 * 60_000 },
      (err) => (err ? reject(new Error("it couldn't be unzipped")) : resolve()),
    );
  });
}

/** Downloads every new or changed mod from the server and checks it. Nothing is installed yet. */
export async function preparePal(gameDir: string, m: PalManifest, link: Link, workRoot: string, log: (l: string) => void): Promise<PalPrepared> {
  const plan = planPal(gameDir, m, link);
  const workDir = path.join(workRoot, `pal-${randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });
  const out: PalPrepared = { kind: 'palworld', gameDir, link, manifest: m, workDir, changes: [], removals: plan.remove, same: plan.same, unavailable: [] };
  // Mods already in place but switched off in the game (or the loader off): installing them again fixes that.
  const redo = plan.needsFix ? m.mods.filter((x) => !plan.add.some((a) => a.id === x.id) && !plan.update.some((u) => u.id === x.id)).map((x) => ({ ...x, from: null as string | null, action: 'update' as const })) : [];
  const todo = [...plan.add.map((x) => ({ ...x, from: null as string | null, action: 'add' as const })), ...plan.update.map((x) => ({ ...x, action: 'update' as const })), ...redo];
  for (const mod of todo) {
    const zip = path.join(workDir, mod.file);
    const dir = path.join(workDir, mod.id);
    try {
      log(`Downloading ${mod.name} ${mod.version} from the server…`);
      const body = (await pinnedGet(link, `/api/share/${link.token}/file/${encodeURIComponent(mod.file)}`, true)) as Buffer;
      if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) throw new Error("it isn't a zip file");
      writeFileSync(zip, body);
      // .NET's unzip refuses entries that would land outside the folder.
      await unzip(zip, dir);
      const info = JSON.parse(readFileSync(path.join(dir, 'Info.json'), 'utf-8').replace(/^﻿/, '')) as { PackageName?: string };
      if (info?.PackageName !== mod.id) throw new Error("its Info.json doesn't match the server's list");
      log(`Checking ${mod.name}…`);
      const def = await defenderScan(zip);
      const flags: ScanResult['flags'] = [];
      if (def.result === 'threat') flags.push({ level: 'high', text: `Windows Defender found ${def.threat}` } as ScanResult['flags'][number]);
      else if (def.result !== 'clean') flags.push({ level: 'medium', text: "Windows Defender couldn't scan it (another antivirus may be in charge)" } as ScanResult['flags'][number]);
      const verdict: ScanResult['verdict'] = def.result === 'threat' ? 'blocked' : def.result === 'clean' ? 'clean' : 'review';
      const summary = def.result === 'threat' ? `blocked: Windows Defender found ${def.threat}` : `${def.result === 'clean' ? 'Windows Defender: clean' : "Windows Defender couldn't scan it"} · sent by the server owner`;
      out.changes.push({
        key: `pal:${mod.id}@${mod.stamp}`,
        mod,
        action: mod.action,
        from: mod.from,
        dir,
        scan: { verdict, defender: def.result, threat: def.threat, flags, summary },
        // Nothing outside the server vouches for these files: the player approves each version once.
        needsApproval: true,
        blocked: verdict === 'blocked',
      });
    } catch (err) {
      const why = `${mod.name}: ${(err as Error).message}`;
      log(`Couldn't get ${why}`);
      out.unavailable.push(why);
    }
  }
  return out;
}

export function canAutoApplyPal(p: PalPrepared, approved: Set<string>) {
  return p.changes.every((c) => !c.blocked && (!c.needsApproval || approved.has(c.key)));
}

/** UE4SS sent by Server Forge 0.9.3 only has a server rule, which the game ignores: gives it the same rule for the game. */
function forPlayers(dest: string) {
  const file = path.join(dest, 'Info.json');
  const info = JSON.parse(readFileSync(file, 'utf-8').replace(/^\uFEFF/, '')) as { InstallRule?: { Type?: string; IsServer?: boolean }[] };
  const rules = info.InstallRule ?? [];
  const ue4ss = rules.filter((r) => r.Type === 'UE4SS');
  if (!ue4ss.length || ue4ss.some((r) => r.IsServer !== true)) return;
  rules.push(...ue4ss.map((r) => ({ ...r, IsServer: false })));
  writeFileSync(file, JSON.stringify(info, null, 2));
}

/** Installs the allowed changes where the game reads mods, switches them on, and uninstalls mods the server dropped. */
export async function applyPal(p: PalPrepared, approved: Set<string>, log: (l: string) => void) {
  const done = { installed: [] as string[], skipped: [] as string[], removed: [] as string[] };
  try {
    const reg = loadRegistry(p.gameDir);
    const root = modRoot(p.gameDir);
    const s = readModSettings(p.gameDir);
    const managed = (id: string) => existsSync(path.join(p.gameDir, 'Mods', 'ManagedMods', id));
    for (const c of p.changes) {
      if (c.blocked) {
        done.skipped.push(`${c.mod.name} (blocked: ${c.scan.summary})`);
        continue;
      }
      if (c.needsApproval && !approved.has(c.key)) {
        done.skipped.push(`${c.mod.name} (not approved)`);
        continue;
      }
      // An older copy elsewhere (the game's mod folder changed since) is removed first.
      const old = reg.mods[c.mod.id];
      if (old) rmSync(path.join(old.root, old.folder), { recursive: true, force: true });
      const folder = workshopFolder(c.mod.id);
      const dest = path.join(root, folder);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      cpSync(c.dir, dest, { recursive: true });
      forPlayers(dest);
      delete reg.own[c.mod.id];
      reg.mods[c.mod.id] = { stamp: c.mod.stamp, version: c.mod.version, name: c.mod.name, folder, root, link: linkKey(p.link) };
      s.remove = s.remove.filter((x) => x !== c.mod.id);
      if (!s.active.includes(c.mod.id)) s.active.push(c.mod.id);
      s.enabled = true;
      done.installed.push(`${c.mod.name} ${c.mod.version}`);
    }
    for (const id of p.removals) {
      const r = reg.mods[id];
      if (!r) continue;
      log(`Removing ${r.name} (the server no longer uses it)…`);
      rmSync(path.join(r.root, r.folder), { recursive: true, force: true });
      s.active = s.active.filter((x) => x !== id);
      // Its files stay installed (and loading) until the game uninstalls it on its next start.
      if (managed(id) && !s.remove.includes(id)) s.remove.push(id);
      delete reg.mods[id];
      done.removed.push(r.name);
    }
    writeModSettings(p.gameDir, s);
    saveRegistry(p.gameDir, reg);
    return done;
  } finally {
    rmSync(p.workDir, { recursive: true, force: true });
  }
}

// ---------- the player's own mods ----------

export interface PalListedMod {
  id: string;
  name: string;
  version: string;
  author: string;
  folder: string;
  active: boolean;
  /** server: follows a server, switched and removed there. workshop: Steam's. own: the player's. */
  source: 'server' | 'workshop' | 'own';
  types: string[];
  /** Only has rules for servers, so the game ignores it. */
  serverOnly: boolean;
  needsUe4ss: boolean;
  pending: string;
}

function modsIn(root: string): { folder: string; dir: string; info: PalInfo }[] {
  if (!existsSync(root)) return [];
  const out: { folder: string; dir: string; info: PalInfo }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const info = readInfo(dir);
    if (info) out.push({ folder: e.name, dir, info });
  }
  return out;
}

const hasUe4ssPackage = (root: string) => modsIn(root).some((m) => m.info.InstallRule.some((r) => r.Type === 'UE4SS' && r.IsServer !== true));

/** Everything in the folder the game reads mods from. */
export function palMods(gameDir: string): PalListedMod[] {
  const reg = loadRegistry(gameDir);
  const s = readModSettings(gameDir);
  const root = modRoot(gameDir);
  const ue4ss = manualUe4ss(gameDir) || hasUe4ssPackage(root);
  return modsIn(root)
    .map(({ folder, info }): PalListedMod => {
      const id = info.PackageName;
      const fromServer = reg.mods[id];
      const active = s.active.includes(id);
      const deployed = existsSync(path.join(gameDir, 'Mods', 'ManagedMods', id));
      return {
        id,
        name: info.ModName || id,
        version: String(info.Version ?? ''),
        author: String(info.Author ?? ''),
        folder,
        active,
        source: fromServer ? 'server' : s.workshopRoot && !reg.own[id] ? 'workshop' : 'own',
        types: [...new Set(info.InstallRule.map((r) => r.Type))],
        serverOnly: palSide(info) === 'server',
        needsUe4ss: !ue4ss && (info.Dependencies ?? []).some(isUe4ssDep),
        pending: active && s.enabled && !deployed ? 'set up the next time Palworld starts' : !active && deployed ? 'removed the next time Palworld starts' : '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The player's own mods follow the game when subscribing to the Workshop (or the opposite) changes its mod folder. */
export function palFollowRoot(gameDir: string) {
  const reg = loadRegistry(gameDir);
  const root = modRoot(gameDir);
  let changed = false;
  for (const r of Object.values(reg.own)) {
    if (path.resolve(r.root).toLowerCase() === root.toLowerCase()) continue;
    const from = path.join(r.root, r.folder);
    if (existsSync(from)) {
      mkdirSync(root, { recursive: true });
      rmSync(path.join(root, r.folder), { recursive: true, force: true });
      try {
        renameSync(from, path.join(root, r.folder));
      } catch {
        cpSync(from, path.join(root, r.folder), { recursive: true });
        rmSync(from, { recursive: true, force: true });
      }
    }
    r.root = root;
    changed = true;
  }
  if (changed) saveRegistry(gameDir, reg);
}

/** Unpacks what the player added and returns its mod folders, packaging downloads that have no Info.json. */
async function unpackOwn(file: string, work: string): Promise<string[]> {
  const top = path.join(work, 'top');
  const name = path.basename(file).replace(/^thsync-\d+-/, '');
  if (statSync(file).isDirectory()) cpSync(file, top, { recursive: true });
  else if (/\.pak$/i.test(file)) {
    mkdirSync(top, { recursive: true });
    cpSync(file, path.join(top, name));
  } else if (/\.zip$/i.test(file)) {
    const scan = await defenderScan(file);
    if (scan.result === 'threat') throw new Error(`Not installed: Windows Defender found ${scan.threat} in ${name}.`);
    await unzip(file, top).catch(() => {
      throw new Error(`${name} couldn't be unzipped (is it a damaged download?).`);
    });
  } else if (/\.(7z|rar)$/i.test(file)) throw new Error(`${name} is packed as ${path.extname(file).slice(1).toUpperCase()}. Only .zip mods can be installed: unpack it, then add the folder (or repack it as a .zip).`);
  else throw new Error('Palworld mods are .zip or .pak files, or a mod folder.');
  const packages = findPackages(top);
  if (packages.length) return packages;
  const ue4ss = wrapUe4ss(top, work);
  if (ue4ss) return [ue4ss];
  const pak = wrapLegacyPaks(top, name, work);
  const dirs = [...wrapLuaMods(top, name, work), ...(pak ? [pak] : [])];
  if (!dirs.length) throw new Error(`No Palworld mod was found in ${name}: there's no Info.json (made for Palworld's mod loader), UE4SS, UE4SS script mod (Scripts\\main.lua) or .pak file.`);
  return dirs;
}

/** Adds the player's own mod (.zip, .pak or folder) to the game and switches it on. Returns lines for the log. */
export async function installOwnPal(gameDir: string, file: string, workRoot: string, log: (l: string) => void): Promise<{ done: string[]; warnings: string[] }> {
  const work = path.join(workRoot, `pal-own-${randomUUID().slice(0, 8)}`);
  mkdirSync(work, { recursive: true });
  const out = { done: [] as string[], warnings: [] as string[] };
  try {
    const dirs = await unpackOwn(file, work);
    const reg = loadRegistry(gameDir);
    const root = modRoot(gameDir);
    const s = readModSettings(gameDir);
    const present = modsIn(root);
    for (const dir of dirs) {
      const info = readInfo(dir);
      if (!info) throw new Error(`${path.basename(dir)}: its Info.json couldn't be read.`);
      const problem = infoProblem(info);
      if (problem) throw new Error(`${info.ModName || path.basename(dir)}: ${problem}.`);
      const id = info.PackageName;
      const name = info.ModName || id;
      if (reg.mods[id]) throw new Error(`${name} comes from a server you follow, which keeps it up to date.`);
      const old = present.filter((m) => m.info.PackageName === id);
      if (old.length && s.workshopRoot && !reg.own[id]) throw new Error(`You already have ${name} from the Steam Workshop. Update or remove it there.`);
      if (/^ue4ss/i.test(id) || info.InstallRule.some((r) => r.Type === 'UE4SS')) {
        if (manualUe4ss(gameDir)) throw new Error('You already have a manual UE4SS install (dwmapi.dll in Pal\\Binaries\\Win64), and two copies crash the game. Rename or delete dwmapi.dll first.');
      }
      for (const o of old) rmSync(o.dir, { recursive: true, force: true });
      const folder = workshopFolder(id);
      const dest = path.join(root, folder);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      cpSync(dir, dest, { recursive: true });
      forPlayers(dest);
      reg.own[id] = { folder, root };
      s.remove = s.remove.filter((x) => x !== id);
      if (!s.active.includes(id)) s.active.push(id);
      s.enabled = true;
      out.done.push(`${old.length ? 'Updated' : 'Added'} ${name}${info.Version ? ` ${info.Version}` : ''}`);
      if (palSide(readInfo(dest) ?? info) === 'server') out.warnings.push(`${name} is made for servers only, so your game won't use it.`);
    }
    writeModSettings(gameDir, s);
    saveRegistry(gameDir, reg);
    if (!manualUe4ss(gameDir) && !hasUe4ssPackage(root) && dirs.some((d) => (readInfo(d)?.Dependencies ?? []).some(isUe4ssDep))) {
      out.warnings.push(`This needs UE4SS. Download UE4SS-Palworld.zip from ${UE4SS_URL} and add it here too.`);
    }
    out.done.forEach(log);
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Switches a mod on or off. Off also uninstalls it on the next start: leaving the list alone keeps its files loading. */
export function setPalEnabled(gameDir: string, id: string, on: boolean) {
  const reg = loadRegistry(gameDir);
  if (reg.mods[id]) throw new Error('That mod comes from a server you follow and is kept matched to it.');
  if (!modsIn(modRoot(gameDir)).some((m) => m.info.PackageName === id)) throw new Error('That mod is not installed.');
  const s = readModSettings(gameDir);
  s.active = s.active.filter((x) => x !== id);
  s.remove = s.remove.filter((x) => x !== id);
  if (on) {
    s.active.push(id);
    s.enabled = true;
  } else if (existsSync(path.join(gameDir, 'Mods', 'ManagedMods', id))) s.remove.push(id);
  writeModSettings(gameDir, s);
}

/** Deletes one of the player's own mods; the game uninstalls its files on the next start. */
export function removeOwnPal(gameDir: string, id: string) {
  const reg = loadRegistry(gameDir);
  if (reg.mods[id]) throw new Error('That mod comes from a server you follow. Remove the server to remove its mods.');
  const s = readModSettings(gameDir);
  if (s.workshopRoot && !reg.own[id]) throw new Error('That mod is from the Steam Workshop: unsubscribe from it in Steam.');
  const mods = modsIn(modRoot(gameDir)).filter((m) => m.info.PackageName === id);
  if (!mods.length) throw new Error('That mod is not installed.');
  for (const m of mods) rmSync(m.dir, { recursive: true, force: true });
  delete reg.own[id];
  s.active = s.active.filter((x) => x !== id);
  s.remove = s.remove.filter((x) => x !== id);
  if (existsSync(path.join(gameDir, 'Mods', 'ManagedMods', id))) s.remove.push(id);
  writeModSettings(gameDir, s);
  saveRegistry(gameDir, reg);
}

/** Mods this app installed for the servers, and whether the game's mod loader is on. */
export function palStatus(gameDir: string) {
  const reg = loadRegistry(gameDir);
  const s = readModSettings(gameDir);
  const root = modRoot(gameDir);
  return {
    loaderOn: s.enabled,
    root,
    steamWorkshop: !!s.workshopRoot,
    manualUe4ss: manualUe4ss(gameDir),
    mods: palMods(gameDir),
    installed: Object.entries(reg.mods).map(([id, r]) => ({ id, name: r.name, version: r.version, active: s.active.includes(id), present: existsSync(path.join(r.root, r.folder, 'Info.json')) })),
    others: existsSync(root) ? readdirSync(root).filter((f) => !Object.values(reg.mods).some((r) => r.folder === f)).length : 0,
  };
}
