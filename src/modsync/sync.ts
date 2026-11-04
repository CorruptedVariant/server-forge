// Tavern Client Mod Manager (the players' app): finds Valheim, reads a server's shared mod list from a thmods:// link and
// makes the game's mods match it. Mods the player installed themselves are left alone; mods that came from the link
// and were dropped by the server are removed.
import https from 'node:https';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { scanPackage, type ScanResult } from '../modscan.ts';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as vm from '../valheim-mods.ts';
import { parseCfg, setValues, checkChange, isCfgName } from '../bepinex-config.ts';

export const VALHEIM_APP_ID = 892970;

// ---------- finding Valheim ----------

export function steamPath(): string | null {
  for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', key.startsWith('HKCU') ? 'SteamPath' : 'InstallPath'], { encoding: 'utf-8', windowsHide: true });
      const m = /REG_SZ\s+(.+)/.exec(out);
      if (m) return m[1].trim().replace(/\//g, '\\');
    } catch {}
  }
  return null;
}

/** Valheim's game folder from Steam's library list, or null. */
export function findValheim(): string | null {
  const steam = steamPath();
  const libraries = new Set<string>();
  if (steam) {
    libraries.add(steam);
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    if (existsSync(vdf)) for (const m of readFileSync(vdf, 'utf-8').matchAll(/"path"\s+"([^"]+)"/g)) libraries.add(m[1].replace(/\\\\/g, '\\'));
  }
  for (const drive of ['C', 'D', 'E', 'F']) libraries.add(`${drive}:\\Program Files (x86)\\Steam`), libraries.add(`${drive}:\\SteamLibrary`);
  for (const lib of libraries) {
    const acf = path.join(lib, 'steamapps', `appmanifest_${VALHEIM_APP_ID}.acf`);
    const installdir = existsSync(acf) ? (/"installdir"\s+"([^"]+)"/.exec(readFileSync(acf, 'utf-8'))?.[1] ?? 'Valheim') : 'Valheim';
    const dir = path.join(lib, 'steamapps', 'common', installdir);
    if (existsSync(path.join(dir, 'valheim.exe'))) return dir;
  }
  return null;
}

export function isValheimFolder(dir: string) {
  return existsSync(path.join(dir, 'valheim.exe'));
}

// ---------- links ----------

export interface Link {
  host: string;
  port: number;
  token: string;
  /** SHA-256 of the server's certificate, uppercase hex without colons. */
  fingerprint: string;
  raw: string;
}

/** thmods://192.168.1.50:8191/<token>?fp=<sha256 hex> */
export function parseLink(text: string): Link {
  const raw = text.trim();
  const m = /^thmods:\/\/([^/:]+):(\d+)\/([\w-]{10,})\?fp=([0-9A-Fa-f:]{64,95})$/.exec(raw);
  if (!m) throw new Error('That isn\'t a Server Forge mod link. It should start with thmods:// (copy it from the server\'s Mods tab).');
  const fingerprint = m[4].replace(/:/g, '').toUpperCase();
  if (fingerprint.length !== 64) throw new Error('The link\'s security fingerprint is damaged; copy the whole link again.');
  return { host: m[1], port: Number(m[2]), token: m[3], fingerprint, raw };
}

/** GET over HTTPS, trusting only the certificate whose fingerprint is in the link. */
export function pinnedGet(link: Link, urlPath: string, asBuffer = false): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        host: link.host,
        port: link.port,
        path: urlPath,
        timeout: 20_000,
        // The server's certificate is self-signed: skip the normal CA check and compare fingerprints instead.
        rejectUnauthorized: false,
        // A fresh connection every time: a reused/resumed TLS session doesn't carry the certificate to check.
        agent: false,
      },
      (res) => {
        const cert = (res.socket as import('node:tls').TLSSocket).getPeerCertificate();
        const fp = String(cert?.fingerprint256 ?? '').replace(/:/g, '').toUpperCase();
        if (fp !== link.fingerprint) {
          res.destroy();
          reject(new Error("The server's security certificate doesn't match the link. Ask the server owner for a fresh link."));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if ((res.statusCode ?? 500) >= 400) {
            let msg = `The server answered ${res.statusCode}.`;
            try {
              msg = JSON.parse(body.toString('utf-8')).error ?? msg;
            } catch {}
            reject(new Error(msg));
          } else resolve(asBuffer ? body : body.toString('utf-8'));
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('The server did not answer (is it on, and is the port forwarded?).')));
    req.on('error', (err) => reject(new Error(/ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND/.test(err.message) ? `Can't reach ${link.host}:${link.port}. Is Server Forge running there with Remote access on?` : err.message)));
  });
}

