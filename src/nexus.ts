// Nexus Mods (Valheim and Palworld), shared by Server Forge and Tavern Client Mod Manager. Downloads go through the official API with
// the user's personal API key (nexusmods.com → Site preferences → API keys):
//   - "Mod Manager Download" buttons give an nxm:// link carrying a one-time key; with it any account can download.
//   - Premium accounts can also download a mod's files straight from its page address.
// Without a key, files downloaded by hand ("Manual download") can still be installed like any other zip.
import { downloadTo } from './valheim-mods.ts';

const API = 'https://api.nexusmods.com/v1';
export const NEXUS_GAME = 'valheim';
/** Games whose Nexus files can be installed (nexusmods.com/<domain>), with their names for messages. */
export const NEXUS_GAMES: Record<string, string> = { valheim: 'Valheim', palworld: 'Palworld', hytale: 'Hytale' };

export interface NexusUser {
  name: string;
  premium: boolean;
}

export interface NexusFile {
  modId: number;
  fileId: number;
  /** The mod's name on Nexus, e.g. "Valheim Plus". */
  modName: string;
  author: string;
  version: string;
  fileName: string;
  summary: string;
}

export interface NxmLink {
  game: string;
  modId: number;
  fileId: number;
  key: string | null;
  expires: string | null;
}

function headers(apiKey: string, app: { name: string; version: string }) {
  return { apikey: apiKey, 'Application-Name': app.name, 'Application-Version': app.version, Accept: 'application/json' };
}

async function get<T>(url: string, apiKey: string, app: { name: string; version: string }): Promise<T> {
  const res = await fetch(url, { headers: headers(apiKey, app) });
  if (res.status === 401) throw new Error('Nexus Mods rejected the API key. Copy it again from nexusmods.com → Site preferences → API keys.');
  if (res.status === 403) throw new Error('Nexus Mods only allows this download from the "Mod Manager Download" button (or with a Premium account).');
  if (res.status === 404) throw new Error('Nexus Mods has no such mod or file (it may have been removed).');
  if (res.status === 429) throw new Error('Too many requests to Nexus Mods right now; try again in a bit.');
  if (!res.ok) throw new Error(`Nexus Mods answered ${res.status}.`);
  return (await res.json()) as T;
}

export async function validateKey(apiKey: string, app: { name: string; version: string }): Promise<NexusUser> {
  const u = await get<{ name: string; is_premium: boolean }>(`${API}/users/validate.json`, apiKey, app);
  return { name: u.name, premium: !!u.is_premium };
}

/** nxm://valheim/mods/123/files/456?key=…&expires=…&user_id=… */
export function parseNxm(text: string): NxmLink | null {
  const m = /^nxm:\/\/([\w-]+)\/mods\/(\d+)\/files\/(\d+)(?:\?(.*))?$/i.exec(text.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[4] ?? '');
  return { game: m[1].toLowerCase(), modId: Number(m[2]), fileId: Number(m[3]), key: q.get('key'), expires: q.get('expires') };
}

