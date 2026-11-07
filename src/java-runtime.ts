// Java runtimes for Minecraft Java servers: Eclipse Temurin (official OpenJDK builds from Adoptium), downloaded into
// Server Forge's own tools folder per major version. Nothing is installed system-wide.
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { bin, isLinux } from './platform/host.ts';
import path from 'node:path';
import os from 'node:os';
import { dataPath } from './store.ts';
import { downloadFile, extractZip, formatBytes, extractTar } from './download.ts';

// Adoptium has no Java 16 build; 17 runs everything 16 does.
const SUBSTITUTE: Record<number, number> = { 16: 17 };

/** 'jre' runs servers; 'jdk' (with the compiler) is only needed to build Spigot with BuildTools. */
export type JavaImage = 'jre' | 'jdk';

function runtimeDir(major: number, image: JavaImage = 'jre') {
  return dataPath('tools', 'java', image === 'jdk' ? `temurin-jdk-${major}` : `temurin-${major}`);
}

const JAVA_EXE = bin('java.exe', 'java');

/** Finds bin/java.exe inside an extracted runtime (the zip contains one top-level folder like jdk-21.0.4+7-jre). */
function findJavaExe(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const direct = path.join(dir, 'bin', JAVA_EXE);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(dir, entry.name, 'bin', JAVA_EXE);
    if (existsSync(nested)) return nested;
  }
  return null;
}

export function javaExe(major: number, image: JavaImage = 'jre'): string | null {
  return findJavaExe(runtimeDir(SUBSTITUTE[major] ?? major, image));
}

/** Makes sure a Java runtime of the given major version is available; returns the path to java.exe. */
export async function ensureJava(
  major: number,
  update: (step: string, pct?: number | null) => void,
  line?: (text: string) => void,
  image: JavaImage = 'jre',
): Promise<string> {
  const version = SUBSTITUTE[major] ?? major;
  const existing = javaExe(version, image);
  if (existing) return existing;
  const url = `https://api.adoptium.net/v3/binary/latest/${version}/ga/${isLinux ? 'linux' : 'windows'}/x64/${image}/hotspot/normal/eclipse`;
  const tmp = path.join(os.tmpdir(), `tavernhost-java-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const zip = path.join(tmp, isLinux ? 'java.tar.gz' : 'java.zip');
    const label = image === 'jdk' ? `Java ${version} JDK` : `Java ${version}`;
    await downloadFile(url, zip, (pct, received) => update(`Downloading ${label} (Eclipse Temurin)… ${formatBytes(received)}`, pct));
    update(`Unpacking ${label}…`, null);
    const dir = runtimeDir(version, image);
    rmSync(dir, { recursive: true, force: true });
    if (isLinux) await extractTar(zip, dir);
    else await extractZip(zip, dir);
    const exe = findJavaExe(dir);
    if (!exe) throw new Error(`Java ${version} was downloaded but java.exe wasn't found in it.`);
    line?.(`Java ${version} is ready.`);
    return exe;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
