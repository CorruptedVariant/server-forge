// Mods tab for Valheim servers: BepInEx + Thunderstore mods (see valheim-mods.ts), plus what the players' app
// (Tavern Client Mod Manager) needs to mirror the server's mods.
import { existsSync, copyFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { AddonSupport, ServerRecord } from './types.ts';
import { dataPath } from '../store.ts';
import * as vm from '../valheim-mods.ts';
import { scanPackage, noScannerIsNormal } from '../modscan.ts';
import { nexusFromFileName } from '../nexus.ts';
import { activeIsVanilla } from './valheim-profiles.ts';
import { listSettingsFiles, readSettings, writeSettings, sharedSettings } from './valheim-settings.ts';

const SIDES = [
  { value: 'both', label: 'Server + players' },
  { value: 'server', label: 'Server only' },
  { value: 'clients', label: 'Players only' },
];
const SIDE_HELP: Record<string, string> = {
  both: 'Installed on the server and synced to players.',
  server: 'Only the server runs it; players don\'t need it.',
  clients: 'Players need it (e.g. UI mods). The server keeps it only to share it and doesn\'t load it.',
};

/**
 * Safety check for every package the server installs: Windows Defender (a detection stops the install), Thunderstore
 * status and the behaviour scan (shown as warnings: the owner chose the mod; players' apps check again themselves).
 */
function safetyCheck(warnings: string[]): vm.InstallOptions['check'] {
  return async (zipFile, pkg) => {
    const site = pkg.namespace === 'Local' || pkg.namespace === 'Nexus' ? null : vm.registryOf(pkg.source);
    const status = site ? await vm.versionStatus(pkg.namespace, pkg.name, pkg.version, site) : { active: null, deprecated: false };
    const r = await scanPackage(zipFile, { fullName: `${pkg.namespace}-${pkg.name}`, thunderstoreActive: status.active, deprecated: status.deprecated });
    if (r.verdict === 'blocked') throw new Error(`Not installed: ${pkg.name} ${pkg.version}. ${r.summary}.`);
    for (const f of r.flags) warnings.push(`${f.level === 'high' ? '⛔ Safety check' : '⚠ Safety check'}: ${pkg.name}: ${f.text}${f.file ? ` (${f.file})` : ''}.`);
    if (!noScannerIsNormal && (r.defender === 'unavailable' || r.defender === 'error')) warnings.push(`⚠ ${pkg.name}: Windows Defender couldn't scan it (another antivirus may be in charge).`);
  };
}

/** The server loads a mod only if it's on and not "players only" (those are kept here just to share them). */
export function placeOnServer(record: ServerRecord, full: string) {
  const m = vm.loadRegistry(record.installDir).mods[full];
  if (m) vm.placeMod(record.installDir, full, m.enabled && m.side !== 'clients');
}

/** Where copies of uploaded (non-Thunderstore) mods are kept, so the players' app can download them from here. */
export function uploadCopy(serverId: string, full: string, version: string) {
  return dataPath('valheim-uploads', serverId, `${full}-${version}.zip`);
}

function items(record: ServerRecord) {
  const dir = record.installDir;
  const reg = vm.loadRegistry(dir);
  const out: any[] = Object.values(reg.mods).map((m) => {
    const full = vm.fullName(m);
    const needed = vm.dependents(dir, full);
    const warnings: { level: 'error' | 'warn'; text: string }[] = [];
    if (!m.enabled && needed.length) warnings.push({ level: 'warn', text: `Switched off, but ${needed.join(', ')} need${needed.length === 1 ? 's' : ''} it.` });
    for (const d of m.dependencies) {
      const ref = vm.parseRef(d);
      if (!ref || (ref.namespace === vm.BEPINEX_PACK.namespace && ref.name === vm.BEPINEX_PACK.name)) continue;
      const have = reg.mods[vm.fullName(ref)];
      if (!have) warnings.push({ level: 'error', text: `Needs ${ref.name} ${ref.version}, which isn't installed.` });
      else if (!have.enabled) warnings.push({ level: 'error', text: `Needs ${ref.name}, which is switched off.` });
    }
    return {
      id: full,
      name: m.name.replace(/_/g, ' '),
      version: m.version,
      description: m.description,
      authors: m.namespace,
      typeLabel: m.asDependency ? 'Dependency' : 'Mod',
      typeClass: m.asDependency ? 'dep' : 'mod',
      enabled: m.enabled,
      hasIcon: !!vm.modIcon(dir, full),
      source: m.source === 'upload' ? (m.namespace === 'Nexus' ? 'Nexus Mods' : 'uploaded file') : m.source === 'hexium' ? 'Hexium' : 'Thunderstore',
      side: m.side,
      sideHelp: SIDE_HELP[m.side],
      warnings,
      file: full,
    };
  });
  // DLLs dropped into BepInEx/plugins by hand: shown so nothing is hidden, but Server Forge can't sync them.
  for (const loose of vm.looseMods(dir)) {
    out.push({
      id: `loose:${loose}`,
      name: loose,
      version: '',
      description: 'Added to BepInEx/plugins by hand, not through Server Forge.',
      typeLabel: 'Manual',
      typeClass: 'manual',
      enabled: true,
      hasIcon: false,
      source: null,
      warnings: [{ level: 'warn', text: "The Tavern Client Mod Manager can't share this one. Reinstall it from Thunderstore (or upload its zip) to share it." }],
      file: loose,
      readOnly: true,
    });
  }
  return out.sort((a, b) => Number(a.typeClass === 'dep') - Number(b.typeClass === 'dep') || a.name.localeCompare(b.name));
}

async function install(record: ServerRecord, file: string, source: string | null, identity?: { namespace: string; name: string; version: string }) {
  if (!vm.bepinexStatus(record.installDir).installed) throw new Error('This is a vanilla server. Turn on modding first (top of the Mods tab).');
  if (/\.(7z|rar)$/i.test(file)) throw new Error('Only .zip mods can be installed. Repack it as a .zip (7-Zip can do it) and add that.');
  if (!/\.zip$/i.test(file)) throw new Error('Valheim mods are .zip files (from Thunderstore: "Manual Download").');
  const manifest = vm.readPackageZip(file);
  // Thunderstore downloads are named Author-Mod-1.2.3.zip, Nexus Mods ones Mod Name-<id>-<version>-<time>.zip; anything
  // else is treated as a local upload. Nexus mods are shared with players from this system, like uploads.
  const nexusRef = identity ?? nexusFromFileName(file);
  const ref = nexusRef ? null : vm.refFromFileName(file);
  const fromThunderstore = !!ref && (!manifest.name || manifest.name.toLowerCase() === ref.name.toLowerCase());
  const namespace = nexusRef ? nexusRef.namespace : fromThunderstore ? ref!.namespace : 'Local';
  const name = (nexusRef ? nexusRef.name : fromThunderstore ? ref!.name : manifest.name || path.basename(file, '.zip')).replace(/[^\w.]/g, '_');
  const version = manifest.version || nexusRef?.version || ref?.version || '1.0.0';
  const logLines: string[] = [];
  const safety: string[] = [];
  const report = await vm.installWithDependencies(
    record.installDir,
    { namespace, name, version, zipFile: file, source: fromThunderstore ? 'thunderstore' : 'upload' },
    (l) => logLines.push(l),
    { check: safetyCheck(safety) },
  );
  // Mods Thunderstore marks as client-side only are kept for players but not loaded by the server.
  for (const i of report.installed) placeOnServer(record, i.full);
  if (!fromThunderstore) {
    const copy = uploadCopy(record.id, `${namespace}-${name}`, version);
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(file, copy);
  }
  const warnings = [...safety, ...report.warnings];
  if (!fromThunderstore) warnings.push(`"${name.replace(/_/g, ' ')}" ${nexusRef ? 'is from Nexus Mods' : "isn't a Thunderstore download"}, so players' Tavern Client Mod Manager gets it from this system (remote access must be on).`);
  const deps = report.installed.filter((i) => i.asDependency && i.action !== 'kept');
  if (deps.length) warnings.push(`Also installed what it needs: ${deps.map((d) => `${d.name} ${d.version}`).join(', ')}.`);
  return {
    installed: report.installed.filter((i) => i.action !== 'kept').map((i) => ({ name: i.name.replace(/_/g, ' '), type: i.asDependency ? 'dependency' : 'mod', version: i.version, action: i.action })),
    warnings,
    source,
  };
}

export const valheimAddons: AddonSupport = {
  labels: () => ({
    tab: 'Mods',
    noun: 'mod',
    plural: 'mods',
    dropHelp:
      'Drop a Valheim mod <b>.zip</b> here (Thunderstore\'s "Manual Download"), or choose one. Server Forge installs BepInEx if needed, puts the files in the right place and installs the mods it depends on.',
  }),
  accept: '.zip',
  needsStopped: true,
  links: [
    { label: 'Thunderstore', url: 'https://thunderstore.io/c/valheim/', help: 'Where almost all Valheim mods are. Click "Manual Download" on a mod.' },
    { label: 'Server-side mods', url: 'https://thunderstore.io/c/valheim/?included_categories=server-side', help: 'Mods tagged as working on dedicated servers.' },
    {
      label: 'Hexium',
      url: 'https://valheim.hexium.gg/',
      help: 'A newer Valheim mod site (some mod makers moved here). "Download" or "Install with Gale" installs the mod and what it needs.',
    },
    {
      label: 'Nexus Mods',
      url: 'https://www.nexusmods.com/games/valheim/mods',
      help: 'Log in, then "Manual download" (any account), or "Mod Manager Download" with your API key in Settings → Integrations.',
    },
  ],
  sides: SIDES,
  // Valheim servers start vanilla. Modding (BepInEx) is turned on once, on purpose, and stays on: mods add items,
  // buildings and data to the world that would break without them.
  isOn: (record) => vm.bepinexStatus(record.installDir).installed,
  status(record) {
    const s = vm.bepinexStatus(record.installDir);
    return s.installed
      ? { ok: true, title: `Modding is on (BepInEx ${s.version})`, text: 'This is a modded server. Modding stays on: mods add things to the world that would break without them.' }
      : {
          ok: false,
          title: 'Vanilla server: modding is off',
          text: 'Turn on modding to add mods. This installs the BepInEx mod loader and is permanent for this server, because mods add items, buildings and data to the world that would break without them.',
          setupLabel: 'Turn on modding',
          confirm:
            'Turn on modding for this server?\n\nThis installs BepInEx, the Valheim mod loader. It is permanent for this server: once mods have added things to the world, removing them can break it.\n\nTip: make a backup first (Backups tab) if you might want the vanilla world back.',
        };
  },
  async setup(record, log) {
    await vm.installWithDependencies(record.installDir, { ...vm.BEPINEX_PACK }, log, { check: safetyCheck([]) });
    return 'Modding is on. You can add mods now.';
  },
  list: items,
  install,
  settings: { list: listSettingsFiles, read: readSettings, write: writeSettings },
  remove(record, id) {
    if (id.startsWith('loose:')) {
      // Only something directly in BepInEx/plugins that looseMods() lists (the id comes from the request).
      const name = id.slice(6);
      if (!vm.looseMods(record.installDir).includes(name)) throw new Error('That mod is not in the plugins folder.');
      const target = path.join(record.installDir, 'BepInEx', 'plugins', name);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      return;
    }
    const needed = vm.dependents(record.installDir, id);
    if (needed.length) throw new Error(`${needed.join(', ')} need${needed.length === 1 ? 's' : ''} this mod. Remove ${needed.length === 1 ? 'it' : 'them'} first.`);
    vm.removeMod(record.installDir, id);
  },
  setEnabled(record, id, enabled) {
    if (id.startsWith('loose:')) throw new Error("Mods added by hand can't be switched off here; remove them instead.");
    vm.setModEnabled(record.installDir, id, enabled);
    placeOnServer(record, id);
  },
  icon: (record, id) => vm.modIcon(record.installDir, id),
  setSide(record, id, side) {
    vm.setModSide(record.installDir, id, side as vm.Side);
    placeOnServer(record, id);
  },
  async checkUpdates(record) {
    const reg = vm.loadRegistry(record.installDir);
    const out: Record<string, string> = {};
    const mods = Object.values(reg.mods).filter((m) => vm.registryOf(m.source));
    await Promise.all(
      mods.map(async (m) => {
        try {
          const latest = await vm.latestPackage(m.namespace, m.name, vm.registryOf(m.source)!);
          if (vm.compareVersions(latest.version, m.version) > 0) out[vm.fullName(m)] = latest.version;
        } catch {}
      }),
    );
    return out;
  },
  async update(record, id) {
    const m = vm.loadRegistry(record.installDir).mods[id];
    if (!m) throw new Error('That mod is not installed.');
    const safety: string[] = [];
    const report = await vm.installWithDependencies(record.installDir, { namespace: m.namespace, name: m.name, side: m.side, source: m.source }, () => {}, { check: safetyCheck(safety) });
    for (const i of report.installed) placeOnServer(record, i.full);
    return {
      installed: report.installed.filter((i) => i.action !== 'kept').map((i) => ({ name: i.name, type: i.asDependency ? 'dependency' : 'mod', version: i.version, action: i.action })),
      warnings: [...safety, ...report.warnings],
    };
  },
};

/** Takes over mods put on the server without Server Forge (see adoptLooseMods), so they can be shared. */
export async function adoptManualMods(record: ServerRecord) {
  const r = await vm.adoptLooseMods(record.installDir);
  for (const full of Object.keys(vm.loadRegistry(record.installDir).mods)) placeOnServer(record, full);
  return r;
}

/** What the share card shows: how many mods players get, and which ones they don't (and why). */
export function shareSummary(record: ServerRecord) {
  const reg = vm.loadRegistry(record.installDir);
  const mods = Object.values(reg.mods);
  return {
    shared: shareManifest(record).mods.length,
    settings: sharedSettings(record).length,
    vanilla: activeIsVanilla(record),
    serverOnly: mods.filter((m) => m.enabled && m.side === 'server').map((m) => m.name.replace(/_/g, ' ')),
    off: mods.filter((m) => !m.enabled).map((m) => m.name.replace(/_/g, ' ')),
    manual: vm.looseMods(record.installDir),
    uploadsMissing: mods.filter((m) => m.enabled && m.side !== 'server' && m.source === 'upload' && !existsSync(uploadCopy(record.id, vm.fullName(m), m.version))).map((m) => m.name.replace(/_/g, ' ')),
  };
}

/** Installs a mod from Hexium (latest version unless one is given), with what it depends on. */
export async function installFromHexium(record: ServerRecord, pkg: { namespace: string; name: string; version?: string | null }) {
  if (!vm.bepinexStatus(record.installDir).installed) throw new Error('This is a vanilla server. Turn on modding first (top of the Mods tab).');
  const safety: string[] = [];
  const report = await vm.installWithDependencies(record.installDir, { namespace: pkg.namespace, name: pkg.name, version: pkg.version ?? undefined, source: 'hexium' }, () => {}, { check: safetyCheck(safety) });
  for (const i of report.installed) placeOnServer(record, i.full);
  const deps = report.installed.filter((i) => i.asDependency && i.action !== 'kept');
  return {
    installed: report.installed.filter((i) => i.action !== 'kept').map((i) => ({ name: i.name.replace(/_/g, ' '), type: i.asDependency ? 'dependency' : 'mod', version: i.version, action: i.action })),
    warnings: [...safety, ...report.warnings, ...(deps.length ? [`Also installed what it needs: ${deps.map((d) => `${d.name} ${d.version}`).join(', ')}.`] : [])],
  };
}

/**
 * Players' apps from before Hexium support only know Thunderstore and "files from the server", so Hexium mods are
 * shared as server files too. Fetches (once) the copy the players' app asks for, if it's one of this server's Hexium
 * mods. Returns false when the name isn't one.
 */
export async function ensureHexiumCopy(record: ServerRecord, fileName: string): Promise<boolean> {
  const mod = Object.values(vm.loadRegistry(record.installDir).mods).find((m) => m.source === 'hexium' && `${vm.fullName(m)}-${m.version}.zip` === fileName);
  if (!mod) return false;
  const copy = uploadCopy(record.id, vm.fullName(mod), mod.version);
  if (!existsSync(copy)) {
    mkdirSync(path.dirname(copy), { recursive: true });
    await vm.downloadTo(await vm.packageDownloadUrl(mod.namespace, mod.name, mod.version, 'hexium'), `${copy}.part`);
    renameSync(`${copy}.part`, copy);
  }
  return true;
}

/** The server's mod list as the players' app needs it (players' side only: "both" and "clients" mods). */
export function shareManifest(record: ServerRecord) {
  const reg = vm.loadRegistry(record.installDir);
  // A vanilla profile is active (BepInEx off): players need no mods.
  const vanilla = activeIsVanilla(record);
  const mods = Object.values(reg.mods)
    .filter((m) => !vanilla && m.enabled && m.side !== 'server')
    .map((m) => ({
      namespace: m.namespace,
      name: m.name,
      version: m.version,
      side: m.side,
      // Hexium mods are listed as server files (older players' apps only know Thunderstore and server files) and marked
      // with site: "hexium", so newer apps download them straight from Hexium.
      source: m.source === 'hexium' ? ('upload' as const) : m.source,
      site: m.source === 'hexium' ? 'hexium' : undefined,
      dependencies: m.dependencies,
      description: m.description,
      // Uploaded mods are only on this system; the players' app downloads them from Server Forge.
      file:
        m.source === 'hexium' || (m.source === 'upload' && existsSync(uploadCopy(record.id, vm.fullName(m), m.version))) ? `${vm.fullName(m)}-${m.version}.zip` : null,
    }));
  // Mod settings the owner sends to players (Tavern Client Mod Manager 0.5.1 and newer; older apps ignore them).
  return { server: record.name, game: 'valheim', bepinex: vanilla ? null : (reg.bepinex?.version ?? null), mods, settings: sharedSettings(record), generatedAt: Date.now() };
}
