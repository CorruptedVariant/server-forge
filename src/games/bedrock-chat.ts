// Chat relay for vanilla Bedrock servers. Bedrock Dedicated Server never prints player chat, so Server Forge installs
// a tiny behavior pack of its own ("Server Forge Chat") whose script catches every chat message and writes it to the
// server console as one tagged line: [THCHAT]{"t":<ms>,"n":"<player>","m":"<message>"}. The panel reads those lines
// (see chat.ts). Messages from the panel go back in with tellraw, which vanilla supports.
//
// It listens to beforeEvents.chatSend, which runs before other addons can cancel or reformat a message (e.g. chat
// rank addons), and only reads it. The chat events are in the scripting API's beta, so the world needs "Beta APIs",
// and the pack must ask for exactly the beta version this Bedrock build ships (e.g. 2.11.0-beta for MC 26.51).
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChatRelayStatus } from './types.ts';
import { listPacks, installAddonFile, removePack, packFolderPath, parseLenientJson } from './bedrock-addons.ts';
import { readWorldSettings } from './bedrock-world.ts';

export const CHAT_PACK_UUID = '6f3c2a1e-8b4d-4e7a-9c5f-2d1b0a9e8c71';
const CHAT_MODULE_UUID = '9a1d4e6b-3c2f-4b8a-8e7d-5f0c1b2a3d94';
const DEFAULT_MODULE_VERSION = '2.11.0-beta';

/** Bumped whenever SCRIPT changes, so the Chat tab can offer to update relays installed by older versions. */
export const CHAT_PACK_VERSION = [1, 1, 1];

const SCRIPT = `// Server Forge Chat: writes each chat message to the server console so Server Forge can show it.
// Made by Server Forge; switched on/off from the server's Chat tab. It only reads messages, except from players the
// owner muted in Server Forge (their messages are held back and they're told they're muted).
import { world, system } from '@minecraft/server';

// Lets Server Forge see that the relay loaded (and that script output reaches the console).
console.warn('[THCHAT-READY] Server Forge chat relay is running');

// Server Forge sends the full list of muted players: scriptevent tavernhost:mutes name|other name  ("-" = nobody).
// (The command can't take JSON: Bedrock rejects a message starting with "[". Gamertags can't contain "|".)
const muted = new Set();
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== 'tavernhost:mutes') return;
  muted.clear();
  for (const n of String(ev.message).split('|')) if (n.trim() && n.trim() !== '-') muted.add(n.trim().toLowerCase());
});

world.beforeEvents.chatSend.subscribe((ev) => {
  const isMuted = muted.has(ev.sender.name.toLowerCase());
  try {
    console.warn('[THCHAT]' + JSON.stringify({ t: Date.now(), n: ev.sender.name, m: ev.message, x: isMuted ? 1 : undefined }));
  } catch {}
  if (isMuted) {
    ev.cancel = true;
    const player = ev.sender;
    system.run(() => {
      try {
        player.sendMessage('§cYou are muted on this server.');
      } catch {}
    });
  }
});
`;

function manifest(moduleVersion: string) {
  return {
    format_version: 2,
    header: {
      name: 'Server Forge Chat',
      description: 'Lets Server Forge show and relay in-game chat. Made by Server Forge.',
      uuid: CHAT_PACK_UUID,
      version: CHAT_PACK_VERSION,
      min_engine_version: [1, 21, 0],
    },
    modules: [{ type: 'script', language: 'javascript', uuid: CHAT_MODULE_UUID, entry: 'scripts/main.js', version: [1, 0, 0] }],
    dependencies: [{ module_name: '@minecraft/server', version: moduleVersion }],
  };
}

