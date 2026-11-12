import { hytaleMods } from './hytale-mods.ts';
// Official Hytale dedicated server integration. Runtime data lives inside Server/.
import { existsSync, mkdirSync, readdirSync, chmodSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isLinux } from '../platform/host.ts';
import { downloadFile, extractZip } from '../download.ts';
import { ensureJava, javaExe } from '../java-runtime.ts';
import type { GameModule, LogState, Settings } from './types.ts';

const serverDir = (dir: string) => existsSync(path.join(dir, 'Server', 'HytaleServer.jar')) ? path.join(dir, 'Server') : dir;
function assets(dir: string): string {
  const cwd = serverDir(dir);
  return existsSync(path.join(cwd, 'Assets.zip')) ? path.join(cwd, 'Assets.zip') : path.resolve(cwd, '..', 'Assets.zip');
}
function integer(value: unknown, label: string, min: number, max: number) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

export const hytale: GameModule = {
  id: 'hytale', name: 'Hytale', linux: 'native', processName: isLinux ? 'java' : 'java.exe',
  fields: [
    { key: 'port', label: 'Game port (UDP)', type: 'number', restart: true, section: 'Hytale server', sectionHelp: 'Downloads require a Hytale account: follow the login link in Console. After the first start, send /auth login device in Console to authenticate the server. Gameplay settings are in Server/config.json; edit only while stopped using Files.', help: 'Forward this UDP port in your router. Hytale uses QUIC, not TCP.' },
    { key: 'memoryMb', label: 'Maximum Java memory (MB)', type: 'number', restart: true, help: 'Java 25 is installed automatically. Leave RAM available for the operating system.' },
  ],
  quickFields: ['port', 'memoryMb'],
  defaults: () => ({ port: 5520, memoryMb: 4096 }),
  validate(s: Settings) {
    return { port: integer(s.port, 'Game port', 1, 65535), memoryMb: integer(s.memoryMb, 'Memory', 1024, 1048576) };
  },
  checkInstall(dir) {
    if (!existsSync(path.join(serverDir(dir), 'HytaleServer.jar'))) throw new Error('Choose the folder containing Server/HytaleServer.jar (or HytaleServer.jar) and Assets.zip.');
    if (!existsSync(assets(dir))) throw new Error('Assets.zip is missing. Copy it from the Hytale launcher or use the official downloader.');
  },
  async prepare(record, note) {
    hytale.checkInstall(record.installDir);
    await ensureJava(25, (step) => note(step), note, 'jdk');
    note('Hytale: use /auth login device in Console if this server has not been authenticated.');
  },
  launch(record) {
    const exe = javaExe(25, 'jdk');
    if (!exe) throw new Error('Java 25 is missing. Start again to download it.');
    return { exe, cwd: serverDir(record.installDir), args: [`-Xmx${record.settings.memoryMb}M`, '-jar', 'HytaleServer.jar', '--assets', assets(record.installDir), '--bind', `0.0.0.0:${record.settings.port}`] };
  },
  addons: hytaleMods,
  commands: { stop: 'stop' },
  slashCommands: true,
  connection: (r) => ({ port: Number(r.settings.port), protocol: 'UDP' }),
  memoryLimit: (r) => ({ mb: Number(r.settings.memoryMb), label: 'Java heap limit', note: 'Java also uses memory outside the heap.' }),
  backup: {
    sources: (r) => ({ base: serverDir(r.installDir), include: ['universe', 'config.json', 'permissions.json', 'whitelist.json', 'bans.json', 'mods', '.sf-disabled-mods'], world: 'universe' }),
    async hot() { throw new Error('Stop the Hytale server before taking a Server Forge backup so world files are consistent.'); },
  },
  createParser() {
    const state: LogState = { ready: false, players: [], playerCount: null, version: null, lastSave: null, extra: {} };
    return {
      feed(line) {
        if (/Hytale Server Booted|Server started successfully/i.test(line)) state.ready = true;
        if (/Waiting for authorization|DEVICE AUTHORIZATION/i.test(line)) state.extra.authentication = 'Complete the Hytale login shown in Console.';
        if (/Authentication successful/i.test(line)) state.extra.authentication = 'Authenticated';
      },
      state: () => structuredClone(state), knownPlayers: () => ({}),
    };
  },
  async install(record, job) {
    // Keep downloader credentials on this host between updates; never put them in world backups.
    const tools = path.join(record.installDir, '.sf-hytale');
    mkdirSync(tools, { recursive: true });
    const name = isLinux ? 'hytale-downloader-linux-amd64' : 'hytale-downloader-windows-amd64.exe';
    const exe = path.join(tools, name);
    if (!existsSync(exe)) {
      job.update('Downloading the official Hytale downloader...', null);
      const zip = path.join(tools, 'downloader.zip');
      await downloadFile('https://downloader.hytale.com/hytale-downloader.zip', zip);
      await extractZip(zip, tools);
    }
    if (!existsSync(exe)) throw new Error('The official downloader archive did not contain the expected executable.');
    if (isLinux) chmodSync(exe, 0o700);
    job.update('Downloading Hytale. Follow the account login link in Console if prompted.', null);
    const archive = path.join(tools, 'game.zip');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ['-download-path', archive], { cwd: tools, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Hytale download timed out. Retry and finish the login in Console.')); }, 60 * 60_000);
      // Buffer partial lines so login URLs are never split across console rows.
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
          pending += chunk;
          const lines = pending.split(/\r\n|\n|\r/);
          pending = lines.pop()!;
          for (const line of lines) if (line.trim()) job.line(line);
        });
        stream.on('end', () => { if (pending.trim()) job.line(pending); });
      }
      child.once('error', (e) => { clearTimeout(timer); reject(e); });
      child.once('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Hytale downloader exited with code ${code}. Check Console for the login or error.`)); });
    });
    // Extract into staging; only copy server binaries/assets, preserving live worlds, settings and mods.
    const staging = path.join(tools, `staging-${Date.now()}`);
    job.update('Unpacking Hytale server...', null);
    await extractZip(archive, staging);
    const candidates = [staging, ...readdirSync(staging, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(staging, e.name))];
    const root = candidates.find(d => existsSync(path.join(d, 'Server', 'HytaleServer.jar')) && existsSync(path.join(d, 'Assets.zip')));
    if (!root) throw new Error('The Hytale download has an unexpected layout; existing server files were preserved.');
    // Imported flat layouts must keep the same working folder, or the next start would create a new universe.
    const target = existsSync(path.join(record.installDir, 'HytaleServer.jar')) ? record.installDir : path.join(record.installDir, 'Server');
    const targetAssets = existsSync(path.join(record.installDir, 'HytaleServer.jar')) ? assets(record.installDir) : path.join(record.installDir, 'Assets.zip');
    mkdirSync(target, { recursive: true });
    for (const file of ['HytaleServer.jar', 'HytaleServer.aot']) {
      if (existsSync(path.join(root, 'Server', file))) cpSync(path.join(root, 'Server', file), path.join(target, file));
    }
    if (existsSync(path.join(root, 'Server', 'Licenses'))) cpSync(path.join(root, 'Server', 'Licenses'), path.join(target, 'Licenses'), { recursive: true });
    cpSync(path.join(root, 'Assets.zip'), targetAssets);
    // These resolved targets are fixed children of the per-server downloader directory.
    if (path.dirname(staging) !== tools || path.dirname(archive) !== tools) throw new Error('Unexpected Hytale staging path.');
    rmSync(staging, { recursive: true, force: true });
    rmSync(archive, { force: true });
    await ensureJava(25, (step, pct) => job.update(step, pct), (line) => job.line(line), 'jdk');
    job.line('Hytale installed. Start it, then use /auth login device in Console to authenticate the server.');
  },
};
