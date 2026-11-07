// Runs and watches game servers. Each server runs in its own hidden console, independent of the panel, so the
// panel can restart or update without stopping games; on startup it re-attaches to servers that are still running.
import { events } from './events.ts';
import { bin, exampleFolder, findOnPath, isLinux, stateFolder, wineHelp } from './platform/host.ts';
import { runningJob, startJob, jobsFor } from './jobs.ts';
import { readlinkSync, existsSync, renameSync, statSync, openSync, readSync, closeSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, rmSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { readJson, writeJson, dataPath, dataDir, isDev, rootDir } from './store.ts';
import { type StartOptions, makeExecutable, startHidden, isAlive, processName, sendCtrlC, sendConsoleInput, forceKill, waitForExit, sendPipeCommand, processesRunningFrom } from './platform/process.ts';
import { quickCheckDb } from './leveldb.ts';
import type { GameModule, LogParser, ServerRecord, Settings } from './games/types.ts';
import { valheim } from './games/valheim.ts';
import { bedrock } from './games/bedrock.ts';
import { java } from './games/java.ts';
import { terraria } from './games/terraria.ts';
import { terrariaVanilla } from './games/terraria-vanilla.ts';
import { satisfactory } from './games/satisfactory.ts';
import { spaceEngineers } from './games/spaceengineers.ts';
import { factorio } from './games/factorio.ts';
import { palworld } from './games/palworld.ts';
import { enshrouded } from './games/enshrouded.ts';
import { vrising } from './games/vrising.ts';
import { zomboid } from './games/zomboid.ts';
import { sevenDays } from './games/sevendays.ts';
import { listProxyServers } from './games/bungee-network.ts';
import { setStatsSource, forgetStats } from './stats.ts';
import { parseChatLine, recordChat } from './chat.ts';
import { syncPlayers, forgetPlayers, mutedPlayers } from './players.ts';
import { createBackup, restoreBackup, pruneScheduled, listBackups, backupsFolder, resumeCutOffBackup, type BackupKind, type BackupTarget } from './backups.ts';
import { assertModifiable, recycle } from './files.ts';

// "terraria" is Terraria with tModLoader (its id from before vanilla existed); "terraria-vanilla" is the official server.
export const GAMES: Record<string, GameModule> = { bedrock, java, valheim, 'terraria-vanilla': terrariaVanilla, terraria, satisfactory, spaceengineers: spaceEngineers, factorio, palworld, enshrouded, vrising, zomboid, sevendays: sevenDays };

// runner.ts in development, runner.js in the installed (compiled) app: same folder and extension as this file.
const thisFile = fileURLToPath(import.meta.url);
const RUNNER_SCRIPT = path.join(path.dirname(thisFile), `runner${path.extname(thisFile)}`);

/** A Windows-only server under Wine, with its own Wine folder inside the server folder. Xvfb stands in for a screen when there's none. */
function throughWine(launch: StartOptions, game: string, installDir: string): StartOptions {
  const wine = findOnPath('wine');
  if (!wine) throw new Error(wineHelp(game));
  const env = { ...launch.env, WINEPREFIX: path.join(installDir, '.wine'), WINEDEBUG: '-all', WINEARCH: 'win64', WINEDLLOVERRIDES: 'mscoree,mshtml=' };
  const xvfb = findOnPath('xvfb-run');
  return xvfb ? { ...launch, exe: xvfb, args: ['-a', wine, launch.exe, ...launch.args], env } : { ...launch, exe: wine, args: [launch.exe, ...launch.args], env };
}

// ---------- the runner's own copy of the runtime (installed app) ----------
// Runners keep running for as long as their game server does. If they ran Tavern Host.exe from the install folder,
// that file would be locked and an update couldn't replace it (and the installer used to close them, stopping the
// servers). So the installed app gives runners a copy of what Node mode needs, in the data folder, one per version,
// under a different name ("Tavern Host Runner.exe"). Updates then never touch a running server.

const RUNNER_EXE = bin('Tavern Host Runner.exe', 'server-forge-runner');
const RUNTIME_FILES = isLinux ? ['libffmpeg.so', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'] : ['ffmpeg.dll', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin'];
const PANEL_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf-8')).version;
  } catch {
    return 'dev';
  }
})();

/** Linux doesn't stop you deleting a running program, so check that no runner still runs from this copy. */
function runtimeInUse(dir: string) {
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readlinkSync(`/proc/${name}/exe`).startsWith(dir + path.sep)) return true;
    } catch {}
  }
  return false;
}