/** https://www.nexusmods.com/<game>/mods/123 (optionally ?tab=files&file_id=456) */
export function parseModPage(text: string, game = NEXUS_GAME): { modId: number; fileId: number | null } | null {
  const m = /^https?:\/\/(?:www\.)?nexusmods\.com\/([\w-]+)\/mods\/(\d+)(?:[/?#](.*))?$/i.exec(text.trim());
  if (!m || m[1].toLowerCase() !== game) return null;
  const fileId = /(?:^|[?&])file_id=(\d+)/.exec(m[3] ?? '')?.[1];
  return { modId: Number(m[2]), fileId: fileId ? Number(fileId) : null };
}

async function fileInfo(modId: number, fileId: number, apiKey: string, app: { name: string; version: string }, game: string): Promise<NexusFile> {
  const [mod, file] = await Promise.all([
    get<{ name: string; author: string; uploaded_by: string; summary: string }>(`${API}/games/${game}/mods/${modId}.json`, apiKey, app),
    get<{ file_name: string; version: string; mod_version: string }>(`${API}/games/${game}/mods/${modId}/files/${fileId}.json`, apiKey, app),
  ]);
  return {
    modId,
    fileId,
    modName: mod.name,
    author: mod.author || mod.uploaded_by || 'Nexus',
    version: file.version || file.mod_version || '1.0.0',
    fileName: file.file_name,
    summary: mod.summary ?? '',
  };
}

/** The newest main file of a mod (what "Manual download" on the mod page gives). */
async function mainFile(modId: number, apiKey: string, app: { name: string; version: string }, game: string): Promise<number> {
  const r = await get<{ files: { file_id: number; category_name: string | null; uploaded_timestamp: number }[] }>(`${API}/games/${game}/mods/${modId}/files.json?category=main`, apiKey, app);
  const newest = [...r.files].sort((a, b) => b.uploaded_timestamp - a.uploaded_timestamp)[0];
  if (!newest) throw new Error('That mod has no main file to download on Nexus Mods.');
  return newest.file_id;
}

/**
 * Downloads a Nexus file to `dest` from an nxm:// link or a mod page address. Returns what's known about it.
 * Only .zip files can be installed; anything else is refused with a clear reason.
 */
export async function downloadNexus(input: string, dest: string, apiKey: string, app: { name: string; version: string }, log: (line: string) => void = () => {}, game = NEXUS_GAME): Promise<NexusFile> {
  if (!apiKey) throw new Error('Add your Nexus Mods API key first (nexusmods.com → Site preferences → API keys).');
  const nxm = parseNxm(input);
  const page = nxm ? null : parseModPage(input, game);
  if (!nxm && !page) throw new Error(`Paste a Nexus Mods link: an nxm:// link from "Mod Manager Download", or a nexusmods.com/${game}/mods/… page.`);
  if (nxm && nxm.game !== game) throw new Error(`That link is for ${nxm.game}, not ${NEXUS_GAMES[game] ?? game}.`);
  const modId = nxm?.modId ?? page!.modId;
  const fileId = nxm?.fileId ?? page!.fileId ?? (await mainFile(modId, apiKey, app, game));
  const info = await fileInfo(modId, fileId, apiKey, app, game);
  if (!/\.zip$/i.test(info.fileName)) throw new Error(`${info.modName} is packed as ${info.fileName.split('.').pop()?.toUpperCase()}; only .zip mods can be installed. Download it by hand, repack it as a .zip, and add that.`);
  const q = nxm?.key && nxm.expires ? `?key=${encodeURIComponent(nxm.key)}&expires=${encodeURIComponent(nxm.expires)}` : '';
  const links = await get<{ URI: string; short_name: string }[]>(`${API}/games/${game}/mods/${modId}/files/${fileId}/download_link.json${q}`, apiKey, app);
  if (!links[0]?.URI) throw new Error('Nexus Mods gave no download link.');
  log(`Downloading ${info.modName} ${info.version} from Nexus Mods…`);
  await downloadTo(links[0].URI, dest);
  return info;
}

/**
 * A Nexus "Manual download" file name: "<Mod Name>-<mod id>-<version parts>-<upload time>.zip" (browsers may add
 * " (1)"). Returns the package identity, or null for other file names.
 */
export function nexusFromFileName(file: string) {
  const base = file.replace(/^.*[\\/]/, '').replace(/\s*\(\d+\)(?=\.zip$)/i, '');
  const m = /^(.+?)-(\d+)-((?:\d+-){0,3}\d+)-(\d{9,})\.zip$/i.exec(base);
  if (!m) return null;
  const parts = m[3].split('-').slice(0, 3);
  while (parts.length < 3) parts.push('0');
  return nexusPackage({ modId: Number(m[2]), fileId: 0, modName: m[1], author: 'Nexus', version: parts.join('.'), fileName: base, summary: '' });
}

/** A registry-safe package identity for a Nexus mod: namespace "Nexus", name from the mod's title + id. */
export function nexusPackage(info: NexusFile) {
  const name = `${info.modName.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Mod'}_${info.modId}`;
  const version = /^\d+\.\d+\.\d+/.exec(info.version)?.[0] ?? (/^\d+\.\d+$/.test(info.version) ? `${info.version}.0` : /^\d+$/.test(info.version) ? `${info.version}.0.0` : '1.0.0');
  return { namespace: 'Nexus', name, version, description: `${info.summary} (Nexus Mods #${info.modId}, by ${info.author})`.trim() };
}
