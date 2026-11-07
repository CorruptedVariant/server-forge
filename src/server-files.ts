// Per-server file manager: everything is relative to one server's folder and can never reach outside it.
// Text files (configs, logs, JSON...) can be opened and edited; anything can be uploaded, downloaded, renamed or deleted.
import { readdirSync, statSync, existsSync, mkdirSync, renameSync, readFileSync, writeFileSync, realpathSync, copyFileSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { isLinux, moveToTrash } from './platform/host.ts';

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 5000;
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export interface FileEntry {
  name: string;
  type: 'dir' | 'file';
  size: number | null;
  modified: number | null;
  editable: boolean;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Turns a path relative to the server folder into an absolute one, refusing anything that escapes the folder. */
export function resolveIn(root: string, rel: string): string {
  const base = path.resolve(root);
  const clean = String(rel ?? '').replace(/^[\\/]+/, '');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(clean) || path.isAbsolute(clean) || /^[a-z]:/i.test(clean)) throw new Error('That path is outside the server folder.');
  const full = path.resolve(base, clean);
  if (!isInside(full, base)) throw new Error('That path is outside the server folder.');
  // Links/junctions inside the folder could point elsewhere; check where the existing part really leads.
  let probe = full;
  while (!existsSync(probe) && probe !== base) probe = path.dirname(probe);
  if (existsSync(probe) && !isInside(realpathSync.native(probe), realpathSync.native(base))) throw new Error('That path is outside the server folder.');
  return full;
}

export function relOf(root: string, full: string) {
  return path.relative(path.resolve(root), full).split(path.sep).join('/');
}

function validName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n || n === '.' || n === '..' || n.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n)) {
    throw new Error('That name is not allowed. Avoid \\ / : * ? " < > | and trailing dots or spaces.');
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) throw new Error('That name is reserved by Windows.');
  return n;
}

const TEXT_EXT = /\.(txt|log|json|json5|jsonc|properties|cfg|conf|config|ini|toml|ya?ml|xml|md|csv|lang|mcmeta|mcfunction|js|ts|sh|bat|cmd|ps1|env|html|css|snbt)$/i;
const BINARY_EXT = /\.(jar|zip|gz|tar|7z|rar|exe|dll|so|png|jpe?g|gif|webp|ogg|mp3|wav|dat|dat_old|mca|mcr|nbt|ldb|db|db2|fwl|mcpack|mcaddon|mcworld|pdb|bin|class)$/i;

/** Text if the extension says so, or (for unknown extensions) if the start of the file has no NUL bytes. */
function looksEditable(full: string, name: string, size: number): boolean {
  if (size > MAX_EDIT_BYTES || BINARY_EXT.test(name)) return false;
  return TEXT_EXT.test(name) || sniffText(full);
}

function sniffText(full: string): boolean {
  try {
    const fd = openSync(full, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return !buf.subarray(0, n).includes(0);
  } catch {
    return false;
  }
}

export function list(root: string, rel: string) {
  const dir = resolveIn(root, rel);
  if (!existsSync(dir)) throw new Error('That folder no longer exists.');
  if (!statSync(dir).isDirectory()) throw new Error('That is not a folder.');
  const entries: FileEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES) break;
    if (!d.isDirectory() && !d.isFile()) continue;
    try {
      const full = path.join(dir, d.name);
      const st = statSync(full);
      const isDir = d.isDirectory();
      entries.push({ name: d.name, type: isDir ? 'dir' : 'file', size: isDir ? null : st.size, modified: st.mtimeMs, editable: !isDir && looksEditable(full, d.name, st.size) });
    } catch {}
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  const path_ = relOf(root, dir);
  return { path: path_, parent: path_ ? relOf(root, path.dirname(dir)) : null, entries };
}

export function readText(root: string, rel: string) {
  const full = resolveIn(root, rel);
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error('That file no longer exists.');
  const st = statSync(full);
  if (st.size > MAX_EDIT_BYTES) throw new Error('That file is too big to edit here (over 5 MB). Download it instead.');
  // Some binary files use text-like names (Bedrock's world database has .log files), so always check the content too.
  if (!looksEditable(full, path.basename(full), st.size) || !sniffText(full)) throw new Error("That isn't a text file. Download it instead.");
  const raw = readFileSync(full);
  const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return { path: relOf(root, full), content: raw.toString('utf-8', bom ? 3 : 0), bom, modified: st.mtimeMs, size: st.size };
}

/** Saves a text file, keeping a one-step backup (<name>.tavernhost-bak) of the previous version. */
export function writeText(root: string, rel: string, content: string, bom: boolean, expectedModified?: number) {
  const full = resolveIn(root, rel);
  if (existsSync(full)) {
    const st = statSync(full);
    if (!st.isFile()) throw new Error('That is a folder.');
    if (expectedModified && Math.abs(st.mtimeMs - expectedModified) > 1) {
      throw new Error('The file changed on disk since you opened it (the server may have rewritten it). Reopen it and make your change again.');
    }
    copyFileSync(full, `${full}.tavernhost-bak`);
  }
  const text = String(content ?? '');
  writeFileSync(full, bom ? '﻿' + text : text);
  return statSync(full).mtimeMs;
}

export function makeDir(root: string, parentRel: string, name: string) {
  const target = path.join(resolveIn(root, parentRel), validName(name));
  resolveIn(root, relOf(root, target));
  if (existsSync(target)) throw new Error('Something with that name already exists.');
  mkdirSync(target);
  return relOf(root, target);
}

export function makeFile(root: string, parentRel: string, name: string) {
  const target = path.join(resolveIn(root, parentRel), validName(name));
  if (existsSync(target)) throw new Error('Something with that name already exists.');
  writeFileSync(target, '');
  return relOf(root, target);
}

export function rename(root: string, rel: string, newName: string) {
  const src = resolveIn(root, rel);
  if (src === path.resolve(root)) throw new Error("The server folder itself can't be renamed here.");
  if (!existsSync(src)) throw new Error('That item no longer exists.');
  const dest = path.join(path.dirname(src), validName(newName));
  if (existsSync(dest) && dest.toLowerCase() !== src.toLowerCase()) throw new Error('Something with that name already exists.');
  renameSync(src, dest);
  return relOf(root, dest);
}

/** Sends a file or folder to the Recycle Bin (network drives have none, so there it is deleted permanently). */
export async function remove(root: string, rel: string) {
  const target = resolveIn(root, rel);
  if (target === path.resolve(root)) throw new Error("The server folder itself can't be deleted here.");
  if (!existsSync(target)) throw new Error('That item no longer exists.');
  if (isLinux) return moveToTrash(target);
  const isDir = statSync(target).isDirectory();
  const script =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}($env:PANEL_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, PANEL_TARGET: target }, windowsHide: true, timeout: 120_000 });
  if (existsSync(target)) throw new Error('Could not delete it (it may be in use by the running server).');
}

/** Moves an uploaded temp file into a folder of the server (replacing a file with the same name). */
export function placeUpload(root: string, dirRel: string, tempFile: string, name: string) {
  const dir = resolveIn(root, dirRel);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('That folder no longer exists.');
  const dest = path.join(dir, validName(name));
  resolveIn(root, relOf(root, dest));
  if (existsSync(dest) && statSync(dest).isDirectory()) throw new Error('A folder with that name already exists.');
  try {
    renameSync(tempFile, dest);
  } catch {
    // Different drive: copy instead.
    copyFileSync(tempFile, dest);
    rmSync(tempFile, { force: true });
  }
  return relOf(root, dest);
}
