// World backups: zip files under data/backups/<serverId>/, with an index.json listing them.
import { existsSync, mkdirSync, statSync, readdirSync, rmSync, cpSync, openSync, readSync, writeSync, closeSync, writeFileSync, readFileSync, statfsSync } from 'node:fs';
import { copyFile, rename, mkdir } from 'node:fs/promises';
import { events } from './events.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { dataPath, readJson, writeJson } from './store.ts';
import { formatBytes } from './download.ts';
import { isLinux } from './platform/host.ts';
import { unzipFile, zipDirectory } from './platform/archive.ts';
import type { Job } from './jobs.ts';
import type { ConsoleIO, GameModule, ServerRecord } from './games/types.ts';

const execFileAsync = promisify(execFile);

export type BackupKind = 'manual' | 'scheduled' | 'before-restore';

export interface BackupInfo {
  id: string;
  file: string;
  kind: BackupKind;
  createdAt: number;
  size: number;
  world: string | null;
  /** Whether it was taken while the server was running. */
  live: boolean;
  /** World check of this backup's copy of the world (Bedrock), see world-check.ts. */
  check?: BackupCheck;
}

export interface BackupCheck {
  status: 'checking' | 'ok' | 'damaged' | 'failed';
  at?: number;
  summary?: string;
}

function dir(serverId: string) {
  return dataPath('backups', serverId);
}

function indexFile(serverId: string) {
  return path.join('backups', serverId, 'index.json');
}

export function listBackups(serverId: string): BackupInfo[] {
  // Drop entries whose zip was deleted by hand.
  return readJson<BackupInfo[]>(indexFile(serverId), [])
    .filter((b) => existsSync(path.join(dir(serverId), b.file)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saveIndex(serverId: string, list: BackupInfo[]) {
  writeJson(indexFile(serverId), list);
}

export function backupsFolder(serverId: string) {
  mkdirSync(dir(serverId), { recursive: true });
  return dir(serverId);
}

/** Zips/unzips with .NET's built-in ZipFile (handles large files); paths go through environment variables. */
export async function zipFolder(source: string, zip: string) {
  if (isLinux) return zipDirectory(source, zip);
  await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:TH_SRC, $env:TH_DEST, 'Optimal', $false)",
    ],
    { env: { ...process.env, TH_SRC: source, TH_DEST: zip }, windowsHide: true, timeout: 60 * 60_000 },
  );
}

export async function unzipTo(zip: string, dest: string) {
  if (isLinux) return unzipFile(zip, dest);
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:TH_SRC, $env:TH_DEST)'],
    { env: { ...process.env, TH_SRC: zip, TH_DEST: dest }, windowsHide: true, timeout: 60 * 60_000 },
  );
}

/** Copies the first `length` bytes of a file (Bedrock says exactly how much of each file is valid). */
function copyTruncated(src: string, dest: string, length: number) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const input = openSync(src, 'r');
  const output = openSync(dest, 'w');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let done = 0;
    while (done < length) {
      const n = readSync(input, buf, 0, Math.min(buf.length, length - done), done);
      if (n <= 0) break;
      writeSync(output, buf, 0, n);
      done += n;
    }
  } finally {
    closeSync(input);
    closeSync(output);
  }
}

export interface BackupTarget {
  record: ServerRecord;
  module: GameModule;
  running: boolean;
  io: ConsoleIO;
}

/**
 * Called with each new backup's unpacked copy (before it's deleted). Return true to take the folder over (then the
 * handler deletes it when done); the world checker uses this to check every backup without copying it again.
 */
type StagedHandler = (s: { serverId: string; backupId: string; staging: string; world: string | null; record: ServerRecord }) => boolean;
let stagedHandler: StagedHandler | null = null;
export function onBackupStaged(fn: StagedHandler) {
  stagedHandler = fn;
}

