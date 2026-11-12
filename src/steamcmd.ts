// SteamCMD: Valve's official command-line tool for installing and updating dedicated servers (anonymously, no Steam
// account needed). Server Forge downloads it into its own data folder the first time a Steam game server needs it.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, type Dirent } from 'node:fs';
import { trackDownload } from './platform/mod-downloads.ts';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { dataPath } from './store.ts';
import { downloadFile, extractTar, extractZip, formatBytes } from './download.ts';
import { bin, findOnPath, isContainer, isLinux, packageHint } from './platform/host.ts';
import type { Job } from './jobs.ts';

const STEAMCMD_URL = isLinux ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz' : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
const STATES: Record<string, string> = {
  '0x3': 'Preparing',
  '0x5': 'Checking files',
  '0x11': 'Allocating disk space',
  '0x61': 'Downloading',
  '0x81': 'Finishing up',
};

function steamCmdDir() {
  return dataPath('tools', 'steamcmd');
}

function steamCmdExe() {
  return path.join(steamCmdDir(), bin('steamcmd.exe', 'steamcmd.sh'));
}

/** SteamCMD is a 32-bit program, and most Linux servers don't come with 32-bit system libraries (SteamOS does). */
function steamCmd32BitHelp() {
  const cmd = packageHint({
    apt: 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install lib32gcc-s1 lib32stdc++6',
    dnf: 'sudo dnf install glibc.i686 libstdc++.i686',
    pacman: 'enable the multilib repository in /etc/pacman.conf, then: sudo pacman -Sy lib32-gcc-libs lib32-glibc',
    zypper: 'sudo zypper install glibc-32bit libgcc_s1-32bit libstdc++6-32bit',
  });
  return `SteamCMD (Valve's server installer) is a 32-bit program and needs 32-bit system libraries that aren't on this system.${cmd ? ` Install them with: ${cmd}` : ''}`;
}

/** Steam's API looks for its client library here on Linux (servers like Palworld stop without it). Steam itself makes these. */
function ensureSteamSdk() {
  for (const [sdk, from] of [['sdk64', 'linux64'], ['sdk32', 'linux32']]) {
    const dest = path.join(os.homedir(), '.steam', sdk, 'steamclient.so');
    const src = path.join(steamCmdDir(), from, 'steamclient.so');
    if (existsSync(dest) || !existsSync(src)) continue;
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } catch {}
  }
}

async function ensureSteamCmd(job: Job): Promise<string> {
  if (existsSync(steamCmdExe())) return steamCmdExe();
  if (isLinux && !['/lib/ld-linux.so.2', '/lib32/ld-linux.so.2', '/usr/lib32/ld-linux.so.2'].some((p) => existsSync(p))) throw new Error(steamCmd32BitHelp());
  mkdirSync(steamCmdDir(), { recursive: true });
  const zip = path.join(steamCmdDir(), isLinux ? 'steamcmd.tar.gz' : 'steamcmd.zip');
  job.update("Downloading SteamCMD (Valve's server installer)…", null);
  await downloadFile(STEAMCMD_URL, zip);
  if (isLinux) await extractTar(zip, steamCmdDir());
  else await extractZip(zip, steamCmdDir());
  rmSync(zip, { force: true });
  job.line('SteamCMD downloaded.');
  return steamCmdExe();
}

function runSteamCmd(args: string[], appId: number, job: Job): Promise<{ success: boolean; error: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn(steamCmdExe(), args, { cwd: steamCmdDir(), windowsHide: true });
    let success = false;
    let error: string | null = null;
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const progress = /Update state \((0x[0-9a-f]+)\) [\w ]+, progress: ([\d.]+)/i.exec(line);
        if (progress) {
          job.update(`${STATES[progress[1]] ?? 'Working'}…`, Math.min(100, Number(progress[2])));
          continue; // too noisy for the console
        }
        job.line(line);
        if (/Checking for available updates|Downloading update/i.test(line)) job.update('Updating SteamCMD itself…', null);
        if (new RegExp(`Success! App '${appId}' (fully installed|already up to date)`, 'i').test(line)) success = true;
        const err = /^(ERROR!|Error!|FAILED)\s*(.*)$/i.exec(line);
        if (err) error = err[2] || line;
        if (isLinux && /error while loading shared libraries/i.test(line)) error = steamCmd32BitHelp();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => resolve({ success: false, error: err.message }));
    proc.on('close', (code) => resolve({ success, error: error ?? (success ? null : `SteamCMD exited with code ${code}`) }));
  });
}