export interface SharedMod {
  namespace: string;
  name: string;
  version: string;
  side: vm.Side;
  source: 'thunderstore' | 'upload';
  /** "hexium": a Hexium mod (listed as a server file for older apps; this app downloads it from Hexium). */
  site?: 'hexium';
  dependencies: string[];
  description: string;
  file: string | null;
}
/** A mod setting the server owner sends to players (Server Forge 0.6.1 and newer): a value in BepInEx/config/<file>. */
export interface SharedSetting {
  file: string;
  section: string;
  key: string;
  value: string;
}
export interface Manifest {
  server: string;
  game: string;
  bepinex: string | null;
  mods: SharedMod[];
  settings: SharedSetting[];
  generatedAt: number;
}

export async function fetchManifest(link: Link): Promise<Manifest> {
  const m = JSON.parse(String(await pinnedGet(link, `/api/share/${link.token}`))) as Manifest;
  if (m.game !== 'valheim' || !Array.isArray(m.mods)) throw new Error('That link is not a Valheim mod list.');
  return checkManifest(m);
}

// ---------- links for any game (Server Forge 0.6.0 and newer share every game) ----------

export interface Join {
  port: number;
  protocol: string;
}
/** What every share link has, whatever the game. */
export interface AnyManifest {
  server: string;
  game: string;
  gameName: string;
  /** sync: the app keeps the mods matched (Valheim, modded Minecraft Java); links: mods to install with another tool (Satisfactory); info: join details only. */
  mode: 'sync' | 'links' | 'info';
  join: Join | null;
  note: string;
  raw: Record<string, unknown>;
}

const GAMES: Record<string, string> = {
  valheim: 'Valheim',
  java: 'Minecraft Java',
  bedrock: 'Minecraft Bedrock',
  satisfactory: 'Satisfactory',
  terraria: 'Terraria (tModLoader)',
  spaceengineers: 'Space Engineers',
  factorio: 'Factorio',
  palworld: 'Palworld',
  enshrouded: 'Enshrouded',
  sevendays: '7 Days to Die',
  zomboid: 'Project Zomboid',
  vrising: 'V Rising',
};

/** Reads a link of any game. Only the common fields are checked here; each game's sync checks its own part. */
export async function fetchAnyManifest(link: Link): Promise<AnyManifest> {
  const m = JSON.parse(String(await pinnedGet(link, `/api/share/${link.token}`))) as Record<string, unknown>;
  const game = String(m.game ?? '');
  if (!GAMES[game]) throw new Error(`That link is for a game this version of the app doesn't know (${game.slice(0, 40) || 'unknown'}). Check for an update (About & help).`);
  const j = m.join as Partial<Join> | null | undefined;
  const port = Number(j?.port);
  return {
    server: String(m.server ?? '').slice(0, 100),
    game,
    gameName: GAMES[game],
    // Links from Server Forge before 0.6.0 are Valheim-only and have no mode.
    mode: game === 'valheim' ? 'sync' : m.mode === 'sync' || m.mode === 'links' ? m.mode : 'info',
    join: Number.isInteger(port) && port > 0 && port < 65536 ? { port, protocol: j?.protocol === 'UDP' ? 'UDP' : 'TCP' } : null,
    note: String(m.note ?? '').slice(0, 400),
    raw: m,
  };
}

