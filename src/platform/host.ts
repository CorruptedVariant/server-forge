// What differs between the systems Server Forge runs on, outside of starting and stopping processes (process.ts).
// On Windows everything below keeps to what the panel has always done; these are the Linux answers (SteamOS included:
// its system folders are read-only and it has no package manager to rely on, so nothing here installs system packages).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isLinux = process.platform === 'linux';

/** The Windows or Linux form of a program's file name. */
export const bin = (windows: string, linux: string) => (isLinux ? linux : windows);

/** A folder for "full path" messages and hints. */
export const exampleFolder = (...sub: string[]) => (isLinux ? path.join(os.homedir(), 'GameServers', ...sub) : ['C:\\GameServers', ...sub].join('\\'));

/** Where a per-user file lives when it isn't in the data folder (~/.local/state on Linux). */
export function stateFolder() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'server-forge');
}

// ---------- which Linux ----------

/** "steamos", "ubuntu", "fedora", "arch"...: the distro and what it's based on (ID and ID_LIKE of /etc/os-release). */
export function distroIds(): string[] {
  try {
    const text = readFileSync('/etc/os-release', 'utf-8');
    const value = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?`, 'm').exec(text)?.[1] ?? '';
    return `${value('ID')} ${value('ID_LIKE')}`.toLowerCase().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

export const isSteamOS = () => isLinux && distroIds().includes('steamos');

/** Picks the install command for this distro (null when it isn't one of these, e.g. SteamOS with its read-only system). */
export function packageHint(cmds: { apt?: string; dnf?: string; pacman?: string; zypper?: string }): string | null {
  const ids = distroIds();
  if (ids.includes('steamos')) return null;
  if (ids.some((i) => ['debian', 'ubuntu'].includes(i))) return cmds.apt ?? null;
  if (ids.some((i) => ['fedora', 'rhel', 'centos'].includes(i))) return cmds.dnf ?? null;
  if (ids.includes('arch')) return cmds.pacman ?? null;
  if (ids.some((i) => i.includes('suse'))) return cmds.zypper ?? null;
  return cmds.apt ?? cmds.dnf ?? cmds.pacman ?? cmds.zypper ?? null;
}

/** Whether a program whose command line matches is running (games under Proton show their Windows path there). */
export function linuxProcessRunning(pattern: RegExp): boolean {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (pattern.test(readFileSync(`/proc/${name}/cmdline`, 'latin1').replace(/\0/g, ' '))) return true;
    } catch {}
  }
  return false;
}

// ---------- Wine (servers that only exist for Windows) ----------

export function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      if (statSync(full).isFile()) return full;
    } catch {}
  }
  return null;
}

/** How a Windows program sees a Linux path under Wine (its Z: drive is the whole file system). */
export const winePath = (p: string) => (isLinux && path.isAbsolute(p) ? `Z:${p.replace(/\//g, '\\')}` : p);

export function wineHelp(game: string): string {
  const cmd = packageHint({ apt: 'sudo apt install wine xvfb', dnf: 'sudo dnf install wine xorg-x11-server-Xvfb', pacman: 'sudo pacman -S wine xorg-server-xvfb', zypper: 'sudo zypper install wine xvfb-run' });
  return cmd
    ? `${game}'s server only exists for Windows, so on Linux it runs through Wine, which isn't installed. Install it with: ${cmd}`
    : `${game}'s server only exists for Windows, so on Linux it needs Wine. Server Forge can't run it on this system (SteamOS has no Wine package).`;
}

// ---------- Trash (the freedesktop.org trash folder, the Linux Recycle Bin) ----------

/**
 * Moves a file or folder to the user's Trash. Like Windows' network drives, a drive other than the home folder's has no
 * bin here, so there it's deleted permanently (moving would copy the whole thing across drives).
 */
export function moveToTrash(target: string) {
  const trash = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'Trash');
  const name = path.basename(target);
  let unique = name;
  for (let i = 2; existsSync(path.join(trash, 'files', unique)) || existsSync(path.join(trash, 'info', `${unique}.trashinfo`)); i++) unique = `${name}.${i}`;
  mkdirSync(path.join(trash, 'files'), { recursive: true });
  mkdirSync(path.join(trash, 'info'), { recursive: true });
  const info = path.join(trash, 'info', `${unique}.trashinfo`);
  const when = new Date().toISOString().slice(0, 19);
  writeFileSync(info, `[Trash Info]\nPath=${encodeURI(target).replace(/[?#]/g, encodeURIComponent)}\nDeletionDate=${when}\n`);
  try {
    renameSync(target, path.join(trash, 'files', unique));
  } catch (err) {
    rmSync(info, { force: true });
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    rmSync(target, { recursive: true, force: true });
  }
}
