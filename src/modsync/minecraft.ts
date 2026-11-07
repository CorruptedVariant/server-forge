// Tavern Client Mod Manager: Minecraft Java. Each followed server gets its own game folder (.minecraft\tavern\<name>)
// and its own Minecraft Launcher profile, so the server's mods never mix with the player's other worlds and mods. The
// server's mod jars are downloaded from Server Forge, checked (size, Windows Defender, and whether Modrinth knows the
// exact file), and kept matched: added, updated and removed with the server. Jars the player adds to that folder
// themselves are left alone. Fabric is set up in the launcher automatically; Forge and NeoForge need their installer run
// once ("Install client").
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { defenderScan, type ScanResult, SCANNER, noScannerIsNormal } from '../modscan.ts';
import { pinnedGet, type Link, type AnyManifest } from './sync.ts';

export interface JavaMod {
  id: string;
  name: string;
  version: string;
  file: string;
  size: number;
}
export interface JavaManifest {
  server: string;
  loader: 'fabric' | 'forge' | 'neoforge';
  mcVersion: string;
  loaderVersion: string | null;
  mods: JavaMod[];
}

const JAR = /^[\w.\-+ ]{1,200}\.jar$/;
const MC_VERSION = /^[\w.\-]{1,40}$/;
const LOADER_VERSION = /^[\w.\-+]{1,80}$/;
const LOADERS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' } as const;

/** The Minecraft Java part of a share link, checked (names end up as file names on this PC). */
export function checkJavaManifest(any: AnyManifest): JavaManifest {
  const m = any.raw;
  const loader = String(m.loader ?? '');
  if (!(loader in LOADERS)) throw new Error('That server runs a Minecraft type the app can\'t sync.');
  const mcVersion = String(m.mcVersion ?? '');
  if (!MC_VERSION.test(mcVersion)) throw new Error('The server sent an invalid Minecraft version, so nothing was changed.');
  const loaderVersion = m.loaderVersion == null ? null : String(m.loaderVersion);
  if (loaderVersion !== null && !LOADER_VERSION.test(loaderVersion)) throw new Error('The server sent an invalid loader version, so nothing was changed.');
  const list = Array.isArray(m.mods) ? (m.mods as Record<string, unknown>[]) : [];
  if (list.length > 1000) throw new Error('The server sent more than 1000 mods, which is not a real mod list.');
  const seen = new Set<string>();
  const mods = list.map((x): JavaMod => {
    const file = String(x?.file ?? '');
    if (!JAR.test(file) || /^\.+/.test(file)) throw new Error('The server sent a mod with an invalid file name, so nothing was changed. Ask the server owner to check their mods.');
    if (seen.has(file.toLowerCase())) throw new Error(`The server listed ${file} twice, so nothing was changed.`);
    seen.add(file.toLowerCase());
    return { id: String(x.id ?? file).slice(0, 100), name: String(x.name ?? file).slice(0, 100), version: String(x.version ?? '').slice(0, 60), file, size: Math.max(0, Number(x.size) || 0) };
  });
  return { server: any.server, loader: loader as JavaManifest['loader'], mcVersion, loaderVersion, mods };
}

// ---------- folders ----------

export function minecraftDir(): string {
  if (process.platform === 'linux') {
    const flatpak = path.join(os.homedir(), '.var', 'app', 'com.mojang.Minecraft', '.minecraft');
    return existsSync(flatpak) ? flatpak : path.join(os.homedir(), '.minecraft');
  }
  return path.join(process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), '.minecraft');
}

/** A folder name for a server (stable: chosen once when the link is added and kept in the app's settings). */
export function folderName(server: string, link: Link): string {
  const base = server.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'server';
  return `${base}-${createHash('sha1').update(`${link.host}:${link.port}/${link.token}`).digest('hex').slice(0, 6)}`;
}

export function instanceDir(folder: string): string {
  if (!/^[\w\-]{1,60}$/.test(folder)) throw new Error('Bad folder name.');
  return path.join(minecraftDir(), 'tavern', folder);
}
const modsDir = (folder: string) => path.join(instanceDir(folder), 'mods');

interface Registry {
  /** Jars this app put in the mods folder (from the server), so only those are ever removed. */
  files: Record<string, { size: number; sha256: string; version: string }>;
}
const registryFile = (folder: string) => path.join(instanceDir(folder), '.tavern-sync.json');
function loadRegistry(folder: string): Registry {
  try {
    const r = JSON.parse(readFileSync(registryFile(folder), 'utf-8'));
    return { files: r && typeof r.files === 'object' ? r.files : {} };
  } catch {
    return { files: {} };
  }
}
function saveRegistry(folder: string, reg: Registry) {
  mkdirSync(instanceDir(folder), { recursive: true });
  writeFileSync(registryFile(folder), JSON.stringify(reg, null, 2));
}