function runnerRuntime(): { exe: string; script: string } {
  // Development runs on plain Node, which isn't in any install folder.
  if (!process.versions.electron) return { exe: process.execPath, script: RUNNER_SCRIPT };
  const dir = dataPath('runtime', PANEL_VERSION);
  const exe = path.join(dir, RUNNER_EXE);
  const script = path.join(dir, 'runner.js');
  if (!existsSync(exe) || !existsSync(script)) {
    const tmp = `${dir}.tmp-${process.pid}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const src = path.dirname(process.execPath);
    copyFileSync(process.execPath, path.join(tmp, RUNNER_EXE));
    for (const f of RUNTIME_FILES) if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(tmp, f));
    copyFileSync(RUNNER_SCRIPT, path.join(tmp, 'runner.js'));
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  }
  // Old versions' copies: remove the ones no runner uses any more (a copy in use can't be deleted, so it stays).
  try {
    for (const v of readdirSync(dataPath('runtime'))) {
      if (v === PANEL_VERSION) continue;
      if (isLinux && runtimeInUse(dataPath('runtime', v))) continue;
      rmSync(dataPath('runtime', v), { recursive: true, force: true, maxRetries: 0 });
    }
  } catch {}
  return { exe, script };
}

/** 'installing' is reported while an install/update job runs (it isn't stored on the instance). */
export type Status = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed' | 'installing';

// eslint-disable-next-line no-control-regex
const ANSI_CODES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SERVERS_FILE = 'servers.json';
const RUNTIME_FILE = 'runtime.json'; // PIDs of running servers, so we can re-attach after a panel restart
const CONSOLE_LINES = 2000;
const STOP_TIMEOUT_MS = 90_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const MAX_CRASH_RESTARTS = 3;

export { events };

function now() {
  return Date.now();
}

/** The system's main LAN IPv4 address (private ranges first), or 127.0.0.1. */
export function lanAddress(): string {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .filter((a) => !a.startsWith('169.254.'));
  return all.find((a) => /^192\.168\./.test(a)) ?? all.find((a) => /^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(a)) ?? all[0] ?? '127.0.0.1';
}

class ServerInstance {
  record: ServerRecord;
  module: GameModule;
  status: Status = 'stopped';
  pid: number | null = null;
  startedAt: number | null = null;
  lastError: string | null = null;
  console: string[] = [];
  private parser: LogParser;
  private logOffset = 0;
  private partial = '';
  private crashTimes: number[] = [];
  private tailTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private readinessProbe = false;
  private nextReadinessProbe = 0;
  /** Runner command pipe and its secret (games with `commands` only). */
  pipe: string | null = null;
  token: string | null = null;

  constructor(record: ServerRecord) {
    this.record = record;
    this.module = GAMES[record.game];
    this.parser = this.module.createParser();
  }

  get logFile() {
    // Games whose console output can't be captured (Terraria) write their own log; read that one.
    return this.module.gameLog ? this.module.gameLog(this.record) : dataPath('servers', this.record.id, 'server.log');
  }

  /** The server reads typed commands: through the runner's pipe, or typed into its own console. */
  get takesCommands() {
    return !!(this.module.commands || this.module.consoleCommands || this.module.runCommand);
  }

  /** Games that can't be messaged in chat are left out of countdown warnings (announce needs a "say" command). */
  get canAnnounce() {
    return !!(this.module.commands || this.module.consoleCommands || this.module.say);
  }

  private setStatus(status: Status, error: string | null = this.lastError) {
    this.status = status;
    this.lastError = error;
    // Nobody is online on a stopped server (closes any open play sessions).
    if (status === 'stopped' || status === 'crashed') {
      syncPlayers(this.id, []);
      this.clearLock();
    }
    saveRuntime();
    events.emit('state', this.id);
  }

  get id() {
    return this.record.id;
  }

  private note(message: string) {
    this.pushLine(`[panel] ${message}`);
  }

  private pushLine(line: string) {
    this.console.push(line);
    if (this.console.length > CONSOLE_LINES) this.console.splice(0, this.console.length - CONSOLE_LINES);
    events.emit('line', this.id, line);
    for (const listener of [...this.lineListeners]) listener(line);
  }

  private lineListeners = new Set<(line: string) => void>();

  /**
   * Resolves with the next console line matching `pattern`, plus the `following` lines after it (registered now, so
   * send the command after calling this). Rejects after `timeoutMs`.
   */
  waitForLine(pattern: RegExp, timeoutMs: number, following = 0): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const captured: string[] = [];
      const listener = (line: string) => {
        if (captured.length === 0 && !pattern.test(line)) return;
        captured.push(line);
        if (captured.length > following) finish();
      };
      const timer = setTimeout(() => finish(new Error('Timed out waiting for the server to answer.')), timeoutMs);
      const finish = (err?: Error) => {
        clearTimeout(timer);
        this.lineListeners.delete(listener);
        if (err) reject(err);
        else resolve(captured);
      };
      this.lineListeners.add(listener);
    });
  }

  /** Console helpers handed to game modules for things like safe backups. */
  consoleIO() {
    return {
      command: (cmd: string) => this.sendCommand(cmd),
      waitForLine: (pattern: RegExp, timeoutMs: number, following = 0) => this.waitForLine(pattern, timeoutMs, following),
      // The log is read once a second; make sure pending output has been processed.
      flush: () => {
        try {
          this.readLog();
        } catch {}
      },
    };
  }

  get isRunning() {
    return !!this.pid && isAlive(this.pid) && (this.status === 'running' || this.status === 'starting');
  }

  // ---------- Log tailing ----------

  private resetLog() {
    this.parser = this.module.createParser();
    this.logOffset = 0;
    this.partial = '';
  }

  private readLog() {
    if (!existsSync(this.logFile)) return;
    const size = statSync(this.logFile).size;
    if (size < this.logOffset) this.resetLog(); // file was recreated
    if (size === this.logOffset) return;

    const fd = openSync(this.logFile, 'r');
    try {
      const buf = Buffer.alloc(size - this.logOffset);
      readSync(fd, buf, 0, buf.length, this.logOffset);
      this.logOffset = size;
      const lines = (this.partial + buf.toString('utf-8')).split(/\r?\n/);
      this.partial = lines.pop() ?? '';
      for (const raw of lines) {
        // Some servers (Sponge, BungeeCord) colour their output with terminal escape codes; show plain text.
        const line = raw.replace(ANSI_CODES, '');
        // Chat from the Bedrock relay pack: save it, and show it in the console as a readable line.
        const chat = parseChatLine(line);
        if (chat) {
          recordChat(this.id, chat);
          this.pushLine(`[Chat] <${chat.name}> ${chat.text}`);
          continue;
        }
        this.parser.feed(line);
        if (line.trim() && !this.module.hideLine?.(line)) this.pushLine(line);
      }
      if (this.parser.state().ready && this.status === 'starting') {
        this.note('Server is ready for players.');
        this.setStatus('running', null);
        this.sendMutes().catch(() => {});
        this.module.onReady?.(this.record, (m) => this.note(m)).catch((err) => this.note(`Setup after start failed: ${(err as Error).message}`));
      } else {
        events.emit('state', this.id);
      }
      syncPlayers(this.id, this.parser.state().players);
    } finally {
      closeSync(fd);
    }
  }

  private startWatching() {
    this.stopWatching();
    this.tailTimer = setInterval(() => {
      try {
        this.readLog();
      } catch {}
      this.checkAlive();
      void this.checkReadiness();
    }, 1000);
  }

  private async checkReadiness() {
    if (this.status !== 'starting' || !this.pid || !this.module.probeReady || this.readinessProbe || Date.now() < this.nextReadinessProbe) return;
    const pid = this.pid;
    const startedAt = this.startedAt;
    this.readinessProbe = true;
    this.nextReadinessProbe = Date.now() + 5000;
    try {
      const ready = await this.module.probeReady(this.record);
      // A stop or restart can happen while the request is in flight.
      if (ready && this.pid === pid && this.startedAt === startedAt && this.status === 'starting' && isAlive(pid)) {
        this.parser.state().ready = true;
        this.note('Server is ready for players (confirmed by its API).');
        this.setStatus('running', null);
        this.sendMutes().catch(() => {});
        this.module.onReady?.(this.record, (m) => this.note(m)).catch((err) => this.note(`Setup after start failed: ${(err as Error).message}`));
      }
    } catch {
      // An unavailable API is normal during startup; keep waiting for it or the log.
    } finally {
      this.readinessProbe = false;
    }
  }

  private stopWatching() {
    if (this.tailTimer) clearInterval(this.tailTimer);
    this.tailTimer = null;
  }

  private checkAlive() {
    if (!this.pid || isAlive(this.pid)) return;
    if (this.status === 'stopping') return; // stop() handles it
    const startedAt = this.startedAt;
    this.pid = null;
    this.startedAt = null;
    this.stopWatching();
    try {
      this.readLog();
    } catch {}
    this.note('Server process exited unexpectedly.');
    // Games with a crash checker: work out why before anything restarts it.
    if (this.module.diagnose) {
      try {
        this.diagnosis = this.module.diagnose(this.record, this.logFile, (startedAt ?? Date.now() - 3600_000) - 60_000) as typeof this.diagnosis;
        const errors = this.diagnosis?.findings?.filter((f) => f.severity === 'error') ?? [];
        this.note(errors.length ? `Crash check: ${errors.map((f) => f.title).join('; ')}. See Overview for details and fixes.` : 'Crash check found no known cause; see Overview.');
      } catch {}
    }
    this.setStatus('crashed', 'The server stopped without being asked to.');
    events.emit('force-stopped', this.id);
    this.maybeAutoRestart();
  }

  /** Latest crash check (kept until the next start). */
  diagnosis: { at: number; findings: { severity: string; title: string }[] } | null = null;

  clearDiagnosis() {
    this.diagnosis = null;
    events.emit('state', this.id);
  }

  /** Runs the crash checker now, on the logs since the last start (or the last hour). */
  diagnoseNow() {
    if (!this.module.diagnose) throw new Error(`${this.module.name} servers don't have a crash checker yet.`);
    this.diagnosis = this.module.diagnose(this.record, this.logFile, (this.startedAt ?? Date.now() - 3600_000) - 60_000) as typeof this.diagnosis;
    events.emit('state', this.id);
    return this.diagnosis;
  }

  private maybeAutoRestart() {
    if (!this.record.autoRestart) return;
    this.crashTimes = [...this.crashTimes.filter((t) => now() - t < CRASH_WINDOW_MS), now()];
    if (this.crashTimes.length > MAX_CRASH_RESTARTS) {
      this.note(`Crashed ${this.crashTimes.length} times in 10 minutes; not restarting automatically. Check the console for errors.`);
      return;
    }
    this.note('Restarting automatically in 10 seconds...');
    setTimeout(() => {
      if (this.status === 'crashed') this.start().catch((err) => this.note(`Automatic restart failed: ${err.message}`));
    }, 10_000);
  }

  // ---------- Ownership lock ----------
  // Several Server Forges can run on one system (installed, portable, development) and could list the same server folder.
  // Whoever starts a server writes this file into its folder; the others refuse to start or update it while that
  // server process is alive, so a test panel can never double-start or overwrite a live server.

  private get lockFile() {
    return path.join(this.record.installDir, '.tavernhost-owner.json');
  }

  /** Throws if another Server Forge lists this server's folder, or (different data folder) is running it right now. */
  assertNotOwnedElsewhere() {
    assertFolderFree(this.record.installDir);
    let lock: { dataDir?: string; pid?: number; panel?: string } | null = null;
    try {
      lock = JSON.parse(readFileSync(this.lockFile, 'utf-8').replace(/^﻿/, ''));
    } catch {
      return;
    }
    if (!lock?.pid || !lock.dataDir || path.resolve(lock.dataDir).toLowerCase() === path.resolve(dataDir).toLowerCase()) return;
    if (!isAlive(lock.pid)) return;
    throw new Error(`This server folder is being run by another Server Forge (${lock.panel ?? 'unknown'} panel, PID ${lock.pid}). Stop it there first.`);
  }

  /** Clears the lock once our server has stopped (only if it's ours). */
  private clearLock() {
    try {
      const lock = JSON.parse(readFileSync(this.lockFile, 'utf-8').replace(/^﻿/, ''));
      if (path.resolve(lock.dataDir ?? '').toLowerCase() === path.resolve(dataDir).toLowerCase()) unlinkSync(this.lockFile);
    } catch {}
  }

  private writeLock() {
    try {
      writeFileSync(this.lockFile, JSON.stringify({ dataDir, pid: this.pid, panel: isDev ? 'development' : 'release', startedAt: this.startedAt }, null, 2));
    } catch {}
  }

  // ---------- Control ----------

  /**
   * Checks before the world is opened: nothing else is running from this server's folder (e.g. the same server
   * started by another panel: two programs writing one world is a known way to lose parts of it), and the world's
   * database has every file it lists (Bedrock). Throws with the reason; `start({ force: true })` skips this.
   */
  async preStartCheck() {
    const others = (await processesRunningFrom(this.record.installDir)).filter((p) => p.pid !== this.pid);
    if (others.length) {
      const list = others.map((p) => `${path.basename(p.exe)} (PID ${p.pid})`).join(', ');
      throw new Error(`${list} is already running from this server's folder, probably this server started by another program (MCSS, another panel). Two programs using one world at the same time can destroy parts of it. Close it there first.`);
    }
    const world = this.record.game === 'bedrock' ? this.module.backup?.sources(this.record).world : null;
    if (world) {
      const q = quickCheckDb(path.join(this.record.installDir, 'worlds', world, 'db'));
      if (!q.ok) throw new Error(`World check: ${q.problems.join(' ')} Starting it now could make the game discard more of the world. Restore a backup (or repair the world) first.`);
    }
  }

  async start(opts: { force?: boolean } = {}) {
    if (this.busy) throw new Error('Another action is in progress.');
    if (runningJob(this.id)) throw new Error('Wait for the install or update to finish.');
    if (this.pid && isAlive(this.pid)) throw new Error('Server is already running.');
    this.assertNotOwnedElsewhere();
    if (!opts.force) {
      try {
        await this.preStartCheck();
      } catch (err) {
        this.note(`Not started: ${(err as Error).message}`);
        this.setStatus('stopped', (err as Error).message);
        events.emit('start-blocked', { serverId: this.id, reason: (err as Error).message });
        throw err;
      }
    }
    this.busy = true;
    try {
      this.module.checkInstall(this.record.installDir);
      mkdirSync(dataPath('servers', this.id), { recursive: true });
      // Keep the previous run's log for troubleshooting (a game's own log is the game's to manage: see its prepare()).
      if (!this.module.gameLog && existsSync(this.logFile)) renameSync(this.logFile, this.logFile.replace(/\.log$/, '.previous.log'));
      this.resetLog();
      this.console = [];
      this.setStatus('starting', null);
      this.note(`Starting ${this.module.name} server...`);
      if (this.module.prepare) await this.module.prepare(this.record, (msg) => this.note(msg));
      let launch = this.module.launch(this.record, this.logFile);
      if (isLinux && this.module.linux === 'unavailable') throw new Error(`${this.module.name} servers can't run on Linux.`);
      if (isLinux) makeExecutable(launch.exe);
      if (isLinux && this.module.linux === 'wine') launch = throughWine(launch, this.module.name, this.record.installDir);
      // On Linux, games that take typed commands read them from the runner's pipe (there's no console window to type into).
      if (this.module.commands || this.module.captureOutput || (isLinux && this.module.consoleCommands)) {
        // Games that read typed commands run under the runner, which owns their console (see runner.ts); so do games
        // whose output only goes to their console (captureOutput: the runner writes it to the log).
        const pipeName = `tavernhost-${this.id}-${randomBytes(6).toString('hex')}`;
        this.pipe = isLinux ? path.join(os.tmpdir(), `${pipeName}.sock`) : `\\\\.\\pipe\\${pipeName}`;
        this.token = randomBytes(24).toString('hex');
        // A game keeping its own log (tModLoader, on Linux here for typed commands) needs that file left alone.
        const runnerLog = isLinux && this.module.consoleCommands ? dataPath('servers', this.id, 'runner.log') : this.logFile;
        const spec = { ...launch, logFile: runnerLog, pipe: this.pipe, token: this.token };
        const runner = runnerRuntime();
        this.pid = await startHidden({
          exe: runner.exe,
          args: [runner.script],
          cwd: launch.cwd,
          env: { TH_RUNNER_SPEC: JSON.stringify(spec), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        });
      } else {
        this.pipe = null;
        this.token = null;
        this.pid = await startHidden(launch);
      }
      this.startedAt = now();
      this.note(`Process started (PID ${this.pid}).`);
      this.writeLock();
      saveRuntime();
      this.startWatching();
    } catch (err) {
      this.pid = null;
      this.note(`Start failed: ${(err as Error).message}`);
      // Games with a crash checker explain it (with a fix where there is one), like after a crash.
      if (this.module.diagnose) {
        try {
          this.diagnosis = this.module.diagnose(this.record, this.logFile, Date.now() - 60_000) as typeof this.diagnosis;
        } catch {}
      }
      this.setStatus('stopped', (err as Error).message);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    if (this.busy) throw new Error('Another action is in progress.');
    if (!this.pid || !isAlive(this.pid)) {
      this.pid = null;
      this.setStatus('stopped', null);
      return;
    }
    this.busy = true;
    const pid = this.pid;
    try {
      this.setStatus('stopping');
      let sent = false;
      if (this.module.commands && this.pipe && this.token) {
        // Games that need to be told to save first (Factorio: /server-save, then /quit).
        const saveFirst = this.module.commands.saveFirst;
        if (saveFirst) {
          this.note(`Stopping: saving first ("${saveFirst.command}")...`);
          const saved = this.waitForLine(saveFirst.done, saveFirst.timeoutMs).then(
            () => true,
            () => false,
          );
          await sendPipeCommand(this.pipe, this.token, saveFirst.command).catch(() => {});
          if (!(await saved)) this.note("The save didn't confirm in time; stopping anyway.");
        }
        const stopCmd = typeof this.module.commands.stop === 'function' ? this.module.commands.stop(this.record) : this.module.commands.stop;
        this.note(`Stopping: sending "${stopCmd}" so the server saves and shuts down...`);
        sent = await sendPipeCommand(this.pipe, this.token, stopCmd).then(
          () => true,
          (err) => {
            this.note(`Could not send the stop command (${err.message}); trying Ctrl+C.`);
            return false;
          },
        );
      }
      if (!sent && this.module.gracefulStop) {
        this.note('Stopping: asking the server to save and shut down...');
        sent = await this.module.gracefulStop(this.record, (m) => this.note(m));
      }
      if (!sent && this.module.consoleCommands) {
        const stopCmd = this.module.consoleCommands.stop;
        this.note(`Stopping: typing "${stopCmd}" so the server saves and shuts down...`);
        sent = isLinux && this.pipe && this.token ? await sendPipeCommand(this.pipe, this.token, stopCmd).then(() => true, () => false) : await sendConsoleInput(pid, stopCmd);
        if (!sent) this.note('Could not type the stop command; trying Ctrl+C.');
      }
      if (!sent) {
        this.note('Stopping: asking the server to save and shut down (Ctrl+C)...');
        sent = await sendCtrlC(pid);
      }
      let exited = sent && (await waitForExit(pid, STOP_TIMEOUT_MS));
      let forced = false;
      if (!exited) {
        this.note(sent ? 'Server did not shut down in time; forcing it to close. Progress since the last save may be lost.' : 'Could not signal the server; forcing it to close.');
        await forceKill(pid);
        exited = await waitForExit(pid, 10_000);
        forced = true;
      }
      try {
        this.readLog();
      } catch {}
      this.stopWatching();
      this.pid = null;
      this.startedAt = null;
      this.note(exited ? 'Server stopped.' : `Server may still be running; check ${isLinux ? 'your system monitor' : 'Task Manager'}.`);
      this.setStatus('stopped', exited ? null : 'Stop may have failed.');
      if (forced) events.emit('force-stopped', this.id);
    } finally {
      this.busy = false;
    }
  }

  async restart(opts: { force?: boolean } = {}) {
    await this.stop();
    await this.start(opts);
  }

  /** Tells the chat relay pack who is muted (Bedrock). Harmless if the relay isn't installed. */
  async sendMutes() {
    if (!this.module.chat || !this.isRunning || !this.module.chat.status(this.record).on) return;
    // "name|other name", or "-" for nobody (see the relay pack's script).
    const names = mutedPlayers(this.id).filter((n) => !n.includes('|'));
    await this.sendCommand(`scriptevent tavernhost:mutes ${names.join('|') || '-'}`);
  }

  // ---------- countdowns (warn players, then restart/stop) ----------

  /** A restart/stop that's counting down (shown in the panel with a Cancel button). */
  countdown: { action: 'restart' | 'stop'; endsAt: number; reason?: string } | null = null;
  private countdownAbort: AbortController | null = null;

  /** A message to everyone in the game (gold "[Server]" text where the game supports it). */
  async announce(text: string) {
    if (!this.canAnnounce || !this.isRunning) return;
    // Games with their own way to message everyone (Space Engineers: Remote API chat).
    if (this.module.say) {
      await this.module.say(this.record, `[Server] ${text}`).catch(() => {});
      return;
    }
    const cmd =
      this.record.game === 'bedrock'
        ? `tellraw @a ${JSON.stringify({ rawtext: [{ text: `§6[Server]§r ${text}` }] })}`
        : this.record.game === 'java'
          ? `tellraw @a ${JSON.stringify({ text: `[Server] ${text}`, color: 'gold' })}`
          : this.module.announceCommand
            ? this.module.announceCommand(text)
            : `say ${text}`;
    await this.sendCommand(cmd).catch(() => {});
  }

  /**
   * Warns players at each of `warnMinutes` (e.g. [5, 1]) and then 10, 5, 3, 2, 1 seconds before, then restarts or
   * stops. `message` may use {time} ("5 minutes") or {minutes}. Resolves false if it was cancelled.
   */
  async countdownThen(action: 'restart' | 'stop', warnMinutes: number[], message?: string, reason?: string): Promise<boolean> {
    if (this.countdown) throw new Error('A countdown is already running. Cancel it first.');
    const total = Math.max(0, ...warnMinutes.filter((m) => Number.isFinite(m) && m > 0)) * 60;
    const verb = action === 'restart' ? 'restarting' : 'shutting down';
    if (!total || !this.canAnnounce || !this.isRunning) {
      if (action === 'restart') await this.restart();
      else await this.stop();
      return true;
    }
    const abort = new AbortController();
    this.countdownAbort = abort;
    const endsAt = Date.now() + total * 1000;
    this.countdown = { action, endsAt, reason };
    this.note(`${action === 'restart' ? 'Restart' : 'Stop'} in ${total / 60} minute${total === 60 ? '' : 's'}${reason ? ` (${reason})` : ''}; players are being warned.`);
    events.emit('state', this.id);
    const marks = [...new Set([...warnMinutes.map((m) => Math.round(m * 60)), 10, 5, 3, 2, 1])].filter((s) => s > 0 && s <= total).sort((a, b) => b - a);
    const until = (t: number) =>
      new Promise<void>((resolve, reject) => {
        if (abort.signal.aborted) return reject(new Error('cancelled'));
        const timer = setTimeout(resolve, Math.max(0, t - Date.now()));
        abort.signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('cancelled'))), { once: true });
      });
    try {
      for (const s of marks) {
        await until(endsAt - s * 1000);
        if (!this.isRunning) return true;
        const time = s >= 60 && s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} second${s === 1 ? '' : 's'}`;
        await this.announce(message ? message.replace(/\{time\}/g, time).replace(/\{minutes\}/g, String(Math.max(1, Math.round(s / 60)))) : `Server ${verb} in ${time}!`);
      }
      await until(endsAt);
    } catch {
      await this.announce(`${action === 'restart' ? 'Restart' : 'Shutdown'} cancelled.`);
      this.note('Countdown cancelled.');
      return false;
    } finally {
      this.countdown = null;
      this.countdownAbort = null;
      events.emit('state', this.id);
    }
    if (!this.isRunning) return true;
    await this.announce(`Server ${verb} now.`);
    await new Promise((r) => setTimeout(r, 1000));
    if (action === 'restart') await this.restart();
    else await this.stop();
    return true;
  }

  cancelCountdown() {
    this.countdownAbort?.abort();
  }

  /** Ends the process at once, without saving (for a hung server). */
  async kill() {
    if (!this.pid || !isAlive(this.pid)) return;
    const pid = this.pid;
    this.note('Killing the server process (no save).');
    await forceKill(pid);
    await waitForExit(pid, 10_000);
    this.stopWatching();
    this.pid = null;
    this.startedAt = null;
    this.setStatus('stopped', null);
    events.emit('force-stopped', this.id);
  }

  /** Writes a Server Forge note into the console (e.g. from the task scheduler). */
  log(message: string) {
    this.note(message);
  }

  /** Sends a typed command to the server's console (games with `commands` only). */
  async sendCommand(command: string) {
    if (!this.takesCommands) throw new Error(`${this.module.name} servers don't accept console commands.`);
    const oneLine = String(command ?? '').replace(/[\r\n]+/g, ' ').trim();
    const clean = this.module.slashCommands ? oneLine : oneLine.replace(/^\//, '');
    if (!clean) throw new Error('Type a command first.');
    if (clean.length > 1000) throw new Error('That command is too long.');
    if (this.module.runCommand) {
      // Through the game's own server API; its answer goes in the console too.
      if (!this.pid || !isAlive(this.pid)) throw new Error('The server is not running.');
      this.pushLine(`> ${clean}`);
      const answer = await this.module.runCommand(this.record, clean);
      if (answer) for (const l of String(answer).split(/\r?\n/)) if (l.trim()) this.pushLine(l);
      return;
    } else if (this.module.consoleCommands) {
      // Typed into the server's own console (it ignores piped input).
      if (!this.pid || !isAlive(this.pid)) throw new Error('The server is not running.');
      if (isLinux && this.pipe && this.token) await sendPipeCommand(this.pipe, this.token, clean);
      else if (!(await sendConsoleInput(this.pid, clean))) throw new Error("Couldn't type into the server's console.");
    } else {
      if (!this.pid || !isAlive(this.pid) || !this.pipe || !this.token) throw new Error('The server is not running.');
      await sendPipeCommand(this.pipe, this.token, clean);
    }
    this.pushLine(`> ${clean}`);
  }

  /** Re-attach to a server that kept running while the panel was down. */
  async adopt(pid: number, startedAt: number, pipe: string | null = null, token: string | null = null) {
    const name = await processName(pid);
    // Runner-based servers are tracked by the runner's process: "Tavern Host Runner.exe" (installed app), or this same
    // executable (development, and servers started by versions before the separate runner).
    const viaRunner = this.module.commands || this.module.captureOutput || (isLinux && this.module.consoleCommands);
    // Under Wine the process is Wine's own loader, whatever the game is called.
    const wine = isLinux && this.module.linux === 'wine' && /^(wine|xvfb|sh$|bash$)|\.exe$/.test(name ?? '');
    const expected = viaRunner ? [path.basename(process.execPath), RUNNER_EXE] : [this.module.processName];
    if (!wine && !expected.some((e) => e.toLowerCase() === name?.toLowerCase())) return;
    if (this.module.commands && (!pipe || !token)) return;
    this.pid = pid;
    this.pipe = pipe;
    this.token = token;
    this.startedAt = startedAt;
    this.status = 'starting';
    this.readLog();
    if (this.parser.state().ready) this.status = 'running';
    this.note(`Re-attached to running server (PID ${pid}).`);
    this.startWatching();
    events.emit('state', this.id);
    // A live backup that was running when Server Forge closed left the server's saving paused: turn it back on.
    resumeCutOffBackup(this.backupTarget())
      .then((did) => did && this.note('A backup was cut off when Server Forge closed; saving is back on.'))
      .catch((err) => this.note(`Couldn't turn saving back on after a cut-off backup: ${(err as Error).message}`));
  }

  liveState() {
    return this.parser.state();
  }

  /** This system's LAN address plus the server's port (what players on the network connect to). */
  private connectionInfo() {
    try {
      const c = this.module.connection?.(this.record);
      return c ? { ip: lanAddress(), ...c } : null;
    } catch {
      return null;
    }
  }

  async snapshot(includeDetails = false) {
    const live = this.parser.state();
    const details = includeDetails && this.module.details ? await this.module.details(this.record) : {};
    return {
      id: this.id,
      game: this.record.game,
      gameName: this.module.name,
      name: this.record.name,
      position: positionOf(this.id),
      installDir: this.record.installDir,
      // Another Server Forge on this system uses this folder too: this panel won't start, update or delete it.
      folderConflict: folderUsedElsewhere(this.record.installDir),
      autoRestart: this.record.autoRestart,
      settings: this.record.settings,
      // Installs/updates/restores make the server unusable meanwhile; a backup doesn't.
      status: ['install', 'restore'].includes(runningJob(this.id)?.kind ?? '') ? 'installing' : this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      lastError: this.lastError,
      live,
      job: jobsFor(this.id).at(-1) ?? null,
      canInstall: !!this.module.install,
      canCommand: this.takesCommands,
      countdown: this.countdown,
      hasProperties: !!this.module.properties,
      propertiesLabel: this.module.propertiesLabel ?? 'Properties',
      canBackup: !!this.module.backup,
      hasAddons: !!this.module.addons && (this.module.addons.available?.(this.record) ?? true),
      addonsTab: this.module.addons?.labels?.(this.record).tab ?? 'Addons',
      // A second manager with its own tab (Bedrock on Endstone: Plugins).
      hasPlugins: !!this.module.plugins && (this.module.plugins.available?.(this.record) ?? true),
      software: this.record.game === 'bedrock' ? (this.record.settings.software ?? 'vanilla') : null,
      // BungeeCord: the servers in its config.yml (the panel shows those it can match under the proxy).
      proxyBackends: this.proxyBackends(),
      // Valheim: modding switched on (permanent), shown as a "Modded" badge.
      modded: this.module.addons?.isOn?.(this.record) ?? false,
      canDiagnose: !!this.module.diagnose,
      diagnosis: this.diagnosis,
      hasWorld: !!this.module.world,
      hasChat: !!this.module.chat,
      hasWorlds: this.record.game === 'bedrock' || this.record.game === 'java',
      connection: this.connectionInfo(),
      backupSchedule: this.record.backupSchedule ?? { everyHours: 0, keep: 10 },
      ...details,
    };
  }

  private proxyCache: { mtime: number; list: { name: string; address: string }[] } | null = null;

  /** A BungeeCord proxy's servers ({name, address} from config.yml), read again only when the file changes; else null. */
  proxyBackends(): { name: string; address: string }[] | null {
    if (this.record.game !== 'java' || this.record.settings.flavor !== 'bungeecord') return null;
    try {
      const mtime = statSync(path.join(this.record.installDir, 'config.yml')).mtimeMs;
      if (this.proxyCache?.mtime !== mtime) this.proxyCache = { mtime, list: listProxyServers(this.record).servers.map((s) => ({ name: s.name, address: s.address })) };
      return this.proxyCache.list;
    } catch {
      return [];
    }
  }

  /** What backups (and clones) need: the record, game module, running state and console access. */
  backupTarget(): BackupTarget {
    return { record: this.record, module: this.module, running: this.isRunning, io: this.consoleIO() };
  }

  /** Backs up the world in the background (safe while running for games that support it). */
  backupNow(kind: BackupKind = 'manual') {
    if (!this.module.backup) throw new Error(`${this.module.name} servers can't be backed up yet.`);
    return startJob(
      this.id,
      kind === 'scheduled' ? 'Scheduled backup' : 'Backing up',
      async (job) => {
        await createBackup(this.backupTarget(), kind, job);
        if (kind === 'scheduled') {
          const removed = pruneScheduled(this.id, this.record.backupSchedule?.keep ?? 10);
          if (removed) job.line(`Removed ${removed} old scheduled backup(s).`);
        }
      },
      (line) => this.pushLine(line),
      'backup',
    );
  }

  /** Restores a backup (server must be stopped). The current state is backed up first, so it can be undone. */
  restore(backupId: string) {
    if (!this.module.backup) throw new Error(`${this.module.name} servers can't be restored.`);
    if (this.busy || (this.pid && isAlive(this.pid))) throw new Error('Stop the server first.');
    this.assertNotOwnedElsewhere();
    return startJob(
      this.id,
      'Restoring backup',
      async (job) => {
        job.update('Backing up the current world first (so this can be undone)…', null);
        await createBackup(this.backupTarget(), 'before-restore', job);
        await restoreBackup(this.backupTarget(), backupId, job);
        this.note('Backup restored.');
        events.emit('world-replaced', this.id);
      },
      (line) => this.pushLine(line),
      'restore',
    );
  }

  /** Downloads/updates the server software in the background. The server must be stopped. */
  installSoftware(title: string, opts: { force?: boolean } = {}) {
    if (!this.module.install) throw new Error(`${this.module.name} servers can't be installed or updated automatically yet.`);
    if (this.busy || (this.pid && isAlive(this.pid))) throw new Error('Stop the server first.');
    this.assertNotOwnedElsewhere();
    return startJob(
      this.id,
      title,
      async (job) => {
        this.note(`${title}...`);
        await this.module.install!(this.record, job, opts);
        // Installers may record what they set up (e.g. Java version, launch file).
        saveServers();
        this.note(`${title}: done.`);
      },
      (line) => this.pushLine(line),
    );
  }

  knownPlayers() {
    return this.parser.knownPlayers();
  }
}

// ---------- Registry ----------

const instances = new Map<string, ServerInstance>();

function saveServers() {
  writeJson(SERVERS_FILE, [...instances.values()].map((i) => i.record));
  publishFolders();
}

// ---------- folders used by other Server Forges on this system ----------
// Several Server Forges can run on one system (installed release, portable copies, the development panel). Each one lists
// its server folders in a shared file, and no panel may use a folder another panel lists (or one inside it, or around
// it), so one can never start, update or delete another's servers.

const FOLDER_REGISTRY = isLinux ? path.join(stateFolder(), 'panel-folders.json') : path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Tavern Host', 'panel-folders.json');
const ourKey = () => path.resolve(dataDir).toLowerCase();
type FolderRegistry = Record<string, { build: string; folders: string[]; updated: number }>;

function readFolderRegistry(): FolderRegistry {
  try {
    return JSON.parse(readFileSync(FOLDER_REGISTRY, 'utf-8'));
  } catch {
    return {};
  }
}

function publishFolders() {
  try {
    const reg = readFolderRegistry();
    reg[ourKey()] = { build: isDev ? 'development' : 'release', folders: [...instances.values()].map((i) => path.resolve(i.record.installDir)), updated: now() };
    // Forget panels whose data folder is gone (uninstalled / deleted portable copies).
    for (const key of Object.keys(reg)) if (key !== ourKey() && !existsSync(key)) delete reg[key];
    mkdirSync(path.dirname(FOLDER_REGISTRY), { recursive: true });
    writeFileSync(`${FOLDER_REGISTRY}.${process.pid}.tmp`, JSON.stringify(reg, null, 2));
    renameSync(`${FOLDER_REGISTRY}.${process.pid}.tmp`, FOLDER_REGISTRY);
  } catch {}
}

function overlaps(a: string, b: string) {
  const x = path.resolve(a).toLowerCase();
  const y = path.resolve(b).toLowerCase();
  const inside = (c: string, p: string) => c === p || c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
  return inside(x, y) || inside(y, x);
}

/** The installed panel's data folders (current and pre-rename), for versions too old to publish their folders. */
function installedDataDirs(): string[] {
  if (isLinux) return [path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Server Forge', 'data')];
  const appData = process.env.APPDATA;
  return appData ? [path.join(appData, 'Tavern Host', 'data'), path.join(appData, 'Game Server Panel', 'data')] : [];
}

/** Which other Server Forge on this system uses `dir` (or a folder inside/around it), or null. */
export function folderUsedElsewhere(dir: string): string | null {
  const reg = readFolderRegistry();
  for (const [key, entry] of Object.entries(reg)) {
    if (key === ourKey() || !existsSync(key)) continue;
    const hit = entry.folders.find((f) => overlaps(f, dir));
    if (hit) return `the ${entry.build} Server Forge (data in ${key}) uses ${hit}`;
  }
  // Installed panels that don't publish yet: read their server list directly.
  for (const d of installedDataDirs()) {
    const key = path.resolve(d).toLowerCase();
    if (key === ourKey() || reg[key]) continue;
    try {
      const list = JSON.parse(readFileSync(path.join(d, 'servers.json'), 'utf-8')) as { installDir?: string }[];
      const hit = list.map((s) => s.installDir).find((f): f is string => !!f && overlaps(f, dir));
      if (hit) return `the installed Server Forge (data in ${d}) uses ${hit}`;
    } catch {}
  }
  return null;
}

/** Server folders the other Server Forges on this system use (e.g. to avoid giving two servers the same ports). */
export function foldersUsedElsewhere(): string[] {
  const reg = readFolderRegistry();
  return Object.entries(reg)
    .filter(([key]) => key !== ourKey() && existsSync(key))
    .flatMap(([, entry]) => entry.folders);
}

/** Throws if another Server Forge on this system uses this folder. */
export function assertFolderFree(dir: string) {
  const other = folderUsedElsewhere(dir);
  if (other) throw new Error(`That folder can't be used here: ${other}. Each Server Forge needs its own server folders.`);
}

interface RuntimeEntry {
  pid: number;
  startedAt: number;
  pipe?: string | null;
  token?: string | null;
}

function saveRuntime() {
  const runtime: Record<string, RuntimeEntry> = {};
  for (const i of instances.values()) {
    if (i.pid && i.startedAt) runtime[i.id] = { pid: i.pid, startedAt: i.startedAt, pipe: i.pipe, token: i.token };
  }
  writeJson(RUNTIME_FILE, runtime);
}

// Automatic backups: while a server runs, back it up once its newest backup is older than its schedule.
setInterval(() => {
  for (const inst of instances.values()) {
    const every = inst.record.backupSchedule?.everyHours ?? 0;
    if (!every || !inst.module.backup || !inst.isRunning || inst.status !== 'running' || runningJob(inst.id)) continue;
    const newest = listBackups(inst.id)[0]?.createdAt ?? 0;
    if (now() - newest < every * 3600_000) continue;
    try {
      inst.backupNow('scheduled');
    } catch {}
  }
}, 60_000).unref();

export async function loadInstances() {
  for (const record of readJson<ServerRecord[]>(SERVERS_FILE, [])) {
    if (GAMES[record.game]) instances.set(record.id, new ServerInstance(record));
  }
  const runtime = readJson<Record<string, RuntimeEntry>>(RUNTIME_FILE, {});
  for (const [id, entry] of Object.entries(runtime)) {
    const inst = instances.get(id);
    if (inst && isAlive(entry.pid)) await inst.adopt(entry.pid, entry.startedAt, entry.pipe ?? null, entry.token ?? null);
  }
  saveRuntime();
  publishFolders();
  // Servers that stopped while the panel was closed: nobody is online there any more.
  for (const inst of instances.values()) if (!inst.pid) syncPlayers(inst.id, []);
}

export function getInstance(id: string): ServerInstance {
  const inst = instances.get(id);
  if (!inst) throw Object.assign(new Error('Server not found.'), { status: 404 });
  return inst;
}

export function listInstances(): ServerInstance[] {
  return [...instances.values()];
}

/** Where a server sits in the list (the order servers.json keeps, and the sidebar shows). */
export function positionOf(id: string): number {
  return [...instances.keys()].indexOf(id);
}

/**
 * Puts the given servers in the given order. They keep the slots they already occupy in the full list, so servers
 * not mentioned (e.g. ones this user can't see) stay where they are.
 */
export function reorderServers(ids: string[]) {
  const all = [...instances.keys()];
  const wanted = [...new Set(ids)].filter((id) => instances.has(id));
  const slots = all.map((id, i) => (wanted.includes(id) ? i : -1)).filter((i) => i >= 0);
  slots.forEach((slot, n) => (all[slot] = wanted[n]));
  const reordered = new Map(all.map((id) => [id, instances.get(id)!]));
  instances.clear();
  for (const [id, inst] of reordered) instances.set(id, inst);
  saveServers();
  for (const id of wanted) events.emit('state', id);
}

// CPU/RAM sampling covers servers with a live process. Runner-based games (Java, Bedrock) are measured without the
// runner itself, so the numbers are the game's own.
setStatsSource(() =>
  listInstances()
    .filter((i) => i.pid && i.status !== 'stopped' && i.status !== 'crashed')
    .map((i) => ({ id: i.id, pid: i.pid!, excludeRoot: !!i.module.commands, players: i.status === 'running' ? (i.liveState().playerCount ?? 0) : null })),
);

/** Adds a server whose files are already in place (used by clone.ts once the copy is finished). */
export function addServer(record: ServerRecord) {
  if (instances.has(record.id)) throw new Error('A server with that id already exists.');
  assertFolderFree(record.installDir);
  const inst = new ServerInstance(record);
  instances.set(record.id, inst);
  saveServers();
  events.emit('state', record.id);
  return inst;
}

/** Import: lets the game find the real server folder and bring its extras along first (see GameModule.prepareImport). */
export async function importServer(input: { game: string; name: string; installDir: string; settings?: Settings }) {
  const module = GAMES[input.game];
  if (!module) throw new Error('Unknown game.');
  let installDir = String(input.installDir ?? '').trim();
  let notes: string[] = [];
  if (module.prepareImport && path.isAbsolute(installDir)) {
    // Nothing is changed in a folder another server already uses.
    assertFolderFree(installDir);
    ({ installDir, notes } = await module.prepareImport(installDir));
  }
  return { inst: createServer({ ...input, installDir }), notes };
}

export function createServer(input: { game: string; name: string; installDir: string; settings?: Settings }) {
  const module = GAMES[input.game];
  if (!module) throw new Error('Unknown game.');
  const name = String(input.name ?? '').trim();
  const installDir = String(input.installDir ?? '').trim();
  if (!name || name.length > 60) throw new Error('Name is required (up to 60 characters).');
  if (path.isAbsolute(installDir)) assertFolderFree(installDir);
  module.checkInstall(installDir);
  const detected = module.detect?.(installDir) ?? {};
  const settings = module.validate({ ...module.defaults({ installDir }), ...detected, ...(input.settings ?? {}) });
  const record: ServerRecord = { id: randomUUID().slice(0, 8), game: module.id, name, installDir, settings, autoRestart: true, createdAt: now() };
  const inst = new ServerInstance(record);
  instances.set(record.id, inst);
  saveServers();
  events.emit('state', record.id);
  return inst;
}

export function updateServer(
  id: string,
  input: { name?: string; installDir?: string; autoRestart?: boolean; autoUpdate?: boolean; settings?: Settings; backupSchedule?: { everyHours: number; keep: number } },
) {
  const inst = getInstance(id);
  const record = { ...inst.record };
  if (input.autoUpdate !== undefined) record.autoUpdate = !!input.autoUpdate;
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name || name.length > 60) throw new Error('Name is required (up to 60 characters).');
    record.name = name;
  }
  if (input.installDir !== undefined) {
    if (path.isAbsolute(String(input.installDir).trim())) assertFolderFree(String(input.installDir).trim());
    inst.module.checkInstall(String(input.installDir).trim());
    record.installDir = String(input.installDir).trim();
  }
  if (input.autoRestart !== undefined) record.autoRestart = !!input.autoRestart;
  if (input.backupSchedule !== undefined) {
    const every = Number(input.backupSchedule.everyHours);
    const keep = Number(input.backupSchedule.keep);
    if (!Number.isInteger(every) || every < 0 || every > 168) throw new Error('Back up every 0-168 hours (0 = off).');
    if (!Number.isInteger(keep) || keep < 1 || keep > 200) throw new Error('Keep 1-200 automatic backups.');
    record.backupSchedule = { everyHours: every, keep };
  }
  if (input.settings) record.settings = inst.module.validate({ ...record.settings, ...input.settings });
  inst.record = record;
  saveServers();
  events.emit('state', id);
  return inst;
}

