// SF Mod Manager: Palworld. Keeps the player's game matched to a Server Forge server's player-side mods, through
// Palworld's own mod loader: each mod is a folder (named with a number, which the loader reads as its Workshop ID) with
// an Info.json, and Mods\PalModSettings.ini switches the loader on and lists the active mods. The game sets them up when
// it starts.
// Found by testing the game (1.0.5): the loader reads mods from WorkshopRootDir when it's set (the game sets it to
// Steam's Workshop folder as soon as the player subscribes to anything), and from Mods\Workshop only when it's empty.
// A mod in the folder it isn't reading is silently uninstalled and dropped from ActiveModList. So the app always puts
// the server's mods where the game is looking right now, and moves them if that changes. Switching a mod off only
// leaves its files installed (and loading): DeleteModList uninstalls it on the next start.
// Only mods this app installed are ever changed or removed (they're listed in Mods\.sf-mod-manager.json).
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { defenderScan, type ScanResult } from '../modscan.ts';
import { pinnedGet, steamPath, type Link, type AnyManifest } from './sync.ts';

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
}
const registryFile = (gameDir: string) => path.join(gameDir, 'Mods', '.sf-mod-manager.json');
function loadRegistry(gameDir: string): Registry {
  try {
    const r = JSON.parse(readFileSync(registryFile(gameDir), 'utf-8'));
    return { mods: r && typeof r.mods === 'object' ? r.mods : {} };
  } catch {
    return { mods: {} };
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

export function planPal(gameDir: string, m: PalManifest, link: Link): PalPlan {
  const reg = loadRegistry(gameDir);
  const root = modRoot(gameDir);
  const s = readModSettings(gameDir);
  const plan: PalPlan = { add: [], update: [], remove: [], same: 0, needsFix: false };
  const wanted = new Set(m.mods.map((x) => x.id));
  for (const mod of m.mods) {
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

/** Mods this app installed for the servers, and whether the game's mod loader is on. */
export function palStatus(gameDir: string) {
  const reg = loadRegistry(gameDir);
  const s = readModSettings(gameDir);
  const root = modRoot(gameDir);
  return {
    loaderOn: s.enabled,
    root,
    steamWorkshop: !!s.workshopRoot,
    installed: Object.entries(reg.mods).map(([id, r]) => ({ id, name: r.name, version: r.version, active: s.active.includes(id), present: existsSync(path.join(r.root, r.folder, 'Info.json')) })),
    others: existsSync(root) ? readdirSync(root).filter((f) => !Object.values(reg.mods).some((r) => r.folder === f)).length : 0,
  };
}