// ---------- the launcher version for the server's loader ----------

/** The launcher's version id for the loader, as each loader's installer names it. */
export function versionId(m: JavaManifest): string | null {
  if (!m.loaderVersion) return null;
  if (m.loader === 'fabric') return `fabric-loader-${m.loaderVersion}-${m.mcVersion}`;
  if (m.loader === 'neoforge') return `neoforge-${m.loaderVersion}`;
  // Forge: the server's build is "<mc>-<forge>", the client version "<mc>-forge-<forge>".
  const forge = m.loaderVersion.startsWith(`${m.mcVersion}-`) ? m.loaderVersion.slice(m.mcVersion.length + 1) : m.loaderVersion;
  return `${m.mcVersion}-forge-${forge}`;
}

function versionInstalled(id: string) {
  return existsSync(path.join(minecraftDir(), 'versions', id, `${id}.json`));
}

/** Forge/NeoForge installer download (the player runs it and picks "Install client"). */
export function installerUrl(m: JavaManifest): string | null {
  if (!m.loaderVersion) return null;
  if (m.loader === 'forge') return `https://maven.minecraftforge.net/net/minecraftforge/forge/${m.loaderVersion}/forge-${m.loaderVersion}-installer.jar`;
  if (m.loader === 'neoforge') return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${m.loaderVersion}/neoforge-${m.loaderVersion}-installer.jar`;
  return null;
}

/** Fabric: the launcher version is a small JSON from Fabric's own server (the launcher downloads the rest itself). */
async function installFabric(m: JavaManifest, log: (l: string) => void): Promise<string> {
  const id = versionId(m)!;
  if (versionInstalled(id)) return id;
  log(`Setting up Fabric ${m.loaderVersion} for Minecraft ${m.mcVersion}…`);
  const res = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(m.mcVersion)}/${encodeURIComponent(m.loaderVersion!)}/profile/json`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Fabric's server answered ${res.status} for Fabric ${m.loaderVersion} / Minecraft ${m.mcVersion}.`);
  const profile = (await res.json()) as { id?: string };
  if (profile.id !== id) throw new Error("Fabric's server sent an unexpected version.");
  const dir = path.join(minecraftDir(), 'versions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(profile, null, 2));
  return id;
}

const LAUNCHER_JVM_ARGS = '-Xmx4G -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M';

/** Adds or updates the server's profile in the Minecraft Launcher (other profiles and settings are kept). */
function writeProfile(folder: string, server: string, id: string) {
  const file = path.join(minecraftDir(), 'launcher_profiles.json');
  let data: { profiles?: Record<string, Record<string, unknown>>; [k: string]: unknown } = { profiles: {}, settings: {}, version: 3 };
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      throw new Error("The Minecraft Launcher's profile list (launcher_profiles.json) couldn't be read, so no profile was added. Open the launcher once, close it and try again.");
    }
  }
  data.profiles ??= {};
  const key = `tavern-${folder}`;
  const now = new Date().toISOString();
  const old = data.profiles[key];
  // The player's own changes (memory, icon, name) are kept; the version and folder follow the server.
  data.profiles[key] = {
    created: now,
    icon: 'Furnace',
    name: `${server} (SF Mod Manager)`,
    javaArgs: LAUNCHER_JVM_ARGS,
    ...old,
    type: 'custom',
    lastVersionId: id,
    gameDir: instanceDir(folder),
    lastUsed: (old?.lastUsed as string) ?? now,
  };
  writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Uncompressed NBT for servers.dat with one server, so it shows in Multiplayer straight away. */
function serversDat(name: string, ip: string): Buffer {
  const parts: Buffer[] = [];
  const str = (s: string) => {
    const b = Buffer.from(s.replace(/[^ -~ -￿]|[\ud800-\udfff]/g, '?'), 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(Math.min(b.length, 65535));
    return Buffer.concat([len, b]);
  };
  const byte = (n: number) => Buffer.from([n]);
  const int = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return b;
  };
  parts.push(byte(10), str('')); // root compound
  parts.push(byte(9), str('servers'), byte(10), int(1)); // list of 1 compound
  parts.push(byte(8), str('ip'), str(ip), byte(8), str('name'), str(name), byte(0)); // the server
  parts.push(byte(0)); // end of root
  return Buffer.concat(parts);
}

export interface JavaSetup {
  versionId: string | null;
  /** The loader version is in the launcher (Fabric: set up by the app; Forge/NeoForge: their installer was run). */
  loaderReady: boolean;
  installerUrl: string | null;
  profile: boolean;
}

