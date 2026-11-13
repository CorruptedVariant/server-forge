// Small JSON file storage under data/. Writes go to a temp file first and are then renamed into place,
// so a crash mid-write can't leave a half-written (corrupt) file.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.PANEL_DATA_DIR ?? path.join(rootDir, 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// On Linux (and in the container) only the account running Server Forge may read its data: it holds the desktop login
// key, node keys, session and password hashes. A folder made by an older version had the default (everyone may read).
if (process.platform !== 'win32') {
  try {
    chmodSync(dataDir, 0o700);
  } catch {}
}

/** Running from the TypeScript sources (the development panel) rather than an installed/portable build. */
export const isDev = import.meta.url.endsWith('.ts');

export function dataPath(...parts: string[]): string {
  return path.join(dataDir, ...parts);
}

export function readJson<T>(file: string, fallback: T): T {
  const full = dataPath(file);
  if (!existsSync(full)) return fallback;
  try {
    return JSON.parse(readFileSync(full, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  const full = dataPath(file);
  mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, full);
}
