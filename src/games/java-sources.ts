// Where each kind of Minecraft Java server comes from, and how to install it. Everything is downloaded from the
// project's official source on the user's own system.
import { existsSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { downloadFile, formatBytes } from '../download.ts';
import type { Job } from '../jobs.ts';

export interface Flavor {
  id: string;
  name: string;
  description: string;
  /** Proxies (BungeeCord) don't run a world and have no Minecraft version of their own. */
  proxy?: boolean;
}

export const FLAVORS: Flavor[] = [
  { id: 'paper', name: 'Paper', description: 'Fast, supports Bukkit/Spigot plugins. The usual choice for plugin servers.' },
  { id: 'vanilla', name: 'Vanilla', description: "Mojang's official server, no plugins or mods." },
  { id: 'fabric', name: 'Fabric', description: 'Lightweight mod loader.' },
  { id: 'forge', name: 'Forge', description: 'The classic mod loader (most older modpacks).' },
  { id: 'neoforge', name: 'NeoForge', description: 'Modern fork of Forge (most newer modpacks).' },
  { id: 'spigot', name: 'Spigot', description: 'Plugin server. Built from source with BuildTools, which takes 5-10 minutes.' },
  { id: 'sponge', name: 'SpongeVanilla', description: 'Sponge plugin platform.' },
  { id: 'bungeecord', name: 'BungeeCord', description: 'Proxy that links several servers into one network.', proxy: true },
];

/** How to launch the installed server. */
export type LaunchSpec = { kind: 'jar'; jar: string } | { kind: 'argsfile'; argsFile: string };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'TavernHost' } });
  if (!res.ok) throw new Error(`Couldn't reach ${new URL(url).host} (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

// ---------- Mojang (also used for Java versions) ----------

interface Manifest {
  latest: { release: string };
  versions: { id: string; type: string; url: string }[];
}
let manifestCache: { at: number; data: Manifest } | null = null;
async function manifest(): Promise<Manifest> {
  if (manifestCache && Date.now() - manifestCache.at < 30 * 60_000) return manifestCache.data;
  const data = await getJson<Manifest>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  manifestCache = { at: Date.now(), data };
  return data;
}
async function versionInfo(mc: string) {
  const entry = (await manifest()).versions.find((v) => v.id === mc);
  if (!entry) throw new Error(`Minecraft ${mc} isn't a version Mojang lists.`);
  return getJson<{ javaVersion?: { majorVersion: number }; downloads?: { server?: { url: string } } }>(entry.url);
}

/** The Java major version Mojang says a Minecraft version needs (e.g. 8, 17, 21, 25). */
export async function javaForMinecraft(mc: string): Promise<number> {
  try {
    return (await versionInfo(mc)).javaVersion?.majorVersion ?? 21;
  } catch {
    return 21;
  }
}

function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
}

// ---------- version lists ----------

function neoToMinecraft(v: string): string {
  // Old scheme "21.1.77" -> 1.21.1 (and "21.0.x" -> 1.21); new scheme "26.3.0.10" -> 26.3 ("26.1.1.5" -> 26.1.1).
  const [a, b, c] = v.split(/[.-]/);
  if (Number(a) >= 26) return c && c !== '0' ? `${a}.${b}.${c}` : `${a}.${b}`;
  return b === '0' ? `1.${a}` : `1.${a}.${b}`;
}

