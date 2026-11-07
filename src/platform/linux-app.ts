// The desktop apps on Linux: installing from an AppImage, and applying updates. An AppImage only exists while it runs
// (it's mounted in a temporary folder), but Server Forge's background service and server runners must outlive the window.
// So an AppImage acts like the Windows setup program: it copies the app to the user's home folder, adds it to the
// applications menu, and starts that copy. This works the same on SteamOS, where only the home folder is writable.
import { spawn, execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findOnPath } from './host.ts';

export interface LinuxAppInfo {
  /** Folder and file name, e.g. "server-forge". */
  slug: string;
  /** Name in menus, e.g. "Server Forge". */
  name: string;
  comment: string;
  version: string;
  icon: string;
}

const shareDir = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const appHome = (slug: string) => path.join(shareDir(), slug);

/** Started from an AppImage: copy it home, unless that's already where this copy runs from. */
export const runningFromAppImage = () => !!process.env.APPIMAGE;

/** What a release should offer this copy: installed from an AppImage, or through the system's package manager. */
export function installKind(execPath: string): 'appimage' | 'deb' | 'rpm' | 'none' {
  if (process.env.APPIMAGE || execPath.startsWith(shareDir() + path.sep)) return 'appimage';
  if (!execPath.startsWith('/opt/')) return 'none';
  return findOnPath('dpkg') ? 'deb' : findOnPath('rpm') ? 'rpm' : 'none';
}

/** The system file name of the installed copy's launcher script (safe to run from menus or Steam). */
function launcher(info: LinuxAppInfo) {
  return path.join(appHome(info.slug), 'run.sh');
}

function writeLauncher(info: LinuxAppInfo, exe: string) {
  const file = launcher(info);
  // Ubuntu 24.04+ blocks the unprivileged sandbox Chromium uses when it isn't installed by a package, and the window
  // would refuse to start. The app only shows its own pages and the mod sites the owner opens.
  writeFileSync(
    file,
    `#!/bin/sh
FLAGS=""
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then FLAGS="--no-sandbox"; fi
exec "${exe}" $FLAGS "$@"
`,
  );
  chmodSync(file, 0o755);
  const iconDir = path.join(shareDir(), 'icons', 'hicolor', '256x256', 'apps');
  mkdirSync(iconDir, { recursive: true });
  copyFileSync(info.icon, path.join(iconDir, `${info.slug}.png`));
  const menu = path.join(shareDir(), 'applications');
  mkdirSync(menu, { recursive: true });
  writeFileSync(
    path.join(menu, `${info.slug}.desktop`),
    `[Desktop Entry]
Type=Application
Name=${info.name}
Comment=${info.comment}
Exec="${file}" %U
Icon=${info.slug}
Terminal=false
Categories=Game;Utility;
StartupWMClass=${info.slug}
`,
  );
  execFile('update-desktop-database', [menu], () => {}); // not every system has it; menus still find the file
}

/** Copies the running AppImage's files into the home folder (one folder per version) and returns the program there. */
export async function installFromAppImage(info: LinuxAppInfo, execPath: string): Promise<string> {
  const root = path.join(appHome(info.slug), 'app');
  const dest = path.join(root, info.version);
  const exe = path.join(dest, path.basename(execPath));
  if (!existsSync(exe)) {
    mkdirSync(root, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    await cp(path.dirname(execPath), tmp, { recursive: true, verbatimSymlinks: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  }
  writeLauncher(info, exe);
  // Older versions: keep the newest other one in case this one has a problem. Runners have their own copy (see instances.ts).
  const old = readdirSync(root).filter((v) => v !== info.version && !/\.tmp-/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of old.slice(0, -1)) rmSync(path.join(root, v), { recursive: true, force: true });
  return launcher(info);
}

/** The environment without what an AppImage's start-up added: it would leak into the service and from there into game servers. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'GSETTINGS_SCHEMA_DIR', 'CHROME_DESKTOP']) delete env[k];
  return env;
}

export function startDetached(file: string, args: string[] = []) {
  spawn(file, args, { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: os.homedir() }).unref();
}

/**
 * Applies a downloaded update once this app has closed. An AppImage installs itself when it starts. A .deb or .rpm goes
 * through pkexec (the system's admin prompt) and starts the app again afterwards.
 */
export function applyUpdate(file: string, pid: number, restart: string) {
  chmodSync(file, 0o755);
  const wait = `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`;
  let run: string;
  if (file.endsWith('.AppImage')) run = 'exec "$0"';
  else {
    const install = file.endsWith('.deb') ? 'dpkg -i' : 'rpm -U --force';
    run = `pkexec sh -c '${install} "$1"' sh "$0"; exec "$1"`;
  }
  spawn('sh', ['-c', `${wait}; ${run}`, file, restart], { detached: true, stdio: 'ignore', env: cleanEnv(), cwd: os.homedir() }).unref();
}