/** Makes a backup. While running, uses the game's safe method if it has one (Bedrock), otherwise copies as-is. */
export async function createBackup(t: BackupTarget, kind: BackupKind, job: Job, opts: { noCopy?: boolean } = {}): Promise<BackupInfo> {
  if (!t.module.backup) throw new Error(`${t.module.name} servers can't be backed up yet.`);
  const staging = path.join(os.tmpdir(), `tavernhost-backup-${randomUUID().slice(0, 8)}`);
  let handedOver = false;
  try {
    const { world, live } = await stageWorld(t, staging, job);

    job.update('Compressing…', null);
    const folder = backupsFolder(t.record.id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = `${stamp}-${kind}.zip`;
    await zipFolder(staging, path.join(folder, file));
    const info: BackupInfo = { id: randomUUID().slice(0, 8), file, kind, createdAt: Date.now(), size: statSync(path.join(folder, file)).size, world, live };
    saveIndex(t.record.id, [info, ...listBackups(t.record.id)]);
    job.line(`Backup saved: ${file} (${formatBytes(info.size)}).`);
    try {
      handedOver = !!stagedHandler?.({ serverId: t.record.id, backupId: info.id, staging, world, record: t.record });
    } catch {}
    const copy = getCopySettings();
    if (copy.enabled && copy.folder && !opts.noCopy) {
      job.update(`Copying to ${copy.folder}…`, null);
      try {
        await copyToOffsite(t.record, info);
        job.line(`Copied to ${copyFolderFor(t.record)}.`);
        events.emit('backup-copy', { serverId: t.record.id, ok: true });
      } catch (err) {
        // The backup itself is fine; only the extra copy failed.
        job.line(`Couldn't copy it to ${copy.folder}: ${(err as Error).message}`);
        events.emit('backup-copy', { serverId: t.record.id, ok: false, error: (err as Error).message, folder: copy.folder });
      }
    }
    return info;
  } finally {
    if (!handedOver) rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Copies a server's world (and the other files its backups include) into `staging`. While running, uses the game's
 * safe method if it has one (Bedrock pauses saving and says exactly which bytes make a consistent copy).
 */
export async function stageWorld(t: BackupTarget, staging: string, job: Pick<Job, 'update'>): Promise<{ world: string | null; live: boolean }> {
  const support = t.module.backup;
  if (!support) throw new Error(`${t.module.name} servers can't be backed up yet.`);
  const { base, include, world } = support.sources(t.record);
  mkdirSync(staging, { recursive: true });
  const live = t.running;
  job.update(live ? 'Copying world files while the server keeps running…' : 'Copying world files…', null);
  let hot: Awaited<ReturnType<NonNullable<typeof support.hot>>> | null = null;
  if (live && support.hot && t.module.commands) {
    job.update('Asking the server to pause saving…', null);
    markLiveBackup(t.record.id, true);
    try {
      hot = await support.hot(t.record, t.io);
    } catch (err) {
      markLiveBackup(t.record.id, false);
      throw err;
    }
  }
  try {
    if (hot) {
      for (const f of hot.files) copyTruncated(path.join(base, f.rel), path.join(staging, f.rel), f.length);
    }
    // Everything else (settings, lists; or the whole world when there's no safe live method). Folders the safe
    // method already copied file-by-file are skipped: copying them wholesale would hit files the running server
    // keeps locked (e.g. Java's session.lock).
    const norm = (p: string) => p.replace(/\\/g, '/');
    const hotFiles = hot ? hot.files.map((f) => norm(f.rel)) : [];
    const coveredByHot = (rel: string) => hotFiles.some((f) => f === norm(rel) || f.startsWith(`${norm(rel)}/`));
    const hotSet = new Set(hotFiles.map((f) => f.toLowerCase()));
    // A folder the safe method only partly covers (Bedrock's save query lists just the world database, level.dat
    // and friends): copy its other files too, e.g. the world's behavior_packs/resource_packs and the
    // world_*_packs.json lists. Subfolders holding listed files (Bedrock's db) are the safe method's alone; files
    // the server keeps locked are skipped.
    const copyRest = (relDir: string, isRoot: boolean) => {
      const abs = path.join(base, relDir);
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      const relOf = (name: string) => norm(path.join(relDir, name));
      if (!isRoot && entries.some((e) => e.isFile() && hotSet.has(relOf(e.name).toLowerCase()))) return;
      for (const e of entries) {
        const r = relOf(e.name);
        if (e.isDirectory()) copyRest(r, false);
        else if (e.isFile() && !hotSet.has(r.toLowerCase())) {
          try {
            mkdirSync(path.dirname(path.join(staging, r)), { recursive: true });
            cpSync(path.join(base, r), path.join(staging, r));
          } catch {}
        }
      }
    };
    for (const rel of include) {
      const src = path.join(base, rel);
      if (!existsSync(src)) continue;
      if (coveredByHot(rel)) {
        if (statSync(src).isDirectory()) copyRest(rel, true);
        continue;
      }
      cpSync(src, path.join(staging, rel), { recursive: true });
    }
  } finally {
    if (hot) {
      job.update('Letting the server save again…', null);
      await hot.finish();
      markLiveBackup(t.record.id, false);
    }
  }
  return { world, live };
}

// A live backup pauses the server's saving (Bedrock "save hold", Java "save-off") until it's done. If Server Forge
// closes in the middle (an update, a crash), the server would stay paused: its world stops being saved, and the next
// backup finds "A previous save has not been completed". Each live backup is noted here until it finishes, and on
// re-attaching Server Forge turns saving back on for any that were cut off (resumeCutOffBackup).
const LIVE_BACKUPS = 'live-backups.json';
function markLiveBackup(serverId: string, on: boolean) {
  const all = readJson<Record<string, number>>(LIVE_BACKUPS, {});
  if (on) all[serverId] = Date.now();
  else delete all[serverId];
  writeJson(LIVE_BACKUPS, all);
}

/** If a live backup of this server was cut off, turns its saving back on. Returns true if it did. */
export async function resumeCutOffBackup(t: BackupTarget): Promise<boolean> {
  if (!readJson<Record<string, number>>(LIVE_BACKUPS, {})[t.record.id]) return false;
  if (!t.running || !t.module.backup?.resume) return false;
  await t.module.backup.resume(t.io);
  markLiveBackup(t.record.id, false);
  return true;
}

/** Records the world check result on a backup. */
export function setBackupCheck(serverId: string, backupId: string, check: BackupCheck) {
  const list = readJson<BackupInfo[]>(indexFile(serverId), []);
  const b = list.find((x) => x.id === backupId);
  if (!b) return;
  b.check = check;
  saveIndex(serverId, list);
}

/** The newest backup whose world passed its check: kept no matter what (the last known-good copy). */
export function lastGoodBackup(serverId: string): BackupInfo | null {
  return listBackups(serverId).find((b) => b.check?.status === 'ok') ?? null;
}

// ---------- copies somewhere else (another drive, a NAS, a network share) ----------
// Every new backup is also copied to <folder>\<server name>-<id>\, with an index.json there listing the copies, so
// they survive this system's disk dying. Copies older than keepDays are removed (the newest 3 per server always stay).

export interface CopySettings {
  enabled: boolean;
  folder: string;
  keepDays: number;
}

const COPY_SETTINGS = 'backup-copy.json';

export function getCopySettings(): CopySettings {
  return { enabled: false, folder: '', keepDays: 30, ...readJson<Partial<CopySettings>>(COPY_SETTINGS, {}) };
}

export function setCopySettings(input: Partial<CopySettings>): CopySettings {
  const next = { ...getCopySettings() };
  if (input.folder !== undefined) {
    const f = String(input.folder).trim();
    if (f && !path.isAbsolute(f)) throw new Error('Use a full folder path, e.g. A:\\Server Forge Backups or \\\\nas\\backups');
    next.folder = f ? path.resolve(f) : '';
  }
  if (input.keepDays !== undefined) {
    const d = Number(input.keepDays);
    if (!Number.isInteger(d) || d < 1 || d > 3650) throw new Error('Keep copies for 1-3650 days.');
    next.keepDays = d;
  }
  if (input.enabled !== undefined) next.enabled = !!input.enabled;
  if (next.enabled && !next.folder) throw new Error('Choose a folder first.');
  if (next.enabled) testCopyFolder(next.folder);
  writeJson(COPY_SETTINGS, next);
  return next;
}

/** Throws unless the folder can be created and written to. Returns its free space when known. */
export function testCopyFolder(folder: string): number | null {
  try {
    mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, `.tavernhost-write-test-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (err) {
    throw new Error(`Can't write to ${folder}: ${(err as Error).message}`);
  }
  try {
    const s = statfsSync(folder);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const safeName = (name: string) => name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'server';

/** The copy folder for a server (found by its id, so renaming the server keeps using the same folder). */
export function copyFolderFor(record: Pick<ServerRecord, 'id' | 'name'>): string {
  const root = getCopySettings().folder;
  try {
    const existing = readdirSync(root).find((d) => d.endsWith(`-${record.id}`));
    if (existing) return path.join(root, existing);
  } catch {}
  return path.join(root, `${safeName(record.name)}-${record.id}`);
}

export interface BackupCopy extends BackupInfo {
  copiedAt: number;
}

export function listCopies(record: Pick<ServerRecord, 'id' | 'name'>): BackupCopy[] {
  const settings = getCopySettings();
  if (!settings.folder) return [];
  const folder = copyFolderFor(record);
  try {
    const list = JSON.parse(readFileSync(path.join(folder, 'index.json'), 'utf-8')) as BackupCopy[];
    return list.filter((c) => existsSync(path.join(folder, c.file))).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** Copies one local backup there (skips it if it's already there) and removes expired copies. */
export async function copyToOffsite(record: Pick<ServerRecord, 'id' | 'name'>, info: BackupInfo) {
  const settings = getCopySettings();
  const folder = copyFolderFor(record);
  await mkdir(folder, { recursive: true });
  const list = listCopies(record);
  if (!list.some((c) => c.file === info.file)) {
    // Copy under a temporary name first, so a half-finished copy is never listed.
    const dest = path.join(folder, info.file);
    await copyFile(path.join(dir(record.id), info.file), `${dest}.part`);
    await rename(`${dest}.part`, dest);
    list.unshift({ ...info, copiedAt: Date.now() });
  }
  const cutoff = Date.now() - settings.keepDays * 86400_000;
  const keep = list.filter((c, i) => i < 3 || c.createdAt >= cutoff);
  for (const c of list) if (!keep.includes(c)) rmSync(path.join(folder, c.file), { force: true });
  writeFileSync(path.join(folder, 'index.json'), JSON.stringify(keep, null, 2));
}

/** Copies every local backup of a server that isn't there yet. Returns how many were copied. */
export async function copyAllToOffsite(record: Pick<ServerRecord, 'id' | 'name'>): Promise<number> {
  const have = new Set(listCopies(record).map((c) => c.file));
  let n = 0;
  for (const b of [...listBackups(record.id)].reverse()) {
    if (have.has(b.file)) continue;
    await copyToOffsite(record, b);
    n++;
  }
  return n;
}

/** Copies a backup back from the copy folder into this system's backups, so it can be restored the normal way. */
export async function bringBackCopy(record: Pick<ServerRecord, 'id' | 'name'>, file: string): Promise<BackupInfo> {
  const c = listCopies(record).find((x) => x.file === file);
  if (!c) throw new Error('That copy is not there any more.');
  const local = listBackups(record.id);
  const existing = local.find((b) => b.file === c.file);
  if (existing) return existing;
  mkdirSync(dir(record.id), { recursive: true });
  await copyFile(path.join(copyFolderFor(record), c.file), path.join(dir(record.id), `${c.file}.part`));
  await rename(path.join(dir(record.id), `${c.file}.part`), path.join(dir(record.id), c.file));
  const { copiedAt: _c, ...info } = c;
  const restored: BackupInfo = { ...info, id: randomUUID().slice(0, 8) };
  saveIndex(record.id, [restored, ...local]);
  return restored;
}

/**
 * Removes the oldest scheduled backups beyond `keep`. Manual and before-restore backups are never pruned, and neither
 * is the newest backup that passed its world check (or one still being checked): if the world gets damaged, the last
 * good copy survives however many damaged backups follow.
 */
export function pruneScheduled(serverId: string, keep: number) {
  const list = listBackups(serverId);
  const good = lastGoodBackup(serverId)?.id;
  const scheduled = list.filter((b) => b.kind === 'scheduled');
  const remove = new Set(scheduled.slice(Math.max(keep, 1)).filter((b) => b.id !== good && b.check?.status !== 'checking').map((b) => b.id));
  for (const b of list) if (remove.has(b.id)) rmSync(path.join(dir(serverId), b.file), { force: true });
  saveIndex(serverId, list.filter((b) => !remove.has(b.id)));
  return remove.size;
}

/** Unpacks a backup's files into `dest` (used when cloning a running server). */
export async function extractBackup(serverId: string, backupId: string, dest: string) {
  const b = listBackups(serverId).find((x) => x.id === backupId);
  if (!b) throw new Error('Backup not found.');
  const tmp = path.join(os.tmpdir(), `tavernhost-extract-${randomUUID().slice(0, 8)}`);
  try {
    await unzipTo(path.join(dir(serverId), b.file), tmp);
    mkdirSync(dest, { recursive: true });
    cpSync(tmp, dest, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function deleteBackup(serverId: string, backupId: string) {
  const list = listBackups(serverId);
  const b = list.find((x) => x.id === backupId);
  if (!b) throw new Error('Backup not found.');
  rmSync(path.join(dir(serverId), b.file), { force: true });
  saveIndex(serverId, list.filter((x) => x.id !== backupId));
}

/**
 * Restores a backup over the server's files (server must be stopped). The folders in the backup replace the current
 * ones entirely; single files are overwritten.
 */
export async function restoreBackup(t: BackupTarget, backupId: string, job: Job) {
  const b = listBackups(t.record.id).find((x) => x.id === backupId);
  if (!b) throw new Error('Backup not found.');
  const { base } = t.module.backup!.sources(t.record);
  const tmp = path.join(os.tmpdir(), `tavernhost-restore-${randomUUID().slice(0, 8)}`);
  try {
    job.update('Unpacking backup…', null);
    await unzipTo(path.join(dir(t.record.id), b.file), tmp);
    job.update('Replacing world files…', null);
    // Top-level items, plus world folders one level down (e.g. worlds/<name>, worlds_local/<name>).
    for (const top of readdirSync(tmp)) {
      const src = path.join(tmp, top);
      if (statSync(src).isDirectory() && ['worlds', 'worlds_local'].includes(top)) {
        for (const worldItem of readdirSync(src)) {
          const dest = path.join(base, top, worldItem);
          rmSync(dest, { recursive: true, force: true });
          cpSync(path.join(src, worldItem), dest, { recursive: true });
        }
      } else {
        const dest = path.join(base, top);
        if (statSync(src).isDirectory()) rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true, force: true });
      }
    }
    job.line(`Restored backup from ${new Date(b.createdAt).toLocaleString()}.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