async function neoVersions(): Promise<string[]> {
  const data = await getJson<{ versions: string[] }>('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
  return data.versions;
}

async function forgePromos(): Promise<Record<string, string>> {
  return (await getJson<{ promos: Record<string, string> }>('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
}

/** Minecraft versions available for a flavor, newest first (stable releases only). */
export async function listVersions(flavor: string): Promise<string[]> {
  switch (flavor) {
    case 'vanilla':
    case 'spigot':
      return (await manifest()).versions.filter((v) => v.type === 'release').map((v) => v.id);
    case 'paper': {
      const data = await getJson<{ versions: Record<string, string[]> }>('https://fill.papermc.io/v3/projects/paper');
      return Object.values(data.versions).flat().filter((v) => !/-/.test(v));
    }
    case 'fabric':
      return (await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/game')).filter((v) => v.stable).map((v) => v.version);
    case 'forge':
      return [...new Set(Object.keys(await forgePromos()).map((k) => k.replace(/-(latest|recommended)$/, '')))].sort(compareVersions);
    case 'neoforge':
      return [...new Set((await neoVersions()).map(neoToMinecraft))].sort(compareVersions);
    case 'sponge': {
      const data = await getJson<{ tags: { minecraft: string[] } }>('https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla');
      return data.tags.minecraft.filter((v) => !/-/.test(v)).sort(compareVersions);
    }
    case 'bungeecord':
      return ['latest'];
    default:
      throw new Error('Unknown server type.');
  }
}

// ---------- installing ----------

/** Runs a Java program (installer/BuildTools) in `cwd`, streaming its output into the job. */
function runJava(java: string, args: string[], cwd: string, job: Job, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(java, args, { cwd, windowsHide: true });
    let tail = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      tail = (tail + text).slice(-4000);
      // BuildTools and installers print a line per file (thousands); keep the console readable.
      for (const line of text.split(/\r?\n/)) if (line.trim() && !/^\s*(Extracted|Extracting|Copying|Downloading library|Processing)\b/i.test(line)) job.line(line.trim());
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[1] ?? 'installer')} failed (exit code ${code}). See the console for details.`));
    });
  });
}

async function download(url: string, dest: string, label: string, job: Job) {
  await downloadFile(url, dest, (pct, received) => job.update(`Downloading ${label}… ${formatBytes(received)}`, pct));
}

/** The args file a modern Forge/NeoForge install creates (launched as java @user_jvm_args.txt @<this>). */
function findArgsFile(dir: string, group: string): string | null {
  const root = path.join(dir, 'libraries', ...group.split('/'));
  if (!existsSync(root)) return null;
  for (const v of readdirSync(root)) {
    const f = path.join(root, v, process.platform === 'linux' ? 'unix_args.txt' : 'win_args.txt');
    if (existsSync(f)) return path.relative(dir, f);
  }
  return null;
}

/**
 * Installs `flavor` for Minecraft `mc` into `dir` using `java`. Returns how to launch it and a short build label.
 * Existing worlds and settings in `dir` are left alone (installers only add server files).
 */
export async function installFlavor(flavor: string, mc: string, dir: string, java: string, job: Job): Promise<{ launch: LaunchSpec; build: string }> {
  mkdirSync(dir, { recursive: true });
  switch (flavor) {
    case 'vanilla': {
      const url = (await versionInfo(mc)).downloads?.server?.url;
      if (!url) throw new Error(`Mojang has no server download for ${mc}.`);
      await download(url, path.join(dir, 'server.jar'), `Minecraft ${mc} server`, job);
      return { launch: { kind: 'jar', jar: 'server.jar' }, build: mc };
    }
    case 'paper': {
      const b = await getJson<{ id: number; channel: string; downloads: Record<string, { url: string; name: string }> }>(
        `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(mc)}/builds/latest`,
      );
      const file = b.downloads['server:default'];
      if (!file) throw new Error(`Paper has no download for ${mc}.`);
      if (b.channel && b.channel !== 'STABLE') job.line(`Note: Paper marks this build as ${b.channel.toLowerCase()} (not yet stable).`);
      await download(file.url, path.join(dir, 'server.jar'), `Paper ${mc} build ${b.id}`, job);
      return { launch: { kind: 'jar', jar: 'server.jar' }, build: `${mc} #${b.id}` };
    }
    case 'fabric': {
      const loader = (await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/loader')).find((l) => l.stable)!.version;
      const installer = (await getJson<{ version: string; stable: boolean }[]>('https://meta.fabricmc.net/v2/versions/installer')).find((i) => i.stable)!.version;
      await download(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/${installer}/server/jar`, path.join(dir, 'server.jar'), `Fabric ${mc} (loader ${loader})`, job);
      return { launch: { kind: 'jar', jar: 'server.jar' }, build: `${mc} loader ${loader}` };
    }
    case 'forge':
    case 'neoforge': {
      let version: string;
      let url: string;
      if (flavor === 'forge') {
        const promos = await forgePromos();
        const fv = promos[`${mc}-recommended`] ?? promos[`${mc}-latest`];
        if (!fv) throw new Error(`Forge has no build for ${mc}.`);
        version = `${mc}-${fv}`;
        url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}/forge-${version}-installer.jar`;
      } else {
        // Newest build for this Minecraft version, preferring non-beta ones (the maven list is oldest-first).
        const all = (await neoVersions()).filter((v) => neoToMinecraft(v) === mc);
        const stable = all.filter((v) => !/beta|alpha/.test(v));
        version = (stable.length ? stable : all).at(-1) ?? '';
        if (!version) throw new Error(`NeoForge has no build for ${mc}.`);
        url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
      }
      const installer = path.join(dir, `${flavor}-installer.jar`);
      await download(url, installer, `${flavor === 'forge' ? 'Forge' : 'NeoForge'} ${version} installer`, job);
      job.update(`Running the ${flavor === 'forge' ? 'Forge' : 'NeoForge'} installer (downloads libraries; a few minutes)…`, null);
      await runJava(java, ['-jar', path.basename(installer), '--installServer'], dir, job, 30 * 60_000);
      rmSync(installer, { force: true });
      rmSync(`${installer}.log`, { force: true });
      const argsFile = findArgsFile(dir, flavor === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge');
      if (argsFile) return { launch: { kind: 'argsfile', argsFile }, build: version };
      // Older Forge (1.16 and earlier) produces a runnable jar instead.
      const jar = readdirSync(dir).find((f) => /^forge-.*\.jar$/i.test(f) && !/installer/i.test(f));
      if (!jar) throw new Error('The installer finished but no launch files were found.');
      return { launch: { kind: 'jar', jar }, build: version };
    }
    case 'sponge': {
      const list = await getJson<{ artifacts: Record<string, { recommended: boolean }> }>(
        `https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions?tags=minecraft:${encodeURIComponent(mc)}&limit=10`,
      );
      const names = Object.keys(list.artifacts);
      const version = names.find((n) => list.artifacts[n].recommended) ?? names[0];
      if (!version) throw new Error(`SpongeVanilla has no build for ${mc}.`);
      const detail = await getJson<{ assets: { classifier: string; downloadUrl: string }[] }>(
        `https://dl-api.spongepowered.org/v2/groups/org.spongepowered/artifacts/spongevanilla/versions/${encodeURIComponent(version)}`,
      );
      const asset = detail.assets.find((a) => a.classifier === 'universal');
      if (!asset) throw new Error(`SpongeVanilla ${version} has no server download.`);
      await download(asset.downloadUrl, path.join(dir, 'server.jar'), `SpongeVanilla ${version}`, job);
      return { launch: { kind: 'jar', jar: 'server.jar' }, build: version };
    }
    case 'spigot': {
      // Spigot can't be downloaded; it has to be compiled with BuildTools (which fetches its own Git if needed).
      const work = path.join(os.tmpdir(), `tavernhost-buildtools-${Date.now()}`);
      mkdirSync(work, { recursive: true });
      try {
        await download('https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar', path.join(work, 'BuildTools.jar'), 'BuildTools', job);
        job.update(`Compiling Spigot ${mc} with BuildTools (5-10 minutes)…`, null);
        await runJava(java, ['-jar', 'BuildTools.jar', '--rev', mc, '--output-dir', dir], work, job, 60 * 60_000);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      const jar = readdirSync(dir).find((f) => /^spigot-.*\.jar$/i.test(f));
      if (!jar) throw new Error('BuildTools finished but no Spigot jar was produced.');
      return { launch: { kind: 'jar', jar }, build: mc };
    }
    case 'bungeecord': {
      await download('https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar', path.join(dir, 'BungeeCord.jar'), 'BungeeCord', job);
      return { launch: { kind: 'jar', jar: 'BungeeCord.jar' }, build: 'latest' };
    }
    default:
      throw new Error('Unknown server type.');
  }
}

/** Accepting the Minecraft EULA is required before a server will run; only called after the user ticked the box. */
export function writeEula(dir: string) {
  writeFileSync(path.join(dir, 'eula.txt'), `# Accepted in Tavern Host on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`);
}
