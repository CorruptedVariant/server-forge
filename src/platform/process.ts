// Starting, stopping and watching game server processes. Windows uses the helper scripts in scripts/; on Linux a program
// is its own process group (so it outlives the panel), a graceful stop is SIGINT, and /proc answers the questions.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, openSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import net from 'node:net';
import { isLinux } from './host.ts';

const execFileAsync = promisify(execFile);
const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

function powershell(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, script), ...args],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
  );
}

/** Quotes one argument the way Windows programs parse their command line. */
export function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg;
  // Backslashes only need doubling when they come before a quote (or the closing quote).
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export interface StartOptions {
  exe: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Linux: append the program's output here instead of dropping it (Wine's errors, for a crash). */
  outputFile?: string;
}

/** Programs keeping `target` (file or folder) busy, e.g. "File Explorer (window open at C:\...)". Best effort. */
export async function findLockers(target: string): Promise<string[]> {
  if (isLinux) return []; // Linux doesn't lock open files, so nothing can be "in the way" of deleting one.
  try {
    const { stdout } = await powershell('find-lockers.ps1', [], { PANEL_TARGET: target });
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, detail] = l.split('|');
        return detail ? `${name} (${detail})` : name;
      });
  } catch {
    return [];
  }
}

/** Programs running from inside `folder` (e.g. a game server another panel started there). Best effort. */
export async function processesRunningFrom(folder: string): Promise<{ pid: number; exe: string }[]> {
  if (isLinux) {
    const root = path.resolve(folder) + path.sep;
    const out: { pid: number; exe: string }[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const exe = readlinkSync(`/proc/${name}/exe`);
        if (exe.startsWith(root)) out.push({ pid: Number(name), exe });
      } catch {} // gone already, or another user's process
    }
    return out;
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$f = [IO.Path]::GetFullPath($env:TH_FOLDER).TrimEnd('\\') + '\\'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($f, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }",
      ],
      { env: { ...process.env, TH_FOLDER: folder }, windowsHide: true, timeout: 20_000 },
    );
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split('|'))
      .filter(([pid, exe]) => Number(pid) > 0 && exe)
      .map(([pid, exe]) => ({ pid: Number(pid), exe }));
  } catch {
    return [];
  }
}

/** Unpacked from a zip or a Steam depot, a game's program can arrive without its "executable" flag (Linux). */
export function makeExecutable(file: string) {
  try {
    if (!(statSync(file).mode & 0o100)) chmodSync(file, 0o755);
  } catch {}
}

/** Starts the program in its own hidden console. Returns its PID. */
export async function startHidden(opts: StartOptions): Promise<number> {
  if (isLinux) {
    makeExecutable(opts.exe);
    return new Promise((resolve, reject) => {
      const out = opts.outputFile ? openSync(opts.outputFile, 'a') : null;
      const child = spawn(opts.exe, opts.args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, detached: true, stdio: out === null ? 'ignore' : ['ignore', out, out] });
      if (out !== null) closeSync(out);
      child.once('error', (err) => reject(new Error(`Could not start ${path.basename(opts.exe)}: ${err.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve(child.pid!);
      });
    });
  }
  const spec = { exe: opts.exe, args: opts.args.map(quoteArg).join(' '), cwd: opts.cwd, env: opts.env ?? {} };
  const { stdout } = await powershell('start-hidden.ps1', [], { PANEL_START: JSON.stringify(spec) });
  const pid = Number(stdout.trim().split(/\s+/).pop());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Could not start ${path.basename(opts.exe)}: ${stdout.trim()}`);
  return pid;
}

export function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The executable name for a PID (e.g. "valheim_server.exe"), or null if it isn't running. Guards against PID reuse. */
export async function processName(pid: number): Promise<string | null> {
  if (isLinux) {
    try {
      return path.basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''));
    } catch {
      try {
        return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim() || null;
      } catch {
        return null;
      }
    }
  }
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
    const m = /^"([^"]+)","(\d+)"/m.exec(stdout);
    return m && Number(m[2]) === pid ? m[1] : null;
  } catch {
    return null;
  }
}

/** Asks the process to exit by sending Ctrl+C to its console. Resolves true if the signal was delivered. */
export async function sendCtrlC(pid: number): Promise<boolean> {
  if (isLinux) {
    // The whole group: under the runner the game is the runner's child, and Ctrl+C on a console reaches both.
    try {
      process.kill(-pid, 'SIGINT');
      return true;
    } catch {
      try {
        process.kill(pid, 'SIGINT');
        return true;
      } catch {
        return false;
      }
    }
  }
  try {
    const { stdout } = await powershell('send-ctrl-c.ps1', ['-ProcessId', String(pid)]);
    return stdout.includes('sent');
  } catch {
    return false;
  }
}

/** Types a line into a process's own console window (servers that ignore piped input, e.g. Terraria). */
export async function sendConsoleInput(pid: number, text: string): Promise<boolean> {
  try {
    const { stdout } = await powershell('send-console-input.ps1', ['-ProcessId', String(pid), '-Text', text]);
    return stdout.includes('sent');
  } catch {
    return false;
  }
}

/** Sends one console command to a server through its runner's named pipe (see runner.ts). */
export function sendPipeCommand(pipe: string, token: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let reply = '';
    const timer = setTimeout(() => socket.destroy(new Error('The server did not respond to the command.')), 5000);
    socket.setEncoding('utf-8');
    socket.on('connect', () => socket.write(JSON.stringify({ token, command }) + '\n'));
    socket.on('data', (chunk: string) => {
      reply += chunk;
      if (!reply.includes('\n')) return;
      clearTimeout(timer);
      socket.end();
      const answer = reply.split('\n')[0].trim();
      if (answer === 'ok') resolve();
      else reject(new Error(answer === 'error not-running' ? 'The server is not running.' : `Command failed (${answer}).`));
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not reach the server's console: ${err.message}`));
    });
  });
}

export async function forceKill(pid: number): Promise<void> {
  if (isLinux) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    return;
  }
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  } catch {}
}

export function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 500);
  });
}