// The list comes from someone else's server, so everything that ends up in a folder name, a file name or a web
// address is checked to be the normal format (a name like "..\..\x" could otherwise reach outside the game folder).
const PART = /^[\w.]{1,100}$/;
const VERSION = /^\d{1,6}(\.\d{1,6}){0,3}$/;
const FILE = /^[\w.-]{1,200}\.zip$/;
export function checkManifest(m: Manifest): Manifest {
  if (m.mods.length > 1000) throw new Error('The server sent more than 1000 mods, which is not a real mod list.');
  const mods = m.mods.map((mod): SharedMod => {
    if (!mod || typeof mod !== 'object' || !PART.test(String(mod.namespace)) || !PART.test(String(mod.name)) || /^\.+$/.test(String(mod.namespace)) || /^\.+$/.test(String(mod.name))) {
      throw new Error('The server sent a mod with an invalid name, so nothing was changed. Ask the server owner to check their mods.');
    }
    if (!VERSION.test(String(mod.version))) throw new Error(`The server sent an invalid version for ${mod.namespace}-${mod.name}, so nothing was changed.`);
    if (mod.file != null && !FILE.test(String(mod.file))) throw new Error(`The server sent an invalid file name for ${mod.namespace}-${mod.name}, so nothing was changed.`);
    return {
      namespace: String(mod.namespace),
      name: String(mod.name),
      version: String(mod.version),
      side: (['both', 'server', 'clients'] as string[]).includes(String(mod.side)) ? mod.side : 'both',
      source: mod.source === 'upload' ? 'upload' : 'thunderstore',
      ...(mod.site === 'hexium' ? { site: 'hexium' as const } : {}),
      dependencies: Array.isArray(mod.dependencies) ? mod.dependencies.map(String).filter((d) => vm.parseRef(d) !== null).slice(0, 200) : [],
      description: String(mod.description ?? '').slice(0, 500),
      file: mod.file == null ? null : String(mod.file),
    };
  });
  const bepinex = m.bepinex == null ? null : VERSION.test(String(m.bepinex)) ? String(m.bepinex) : null;
  return { server: String(m.server ?? '').slice(0, 100), game: 'valheim', bepinex, mods, settings: checkSettings(m.settings), generatedAt: Number(m.generatedAt) || 0 };
}

/**
 * Settings from the server only ever change a value in a mod's config file: the file name must be a plain .cfg name in
 * BepInEx/config (never BepInEx's own BepInEx.cfg), and names and values must stay on one line. Anything else is left out
 * (a bad setting doesn't stop the mods from syncing).
 */
function checkSettings(list: unknown): SharedSetting[] {
  if (!Array.isArray(list)) return [];
  const out: SharedSetting[] = [];
  for (const s of list.slice(0, 500)) {
    if (!s || typeof s !== 'object') continue;
    const x = { file: String(s.file ?? ''), section: String(s.section ?? '').trim(), key: String(s.key ?? '').trim(), value: String(s.value ?? '').trim() };
    if (!isCfgName(x.file) || x.file.toLowerCase() === 'bepinex.cfg' || checkChange(x)) continue;
    out.push(x);
  }
  return out;
}

/** A shared setting whose value differs from the player's file (from = their current value; null = not in the file). */
export interface SettingChange extends SharedSetting {
  from: string | null;
}

const cfgFile = (gameDir: string, file: string) => path.join(gameDir, 'BepInEx', 'config', file);

/** Which of the server's settings would change the player's files. */
export function planSettings(gameDir: string, settings: SharedSetting[]): SettingChange[] {
  const files = new Map<string, Map<string, string>>();
  const changes: SettingChange[] = [];
  for (const s of settings) {
    if (!files.has(s.file)) {
      const f = cfgFile(gameDir, s.file);
      const entries = existsSync(f) ? parseCfg(readFileSync(f, 'utf-8')).entries : [];
      files.set(s.file, new Map(entries.map((e) => [`${e.section}\u0000${e.key}`, e.value])));
    }
    const have = files.get(s.file)!.get(`${s.section}\u0000${s.key}`);
    if (have !== s.value) changes.push({ ...s, from: have ?? null });
  }
  return changes;
}

/** Writes the setting changes, one file at a time. A file that doesn't exist yet is created with just these values. */
export function applySettings(gameDir: string, changes: SettingChange[]): string[] {
  const byFile = new Map<string, SettingChange[]>();
  for (const c of changes) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const done: string[] = [];
  for (const [file, list] of byFile) {
    const f = cfgFile(gameDir, file);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, setValues(existsSync(f) ? readFileSync(f, 'utf-8') : '', list));
    done.push(...list.map((c) => `${c.key} = ${c.value} (${file})`));
  }
  return done;
}

// ---------- syncing ----------

export interface Plan {
  add: SharedMod[];
  update: (SharedMod & { from: string })[];
  remove: vm.ModEntry[];
  same: SharedMod[];
  needsBepInEx: boolean;
}

export const linkId = (link: Link) => `${link.host}:${link.port}/${link.token.slice(0, 6)}`;

