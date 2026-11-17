// BeamMP's Mods tab. Two kinds, both under the server's resources folder (Resources by default):
// - Client mods: BeamNG.drive mod .zip files (cars, maps, ...) in Resources/Client. Players' games download them when
//   they join.
// - Server plugins: Lua folders in Resources/Server, run by the server itself.
// Switched-off items move to Resources/.sf-disabled/{Client,Server}, which BeamMP doesn't read.
// An upload is one of: a client mod zip (has vehicles/, levels/, ... inside), a plugin zip (.lua files at its root or
// in one folder), or a package laid out like the server (Resources/Server/<plugin>/..., Resources/Client/<mod>.zip),
// which many BeamMP plugins with a client part are.
import { existsSync, readdirSync, lstatSync, mkdirSync, copyFileSync, renameSync, unlinkSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZipFile } from '../zip.ts';
import { extractZip } from '../download.ts';
import { defenderScan, SCANNER, noScannerIsNormal } from '../modscan.ts';
import type { AddonSupport, ServerRecord } from './types.ts';
import { resourcesDir } from './beammp.ts';

type Kind = 'client' | 'server';
const KIND_DIR: Record<Kind, string> = { client: 'Client', server: 'Server' };
/** Top-level folders of a BeamNG.drive mod zip. */
const MOD_ROOTS = new Set(['vehicles', 'levels', 'art', 'lua', 'ui', 'scripts', 'core', 'gameplay', 'settings', 'mod_info', 'campaigns', 'flowEditor', 'trackEditor', 'shaders', 'locales', 'missions'].map((s) => s.toLowerCase()));

function dirOf(r: ServerRecord, kind: Kind, enabled: boolean, create = false): string {
  const res = resourcesDir(r);
  const dir = enabled ? path.join(res, KIND_DIR[kind]) : path.join(res, '.sf-disabled', KIND_DIR[kind]);
  if (create) mkdirSync(dir, { recursive: true });
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error('The BeamMP resources folders must be real folders, not links.');
  return dir;
}

