import { existsSync, readdirSync, lstatSync, mkdirSync, copyFileSync, renameSync, unlinkSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZipFile } from '../zip.ts';
import { defenderScan, SCANNER, noScannerIsNormal } from '../modscan.ts';
import type { AddonSupport, ServerRecord } from './types.ts';

const base = (r: ServerRecord) => existsSync(path.join(r.installDir, 'Server', 'HytaleServer.jar')) ? path.join(r.installDir, 'Server') : r.installDir;
const folder = (r: ServerRecord, enabled = true) => path.join(base(r), enabled ? 'mods' : '.sf-disabled-mods');
const supported = (name: string) => /\.(jar|zip)$/i.test(name);

function metadata(file: string) {
  const zip = new ZipFile(file);
  try {
    const raw = zip.get('manifest.json', 256 * 1024);
    if (!raw) throw new Error('No manifest.json at the archive root. Choose the Hytale mod itself, rather than a modpack, source archive or Minecraft mod.');
    const m = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
    if (!m || typeof m.Name !== 'string' || !m.Name.trim()) throw new Error('The Hytale manifest must contain a Name.');
    return {
      name: m.Name.slice(0, 200),
      identity: typeof m.Group === 'string' && m.Group ? `${m.Group}:${m.Name}` : null,
      version: typeof m.Version === 'string' ? m.Version.slice(0, 100) : '',
      description: typeof m.Description === 'string' ? m.Description.slice(0, 2000) : '',
      authors: Array.isArray(m.Authors) ? m.Authors.map((a: unknown) => typeof a === 'string' ? a : a && typeof a === 'object' && 'Name' in a ? String(a.Name) : '').filter(Boolean).join(', ').slice(0, 500) : '',
      dependencies: m.Dependencies && typeof m.Dependencies === 'object' && !Array.isArray(m.Dependencies) ? Object.keys(m.Dependencies) : [],
    };
  } finally { zip.close(); }
}

function safeFolder(r: ServerRecord, enabled: boolean, create = false) {
  const dir = folder(r, enabled);
  if (create) mkdirSync(dir, { recursive: true });
  if (existsSync(dir) && (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())) throw new Error('The Hytale mods folder must be a real directory, not a link.');
  return dir;
}

