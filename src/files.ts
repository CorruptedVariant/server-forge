// A small file browser for picking server folders: list, create, rename and delete folders.
// Deleting goes to the Recycle Bin, and dangerous locations are refused outright.
import { readdirSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { rootDir } from './store.ts';
import { findLockers } from './platform/process.ts';
import { exampleFolder, isLinux, moveToTrash } from './platform/host.ts';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 2000;

export interface Entry {
  name: string;
  type: 'dir' | 'file';
  size: number | null;
  modified: number | null;
}

function resolveAbsolute(p: string): string {
  const raw = String(p ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error(`A full path is required, e.g. ${exampleFolder()}`);
  return path.resolve(raw);
}

function validName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n || n === '.' || n === '..' || n.length > 255 || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n)) {
    throw new Error('That name is not allowed. Avoid \\ / : * ? " < > | and trailing dots or spaces.');
  }
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) throw new Error('That name is reserved by Windows.');
  return n;
}

function drives(): Entry[] {
  const list: Entry[] = [];
  if (isLinux) {
    // The places worth starting from: home, the whole system, and removable or extra drives (SteamOS mounts SD cards in /run/media).
    const add = (p: string) => {
      if (existsSync(p) && !list.some((e) => e.name === p)) list.push({ name: p, type: 'dir', size: null, modified: null });
    };
    add(os.homedir());
    add('/');
    for (const base of ['/mnt', '/media', `/media/${os.userInfo().username}`, '/run/media', `/run/media/${os.userInfo().username}`]) {
      try {
        for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory() && d.name !== os.userInfo().username && !/^wsl|^wslg$/.test(d.name)) add(path.join(base, d.name));
      } catch {}
    }
    return list;
  }
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) list.push({ name: root, type: 'dir', size: null, modified: null });
  }
  return list;
}

/** Lists a folder (folders first). An empty path lists the drives. */
export function listDir(p: string) {
  if (!p) return { path: '', parent: null, entries: drives() };
  const dir = resolveAbsolute(p);
  if (!statSync(dir).isDirectory()) throw new Error('That is not a folder.');
  const entries: Entry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (entries.length >= MAX_ENTRIES) break;
    if (!d.isDirectory() && !d.isFile()) continue;
    let size: number | null = null;
    let modified: number | null = null;
    try {
      const st = statSync(path.join(dir, d.name));
      size = d.isFile() ? st.size : null;
      modified = st.mtimeMs;
    } catch {
      continue; // e.g. system files we're not allowed to read
    }
    entries.push({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, modified });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? '' : parent, entries };
}

export function makeDir(parent: string, name: string): string {
  const target = path.join(resolveAbsolute(parent), validName(name));
  if (existsSync(target)) throw new Error('Something with that name already exists.');
  mkdirSync(target);
  return target;
}

// ---------- safety ----------

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const SYSTEM_DIRS = (isLinux ? ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/run/current-system', '/sbin', '/sys', '/usr', '/var'] : [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData])
  .filter((d): d is string => !!d)
  .map((d) => path.resolve(d));
const USERS_DIR = isLinux ? path.dirname(os.homedir()) : path.resolve(process.env.SystemDrive ? `${process.env.SystemDrive}\\Users` : 'C:\\Users');

/**
 * Throws if changing/deleting `target` is too dangerous: drive roots, system folders, user profile roots,
 * the panel itself, or anything a running server is using (`inUse`).
 */
export function assertModifiable(target: string, inUse: string[]): void {
  if (path.parse(target).root.toLowerCase() === target.toLowerCase()) throw new Error('Drive roots cannot be changed here.');
  for (const sys of SYSTEM_DIRS) if (isInside(target, sys)) throw new Error('System folders cannot be changed here.');
  if (target.toLowerCase() === USERS_DIR.toLowerCase() || path.dirname(target).toLowerCase() === USERS_DIR.toLowerCase()) {
    throw new Error('User profile folders cannot be changed here.');
  }
  if (isInside(rootDir, target) || isInside(target, rootDir)) throw new Error('The panel\'s own folder cannot be changed here.');
  for (const dir of inUse) {
    if (isInside(dir, target) || isInside(target, dir)) throw new Error('A running server is using this folder. Stop it first.');
  }
}

export function renameEntry(p: string, newName: string, inUse: string[]): string {
  const src = resolveAbsolute(p);
  if (!existsSync(src)) throw new Error('That item no longer exists.');
  assertModifiable(src, inUse);
  const dest = path.join(path.dirname(src), validName(newName));
  if (existsSync(dest)) throw new Error('Something with that name already exists.');
  renameSync(src, dest);
  return dest;
}

/** Sends a file or folder to the Recycle Bin (network drives have none, so there it is deleted permanently). */
export async function deleteEntry(p: string, inUse: string[]): Promise<void> {
  const target = resolveAbsolute(p);
  if (!existsSync(target)) throw new Error('That item no longer exists.');
  assertModifiable(target, inUse);
  await recycle(target);
}

/** Sends `target` to the Recycle Bin with no safety checks (callers check first). */
export async function recycle(target: string): Promise<void> {
  if (isLinux) return moveToTrash(target);
  const isDir = statSync(target).isDirectory();
  const script =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}($env:PANEL_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  let failure = '';
  try {
    // The path goes through an environment variable, so it can never be interpreted as PowerShell code.
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PANEL_TARGET: target },
      windowsHide: true,
      timeout: 120_000,
    });
  } catch (err) {
    failure = String((err as { stderr?: string }).stderr || (err as Error).message);
  }
  if (!existsSync(target)) return;
  // Say what's in the way instead of dumping the PowerShell error.
  // (Windows words "in use" several ways, e.g. "being used by another process" or "system call level is not correct".)
  const what = isDir ? 'the folder' : 'the file';
  const lockers = await findLockers(target);
  if (lockers.length) {
    throw new Error(`Couldn't delete ${what} because it's open in: ${lockers.join('; ')}. Close ${lockers.length === 1 ? 'it' : 'them'} and try again.`);
  }
  if (/access.*denied|unauthorized/i.test(failure)) throw new Error(`Couldn't delete ${what}: Windows denied access (it may be read-only or need administrator rights).`);
  const reason = failure.match(/"([^"]+)"\s*$/m)?.[1] ?? failure.split(/\r?\n/).find((l) => /exception|error/i.test(l))?.trim() ?? 'unknown error';
  throw new Error(`Couldn't delete ${what} (${reason}). A program may be using it, such as a File Explorer window, an editor or a terminal open there. Close it and try again.`);
}
