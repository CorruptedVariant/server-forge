// What a share link (thmods://…) gives the SF Mod Manager, per game. Valheim, modded Minecraft Java and Palworld are
// synced by the app; Satisfactory mods are installed with Satisfactory Mod Manager (the app links each one); the other
// games download what they need by themselves when a player joins, so the link only carries how to join.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameModule, ServerRecord } from './games/types.ts';
import { shareManifest as valheimManifest, shareSummary as valheimSummary } from './games/valheim-addons.ts';
import { contentKind, listContent, sharedMods, sharedModFile } from './games/java-content.ts';
import { serverMods as satisfactoryMods } from './games/satisfactory.ts';
import { palSharedMods, palShareSummary, palSharedZip } from './games/palworld-mods.ts';

interface Shareable {
  record: ServerRecord;
  module: GameModule;
}

/** Minecraft Java: the loader Server Forge installed (".tavernhost-version"). */
function javaLoader(record: ServerRecord) {
  const flavor = String(record.settings.flavor ?? '');
  let mc = String(record.settings.mcVersion ?? '');
  let build = '';
  try {
    const m = JSON.parse(readFileSync(path.join(record.installDir, '.tavernhost-version'), 'utf-8'));
    mc = String(m.mc ?? mc);
    build = String(m.build ?? '');
  } catch {}
  // Fabric: "1.21.1 loader 0.16.5"; Forge: "1.20.1-47.3.0"; NeoForge: "21.1.72".
  const loaderVersion = flavor === 'fabric' ? (/loader (\S+)/.exec(build)?.[1] ?? null) : ['forge', 'neoforge'].includes(flavor) ? build || null : null;
  return { loader: flavor, mcVersion: mc, loaderVersion };
}

/** How players get the game ready for this server, shown by the app for games it doesn't sync. */
function joinNote(record: ServerRecord): string {
  switch (record.game) {
    case 'bedrock':
      return "Players' games download this server's addons by themselves when they join (accept the download when asked).";
    case 'terraria':
      return "Join with tModLoader (on Steam: Terraria → tModLoader). It downloads this server's mods by itself when you join.";
    case 'terraria-vanilla':
      return 'Join with regular Terraria (not tModLoader): Multiplayer → Join via IP.';
    case 'spaceengineers':
      return "Steam downloads this server's Workshop mods by itself when you join (Join Game → Servers, or add it to Steam's favourites).";
    case 'factorio':
      return "Factorio downloads this server's mods by itself when you join (Multiplayer → Connect to address). Your game must be on the same version.";
    case 'palworld':
      return 'Join from the title screen: Join Multiplayer Game, then enter the address at the bottom (and the password if there is one).';
    case 'enshrouded':
      return 'Play → Join → search for the server by name (or add it to your Steam favourites with this address).';
    case 'sevendays':
      return 'Join a Game → Connect to IP, and enter the address and port.';
    case 'zomboid':
      return 'Join → Add server: enter the address and port (and the password if there is one).';
    case 'vrising':
      return 'Play → Online Play → Find servers → Direct connect, and enter the address and port.';
    case 'satisfactory':
      return "Install the same mods with Satisfactory Mod Manager (each one below opens in it), then Server Manager → Add Server in the game.";
    case 'java':
      return contentKind(record) === 'mods' ? '' : 'No mods needed: join with the normal Minecraft Java launcher (Multiplayer → Add Server).';
    default:
      return '';
  }
}

/** The list a share link serves. */
export function shareManifest(inst: Shareable) {
  const { record } = inst;
  // Valheim keeps its original shape (older players' apps read it).
  if (record.game === 'valheim') return { ...valheimManifest(record), gameName: inst.module.name, join: join(inst), note: '', mode: 'sync' as const, loader: null, loaderVersion: null };
  const base = { server: record.name, game: record.game, gameName: inst.module.name, join: join(inst), note: joinNote(record), generatedAt: Date.now() };
  if (record.game === 'java') {
    if (contentKind(record) !== 'mods') return { ...base, mode: 'info' as const };
    return { ...base, mode: 'sync' as const, ...javaLoader(record), mods: sharedMods(record) };
  }
  if (record.game === 'satisfactory') {
    return {
      ...base,
      mode: 'links' as const,
      // SML (the mod loader) comes with the mods in SMM; listed so players see the version.
      mods: satisfactoryMods(record.installDir).map((m) => ({ id: m.id, name: m.name, version: m.version, url: m.url })),
    };
  }
  if (record.game === 'palworld') {
    // Mods for players' games, kept matched by the app (Palworld's own mod loader sets them up when the game starts).
    return { ...base, mode: 'sync' as const, loader: null, loaderVersion: null, mods: palSharedMods(record) };
  }
  return { ...base, mode: 'info' as const };
}

function join(inst: Shareable) {
  try {
    const c = inst.module.connection?.(inst.record);
    return c?.port ? { port: c.port, protocol: c.protocol } : null;
  } catch {
    return null;
  }
}

/** What the share card in Server Forge shows. */
export function shareSummary(inst: Shareable) {
  const { record } = inst;
  if (record.game === 'valheim') return { ...valheimSummary(record), mode: 'sync' };
  if (record.game === 'palworld') return { mode: 'sync', palworld: true, ...palShareSummary(record) };
  const m = shareManifest(inst);
  if (record.game === 'java' && m.mode === 'sync') {
    const all = listContent(record);
    return {
      mode: 'sync',
      shared: m.mods.length,
      serverOnly: all.filter((x) => x.enabled && x.side === 'server').map((x) => x.name),
      off: all.filter((x) => !x.enabled).map((x) => x.name),
      loader: m.loader,
      loaderVersion: m.loaderVersion,
    };
  }
  return { mode: m.mode, shared: 'mods' in m ? m.mods.length : 0, note: m.note };
}

/** A file players may download through the link, or null. Valheim's uploads are handled in main.ts. */
export async function sharedFile(inst: Shareable, name: string): Promise<{ file: string; type: string } | null> {
  if (inst.record.game === 'palworld') {
    const zip = await palSharedZip(inst.record, name);
    return zip ? { file: zip, type: 'application/zip' } : null;
  }
  if (inst.record.game === 'java' && /^[\w.\-+ ]+\.jar$/.test(name)) {
    const file = sharedModFile(inst.record, name);
    return file && existsSync(file) ? { file, type: 'application/java-archive' } : null;
  }
  return null;
}

/** Games whose servers can have a share link. */
export function canShare(game: string): boolean {
  return ['valheim', 'java', 'satisfactory', 'bedrock', 'terraria', 'spaceengineers', 'factorio', 'palworld', 'enshrouded', 'sevendays', 'zomboid', 'vrising'].includes(game);
}
