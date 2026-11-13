// Moving a server to another system, the per-system half. The system it leaves packs its parts as tar streams: the
// server folder, a world kept outside that folder (Satisfactory, or a Valheim/tModLoader save folder set elsewhere),
// and its backups. The system it goes to unpacks them into a new folder of its own and adds the server, with the same
// settings, ports and scheduled tasks. The main panel joins the two (moves.ts); nothing is staged on disk in between.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { GAMES, addServer, assertFolderFree, getInstance, listInstances } from './instances.ts';
import { runningJob } from './jobs.ts';
import { backupsFolder } from './backups.ts';
import { dataPath, isDev } from './store.ts';
import { exampleFolder, isLinux } from './platform/host.ts';
import { createTask, listTasks } from './scheduler.ts';
import type { ServerRecord } from './games/types.ts';

export type TransferPart = 'server' | 'world' | 'backups';
const PARTS: TransferPart[] = ['server', 'world', 'backups'];

export interface TransferInfo {
  record: ServerRecord;
  platform: NodeJS.Platform;
  running: boolean;
  parts: { name: TransferPart; bytes: number }[];
  tasks: unknown[];
}

// Windows' own tar (bsdtar): a Git or Cygwin tar earlier on PATH would read "C:\..." as a remote host.
const TAR = isLinux ? 'tar' : path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
const LOCK_FILE = '.tavernhost-owner.json';

const inside = (child: string, parent: string) => {
  // Windows paths ignore case; Linux paths distinguish e.g. Base and base.
  const c = isLinux ? path.resolve(child) : path.resolve(child).toLowerCase();
  const p = isLinux ? path.resolve(parent) : path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
};

/** The world's folder when the game keeps it outside the server folder, else null. */
function outsideWorld(record: ServerRecord): string | null {
  const base = GAMES[record.game]?.backup?.sources(record)?.base;
  return base && !inside(base, record.installDir) ? base : null;
}