/** Makes the launcher ready for the server: loader (Fabric), profile, and the server in Multiplayer. */
export async function setupLauncher(folder: string, m: JavaManifest, address: string | null, log: (l: string) => void): Promise<JavaSetup> {
  let id = versionId(m);
  if (id && m.loader === 'fabric') id = await installFabric(m, log);
  const ready = !!id && versionInstalled(id);
  mkdirSync(modsDir(folder), { recursive: true });
  const dat = path.join(instanceDir(folder), 'servers.dat');
  if (address && !existsSync(dat)) writeFileSync(dat, serversDat(m.server || 'Server', address));
  if (ready) writeProfile(folder, m.server, id!);
  return { versionId: id, loaderReady: ready, installerUrl: ready ? null : installerUrl(m), profile: ready };
}

/** Status without changing anything (for the page). */
export function launcherStatus(folder: string, m: JavaManifest): JavaSetup {
  const id = versionId(m);
  const ready = !!id && versionInstalled(id);
  let profile = false;
  try {
    profile = !!JSON.parse(readFileSync(path.join(minecraftDir(), 'launcher_profiles.json'), 'utf-8')).profiles?.[`tavern-${folder}`];
  } catch {}
  return { versionId: id, loaderReady: ready, installerUrl: ready || m.loader === 'fabric' ? null : installerUrl(m), profile };
}

// ---------- syncing ----------

export interface JavaPlan {
  add: JavaMod[];
  update: (JavaMod & { from: string })[];
  remove: string[];
  same: number;
}

export function planJava(folder: string, m: JavaManifest): JavaPlan {
  const reg = loadRegistry(folder);
  const dir = modsDir(folder);
  const plan: JavaPlan = { add: [], update: [], remove: [], same: 0 };
  const wanted = new Set(m.mods.map((x) => x.file.toLowerCase()));
  for (const mod of m.mods) {
    const full = path.join(dir, mod.file);
    const have = reg.files[mod.file];
    const size = existsSync(full) ? statSync(full).size : -1;
    if (size === -1) plan.add.push(mod);
    else if (mod.size && size !== mod.size) plan.update.push({ ...mod, from: have?.version || 'another copy' });
    else plan.same++;
  }
  for (const file of Object.keys(reg.files)) if (!wanted.has(file.toLowerCase()) && existsSync(path.join(dir, file))) plan.remove.push(file);
  return plan;
}

export interface JavaChange {
  key: string;
  file: string;
  mod: JavaMod;
  action: 'add' | 'update';
  from: string | null;
  jar: string;
  sha256: string;
  scan: ScanResult;
  /** Modrinth project the exact file belongs to, when it's there. */
  modrinth: string | null;
  needsApproval: boolean;
  blocked: boolean;
}
export interface JavaPrepared {
  kind: 'java';
  folder: string;
  link: Link;
  manifest: JavaManifest;
  address: string | null;
  workDir: string;
  changes: JavaChange[];
  removals: string[];
  same: number;
  unavailable: string[];
}

/** Modrinth's project names for the files it knows (by SHA-1), or {} when it can't be reached. */
async function modrinthLookup(sha1s: string[]): Promise<Record<string, string>> {
  if (!sha1s.length) return {};
  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Volatile111/tavern-client-mod-manager' },
      body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as Record<string, { project_id?: string; name?: string }>;
    return Object.fromEntries(Object.entries(data).map(([h, v]) => [h, String(v?.name ?? v?.project_id ?? 'Modrinth')]));
  } catch {
    return {};
  }
}