const safeName = (n: string) => /^[^\\/:*?"<>|\u0000-\u001f]{1,150}$/.test(n) && n !== '.' && n !== '..';

/** Entry names, normalised, after refusing anything that could land outside the folder it's unpacked into. */
function entryNames(zip: ZipFile): string[] {
  const names = zip.names().map(ZipFile.normalise).filter((n) => n && !n.startsWith('__MACOSX/'));
  if (names.length > 50_000) throw new Error('This zip has too many files.');
  for (const n of names) if (/^[a-zA-Z]:/.test(n) || n.split('/').some((p) => p === '..')) throw new Error('This zip has unsafe paths in it and was not installed.');
  return names;
}

/** What a client mod zip holds, for the list (reads only the central directory). */
function clientInfo(file: string): { typeLabel: string; description: string } {
  try {
    const zip = new ZipFile(file);
    try {
      const names = zip.names().map(ZipFile.normalise);
      const levels = [...new Set(names.map((n) => /^levels\/([^/]+)\/info\.json$/i.exec(n)?.[1]).filter(Boolean))] as string[];
      if (levels.length) return { typeLabel: 'Map', description: `Map path for Settings → Custom map: ${levels.map((l) => `/levels/${l}/info.json`).join(', ')}` };
      const cars = [...new Set(names.map((n) => /^vehicles\/([^/]+)\//i.exec(n)?.[1]).filter(Boolean))] as string[];
      if (cars.length) return { typeLabel: 'Vehicle', description: `Vehicles: ${cars.slice(0, 8).join(', ')}${cars.length > 8 ? ', ...' : ''}` };
      return { typeLabel: 'Client mod', description: 'Sent to players when they join.' };
    } finally {
      zip.close();
    }
  } catch {
    return { typeLabel: 'Unreadable zip', description: 'This file could not be read as a zip. Players may fail to load it.' };
  }
}

function folderSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += folderSize(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}

export function listBeammpMods(r: ServerRecord) {
  const items = [];
  for (const enabled of [true, false]) {
    const client = dirOf(r, 'client', enabled);
    if (existsSync(client))
      for (const e of readdirSync(client, { withFileTypes: true })) {
        if (!e.isFile() || !/\.zip$/i.test(e.name)) continue;
        const info = clientInfo(path.join(client, e.name));
        items.push({ id: `client:${enabled ? 'on' : 'off'}:${e.name}`, file: e.name, enabled, name: e.name.replace(/\.zip$/i, ''), version: '', description: info.description, authors: '', size: statSync(path.join(client, e.name)).size, type: 'client', typeLabel: info.typeLabel, typeClass: info.typeLabel === 'Unreadable zip' ? 'bad' : 'resource' });
      }
    const server = dirOf(r, 'server', enabled);
    if (existsSync(server))
      for (const e of readdirSync(server, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(server, e.name);
        const lua = readdirSync(dir).some((n) => /\.lua$/i.test(n));
        items.push({ id: `server:${enabled ? 'on' : 'off'}:${e.name}`, file: e.name, enabled, name: e.name, version: '', description: lua ? 'Runs on the server.' : 'No .lua files at the top of this folder: BeamMP may not load it.', authors: '', size: folderSize(dir), type: 'server', typeLabel: 'Server plugin', typeClass: lua ? 'behavior' : 'bad' });
      }
  }
  return items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'client' ? -1 : 1));
}

function installed(r: ServerRecord, id: string) {
  const item = listBeammpMods(r).find((m) => m.id === id);
  if (!item) throw new Error('That mod is not installed.');
  return { item, kind: item.type as Kind, at: path.join(dirOf(r, item.type as Kind, item.enabled), item.file) };
}

/** Puts a folder or file in place, replacing what was there (keeping it switched off if it was). */
function place(r: ServerRecord, kind: Kind, name: string, from: string): { action: string; enabled: boolean } {
  if (!safeName(name)) throw new Error(`"${name}" isn't a usable name.`);
  const offAt = path.join(dirOf(r, kind, false), name);
  const enabled = !existsSync(offAt);
  const target = path.join(dirOf(r, kind, enabled, true), name);
  const existed = existsSync(target);
  if (existed) rmSync(target, { recursive: true, force: true });
  renameSync(from, target);
  return { action: existed ? 'updated' : 'installed', enabled };
}

function noLinks(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error('This zip contains links and was not installed.');
    if (e.isDirectory()) noLinks(p);
  }
}

export const beammpMods: AddonSupport = {
  accept: '.zip',
  needsStopped: true,
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp:
      'Drop BeamNG.drive mod <b>.zip</b> files (cars, maps) or BeamMP server plugin <b>.zip</b> files here. Car and map mods go to Resources/Client and players download them when they join. Plugins go to Resources/Server. Stop the server first; start it again to load changes.',
  }),
  links: [
    { label: 'BeamNG mods', url: 'https://www.beamng.com/resources/', help: 'The official BeamNG.drive mod repository: cars, maps and more. Download the .zip and it is added to this server.' },
    { label: 'BeamMP forum', url: 'https://forum.beammp.com/', help: 'BeamMP server plugins and multiplayer resources (Resources category).' },
  ],
  list: listBeammpMods,

  async install(r, file, source) {
    if (!/\.zip$/i.test(file)) throw new Error('BeamMP mods and plugins are .zip files.');
    const zip = new ZipFile(file);
    let names: string[];
    try {
      names = entryNames(zip);
    } finally {
      zip.close();
    }
    const lower = names.map((n) => n.toLowerCase());
    // A package laid out like the server: "Resources/Client/..." or "Resources/Server/...", at the top or in one folder.
    const pkg = names.map((n) => /^((?:[^/]+\/)?resources\/)(?:client|server)\//i.exec(n)?.[1]).find(Boolean);
    const prefix = pkg ?? null;
    const tops = new Set(lower.map((n) => n.split('/')[0]));
    const isClientMod = [...tops].some((t) => MOD_ROOTS.has(t));
    const rootLua = lower.some((n) => !n.includes('/') && n.endsWith('.lua'));
    const singleTop = tops.size === 1 ? [...tops][0] : null;
    const folderLua = !!singleTop && lower.some((n) => n.startsWith(singleTop + '/') && n.split('/').length === 2 && n.endsWith('.lua'));
    if (!prefix && !isClientMod && !rootLua && !folderLua)
      throw new Error("This zip isn't a BeamNG.drive mod (no vehicles/, levels/ or similar folder inside) or a BeamMP server plugin (no .lua files). If it's a pack of several mods, unzip it and add them one by one.");

    const scan = await defenderScan(path.resolve(file));
    if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat ?? 'a threat'}.`);
    const warnings: string[] = [];
    if (scan.result !== 'clean' && !noScannerIsNormal) warnings.push(`${SCANNER} could not scan this file (${scan.result}).`);
    const results: { name: string; version: string; type: string; action: string; source: string | null }[] = [];

    // A client mod goes in as the zip itself (players download exactly this file).
    if (!prefix && isClientMod) {
      const name = path.basename(file).replace(/[^\w. +()\-\[\]]/g, '_');
      const res = resourcesDir(r);
      mkdirSync(res, { recursive: true });
      const temp = path.join(res, `.sf-upload-${randomUUID()}.tmp`);
      try {
        copyFileSync(file, temp);
        const { action, enabled } = place(r, 'client', name, temp);
        results.push({ name: name.replace(/\.zip$/i, ''), version: '', type: 'client', action, source });
        if (!enabled) warnings.push('This mod was switched off before, so it stays off. Switch it on to send it to players.');
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
      }
      const info = clientInfo(path.join(dirOf(r, 'client', true), name));
      if (info.typeLabel === 'Map') warnings.push(`To play on this map, set Map to "Custom map" in Settings with this path: ${info.description.split(': ').pop()}`);
      return { installed: results, warnings };
    }

    // Plugins and packages: unpack next to the resources folder (same drive, so moving into place is a rename).
    const res = resourcesDir(r);
    mkdirSync(res, { recursive: true });
    const staging = path.join(res, `.sf-staging-${randomUUID()}`);
    try {
      await extractZip(file, staging);
      noLinks(staging);
      if (prefix) {
        const base = path.join(staging, ...prefix.split('/').filter(Boolean));
        const found = (sub: string) => {
          const want = readdirSync(base).find((n) => n.toLowerCase() === sub);
          return want ? path.join(base, want) : null;
        };
        const server = found('server');
        if (server)
          for (const e of readdirSync(server, { withFileTypes: true }).filter((x) => x.isDirectory())) {
            const { action } = place(r, 'server', e.name, path.join(server, e.name));
            results.push({ name: e.name, version: '', type: 'server', action, source });
          }
        const client = found('client');
        if (client)
          for (const e of readdirSync(client, { withFileTypes: true }).filter((x) => x.isFile() && /\.zip$/i.test(x.name))) {
            const { action } = place(r, 'client', e.name, path.join(client, e.name));
            results.push({ name: e.name.replace(/\.zip$/i, ''), version: '', type: 'client', action, source });
          }
        if (!results.length) throw new Error('This package has a Resources folder but no plugin folders in Resources/Server or .zip mods in Resources/Client.');
      } else if (rootLua) {
        const name = path.basename(file).replace(/\.zip$/i, '').replace(/[^\w. +()\-]/g, '_');
        const { action } = place(r, 'server', name, staging);
        results.push({ name, version: '', type: 'server', action, source });
      } else {
        const folder = readdirSync(staging).find((n) => n.toLowerCase() === singleTop)!;
        const { action } = place(r, 'server', folder, path.join(staging, folder));
        results.push({ name: folder, version: '', type: 'server', action, source });
      }
    } finally {
      if (path.dirname(staging) !== res) throw new Error('Unexpected staging path.');
      rmSync(staging, { recursive: true, force: true });
    }
    if (results.some((x) => x.type === 'server')) warnings.push('Server plugins run code on this server. Only install plugins you trust. Check the plugin page for any settings it needs.');
    return { installed: results, warnings };
  },

  setEnabled(r, id, enabled) {
    const { item, kind, at } = installed(r, id);
    if (item.enabled === enabled) return;
    const target = path.join(dirOf(r, kind, enabled, true), item.file);
    if (existsSync(target)) throw new Error('Another copy with this name already exists. Remove that copy first.');
    renameSync(at, target);
  },

  remove(r, id) {
    const { at } = installed(r, id);
    rmSync(at, { recursive: true, force: true });
  },

  icon: () => null,
};