function partFolder(record: ServerRecord, part: TransferPart): string | null {
  if (part === 'server') return record.installDir;
  if (part === 'world') return outsideWorld(record);
  return backupsFolder(record.id);
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

const hasFiles = (dir: string | null): dir is string => !!dir && existsSync(dir) && readdirSync(dir).length > 0;

// ---------- the system the server leaves ----------

export async function transferInfo(id: string): Promise<TransferInfo> {
  const inst = getInstance(id);
  const parts: TransferInfo['parts'] = [];
  for (const name of PARTS) {
    const dir = partFolder(inst.record, name);
    if (hasFiles(dir)) parts.push({ name, bytes: await folderBytes(dir) });
  }
  return { record: inst.record, platform: process.platform, running: inst.isRunning, parts, tasks: listTasks(id) };
}

/** One part as a tar stream. The server has to be stopped, so nothing changes while it's read. */
export function packPart(id: string, part: TransferPart): Readable {
  const inst = getInstance(id);
  if (inst.isRunning) throw new Error('Stop the server before moving it.');
  if (runningJob(id)) throw new Error('Wait for the install or update to finish before moving it.');
  const dir = partFolder(inst.record, part);
  if (!hasFiles(dir)) throw new Error(`This server has no ${part} files to move.`);
  const tar = spawn(TAR, ['-cf', '-', '--exclude', LOCK_FILE, '-C', dir, '.'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  tar.stderr.on('data', (d) => (errors = (errors + d.toString()).slice(-2000)));
  tar.on('close', (code) => {
    // A failed pack ends the stream with an error, so the other side doesn't take a half archive for a whole one.
    if (code !== 0) tar.stdout.destroy(new Error(`Packing ${part} failed: ${errors.trim().split('\n').pop() || `tar exit code ${code}`}`));
  });
  return tar.stdout;
}

// ---------- the system the server arrives on ----------

interface Incoming {
  record: ServerRecord;
  sourcePlatform: string;
  folders: Partial<Record<TransferPart, string>>;
  /** Of those, the ones that were already there (empty) when the move began. */
  existed: Set<string>;
  tasks: unknown[];
  received: Set<TransferPart>;
  at: number;
}
const incoming = new Map<string, Incoming>();
setInterval(() => {
  for (const [token, i] of incoming) if (Date.now() - i.at > 24 * 3600_000) abortReceive(token);
}, 3600_000).unref();

/** A free folder name in this system's server folder, named like the original's. */
function newFolder(sourceDir: string): string {
  // Only the last part of the old path is used, cleaned so it can't be ".." or reach anywhere else.
  const name =
    String(sourceDir ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/[<>:"|?*\x00-\x1f]/g, '')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 80) || 'Server';
  // The same default folder the panel offers for new servers (the development panel keeps its own).
  const root = exampleFolder(...(isDev ? ['Dev'] : []));
  for (let i = 1; ; i++) {
    const dir = path.join(root, i === 1 ? name : `${name} (${i})`);
    if (!existsSync(dir) && !listInstances().some((s) => inside(dir, s.record.installDir) || inside(s.record.installDir, dir))) return dir;
  }
}

/**
 * The record's settings with every path in the old folders pointed at the new ones. A world kept outside the old
 * server folder goes into "saves" inside the new one (a game that keeps it in a fixed place uses its own place here).
 */
function movePaths(value: unknown, moves: [string, string][]): unknown {
  if (typeof value === 'string') {
    for (const [from, to] of moves) {
      const v = value.replace(/[\\/]+/g, '/').toLowerCase();
      const f = from.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
      if (v === f || v.startsWith(`${f}/`)) return path.join(to, ...value.replace(/[\\/]+/g, '/').slice(f.length).split('/').filter(Boolean));
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => movePaths(v, moves));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, movePaths(v, moves)]));
  return value;
}

const SAFE_ID = /^[\w-]{1,40}$/;

/**
 * Everything in the incoming record comes from another system (or whoever holds a key with "create servers"), so none
 * of it is trusted: the id must be a plain name, the settings go through the game's own checks, and every folder the
 * parts unpack into must be the new server folder, its backups folder, or the game's own fixed world folder.
 */
export function beginReceive(input: { record: ServerRecord; platform: string; parts: TransferPart[]; tasks?: unknown[] }): { token: string; installDir: string; id: string } {
  const src = input?.record;
  if (!src || typeof src !== 'object' || typeof src.game !== 'string' || typeof src.installDir !== 'string') throw new Error('That move request is missing the server details.');
  const module = Object.hasOwn(GAMES, src.game) ? GAMES[src.game] : undefined;
  if (!module) throw new Error("This system's Server Forge doesn't know that game. Update it first.");
  if (isLinux && module.linux === 'unavailable') throw new Error(`${module.name} servers can't run on Linux.`);
  const parts = Array.isArray(input.parts) ? input.parts.filter((p): p is TransferPart => PARTS.includes(p)) : [];
  if (!parts.includes('server')) throw new Error('That move request has no server files.');
  if (parts.includes('world') && src.game === 'satisfactory' && listInstances().some((s) => s.record.game === 'satisfactory')) {
    throw new Error('This system already has a Satisfactory server, and Satisfactory keeps every server\'s saves in one place. Move or remove that one first.');
  }
  const installDir = newFolder(src.installDir);
  if (!inside(installDir, exampleFolder(...(isDev ? ['Dev'] : [])))) throw new Error('That server folder name is not allowed.');
  assertFolderFree(installDir);
  // A new id unless the old one is a plain name that's free here (it names the backups folder in this system's data).
  const freeId = (x: string) => !listInstances().some((s) => s.id === x) && !existsSync(dataPath('backups', x));
  let id = SAFE_ID.test(String(src.id)) && freeId(String(src.id)) ? String(src.id) : '';
  while (!id) {
    const x = randomBytes(4).toString('hex');
    if (freeId(x)) id = x;
  }
  const oldWorld = outsideWorld(src);
  const moves: [string, string][] = [[src.installDir, installDir], ...(oldWorld ? ([[oldWorld, path.join(installDir, 'saves')]] as [string, string][]) : [])];
  moves.sort((a, b) => b[0].length - a[0].length);
  const moved = movePaths(src.settings && typeof src.settings === 'object' ? src.settings : {}, moves) as ServerRecord['settings'];
  // The game's own checks, the same as saving settings here (unknown or bad values are refused or dropped).
  const settings = module.validate({ ...module.defaults({ installDir }), ...moved });
  const name = String(src.name ?? '').trim().slice(0, 60) || module.name;
  const schedule = src.backupSchedule && typeof src.backupSchedule === 'object' ? { everyHours: Math.max(0, Math.min(Number(src.backupSchedule.everyHours) || 0, 24 * 30)), keep: Math.max(1, Math.min(Number(src.backupSchedule.keep) || 1, 1000)) } : undefined;
  const record: ServerRecord = {
    id,
    game: module.id,
    name,
    installDir,
    settings,
    autoRestart: src.autoRestart !== false,
    createdAt: Number(src.createdAt) || Date.now(),
    ...(schedule ? { backupSchedule: schedule } : {}),
    ...(typeof src.autoUpdate === 'boolean' ? { autoUpdate: src.autoUpdate } : {}),
  };

  const folders: Incoming['folders'] = { server: installDir, backups: dataPath('backups', id) };
  if (parts.includes('world')) {
    const world = outsideWorld(record) ?? module.backup?.sources(record)?.base;
    if (!world) throw new Error("This system can't tell where that server's world goes.");
    // Outside the new server folder, only the place this game always keeps its world (e.g. Satisfactory's) is allowed.
    const fixed = module.backup?.sources({ ...record, settings: module.defaults({ installDir }) })?.base;
    if (!inside(world, installDir) && !(fixed && inside(fixed, world) && inside(world, fixed))) {
      throw new Error(`That server's world would go outside its new folder (${world}). Nothing was moved.`);
    }
    if (hasFiles(world) && !inside(world, installDir)) throw new Error(`The world folder here (${world}) already has files in it. Nothing was moved.`);
    folders.world = world;
  }
  // Folders that already exist (an empty fixed world folder) are only emptied again if the move is cancelled, never removed.
  const existed = new Set(Object.values(folders).filter((d): d is string => !!d && existsSync(d)));
  const token = randomBytes(16).toString('hex');
  incoming.set(token, { record, sourcePlatform: String(input.platform ?? ''), folders, existed, tasks: Array.isArray(input.tasks) ? input.tasks.slice(0, 200) : [], received: new Set(), at: Date.now() });
  return { token, installDir, id };
}

function pending(token: string): Incoming {
  const i = incoming.get(token);
  if (!i) throw new Error('That move was cancelled or has expired. Start it again.');
  return i;
}

/**
 * Removes symbolic links (and Windows junctions) in an unpacked folder that point outside it. tar refuses to unpack
 * files through a link, but a link left behind could still lead backups, mods or the game itself out of the folder.
 */
function removeOutsideLinks(root: string) {
  const base = realpathSync(root);
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let target = '';
        try {
          // Resolve the actual chain before checking containment. Normalizing a link's text first can
          // hide an escape such as alias/../outside when alias points back to this directory.
          target = realpathSync(full);
        } catch {
          // Dangling or cyclic links cannot be established as safe; remove the link itself.
        }
        if (!target || !inside(target, base)) {
          // Removes the link itself, never what it points to (a Windows junction needs rmdir).
          try {
            unlinkSync(full);
          } catch {
            rmdirSync(full);
          }
        }
      } else if (e.isDirectory()) walk(full);
    }
  };
  walk(base);
}