export function planSync(gameDir: string, manifest: Manifest, link: Link): Plan {
  const reg = vm.loadRegistry(gameDir);
  const id = linkId(link);
  const plan: Plan = { add: [], update: [], remove: [], same: [], needsBepInEx: !vm.bepinexStatus(gameDir).installed };
  const wanted = new Set<string>();
  for (const mod of manifest.mods) {
    const full = vm.fullName(mod);
    wanted.add(full.toLowerCase());
    const have = Object.values(reg.mods).find((m) => vm.fullName(m).toLowerCase() === full.toLowerCase());
    if (!have) plan.add.push(mod);
    else if (have.version !== mod.version || !have.enabled) plan.update.push({ ...mod, from: have.enabled ? have.version : `${have.version} (off)` });
    else plan.same.push(mod);
  }
  // Only remove what this link installed; the player's own mods stay, and so does anything one of them still needs.
  const dropped = Object.values(reg.mods).filter((m) => m.syncedFrom === id && !wanted.has(vm.fullName(m).toLowerCase()));
  const droppedNames = new Set(dropped.map((m) => vm.fullName(m).toLowerCase()));
  for (const m of dropped) {
    const neededByKept = vm.dependents(gameDir, vm.fullName(m)).length > 0 &&
      Object.values(reg.mods).some(
        (other) =>
          !droppedNames.has(vm.fullName(other).toLowerCase()) &&
          other.dependencies.some((d) => vm.parseRef(d) && vm.fullName(vm.parseRef(d)!).toLowerCase() === vm.fullName(m).toLowerCase()),
      );
    if (!neededByKept) plan.remove.push(m);
  }
  return plan;
}

// ---------- download + safety check first, install second ----------

export interface PreparedChange {
  /** "Author-Mod@1.2.3": approvals are remembered per exact version. */
  key: string;
  full: string;
  mod: SharedMod;
  action: 'add' | 'update';
  from: string | null;
  zipFile: string;
  scan: ScanResult;
  /** Not from Thunderstore, or the safety check flagged it: the player has to approve it. */
  needsApproval: boolean;
  /** Windows Defender detected something: can't be installed. */
  blocked: boolean;
}

export interface Prepared {
  link: Link;
  manifest: Manifest;
  workDir: string;
  bepinex: { zipFile: string; version: string; scan: ScanResult } | null;
  changes: PreparedChange[];
  removals: vm.ModEntry[];
  same: number;
  /** Mods that couldn't be downloaded (the rest still sync): "Name: reason". */
  unavailable: string[];
  /** Mod settings from the server that differ from the player's files. */
  settings: SettingChange[];
}

/**
 * Downloads every new/changed mod and runs the safety checks (Windows Defender, Thunderstore status, behaviour scan),
 * without installing anything yet.
 */
export async function prepareSync(gameDir: string, manifest: Manifest, link: Link, workRoot: string, log: (line: string) => void): Promise<Prepared> {
  if (!isValheimFolder(gameDir)) throw new Error("That folder doesn't contain valheim.exe.");
  const plan = planSync(gameDir, manifest, link);
  const workDir = path.join(workRoot, `sync-${randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });
  const prepared: Prepared = { link, manifest, workDir, bepinex: null, changes: [], removals: plan.remove, same: plan.same.length, unavailable: [], settings: planSettings(gameDir, manifest.settings) };
  if (plan.needsBepInEx) {
    const info = await vm.latestPackage(vm.BEPINEX_PACK.namespace, vm.BEPINEX_PACK.name);
    const version = manifest.bepinex ?? info.version;
    const zipFile = path.join(workDir, `BepInEx-${version}.zip`);
    log(`Downloading BepInEx ${version}…`);
    await vm.downloadTo(vm.downloadUrl(vm.BEPINEX_PACK.namespace, vm.BEPINEX_PACK.name, version), zipFile);
    prepared.bepinex = { zipFile, version, scan: await scanPackage(zipFile, { fullName: vm.fullName(vm.BEPINEX_PACK) }) };
  }
  for (const mod of [...plan.add.map((m) => ({ ...m, from: null as string | null, action: 'add' as const })), ...plan.update.map((m) => ({ ...m, action: 'update' as const }))]) {
    const full = vm.fullName(mod);
    const zipFile = path.join(workDir, `${full}-${mod.version}.zip`);
    const fromServer = async () => {
      if (!mod.file) throw new Error(`${mod.name} isn't available for download from the server.`);
      log(`Downloading ${mod.name} ${mod.version} from the server…`);
      writeFileSync(zipFile, (await pinnedGet(link, `/api/share/${link.token}/file/${encodeURIComponent(mod.file)}`, true)) as Buffer);
    };
    // Where the mod really comes from: Thunderstore, Hexium or (uploaded mods) only the server.
    const site: vm.ModSite | null = mod.site === 'hexium' ? 'hexium' : mod.source === 'thunderstore' ? 'thunderstore' : null;
    // One mod that can't be downloaded doesn't stop the others.
    try {
      if (site === 'hexium') {
        try {
          log(`Downloading ${mod.name} ${mod.version} from Hexium…`);
          await vm.downloadTo(await vm.packageDownloadUrl(mod.namespace, mod.name, mod.version, 'hexium'), zipFile);
        } catch {
          await fromServer(); // Hexium unreachable: the server keeps a copy
        }
      } else if (site === 'thunderstore') {
        log(`Downloading ${mod.name} ${mod.version}…`);
        await vm.downloadTo(vm.downloadUrl(mod.namespace, mod.name, mod.version), zipFile);
      } else await fromServer();
    } catch (err) {
      const why = `${mod.name.replace(/_/g, ' ')}: ${(err as Error).message}`;
      log(`Couldn't download ${why}`);
      prepared.unavailable.push(why);
      continue;
    }
    log(`Checking ${mod.name}…`);
    const status = site ? await vm.versionStatus(mod.namespace, mod.name, mod.version, site) : { active: null, deprecated: false };
    const scan = await scanPackage(zipFile, { fullName: full, thunderstoreActive: status.active, deprecated: status.deprecated });
    prepared.changes.push({
      key: `${full}@${mod.version}`,
      full,
      mod,
      action: mod.action,
      from: mod.from,
      zipFile,
      scan,
      // Mods from a public mod site (Thunderstore, Hexium) install without asking when they pass the checks.
      needsApproval: (mod.source === 'upload' && mod.site !== 'hexium') || scan.verdict !== 'clean',
      blocked: scan.verdict === 'blocked',
    });
  }
  return prepared;
}

