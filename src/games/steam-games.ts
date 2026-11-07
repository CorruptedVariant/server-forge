// Shared bits for the dedicated servers installed with SteamCMD (anonymous): their Steam app IDs, settings checks, and
// a SteamCMD install that checks the expected program arrived.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { steamAppUpdate } from '../steamcmd.ts';
import type { ServerRecord } from './types.ts';
import type { Job } from '../jobs.ts';

/** Steam app IDs of the dedicated servers (not the games). */
export const STEAM_APPS = {
  palworld: 2394010,
  enshrouded: 2278520,
  sevendays: 294420,
  zomboid: 380870,
  vrising: 1829350,
} as const;

export function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function decimal(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return Math.round(n * 1000) / 1000;
}

export const bool = (v: unknown, fallback = false) => (v === undefined || v === null || v === '' ? fallback : v === true || v === 'true');

export function text(v: unknown, name: string, max: number, required = false): string {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Error(`${name} is required.`);
  if (s.length > max) throw new Error(`${name} can be up to ${max} characters.`);
  if (/[\r\n]/.test(s)) throw new Error(`${name} must be one line.`);
  return s;
}

/** A password made for settings that need one (e.g. a server's admin password, used by Server Forge's own API calls). */
export const newPassword = () => randomBytes(9).toString('base64url');

/** Installs or updates the server with SteamCMD and checks `exe` (relative to the install folder) is there. */
export async function steamInstall(record: ServerRecord, job: Job, appId: number, exe: string, name: string, opts: { windowsBuild?: boolean } = {}) {
  await steamAppUpdate(appId, record.installDir, job, opts);
  if (!existsSync(path.join(record.installDir, exe))) throw new Error(`Install finished but ${exe} is missing.`);
  job.line(`${name} dedicated server is installed.`);
}
