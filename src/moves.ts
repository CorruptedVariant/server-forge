// Moving a server to another system, the main panel's half: one job that stops the server, streams its parts from the
// system it's on to the system it goes to (through this panel, so the two never need to reach each other), has the new
// system add it, and then removes the old copy (its files go to the Recycle Bin / Trash there). Either side may be this
// system or a node. The per-system half is transfer.ts.
import { PassThrough, type Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { deleteServer, getInstance } from './instances.ts';
import { deleteTasksFor } from './scheduler.ts';
import { getNode, listNodes, nodeJson, nodeRequest, parseRemoteId, remoteId, type NodeRecord } from './nodes.ts';
import { abortReceive, beginReceive, finishReceive, packPart, receivePart, transferInfo, type TransferInfo, type TransferPart } from './transfer.ts';

export interface MoveInfo {
  id: string;
  serverId: string;
  serverName: string;
  from: string;
  to: string;
  status: 'running' | 'done' | 'failed';
  step: string;
  progress: number | null;
  error: string | null;
  /** The server's id on this panel once it's in its new place. */
  newServerId: string | null;
  notes: string[];
  startedAt: number;
  finishedAt: number | null;
}

interface Received {
  server: { id: string; name: string; installDir: string };
  reinstalling: boolean;
}

interface Source {
  name: string;
  info(): Promise<TransferInfo>;
  status(): Promise<string>;
  stop(): Promise<void>;
  open(part: TransferPart): Promise<Readable>;
  remove(): Promise<void>;
}

interface Target {
  name: string;
  begin(body: unknown): Promise<{ token: string; installDir: string; id: string }>;
  part(token: string, part: TransferPart, body: Readable): Promise<void>;
  finish(token: string): Promise<Received>;
  abort(token: string): Promise<void>;
  panelId(id: string): string;
}

const LOCAL = 'This System';
const moves = new Map<string, MoveInfo>();
const moving = new Set<string>();

/** A node too old to move servers answers 404 for these. */
function nodeError(node: NodeRecord, err: unknown): Error {
  const e = err as Error & { status?: number };
  return e.status === 404 && /not found/i.test(e.message) ? new Error(`${node.name} runs a Server Forge too old to move servers. Update it there first.`) : new Error(`${node.name}: ${e.message}`);
}

async function readError(res: Readable & { statusCode?: number }): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text || `answered ${res.statusCode}`;
  }
}

function localSource(id: string): Source {
  const inst = getInstance(id);
  return {
    name: LOCAL,
    info: () => transferInfo(id),
    status: async () => getInstance(id).status,
    stop: () => inst.stop(),
    open: async (part) => packPart(id, part),
    remove: async () => {
      await deleteServer(id, { files: true, backups: true });
      deleteTasksFor(id);
    },
  };
}

function nodeSource(nodeId: string, id: string): Source {
  const node = getNode(nodeId);
  const base = `/api/servers/${encodeURIComponent(id)}`;
  const call = <T>(method: string, path: string, body?: unknown, timeout?: number) => nodeJson<T>(node, method, path, body, timeout).catch((err) => Promise.reject(nodeError(node, err)));
  return {
    name: node.name,
    info: () => call<TransferInfo>('GET', `${base}/transfer-info`, undefined, 10 * 60_000),
    status: async () => (await call<{ status: string }>('GET', base)).status,
    stop: async () => void (await call('POST', `${base}/stop`, {})),
    open: async (part) => {
      const res = await nodeRequest(node, 'GET', `${base}/transfer-part?part=${part}`, { timeoutMs: 0 });
      if ((res.statusCode ?? 500) >= 400) throw nodeError(node, Object.assign(new Error(await readError(res)), { status: res.statusCode }));
      return res;
    },
    remove: async () => void (await call('DELETE', `${base}?files=1&backups=1`, undefined, 5 * 60_000)),
  };
}

function localTarget(): Target {
  return {
    name: LOCAL,
    begin: async (body) => beginReceive(body as Parameters<typeof beginReceive>[0]),
    part: (token, part, body) => receivePart(token, part, body),
    finish: (token) => finishReceive(token),
    abort: async (token) => abortReceive(token),
    panelId: (id) => id,
  };
}