/** Total size of a folder (best effort; unreadable entries are skipped). */
function folderSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {}
      }
    }
  }
  return total;
}

/** The Steam build installed in `installDir` (from SteamCMD's app manifest), or null. */
export function installedBuild(appId: number, installDir: string): string | null {
  try {
    const acf = readFileSync(path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf-8');
    return /"buildid"\s+"(\d+)"/.exec(acf)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The newest public Steam build of an app, asked from Steam through SteamCMD (anonymous login). `updated` is when that
 * build went live (ms).
 */
export async function latestBuild(appId: number): Promise<{ build: string; updated: number | null }> {
  const quiet = { update() {}, line() {} } as unknown as Job;
  await ensureSteamCmd(quiet);
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn(steamCmdExe(), ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(appId), '+quit'], { cwd: steamCmdDir(), windowsHide: true });
      let out = '';
      const timer = setTimeout(() => proc.kill(), 120_000);
      proc.stdout.on('data', (d) => (out += d.toString('utf-8')));
      proc.stderr.on('data', (d) => (out += d.toString('utf-8')));
      proc.on('error', (err) => (clearTimeout(timer), reject(err)));
      proc.on('close', () => (clearTimeout(timer), resolve(out)));
    });
  // The "public" branch inside the app's "branches" block.
  const parse = (out: string) => {
    const m = /"branches"\s*\{\s*"public"\s*\{([^}]*)\}/.exec(out);
    const build = m && /"buildid"\s+"(\d+)"/.exec(m[1])?.[1];
    const updated = m && /"timeupdated"\s+"(\d+)"/.exec(m[1])?.[1];
    return build ? { build, updated: updated ? Number(updated) * 1000 : null } : null;
  };
  // SteamCMD sometimes prints stale or no app info on a run where it updated itself first; one retry covers that.
  const found = parse(await run()) ?? parse(await run());
  if (!found) throw new Error("Steam didn't say which version is current (SteamCMD gave no app info). Try again in a minute.");
  return found;
}

// ---------- Steam sign-in, for Workshop downloads ----------
// The password and Steam Guard code are typed into SteamCMD's own window and never reach Server Forge. SteamCMD keeps its
// own saved login in its folder; Server Forge only remembers the account name. Game server installs stay anonymous.

const accountFile = () => dataPath('steam-login.json');

/** The Steam account signed in on this PC, or null. */
export function steamAccount(): string | null {
  try {
    return String(JSON.parse(readFileSync(accountFile(), 'utf-8')).username ?? '') || null;
  } catch {
    return null;
  }
}

function checkAccountName(username: unknown): string {
  const name = String(username ?? '').trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error('Enter your Steam account name: the one you log in with, not your profile name.');
  return name;
}

/** Runs SteamCMD with the saved login, never asking for a password. */
function runSignedIn(username: string, before: string[], after: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(steamCmdExe(), ['+@NoPromptForPassword', '1', ...before, '+login', username, ...after, '+quit'], { cwd: steamCmdDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString('utf-8')));
    proc.stderr.on('data', (d) => (out += d.toString('utf-8')));
    proc.on('error', (err) => (clearTimeout(timer), resolve(`ERROR! ${err.message}`)));
    proc.on('close', () => (clearTimeout(timer), resolve(out)));
  });
}

