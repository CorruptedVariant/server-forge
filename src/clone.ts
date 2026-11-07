// "Make a copy": clones a server (software, world, addons, settings) into a new folder as a new server, e.g. to try
// addon updates without touching the live world. Ports are moved to free ones so both can run at once. If the source
// is running, its world is taken with the game's safe live-backup method (Bedrock save hold / Java save-off), so the
// live server isn't disturbed; everything else is copied file by file (files the server keeps locked are skipped).
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { exampleFolder } from './platform/host.ts';
import { readdir, stat, copyFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getInstance, listInstances, addServer, assertFolderFree } from './instances.ts';
import { startJob, type Job } from './jobs.ts';
import { createBackup, extractBackup, deleteBackup } from './backups.ts';
import { readProperties, writeProperties } from './properties.ts';
import type { ServerRecord } from './games/types.ts';

const inside = (child: string, parent: string) => {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(`${p}\\`);
};

/** Ports every server in this panel uses (plus the Bedrock IPv6 ports). */
function usedPorts(): Set<number> {
  const used = new Set<number>();
  for (const inst of listInstances()) {
    const port = inst.module.connection?.(inst.record)?.port;
    if (!port) continue;
    used.add(port);
    if (inst.record.game === 'bedrock') {
      const v6 = Number(readProperties(path.join(inst.record.installDir, 'server.properties')).values.get('server-portv6'));
      used.add(v6 || port + 1);
    }
    if (inst.record.game === 'valheim') used.add(port + 1); // Valheim also uses the next port
  }
  return used;
}

/** A free port near `from`, `step` apart (Bedrock needs port+1 free for IPv6, Valheim port+1 for Steam). */
function freePort(from: number, step: number, needsNext: boolean): number {
  const used = usedPorts();
  for (let p = from + step; p < 65000; p += step) if (!used.has(p) && (!needsNext || !used.has(p + 1))) return p;
  throw new Error('No free port found.');
}

/** Copies a folder file by file (async), skipping `skip` paths and files that can't be read (locked ones). */
async function copyTree(src: string, dest: string, skip: (rel: string) => boolean, job: Job) {
  const files: { rel: string; size: number }[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(src, full);
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) files.push({ rel, size: (await stat(full)).size });
    }
  };
  job.update('Listing files…', null);
  await walk(src);
  const total = files.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  const skipped: string[] = [];
  let lastShown = 0;
  for (const f of files) {
    const to = path.join(dest, f.rel);
    try {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(path.join(src, f.rel), to);
    } catch {
      skipped.push(f.rel);
    }
    done += f.size;
    if (Date.now() - lastShown > 400) {
      lastShown = Date.now();
      job.update(`Copying files… ${(done / 2 ** 30).toFixed(2)} of ${(total / 2 ** 30).toFixed(2)} GB`, Math.round((done / total) * 100));
    }
  }
  return { count: files.length, bytes: total, skipped };
}