export function listHytaleMods(r: ServerRecord) {
  const items = [];
  for (const enabled of [true, false]) {
    const dir = safeFolder(r, enabled);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !supported(e.name)) continue;
      const file = path.join(dir, e.name);
      let info;
      let problem = '';
      try { info = metadata(file); } catch (err) { problem = (err as Error).message; }
      items.push({ id: `${enabled ? 'on' : 'off'}:${e.name}`, file: e.name, enabled, name: info?.name ?? e.name, version: info?.version ?? '', description: problem || info?.description || '', authors: info?.authors ?? '', identity: info?.identity ?? null, size: lstatSync(file).size, type: 'mod', typeLabel: problem ? 'Invalid Hytale mod' : /\.jar$/i.test(e.name) ? 'Hytale plugin' : 'Hytale asset pack', typeClass: problem ? 'bad' : 'behavior' });
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function installed(r: ServerRecord, id: string) {
  const item = listHytaleMods(r).find(m => m.id === id);
  if (!item) throw new Error('That Hytale mod is not installed.');
  return { item, file: path.join(safeFolder(r, item.enabled), item.file) };
}

export const hytaleMods: AddonSupport = {
  accept: '.jar,.zip', needsStopped: true,
  labels: () => ({ tab: 'Mods', noun: 'mod', plural: 'mods', dropHelp: 'Drop Hytale <b>.jar</b> plugins or <b>.zip</b> asset packs here, or browse the sites below. Stop the server before making changes. Start it again to load the mods. Use Files to edit mod settings while stopped.' }),
  curseforgeGame: 'hytale',
  links: [
    { label: 'CurseForge', url: 'https://www.curseforge.com/hytale/mods', help: 'Hytale’s official mod distribution partner. Use Download for a .jar or .zip.' },
    { label: 'Nexus Mods', url: 'https://www.nexusmods.com/games/hytale/mods', help: 'Use Manual download, or Mod Manager Download with your Nexus API key.' },
    { label: 'Modtale', url: 'https://modtale.net/mods', help: 'Hytale mods and asset packs. Download the server mod file.' },
    { label: 'Thunderstore', url: 'https://thunderstore.io/c/hytale/', help: 'Use Download. Server Forge installs the Hytale mod files inside the package; add required mods separately.' },
    { label: 'BuiltByBit', url: 'https://builtbybit.com/resources/hytale/plugins/', help: 'Free and paid server plugins. Sign in or purchase there, then download the mod file.' },
  ],
  list: listHytaleMods,
  async install(r, file, source) {
    if (!supported(file)) throw new Error('Hytale mods must be .jar or .zip files.');
    // Site packages (notably Thunderstore) wrap the Hytale mod in a ZIP with store metadata.
    // Only unpack archive payloads; never extract arbitrary paths supplied by a download.
    let info;
    try { info = metadata(file); }
    catch (original) {
      if (!/\.zip$/i.test(file)) throw original;
      const zip = new ZipFile(file);
      const work = mkdtempSync(path.join(os.tmpdir(), 'sf-hytale-package-'));
      try {
        const entries = zip.names().filter(n => /\.(jar|zip)$/i.test(n) && !n.includes('__MACOSX'));
        if (!entries.length || entries.length > 30) throw original;
        const payloads: string[] = [];
        let total = 0;
        for (const entry of entries) {
          const data = zip.get(entry, 128 * 1024 * 1024);
          if (!data || (total += data.length) > 256 * 1024 * 1024) throw new Error('This mod package is too large or could not be read. Upload the individual Hytale mod files instead.');
          const name = path.posix.basename(entry.replace(/\\/g, '/')).replace(/[^\w. +()-]/g, '_');
          const payload = path.join(work, `${payloads.length}-${name}`);
          writeFileSync(payload, data);
          metadata(payload); // Validate every mod before installing any of them; no recursive wrapper extraction.
          payloads.push(payload);
        }
        const scan = await defenderScan(path.resolve(file));
        if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat ?? 'a threat'}.`);
        const installed: unknown[] = [];
        const warnings = ['Package contents installed. Check the mod page for required dependencies and add them separately.'];
        for (const payload of payloads) {
          const result = await hytaleMods.install(r, payload, source);
          installed.push(...result.installed);
          warnings.push(...result.warnings);
        }
        return { installed, warnings: [...new Set(warnings)] };
      } finally {
        zip.close();
        if (path.dirname(work) !== os.tmpdir()) throw new Error('Unexpected mod staging path.');
        rmSync(work, { recursive: true, force: true });
      }
    }
    const scan = await defenderScan(path.resolve(file));
    if (scan.result === 'threat') throw new Error(`Not installed: ${SCANNER} found ${scan.threat ?? 'a threat'}.`);
    const warnings: string[] = [];
    if (scan.result !== 'clean' && !noScannerIsNormal) warnings.push(`${SCANNER} could not scan this file (${scan.result}).`);
    const existing = listHytaleMods(r);
    const name = path.basename(file).replace(/[^\w. +()-]/g, '_');
    if (!supported(name) || name.length > 180) throw new Error('Choose a shorter mod filename ending in .jar or .zip.');
    const same = existing.filter(m => (info.identity && m.identity === info.identity) || m.file.toLowerCase() === name.toLowerCase());
    if (same.length > 1) throw new Error('Multiple copies of this mod are installed. Remove the duplicates before updating.');
    const old = same[0];
    const enabled = old?.enabled ?? true;
    const dir = safeFolder(r, enabled, true);
    const target = path.join(dir, old?.file ?? name);
    // Copy to a unique temporary file then replace, so failed copies leave the old mod intact.
    const temp = path.join(dir, `.sf-upload-${crypto.randomUUID()}.tmp`);
    try { copyFileSync(file, temp); renameSync(temp, target); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    const have = new Set(existing.filter(m => m.enabled).map(m => m.identity));
    for (const dep of info.dependencies) if (enabled && !dep.startsWith('Hytale:') && !have.has(dep) && dep !== info.identity) warnings.push(`Required dependency: ${dep}. Install a compatible version if it is not supplied by Hytale itself.`);
    return { installed: [{ name: info.name, version: info.version, type: 'mod', action: old ? 'updated' : 'installed', source }], warnings };
  },
  setEnabled(r, id, enabled) {
    const { item, file } = installed(r, id);
    if (item.enabled === enabled) return;
    const dir = safeFolder(r, enabled, true);
    const target = path.join(dir, item.file);
    if (existsSync(target)) throw new Error('Another copy with this filename already exists. Remove that copy first.');
    renameSync(file, target);
  },
  remove(r, id) { unlinkSync(installed(r, id).file); },
  icon: () => null,
};