const loginFailed = (out: string) => /Login Failure|No cached credentials|Cached credentials not found|FAILED \(|password:|Steam Guard/i.test(out);

/** Opens SteamCMD's window on this PC, where the owner signs in. */
export async function openSteamLogin(username: unknown): Promise<void> {
  const name = checkAccountName(username);
  await ensureSteamCmd({ update() {}, line() {} } as unknown as Job);
  if (isLinux) {
    // The first terminal found, with the flag that makes it run a command (SteamOS has konsole).
    const terminals: [string, string[]][] = [['konsole', ['-e']], ['gnome-terminal', ['--']], ['ptyxis', ['--']], ['kgx', ['--']], ['xfce4-terminal', ['-x']], ['x-terminal-emulator', ['-e']], ['kitty', []], ['alacritty', ['-e']], ['xterm', ['-e']]];
    const script = `./steamcmd.sh +login "$1" +quit; echo; echo "Done. Press Enter to close this window, then go back to Server Forge."; read x`;
    const found = terminals.find(([t]) => findOnPath(t));
    if (!found || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) {
      throw new Error(`This system has no terminal window Server Forge can open. Sign in by hand, in a terminal on this system: cd "${steamCmdDir()}" && ./steamcmd.sh +login ${name} +quit`);
    }
    spawn(found[0], [...found[1], 'sh', '-c', script, 'sh', name], { cwd: steamCmdDir(), detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('cmd.exe', ['/c', `start "Server Forge - Steam sign-in" cmd /c "steamcmd.exe +login ${name} +quit & echo. & echo Done. Press a key to close this window, then go back to Server Forge. & pause >nul"`], {
    cwd: steamCmdDir(),
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
}

/** Checks that SteamCMD's saved login works, and remembers the account if it does. */
export async function confirmSteamLogin(username: unknown): Promise<string> {
  const name = checkAccountName(username);
  await ensureSteamCmd({ update() {}, line() {} } as unknown as Job);
  const out = await runSignedIn(name, [], [], 120_000);
  if (loginFailed(out) || !/Waiting for user info.*OK|Logging in user.*OK/is.test(out)) {
    throw new Error(`Steam isn't signed in as ${name} yet. Finish signing in in the SteamCMD window, close it, and try again.`);
  }
  writeFileSync(accountFile(), JSON.stringify({ username: name }));
  return name;
}

/** No SteamCMD window can open here (the container has no screen or terminal), so the panel's own form signs in. */
export const steamLoginInPanel = () => isContainer;

/**
 * Signs in from the panel's form where there's no SteamCMD window. The password and Steam Guard code are handed to
 * SteamCMD once and never stored; SteamCMD then keeps its own saved login, as it does after signing in in its window.
 */
export async function steamLoginWithPassword(username: unknown, password: unknown, code: unknown): Promise<string> {
  const name = checkAccountName(username);
  const pass = String(password ?? '');
  const guard = String(code ?? '').trim();
  if (!pass) throw new Error('Enter your Steam password.');
  if (guard && !/^[A-Za-z0-9]{5}$/.test(guard)) throw new Error('A Steam Guard code is 5 letters and numbers.');
  await ensureSteamCmd({ update() {}, line() {} } as unknown as Job);
  // Up to 3 minutes: with the Steam app's Steam Guard, SteamCMD waits while the owner approves the sign-in on their phone.
  const out = await new Promise<string>((resolve) => {
    const proc = spawn(steamCmdExe(), ['+@NoPromptForPassword', '1', '+login', name, pass, ...(guard ? [guard] : []), '+quit'], { cwd: steamCmdDir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    const timer = setTimeout(() => proc.kill(), 180_000);
    proc.stdout.on('data', (d) => (text += d.toString('utf-8')));
    proc.stderr.on('data', (d) => (text += d.toString('utf-8')));
    proc.on('error', (err) => (clearTimeout(timer), resolve(`ERROR! ${err.message}`)));
    proc.on('close', () => (clearTimeout(timer), resolve(text.split(pass).join('***'))));
  });
  if (/Waiting for user info.*OK|Logging in user.*OK/is.test(out) && !/FAILED/i.test(out)) {
    writeFileSync(accountFile(), JSON.stringify({ username: name }));
    return name;
  }
  if (/Invalid ?Password/i.test(out)) throw new Error('Steam says the account name or password is wrong.');
  if (/Rate ?Limit/i.test(out)) throw new Error('Steam is refusing sign-ins for a while after too many tries. Wait about an hour and try again.');
  if (/Steam Guard|Two-factor|TwoFactor|AuthCode|Logon ?Denied/i.test(out)) {
    throw new Error(guard
      ? "Steam didn't accept that Steam Guard code. Codes change every 30 seconds (Steam app) or come by email: enter the newest one and sign in again."
      : 'Steam wants a Steam Guard code: enter the code from your Steam app or email, and sign in again. If the Steam app asks you to approve the sign-in instead, approve it while Server Forge waits.');
  }
  const failed = /FAILED[^\n]*|ERROR![^\n]*/i.exec(out)?.[0];
  throw new Error(`Steam sign-in didn't finish${failed ? `: ${failed.trim()}` : ' (no answer from Steam within 3 minutes).'}`);
}

/** Forgets the account and removes SteamCMD's saved login from this PC. */
export function steamSignOut() {
  rmSync(accountFile(), { force: true });
  rmSync(path.join(steamCmdDir(), 'config', 'config.vdf'), { force: true });
  try {
    for (const f of readdirSync(steamCmdDir())) if (/^ssfn/i.test(f)) rmSync(path.join(steamCmdDir(), f), { force: true });
  } catch {}
}

/**
 * Downloads a Workshop item into a new temporary folder with the signed-in account, which must own the game. Returns the
 * item's folder; the caller deletes `root` when done.
 */
export async function workshopDownload(appId: number, itemId: string, game: string): Promise<{ root: string; dir: string }> {
  const tracked = trackDownload('Steam Workshop item');
  try {
    const out = await workshopDownloadTracked(appId, itemId, game);
    tracked.done();
    return out;
  } catch (err) {
    tracked.failed();
    throw err;
  }
}

async function workshopDownloadTracked(appId: number, itemId: string, game: string): Promise<{ root: string; dir: string }> {
  const username = steamAccount();
  if (!username) throw new Error(`Sign in to Steam first, with an account that owns ${game} (Steam Workshop, on this tab).`);
  await ensureSteamCmd({ update() {}, line() {} } as unknown as Job);
  const root = mkdtempSync(path.join(os.tmpdir(), 'sf-workshop-'));
  try {
    const run = () => runSignedIn(username, ['+force_install_dir', root], ['+workshop_download_item', String(appId), itemId], 30 * 60_000);
    // On its very first run SteamCMD updates itself and sometimes exits before doing the job; one retry covers that.
    let out = await run();
    if (!/Success\. Downloaded item/i.test(out)) out = await run();
    if (!/Success\. Downloaded item/i.test(out)) {
      if (loginFailed(out)) {
        rmSync(accountFile(), { force: true });
        throw new Error(`Steam's sign-in for ${username} has run out. Sign in again (Steam Workshop, on this tab).`);
      }
      const why = /ERROR! Download item \d+ failed \(([^)]*)\)/i.exec(out)?.[1];
      throw new Error(`Steam wouldn't download Workshop item ${itemId}${why ? ` (${why})` : ''}. Check that ${username} owns ${game}.`);
    }
    return { root, dir: path.join(root, 'steamapps', 'workshop', 'content', String(appId), itemId) };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Installs or updates a Steam dedicated server into `installDir` (validating files). */
export async function steamAppUpdate(appId: number, installDir: string, job: Job, opts: { windowsBuild?: boolean } = {}): Promise<void> {
  await ensureSteamCmd(job);
  mkdirSync(installDir, { recursive: true });
  // force_install_dir must come before login. A server that only exists for Windows has to be asked for by platform on Linux.
  const platform = isLinux && opts.windowsBuild ? ['+@sSteamCmdForcePlatformType', 'windows'] : [];
  const args = [...platform, '+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(appId), 'validate', '+quit'];
  job.update('Connecting to Steam…', null);

  // SteamCMD holds back its progress output when it isn't writing to a real console, so show how much has
  // arrived in the folder instead.
  const startSize = folderSize(installDir);
  const watcher = setInterval(() => {
    const grown = folderSize(installDir) - startSize;
    if (grown > 1024 * 1024) job.update(`Downloading from Steam… ${formatBytes(grown)} so far`, null);
  }, 2000);
  try {
    let result = await runSteamCmd(args, appId, job);
    if (!result.success) {
      // On its very first run SteamCMD updates itself and sometimes exits before doing the job; one retry covers that.
      job.line('Retrying once…');
      result = await runSteamCmd(args, appId, job);
    }
    if (!result.success) throw new Error(result.error ?? 'SteamCMD did not finish the install.');
    if (isLinux) ensureSteamSdk();
  } finally {
    clearInterval(watcher);
  }
}