export function cloneServer(sourceId: string, input: { name: string; installDir: string }) {
  const source = getInstance(sourceId);
  const name = String(input.name ?? '').trim();
  const dest = path.resolve(String(input.installDir ?? '').trim());
  if (!name || name.length > 60) throw new Error('Give the copy a name (up to 60 characters).');
  if (!path.isAbsolute(String(input.installDir ?? '').trim())) throw new Error(`Choose a full folder path for the copy, e.g. ${exampleFolder('My Server (test)')}`);
  if (existsSync(dest) && readdirSync(dest).length) throw new Error('That folder is not empty. Choose a new or empty folder.');
  if (inside(dest, source.record.installDir) || inside(source.record.installDir, dest)) throw new Error("The copy can't go inside the original's folder (or around it).");
  if (listInstances().some((i) => inside(dest, i.record.installDir) || inside(i.record.installDir, dest))) throw new Error('Another server already uses that folder.');
  assertFolderFree(dest);

  const src = source.record;
  const support = source.module.backup;
  const sources = support?.sources(src);
  // Valheim can keep its world outside the server folder; the copy gets its own.
  const srcBase = sources?.base ?? src.installDir;
  const baseInside = inside(srcBase, src.installDir);
  const destBase = baseInside ? path.join(dest, path.relative(src.installDir, srcBase)) : path.join(dest, 'saves');

  return startJob(
    source.id,
    `Making a copy: ${name}`,
    async (job) => {
      mkdirSync(dest, { recursive: true });
      try {
        // 1. A running world: take it the safe live way (a temporary backup, removed afterwards).
        let liveBackup: string | null = null;
        if (source.isRunning && support) {
          job.update('Taking the world safely while the server keeps running…', null);
          liveBackup = (await createBackup(source.backupTarget(), 'manual', job, { noCopy: true })).id;
        }
        // 2. Everything else, file by file. When the world came from the backup, its folders are skipped here.
        const worldRel = liveBackup && baseInside && sources ? sources.include.map((r) => path.join(path.relative(src.installDir, srcBase), r)) : [];
        const skip = (rel: string) =>
          rel === '.tavernhost-owner.json' || worldRel.some((w) => rel.toLowerCase() === w.toLowerCase() || rel.toLowerCase().startsWith(`${w.toLowerCase()}\\`));
        const copied = await copyTree(src.installDir, dest, skip, job);
        if (liveBackup) {
          job.update('Unpacking the world…', null);
          await extractBackup(source.id, liveBackup, destBase);
          deleteBackup(source.id, liveBackup);
        } else if (!baseInside && existsSync(srcBase)) {
          await copyTree(srcBase, destBase, () => false, job);
        }
        if (copied.skipped.length) job.line(`Skipped ${copied.skipped.length} file(s) the running server had locked: ${copied.skipped.slice(0, 5).join(', ')}${copied.skipped.length > 5 ? '…' : ''}`);

        // 3. The new server's settings: its own folder, free ports, and a name that says it's a copy.
        const record: ServerRecord = JSON.parse(JSON.stringify(src));
        Object.assign(record, { id: randomUUID().slice(0, 8), name, installDir: dest, createdAt: Date.now() });
        delete (record as Partial<ServerRecord>).backupSchedule;
        const props = path.join(dest, 'server.properties');
        if (src.game === 'bedrock') {
          const port = freePort(source.module.connection?.(src)?.port ?? 19132, 2, true);
          writeProperties(props, { 'server-port': String(port), 'server-portv6': String(port + 1), 'server-name': `${readProperties(props).values.get('server-name') ?? src.name} (copy)`.slice(0, 60) });
          if (record.settings['prop:server-port'] !== undefined) record.settings['prop:server-port'] = String(port);
          if (record.settings['prop:server-name'] !== undefined) record.settings['prop:server-name'] = `${record.settings['prop:server-name']} (copy)`.slice(0, 60);
          job.line(`The copy uses port ${port} (IPv6 ${port + 1}).`);
        } else if (src.game === 'java') {
          const port = freePort(source.module.connection?.(src)?.port ?? 25565, 1, false);
          if (existsSync(props)) writeProperties(props, { 'server-port': String(port) });
          if (record.settings.port !== undefined) record.settings.port = port;
          job.line(`The copy uses port ${port}.`);
        } else if (src.game === 'valheim') {
          const port = freePort(Number(src.settings.port) || 2456, 10, true);
          record.settings.port = port;
          record.settings.saveDir = destBase;
          record.settings.serverName = `${src.settings.serverName ?? src.name} (copy)`.slice(0, 60);
          record.settings.public = false; // don't list a test copy on the public server list
          job.line(`The copy uses port ${port}, saves in ${destBase}, and isn't listed publicly.`);
        }
        const inst = addServer(record);
        job.line(`Copy "${name}" is ready (${copied.count} files, ${(copied.bytes / 2 ** 30).toFixed(2)} GB) at ${dest}.`);
        return void inst;
      } catch (err) {
        rmSync(dest, { recursive: true, force: true });
        throw err;
      }
    },
    (line) => source.log(line),
    'backup',
  );
}
