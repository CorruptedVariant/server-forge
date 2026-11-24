// In-game chat history per server: messages read from the console ([THCHAT] lines from the Bedrock relay pack) and
// messages sent from the panel. Kept in data/servers/<id>/chat.jsonl (the newest 300 also in memory) and announced
// on the 'chat' event, which the live stream passes on (Watcher uses it to mirror chat to Discord).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { dataPath } from './store.ts';
import { events } from './events.ts';

export interface ChatMessage {
  /** When it was sent (ms). */
  t: number;
  /** 'game' = typed in the game; 'panel' = sent from Server Forge (panel, API key, Discord via Watcher...). */
  from: 'game' | 'panel';
  name: string;
  text: string;
  /** For panel messages: where it came from ("Panel", "Discord", an API key's name...). */
  via?: string;
  /** A private panel message: only this player saw it in game. */
  to?: string;
  /** For panel messages: the sender's id where they wrote it (e.g. their Discord user id), as the poster said. */
  userId?: string;
  /** For panel messages sent with an API key: that key's id (unforgeable: set by Server Forge, not the poster). */
  byKey?: string;
  /** Sent by a muted player: held back in the game (only the panel sees it). */
  muted?: boolean;
}

const TAG = '[THCHAT]';
const KEEP = 300;
const MAX_FILE = 5 * 1024 * 1024;
const cache = new Map<string, ChatMessage[]>();

const fileOf = (id: string) => dataPath('servers', id, 'chat.jsonl');

/** A [THCHAT] console line as a chat message, or null. */
export function parseChatLine(line: string): ChatMessage | null {
  const at = line.indexOf(TAG);
  if (at < 0) return null;
  try {
    const d = JSON.parse(line.slice(at + TAG.length).trim());
    if (typeof d?.n !== 'string' || typeof d?.m !== 'string') return null;
    return { t: Number(d.t) || Date.now(), from: 'game', name: d.n.slice(0, 64), text: d.m.slice(0, 2000), ...(d.x ? { muted: true } : {}) };
  } catch {
    return null;
  }
}

export function readChat(id: string, limit = 200): ChatMessage[] {
  return history(id).slice(-limit);
}

/** The cached history itself (loaded from disk the first time); recordChat adds to this array. */
function history(id: string): ChatMessage[] {
  let list = cache.get(id);
  if (!list) {
    list = [];
    if (existsSync(fileOf(id))) {
      for (const line of readFileSync(fileOf(id), 'utf-8').split('\n').slice(-KEEP)) {
        try {
          if (line.trim()) list.push(JSON.parse(line));
        } catch {}
      }
    }
    cache.set(id, list);
  }
  return list;
}

/**
 * Saves a message and announces it. Game messages at or before the newest one already saved are skipped: after a panel
 * restart the whole server log is read again, and those messages are already in the history.
 */
export function recordChat(id: string, msg: ChatMessage) {
  const list = history(id);
  if (msg.from === 'game') {
    const lastGame = [...list].reverse().find((m) => m.from === 'game');
    if (lastGame && msg.t <= lastGame.t) return;
  }
  list.push(msg);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
  try {
    const file = fileOf(id);
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_FILE) renameSync(file, file.replace(/\.jsonl$/, '.old.jsonl'));
    appendFileSync(file, `${JSON.stringify(msg)}\n`);
  } catch {}
  events.emit('chat', id, msg);
}