/** Semver-ish compare for "2.11.0-beta" style versions (the beta suffix is ignored). */
function compareModule(a: string, b: string) {
  const pa = a.replace(/-.*$/, '').split('.').map(Number);
  const pb = b.replace(/-.*$/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** The @minecraft/server version a pack folder asks for, if any. */
function scriptVersionOf(dir: string): string | null {
  try {
    const m = parseLenientJson(readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    const dep = (Array.isArray(m?.dependencies) ? m.dependencies : []).find((d: { module_name?: string }) => d?.module_name === '@minecraft/server');
    return dep?.version ? String(dep.version) : null;
  } catch {
    return null;
  }
}

/** The beta version to ask for: the newest one the switched-on beta packs on this server already use. */
export function suggestModuleVersion(installDir: string, level: string): { version: string; from: string } {
  const found: { version: string; name: string }[] = [];
  for (const p of listPacks(installDir, level)) {
    if (!p.enabled || p.uuid === CHAT_PACK_UUID || p.type !== 'behavior') continue;
    const v = scriptVersionOf(packFolderPath(installDir, level, p));
    if (v && /beta/i.test(v)) found.push({ version: v, name: p.name });
  }
  const explicit = found.filter((f) => /^\d+\.\d+\.\d+-beta$/i.test(f.version)).sort((a, b) => compareModule(b.version, a.version));
  if (explicit.length) return { version: explicit[0].version, from: `used by "${explicit[0].name}" on this server` };
  const alias = found.find((f) => f.version.toLowerCase() === 'beta');
  if (alias) return { version: 'beta', from: `used by "${alias.name}" on this server` };
  return { version: DEFAULT_MODULE_VERSION, from: 'default for Minecraft 26.51 (no beta packs found on this server)' };
}

export function chatStatus(installDir: string, level: string): ChatRelayStatus {
  const pack = listPacks(installDir, level).find((p) => p.uuid === CHAT_PACK_UUID);
  const suggestion = suggestModuleVersion(installDir, level);
  let betaApis: boolean | null = null;
  try {
    betaApis = readWorldSettings(installDir, level).experiments.find((e) => e.key === 'gametest')?.enabled ?? null;
  } catch {}
  return {
    on: !!pack?.enabled,
    moduleVersion: pack ? scriptVersionOf(packFolderPath(installDir, level, pack)) : null,
    suggestedVersion: suggestion.version,
    suggestedFrom: suggestion.from,
    betaApis,
    contentLog: contentLogToConsole(installDir),
    // Installed by an older Server Forge (e.g. before mute): pressing Update rebuilds it.
    outdated: !!pack && pack.version.join('.') !== CHAT_PACK_VERSION.join('.'),
  };
}

// Script output (console.warn) goes to Bedrock's "content log", which is only printed to the server console when
// server.properties has content-log-console-output-enabled=true. Without it the relay's lines never reach the panel.
const CONTENT_LOG_KEY = 'content-log-console-output-enabled';

function contentLogToConsole(installDir: string): boolean {
  try {
    const m = /^\s*content-log-console-output-enabled\s*=\s*(\S+)/m.exec(readFileSync(path.join(installDir, 'server.properties'), 'utf-8'));
    return m?.[1].toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/** Sets content-log-console-output-enabled=true in server.properties (keeping everything else as it is). */
function enableContentLogToConsole(installDir: string) {
  const file = path.join(installDir, 'server.properties');
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const re = /^(\s*content-log-console-output-enabled\s*=).*$/m;
  const next = re.test(text) ? text.replace(re, '$1true') : `${text.replace(/\s*$/, '')}\n${CONTENT_LOG_KEY}=true\n`;
  if (next !== text) writeFileSync(file, next);
}

/** Installs (or rebuilds with another module version) / removes the chat relay pack. */
export async function setChatRelay(installDir: string, level: string, on: boolean, moduleVersion?: string): Promise<ChatRelayStatus> {
  if (!on) {
    for (const p of listPacks(installDir, level).filter((x) => x.uuid === CHAT_PACK_UUID)) removePack(installDir, level, p.id);
    return chatStatus(installDir, level);
  }
  const version = (moduleVersion ?? '').trim() || suggestModuleVersion(installDir, level).version;
  if (!/^(\d+\.\d+\.\d+(-beta)?|beta)$/i.test(version)) throw new Error('Scripting version should look like 2.11.0-beta.');
  const work = path.join(os.tmpdir(), `tavernhost-chat-${randomUUID().slice(0, 8)}`);
  const dir = path.join(work, 'TavernHostChat');
  try {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest(version), null, 2));
    writeFileSync(path.join(dir, 'scripts', 'main.js'), SCRIPT);
    await installAddonFile(installDir, level, dir, 'Server Forge chat relay');
    enableContentLogToConsole(installDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return chatStatus(installDir, level);
}

/** A panel message as a console command: tellraw to everyone (the text is JSON-escaped, so it can't break out). */
export function chatSayCommand(text: string) {
  const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 600);
  return `tellraw @a ${JSON.stringify({ rawtext: [{ text: clean }] })}`;
}

/**
 * A message to one player: tellraw to that name only. Gamertags are letters, digits, spaces and a few symbols, never
 * quotes, so anything else is refused rather than escaped (a quote would end the selector).
 */
export function chatWhisperCommand(player: string, text: string) {
  const name = String(player ?? '').trim();
  if (!/^[A-Za-z0-9 _.\-]{1,32}$/.test(name)) return null;
  const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, 600);
  return `tellraw "${name}" ${JSON.stringify({ rawtext: [{ text: clean }] })}`;
}

export const chatPackInstalled = (installDir: string, level: string) => existsSync(installDir) && listPacks(installDir, level).some((p) => p.uuid === CHAT_PACK_UUID);