function nodeTarget(nodeId: string): Target {
  const node = getNode(nodeId);
  const call = <T>(method: string, path: string, body?: unknown) => nodeJson<T>(node, method, path, body, 5 * 60_000).catch((err) => Promise.reject(nodeError(node, err)));
  return {
    name: node.name,
    begin: (body) => call('POST', '/api/transfer/begin', body),
    part: async (token, part, body) => {
      const res = await nodeRequest(node, 'POST', `/api/transfer/${token}/part?name=${part}`, { headers: { 'Content-Type': 'application/x-tar' }, body, timeoutMs: 0 });
      if ((res.statusCode ?? 500) >= 400) throw new Error(`${node.name}: ${await readError(res)}`);
      res.resume();
    },
    finish: (token) => call('POST', `/api/transfer/${token}/finish`, {}),
    abort: async (token) => void (await call('DELETE', `/api/transfer/${token}`).catch(() => {})),
    panelId: (id) => remoteId(nodeId, id),
  };
}

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(2)} GB`;

/** Where a server is: this system ("local") or the node it's on. */
export function systemOf(serverId: string): string {
  return parseRemoteId(serverId)?.nodeId ?? 'local';
}

export function startMove(serverId: string, to: string, opts: { keepOld: boolean }): MoveInfo {
  const remote = parseRemoteId(serverId);
  if (moving.has(serverId)) throw new Error('That server is already being moved.');
  if ((remote?.nodeId ?? 'local') === to) throw new Error("It's already on that system.");
  if (to !== 'local' && !listNodes().some((n) => n.id === to && n.online && n.kind === 'host')) throw new Error('That system is offline or not a Server Forge node.');
  if (remote && !listNodes().some((n) => n.id === remote.nodeId && n.online)) throw new Error('The system this server is on is offline.');
  const source = remote ? nodeSource(remote.nodeId, remote.serverId) : localSource(serverId);
  const target = to === 'local' ? localTarget() : nodeTarget(to);
  const name = remote ? serverId : getInstance(serverId).record.name;

  const move: MoveInfo = { id: randomBytes(6).toString('hex'), serverId, serverName: name, from: source.name, to: target.name, status: 'running', step: 'Starting…', progress: null, error: null, newServerId: null, notes: [], startedAt: Date.now(), finishedAt: null };
  moves.set(move.id, move);
  moving.add(serverId);
  const step = (text: string, progress: number | null = null) => Object.assign(move, { step: text, progress });

  void (async () => {
    let token: string | null = null;
    try {
      step('Looking at what to move…');
      let info = await source.info();
      move.serverName = info.record.name;
      if (info.running) {
        step(`Stopping ${info.record.name} (it saves first)…`);
        await source.stop();
        const until = Date.now() + 5 * 60_000;
        while (!['stopped', 'crashed'].includes(await source.status())) {
          if (Date.now() > until) throw new Error("The server didn't stop within 5 minutes. Stop it yourself, then move it.");
          await new Promise((r) => setTimeout(r, 2000));
        }
        info = await source.info();
      }
      step(`Getting ${target.name} ready…`);
      const begun = await target.begin({ record: info.record, platform: info.platform, parts: info.parts.map((p) => p.name), tasks: info.tasks });
      token = begun.token;
      const total = info.parts.reduce((n, p) => n + p.bytes, 0) || 1;
      let done = 0;
      for (const part of info.parts) {
        const label = part.name === 'server' ? 'server files' : part.name === 'world' ? 'world' : 'backups';
        step(`Moving the ${label}… ${gb(done)} of ${gb(total)}`, Math.round((done / total) * 100));
        const from = await source.open(part.name);
        const counter = new PassThrough();
        from.on('error', (err) => counter.destroy(err));
        counter.on('data', (c: Buffer) => {
          done += c.length;
          step(`Moving the ${label}… ${gb(done)} of ${gb(total)}`, Math.min(99, Math.round((done / total) * 100)));
        });
        from.pipe(counter);
        await target.part(token, part.name, counter);
      }
      step(`Adding it on ${target.name}…`, 99);
      const result = await target.finish(token);
      token = null;
      move.newServerId = target.panelId(result.server.id);
      move.notes.push(`On ${target.name} it's in ${result.server.installDir}, with the same settings and ports.`);
      if (result.reinstalling) move.notes.push(`${target.name} is a different kind of system, so it's installing the server files made for it now (see the server's console). Start it when that's done.`);
      if (!opts.keepOld) {
        step(`Removing the old copy from ${source.name}…`, 100);
        try {
          await source.remove();
          move.notes.push(`The old copy was removed from ${source.name} (its files went to the Recycle Bin / Trash there).`);
        } catch (err) {
          move.notes.push(`The old copy couldn't be removed from ${source.name} (${(err as Error).message}). It's stopped; remove it yourself when you're happy with the move.`);
        }
      } else move.notes.push(`The old copy is still on ${source.name}, stopped.`);
      Object.assign(move, { status: 'done', step: 'Moved.', progress: 100 });
    } catch (err) {
      if (token) await target.abort(token).catch(() => {});
      Object.assign(move, { status: 'failed', error: (err as Error).message, step: 'The move failed. Nothing was removed from the old system.' });
    } finally {
      move.finishedAt = Date.now();
      moving.delete(serverId);
    }
  })();
  return move;
}

export function getMove(id: string): MoveInfo | null {
  return moves.get(id) ?? null;
}