/** Unpacks one part's tar stream into its folder. */
export function receivePart(token: string, part: TransferPart, body: Readable): Promise<void> {
  const i = pending(token);
  if (!PARTS.includes(part)) throw new Error(`Unexpected part "${part}".`);
  const dir = i.folders[part];
  if (!dir) throw new Error(`Unexpected part "${part}".`);
  if (i.received.has(part)) throw new Error(`The ${part} files have already arrived.`);
  mkdirSync(dir, { recursive: true });
  // --no-same-owner: files belong to whoever runs Server Forge here, not the user ids of the old system.
  const tar = spawn(TAR, ['-xf', '-', ...(isLinux ? ['--no-same-owner'] : []), '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let errors = '';
  tar.stderr.on('data', (d) => (errors = (errors + d.toString()).slice(-2000)));
  // The upload has to arrive whole: an error or a dropped connection before its end fails the part.
  const arrived = new Promise<boolean>((resolve) => {
    body.on('end', () => resolve(true));
    body.on('error', () => resolve(false));
    body.on('close', () => resolve(body.readableEnded));
  });
  body.on('error', () => tar.kill());
  body.pipe(tar.stdin);
  tar.stdin.on('error', () => {});
  const fail = (why: string) => new Error(`Unpacking ${part} failed: ${why}`);
  return new Promise((resolve, reject) => {
    tar.on('error', (err) => reject(fail(err.message)));
    tar.on('close', async (code) => {
      if (code !== 0) return reject(fail(errors.trim().split('\n').pop() || `tar exit code ${code}`));
      // GNU tar stops at the archive's end marker, before the padding after it: read the rest, then check it all came.
      body.unpipe(tar.stdin);
      body.resume();
      if (!(await arrived)) return reject(fail('the transfer stopped part-way'));
      removeOutsideLinks(dir);
      i.received.add(part);
      i.at = Date.now();
      resolve();
    });
  });
}

/** Adds the server once its parts are in. Software for another system (Windows to Linux) is installed fresh. */
export async function finishReceive(token: string) {
  const i = pending(token);
  if (!i.received.has('server')) throw new Error("The server's files haven't arrived.");
  incoming.delete(token);
  const inst = addServer(i.record);
  for (const t of i.tasks) {
    try {
      const { id: _id, lastRun: _last, ...task } = t as Record<string, unknown>;
      createTask(inst.id, task);
    } catch {}
  }
  const reinstall = i.sourcePlatform !== process.platform && !!inst.module.install;
  if (reinstall) inst.installSoftware(`Installing ${inst.module.name} server for ${isLinux ? 'Linux' : 'Windows'}`);
  return { server: await inst.snapshot(), reinstalling: reinstall };
}

export function abortReceive(token: string) {
  const i = incoming.get(token);
  if (!i) return;
  incoming.delete(token);
  for (const dir of Object.values(i.folders)) {
    if (!dir) continue;
    // A folder this move made goes completely; one that was already there (empty) is only emptied again.
    if (!i.existed.has(dir)) rmSync(dir, { recursive: true, force: true });
    else if (existsSync(dir)) for (const e of readdirSync(dir)) rmSync(path.join(dir, e), { recursive: true, force: true });
  }
}