/**
 * Creates a brand-new server: makes the folder (it must be new or empty), adds the server, and downloads the software
 * in the background. The server can be started once the install job finishes.
 */
export function createNewServer(input: { game: string; name: string; installDir: string; settings?: Settings; acceptEula?: boolean }) {
  const module = GAMES[input.game];
  if (!module) throw new Error('Unknown game.');
  if (!module.install) throw new Error(`New ${module.name} servers can't be created automatically yet. Use Import Server instead.`);
  const name = String(input.name ?? '').trim();
  const installDir = String(input.installDir ?? '').trim();
  if (!name || name.length > 60) throw new Error('Name is required (up to 60 characters).');
  if (module.eula && input.acceptEula !== true) throw new Error('You need to accept the Minecraft EULA to create this server.');
  if (!path.isAbsolute(installDir)) throw new Error(`Choose a full folder path, e.g. ${exampleFolder('My Server')}`);
  assertFolderFree(installDir);
  if (existsSync(installDir) && readdirSync(installDir).length > 0) {
    throw new Error('That folder is not empty. Choose a new or empty folder, or use Import Server for an existing server.');
  }
  if (listInstances().some((i) => path.resolve(i.record.installDir).toLowerCase() === path.resolve(installDir).toLowerCase())) {
    throw new Error('Another server already uses that folder.');
  }
  const settings = module.validate({
    ...module.defaults({ installDir }),
    ...(input.settings ?? {}),
    // The user ticked the EULA box; games that write eula.txt during install need to know.
    ...(module.eula ? { eulaAccepted: true } : {}),
  });
  mkdirSync(installDir, { recursive: true });
  const record: ServerRecord = { id: randomUUID().slice(0, 8), game: module.id, name, installDir, settings, autoRestart: true, createdAt: now() };
  const inst = new ServerInstance(record);
  instances.set(record.id, inst);
  saveServers();
  inst.installSoftware(`Installing ${module.name} server`);
  return inst;
}