/** True when everything can be installed without asking (all from Thunderstore and clean, or already approved). */
export function canAutoApply(p: Prepared, approved: Set<string>) {
  return (!p.bepinex || p.bepinex.scan.verdict !== 'blocked') && p.changes.every((c) => !c.blocked && (!c.needsApproval || approved.has(c.key)));
}

/** Installs what's allowed: clean changes plus the ones the player approved. Blocked ones are never installed. */
export async function applyPrepared(gameDir: string, p: Prepared, approved: Set<string>, log: (line: string) => void) {
  const id = linkId(p.link);
  const done = { installed: [] as string[], skipped: [] as string[], removed: [] as string[], settings: [] as string[] };
  try {
    if (p.bepinex) {
      if (p.bepinex.scan.verdict === 'blocked') throw new Error(`BepInEx was not installed: ${p.bepinex.scan.summary}.`);
      vm.installBepInExZip(gameDir, p.bepinex.zipFile, p.bepinex.version);
      done.installed.push(`BepInEx ${p.bepinex.version}`);
    }
    for (const c of p.changes) {
      if (c.blocked) {
        done.skipped.push(`${c.mod.name} (blocked: ${c.scan.summary})`);
        continue;
      }
      if (c.needsApproval && !approved.has(c.key)) {
        done.skipped.push(`${c.mod.name} (not approved)`);
        continue;
      }
      await vm.installWithDependencies(
        gameDir,
        { namespace: c.mod.namespace, name: c.mod.name, version: c.mod.version, zipFile: c.zipFile, side: c.mod.side, source: c.mod.site === 'hexium' ? 'hexium' : c.mod.source, syncedFrom: id },
        log,
        { noDependencies: true },
      );
      const reg = vm.loadRegistry(gameDir);
      if (reg.mods[c.full] && !reg.mods[c.full].enabled) vm.setModEnabled(gameDir, c.full, true);
      done.installed.push(`${c.mod.name} ${c.mod.version}`);
    }
    for (const m of p.removals) {
      log(`Removing ${m.name} (the server no longer uses it)…`);
      vm.removeMod(gameDir, vm.fullName(m));
      done.removed.push(m.name);
    }
    // Settings last: planned before installing, so re-check against the files as they are now (a mod's own default
    // config, just installed, may already have some of these values).
    if (p.settings.length) {
      for (const line of applySettings(gameDir, planSettings(gameDir, p.settings))) {
        log(`Setting ${line}`);
        done.settings.push(line);
      }
    }
    return done;
  } finally {
    rmSync(p.workDir, { recursive: true, force: true });
  }
}

/** Mods in the game folder, marked as from the server link or added by the player. */
export function installedMods(gameDir: string, link: Link | null) {
  const reg = vm.loadRegistry(gameDir);
  const id = link ? linkId(link) : null;
  return Object.values(reg.mods).map((m) => ({ ...m, full: vm.fullName(m), fromServer: !!id && m.syncedFrom === id }));
}
