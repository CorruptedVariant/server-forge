// Vanilla Terraria: the official dedicated server from terraria.org (no mods; vanilla players can't join a tModLoader
// server and the other way round, so it's its own server type). The Windows server needs Microsoft's XNA Framework 4.0,
// which the Steam game installs on players' systems but a server often lacks: the install puts it on (Windows asks for
// admin once). It runs under Server Forge's runner (output captured, commands piped, Stop types "exit" so it saves).
// World settings, the serverconfig.txt and the log reader are shared with Terraria (tModLoader).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { bin, isLinux } from '../platform/host.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { downloadFile, extractZip } from '../download.ts';
import { terraria, writeConfig, createTerrariaParser, savesDir } from './terraria.ts';
import type { GameModule } from './types.ts';
import type { Job } from '../jobs.ts';

const execFileAsync = promisify(execFile);
const EXE = bin('TerrariaServer.exe', 'TerrariaServer.bin.x86_64');
const ZIP_FOLDER = bin('Windows', 'Linux');
const VERSION_FILE = '.tavernhost-version';
const CONFIG_FILE = 'tavernhost-serverconfig.txt';
const XNA_MSI = 'https://download.microsoft.com/download/A/C/2/AC2C903B-E6E8-42C2-9FD7-BEBAC362A930/xnafx40_redist.msi';

/** "terraria-server-1458.zip" → { file, version: "1.4.5.8" }, from terraria.org's list of dedicated servers. */
async function latestServer(): Promise<{ file: string; version: string }> {
  const res = await fetch('https://terraria.org/api/get/dedicated-servers-names', { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`terraria.org answered ${res.status}.`);
  const names = (await res.json()) as string[];
  const file = names.map(String).find((n) => /^terraria-server-\d{4,}\.zip$/.test(n));
  if (!file) throw new Error("terraria.org didn't list a dedicated server.");
  const digits = /(\d{4,})/.exec(file)![1];
  return { file, version: digits.split('').join('.') };
}

export const latestVanillaVersion = async () => (await latestServer()).version;
export function installedVanillaVersion(installDir: string): string | null {
  try {
    return readFileSync(path.join(installDir, VERSION_FILE), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function xnaInstalled(): boolean {
  return existsSync('C:\\Windows\\Microsoft.NET\\assembly\\GAC_32\\Microsoft.Xna.Framework') || existsSync('C:\\Windows\\assembly\\GAC_32\\Microsoft.Xna.Framework');
}

/** Installs Microsoft's XNA Framework 4.0 Redistributable (Windows shows its admin prompt). */
async function ensureXna(note: (m: string) => void) {
  if (isLinux || xnaInstalled()) return; // the Linux server brings what it needs
  note('Installing Microsoft XNA Framework 4.0 (the vanilla Terraria server needs it). Windows will ask for admin permission…');
  const work = path.join(os.tmpdir(), `tavernhost-xna-${randomBytes(4).toString('hex')}`);
  mkdirSync(work, { recursive: true });
  try {
    const msi = path.join(work, 'xnafx40_redist.msi');
    await downloadFile(XNA_MSI, msi);
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "$p = Start-Process msiexec.exe -ArgumentList '/i', ('\"' + $env:TH_MSI + '\"'), '/quiet', '/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"],
      { env: { ...process.env, TH_MSI: msi }, windowsHide: true, timeout: 10 * 60_000 },
    ).catch((err) => {
      throw new Error(`XNA Framework wasn't installed (${err.message.split('\n')[0]}). Install "Microsoft XNA Framework Redistributable 4.0 Refresh" from Microsoft, then start the server.`);
    });
    if (!xnaInstalled()) throw new Error('XNA Framework still looks missing. Install "Microsoft XNA Framework Redistributable 4.0 Refresh" from Microsoft, then start the server.');
    note('XNA Framework is installed.');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const terrariaVanilla: GameModule = {
  ...terraria,
  id: 'terraria-vanilla',
  name: 'Terraria',
  processName: EXE,
  fields: terraria.fields.map((f) => (f.key === 'saveDir' ? { ...f, help: 'Worlds and the ban list live here.' } : f)),

  checkInstall(installDir) {
    if (!existsSync(path.join(installDir, EXE))) throw new Error(`${EXE} was not found in that folder.`);
  },

  async prepare(record, note) {
    await ensureXna(note);
    mkdirSync(path.join(savesDir(record), 'Worlds'), { recursive: true });
    writeConfig(record);
  },

  launch(record) {
    return { exe: path.join(record.installDir, EXE), args: ['-config', CONFIG_FILE], cwd: record.installDir };
  },

  // Under the runner: output is captured, commands piped; Stop types "exit" (saves the world first).
  commands: { stop: 'exit' },
  consoleCommands: undefined,
  gameLog: undefined,
  hideLine: (line) => /\b\d{1,3}%\s*$/.test(line),

  createParser: createTerrariaParser,

  backup: { sources: (record) => ({ base: savesDir(record), include: ['Worlds', 'banlist.txt'], world: 'Worlds' }) },

  addons: undefined,

  async install(record, job: Job, opts) {
    job.update('Looking up the latest Terraria server…', null);
    const latest = await latestServer();
    if (!opts?.force && installedVanillaVersion(record.installDir) === latest.version && existsSync(path.join(record.installDir, EXE))) {
      job.line(`Terraria ${latest.version} is already installed.`);
      return;
    }
    const work = path.join(os.tmpdir(), `tavernhost-terraria-${randomBytes(4).toString('hex')}`);
    mkdirSync(work, { recursive: true });
    try {
      const zip = path.join(work, latest.file);
      job.update(`Downloading Terraria ${latest.version}…`, null);
      await downloadFile(`https://terraria.org/api/download/pc-dedicated-server/${latest.file}`, zip);
      job.update('Unpacking…', null);
      await extractZip(zip, path.join(work, 'x'));
      // The zip holds <version>/Windows, Linux and Mac; only this system's server is used.
      const top = readdirSync(path.join(work, 'x')).find((d) => existsSync(path.join(work, 'x', d, ZIP_FOLDER, EXE)));
      if (!top) throw new Error(`The download has no ${ZIP_FOLDER} server in it.`);
      mkdirSync(record.installDir, { recursive: true });
      cpSync(path.join(work, 'x', top, ZIP_FOLDER), record.installDir, { recursive: true, force: true });
      writeFileSync(path.join(record.installDir, VERSION_FILE), latest.version);
      job.line(`Terraria ${latest.version} dedicated server is installed.`);
      await ensureXna((m) => job.line(m));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
};