/**
 * Removes a server from the panel. With `files`, its folder goes to the Recycle Bin too; with `backups`, its backups.
 * Everything is checked before anything is deleted, and the server stays listed if deleting its files fails.
 */
export async function deleteServer(id: string, opts: { files?: boolean; backups?: boolean } = {}) {
  const inst = getInstance(id);
  if (inst.pid && isAlive(inst.pid)) throw new Error('Stop the server before removing it.');
  if (runningJob(id)) throw new Error('Wait for the install or update to finish before removing it.');
  const folder = path.resolve(inst.record.installDir);
  if (opts.files && existsSync(folder)) {
    inst.assertNotOwnedElsewhere();
    // Never delete a folder another server lives in (or inside), whether or not it's running.
    const others = [...instances.values()].filter((i) => i.id !== id).map((i) => path.resolve(i.record.installDir));
    try {
      assertModifiable(folder, others);
    } catch (err) {
      const msg = (err as Error).message.replace('A running server is using this folder. Stop it first.', 'Another server in Server Forge uses this folder, so it can\'t be deleted.');
      throw new Error(`The folder can't be deleted: ${msg}`);
    }
    try {
      await recycle(folder);
    } catch (err) {
      throw new Error(`${(err as Error).message} Nothing was deleted and the server is still listed.`);
    }
  }
  if (opts.backups && existsSync(backupsFolder(id))) {
    try {
      await recycle(backupsFolder(id));
    } catch {}
  }
  instances.delete(id);
  saveServers();
  saveRuntime();
  forgetStats(id);
  forgetPlayers(id);
  events.emit('removed', id);
}