/** Downloads every new/changed jar and checks it. Nothing is installed yet. */
export async function prepareJava(folder: string, m: JavaManifest, link: Link, address: string | null, workRoot: string, log: (l: string) => void): Promise<JavaPrepared> {
  const plan = planJava(folder, m);
  const workDir = path.join(workRoot, `mc-${randomUUID().slice(0, 8)}`);
  mkdirSync(workDir, { recursive: true });
  const out: JavaPrepared = { kind: 'java', folder, link, manifest: m, address, workDir, changes: [], removals: plan.remove, same: plan.same, unavailable: [] };
  const downloaded: { mod: JavaMod; action: 'add' | 'update'; from: string | null; jar: string; sha256: string; sha1: string }[] = [];
  for (const mod of [...plan.add.map((x) => ({ ...x, from: null as string | null, action: 'add' as const })), ...plan.update.map((x) => ({ ...x, action: 'update' as const }))]) {
    const jar = path.join(workDir, mod.file);
    try {
      log(`Downloading ${mod.name} ${mod.version} from the server…`);
      const body = (await pinnedGet(link, `/api/share/${link.token}/file/${encodeURIComponent(mod.file)}`, true)) as Buffer;
      if (mod.size && body.length !== mod.size) throw new Error('the download was incomplete');
      if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) throw new Error("it isn't a jar file");
      writeFileSync(jar, body);
      downloaded.push({ mod, action: mod.action, from: mod.from, jar, sha256: createHash('sha256').update(body).digest('hex'), sha1: createHash('sha1').update(body).digest('hex') });
    } catch (err) {
      const why = `${mod.name}: ${(err as Error).message}`;
      log(`Couldn't download ${why}`);
      out.unavailable.push(why);
    }
  }
  const known = await modrinthLookup(downloaded.map((d) => d.sha1));
  for (const d of downloaded) {
    log(`Checking ${d.mod.name}…`);
    const def = await defenderScan(d.jar);
    const modrinth = known[d.sha1] ?? null;
    const flags: ScanResult['flags'] = [];
    if (def.result === 'threat') flags.push({ level: 'high', text: `${SCANNER} found ${def.threat}` } as ScanResult['flags'][number]);
    else if (def.result !== 'clean' && !noScannerIsNormal) flags.push({ level: 'medium', text: "Windows Defender couldn't scan it (another antivirus may be in charge)" } as ScanResult['flags'][number]);
    const verdict: ScanResult['verdict'] = def.result === 'threat' ? 'blocked' : def.result === 'clean' ? 'clean' : 'review';
    const summary = def.result === 'threat' ? `blocked: ${SCANNER} found ${def.threat}` : `${noScannerIsNormal && def.result !== 'clean' ? 'No virus scanner on this system' : def.result === 'clean' ? `${SCANNER}: clean` : "Windows Defender couldn't scan it"} · ${modrinth ? `the exact file is on Modrinth (${modrinth})` : 'not found on Modrinth (sent by the server owner)'}`;
    out.changes.push({
      key: `mc:${d.mod.file}@${d.sha256.slice(0, 16)}`,
      file: d.mod.file,
      mod: d.mod,
      action: d.action,
      from: d.from,
      jar: d.jar,
      sha256: d.sha256,
      scan: { verdict, defender: def.result, threat: def.threat, flags, summary },
      modrinth,
      // Files Modrinth knows exactly install without asking when Defender passes them; others wait for approval.
      needsApproval: !modrinth || verdict !== 'clean',
      blocked: verdict === 'blocked',
    });
  }
  return out;
}

export function canAutoApplyJava(p: JavaPrepared, approved: Set<string>) {
  return p.changes.every((c) => !c.blocked && (!c.needsApproval || approved.has(c.key)));
}

/** Installs the allowed changes, removes jars the server dropped, then sets up the launcher. */
export async function applyJava(p: JavaPrepared, approved: Set<string>, log: (l: string) => void) {
  const done = { installed: [] as string[], skipped: [] as string[], removed: [] as string[], setup: null as JavaSetup | null };
  const dir = modsDir(p.folder);
  try {
    mkdirSync(dir, { recursive: true });
    const reg = loadRegistry(p.folder);
    for (const c of p.changes) {
      if (c.blocked) {
        done.skipped.push(`${c.mod.name} (blocked: ${c.scan.summary})`);
        continue;
      }
      if (c.needsApproval && !approved.has(c.key)) {
        done.skipped.push(`${c.mod.name} (not approved)`);
        continue;
      }
      try {
        copyFileSync(c.jar, path.join(dir, c.file));
      } catch (err) {
        throw new Error(/EBUSY|EPERM/.test((err as Error).message) ? 'Close Minecraft first: its mod files are locked while it runs.' : (err as Error).message);
      }
      reg.files[c.file] = { size: statSync(path.join(dir, c.file)).size, sha256: c.sha256, version: c.mod.version };
      done.installed.push(`${c.mod.name} ${c.mod.version}`);
    }
    for (const file of p.removals) {
      log(`Removing ${file} (the server no longer uses it)…`);
      rmSync(path.join(dir, file), { force: true });
      delete reg.files[file];
      done.removed.push(file);
    }
    // Same-named jars already there (copied by hand earlier) now count as from the server.
    for (const mod of p.manifest.mods) {
      const full = path.join(dir, mod.file);
      if (!reg.files[mod.file] && existsSync(full) && (!mod.size || statSync(full).size === mod.size)) reg.files[mod.file] = { size: statSync(full).size, sha256: '', version: mod.version };
    }
    saveRegistry(p.folder, reg);
    done.setup = await setupLauncher(p.folder, p.manifest, p.address, log);
    return done;
  } finally {
    rmSync(p.workDir, { recursive: true, force: true });
  }
}

/** Jars in the server's mods folder: from the server or added by the player. */
export function installedJava(folder: string) {
  const reg = loadRegistry(folder);
  const dir = modsDir(folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.jar$/i.test(f))
    .map((f) => ({ file: f, fromServer: !!reg.files[f], version: reg.files[f]?.version ?? '' }));
}

export const loaderName = (l: string) => LOADERS[l as keyof typeof LOADERS] ?? l;
