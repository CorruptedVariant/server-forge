// Nodes: other systems running Server Forge, managed from this panel. A node is reached over its remote-access HTTPS
// listener with an API key it made for this purpose ("Use this system as a node" makes a code with its address, the key
// and its certificate fingerprint). The certificate is pinned: a node whose certificate changes is refused.
//
// A node's servers appear here with ids "n~<nodeId>~<serverId>". Requests for them are passed through to the node
// (main.ts checks this panel's permissions first), and one live-updates stream per node is re-broadcast here with the
// ids rewritten, so the page treats remote servers like local ones.
import https from 'node:https';
import net from 'node:net';
import tls, { type TLSSocket } from 'node:tls';
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './store.ts';
import { events } from './events.ts';

export interface NodeRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  key: string;
  /** SHA-256 of the node's certificate, hex, upper case, no colons. */
  fingerprint: string;
  addedAt: number;
  /** "vault": a system with only Tavern Vault (no Server Forge), linked by Tavern Vault's own code. Storage only. */
  kind?: 'host' | 'vault';
}

interface NodeState {
  online: boolean;
  error: string | null;
  version: string | null;
  /** Latest snapshot of each server, by the node's own id (from the live stream). */
  servers: Map<string, Record<string, unknown>>;
  stream: IncomingMessage | null;
  retry: NodeJS.Timeout | null;
  restarting: boolean;
}

const FILE = 'nodes.json';
let nodes: NodeRecord[] = readJson<NodeRecord[]>(FILE, []);
const states = new Map<string, NodeState>();

const PREFIX = 'n~';
export const remoteId = (nodeId: string, serverId: string) => `${PREFIX}${nodeId}~${serverId}`;
export function parseRemoteId(id: string): { nodeId: string; serverId: string } | null {
  const m = /^n~([a-z0-9]+)~([\w-]+)$/i.exec(id);
  return m ? { nodeId: m[1], serverId: m[2] } : null;
}
export const isRemoteId = (id: string) => id.startsWith(PREFIX);

function state(id: string): NodeState {
  let s = states.get(id);
  if (!s) {
    s = { online: false, error: null, version: null, servers: new Map(), stream: null, retry: null, restarting: false };
    states.set(id, s);
  }
  return s;
}

export function getNode(id: string): NodeRecord {
  const n = nodes.find((x) => x.id === id);
  if (!n) throw Object.assign(new Error('That node is not connected to this panel.'), { status: 404 });
  return n;
}

export function listNodes() {
  return nodes.map((n) => {
    const s = state(n.id);
    return { id: n.id, name: n.name, kind: n.kind ?? 'host', host: n.host, port: n.port, addedAt: n.addedAt, online: s.online, error: s.error, version: s.version, restarting: s.restarting, servers: s.servers.size };
  });
}

// ---------- talking to a node ----------

/**
 * A TLS connection to host:port whose certificate matches `fingerprint` (SHA-256, hex, any case, colons allowed).
 * The certificate is checked as soon as the handshake ends, before anything (such as the node key) is sent, so a
 * system pretending to be the node never sees the key. Self-signed certificates are fine: the fingerprint is the check.
 */
export function pinnedConnect(host: string, port: number, fingerprint: string, mismatch: string): Promise<TLSSocket> {
  const want = fingerprint.replace(/:/g, '').toUpperCase();
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, ...(net.isIP(host) ? {} : { servername: host }) });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), 30_000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const fp = String(socket.getPeerCertificate()?.fingerprint256 ?? '').replace(/:/g, '').toUpperCase();
      if (!fp || fp !== want) {
        socket.destroy();
        reject(new Error(mismatch));
        return;
      }
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`Can't reach the node (${(err as NodeJS.ErrnoException).code ?? err.message}).`), { connect: true }));
    });
  });
}

/** One HTTPS request to a node, over a connection whose certificate was checked against the pinned fingerprint first. */
export async function nodeRequest(
  node: Pick<NodeRecord, 'host' | 'port' | 'key' | 'fingerprint'>,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: Buffer | NodeJS.ReadableStream | null; timeoutMs?: number } = {},
): Promise<IncomingMessage> {
  const socket = await pinnedConnect(node.host, node.port, node.fingerprint, "The node's security certificate has changed. Remove the node and add it again with a fresh code.");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: node.host,
        port: node.port,
        method,
        path,
        headers: { Authorization: `Bearer ${node.key}`, ...opts.headers },
        // The already-checked connection above (no agent: it's used for this one request only).
        createConnection: () => socket,
        timeout: opts.timeoutMs ?? 30_000,
      },
      resolve,
    );
    req.on('timeout', () => req.destroy(new Error('The node did not answer in time.')));
    req.on('error', (err) => reject(new Error(`Can't reach the node (${(err as NodeJS.ErrnoException).code ?? err.message}).`)));
    const body = opts.body;
    if (body && typeof (body as NodeJS.ReadableStream).pipe === 'function') {
      // A body that fails part-way (e.g. a server move whose other side stopped) ends the request instead of leaving it open.
      (body as NodeJS.ReadableStream).on('error', (err) => req.destroy(err));
      (body as NodeJS.ReadableStream).pipe(req);
    }
    else req.end(body as Buffer | undefined);
  });
}

export async function nodeJson<T = unknown>(node: NodeRecord, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const res = await nodeRequest(node, method, path, { ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) } : {}), timeoutMs });
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf-8');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if ((res.statusCode ?? 500) >= 400) throw Object.assign(new Error((data as { error?: string })?.error ?? `The node answered ${res.statusCode}.`), { status: res.statusCode });
  return data as T;
}

// ---------- adding / removing ----------

/**
 * thnode://host:port/<th_key>?fp=<sha256>&name=<name> (Server Forge), or thvault://host:port/<tv_key>?fp=…&name=…
 * (Tavern Vault on a system without Server Forge: storage only).
 */
export function parseNodeCode(code: string) {
  const m = /^(thnode|thvault):\/\/([^/:\s]+):(\d+)\/((?:th|tv)_[0-9a-f]+)\?(.+)$/i.exec(String(code ?? '').trim());
  if (!m) throw new Error('That isn\'t a node code. On the other system open Server Forge → Settings → "Use this system as a node" (or, on a system with only Tavern Vault, Tavern Vault → Settings → Node mode) and copy the code (it starts with thnode:// or thvault://).');
  const kind = m[1].toLowerCase() === 'thvault' ? 'vault' : 'host';
  if ((kind === 'vault') !== m[4].startsWith('tv_')) throw new Error("That code doesn't look right. Copy it again from the other system.");
  const q = new URLSearchParams(m[5]);
  const fp = String(q.get('fp') ?? '').replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(fp)) throw new Error('The code is missing the certificate fingerprint.');
  return { kind: kind as 'host' | 'vault', host: m[2], port: Number(m[3]), key: m[4], fingerprint: fp, name: q.get('name') ?? m[2] };
}

export async function addNode(code: string, name?: string) {
  const c = parseNodeCode(code);
  if (nodes.some((n) => n.host === c.host && n.port === c.port)) throw new Error('That system is already a node here.');
  const probe = { ...c, id: '', addedAt: 0 };
  // Check it answers, the key works and it's a Server Forge new enough to be a node (or a Tavern Vault).
  const me = await nodeJson<{ version?: string; global?: unknown; app?: string }>(probe as NodeRecord, 'GET', '/api/me');
  if (c.kind === 'vault' && me?.app !== 'Tavern Vault') throw new Error("That system didn't answer as Tavern Vault. Make a fresh code in Tavern Vault there.");
  if (c.kind === 'host' && !Array.isArray(me?.global)) throw new Error('That system runs a Server Forge too old to be a node. Update it first.');
  const node: NodeRecord = { id: randomBytes(3).toString('hex'), name: String(name ?? '').trim().slice(0, 40) || c.name, host: c.host, port: c.port, key: c.key, fingerprint: c.fingerprint, addedAt: Date.now(), kind: c.kind };
  nodes.push(node);
  writeJson(FILE, nodes);
  connect(node);
  return node;
}

export function renameNode(id: string, name: string) {
  const n = getNode(id);
  n.name = String(name ?? '').trim().slice(0, 40) || n.name;
  writeJson(FILE, nodes);
  for (const snap of state(id).servers.values()) events.emit('remote-server', decorate(n, snap));
}

export function removeNode(id: string) {
  const n = getNode(id);
  const s = state(id);
  s.stream?.destroy();
  if (s.retry) clearTimeout(s.retry);
  for (const serverId of s.servers.keys()) events.emit('remote-removed', remoteId(n.id, serverId));
  states.delete(id);
  nodes = nodes.filter((x) => x.id !== id);
  writeJson(FILE, nodes);
}

// ---------- the live stream from each node ----------

/** A node's server snapshot as this panel shows it: its own id, and which node it's on. */
function decorate(node: NodeRecord, snap: Record<string, unknown>) {
  return { ...snap, id: remoteId(node.id, String(snap.id)), node: { id: node.id, name: node.name } };
}

export function remoteServers(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) {
    const s = state(n.id);
    for (const snap of s.servers.values()) out.push(decorate(n, s.online ? snap : { ...snap, status: 'unknown', nodeOffline: true }));
  }
  return out;
}

function handleEvent(node: NodeRecord, event: string, data: string) {
  const s = state(node.id);
  let d: Record<string, any>;
  try {
    d = JSON.parse(data);
  } catch {
    return;
  }
  switch (event) {
    case 'server':
      s.servers.set(String(d.id), d);
      events.emit('remote-server', decorate(node, d));
      break;
    case 'removed':
      s.servers.delete(String(d.id));
      events.emit('remote-removed', remoteId(node.id, String(d.id)));
      break;
    case 'line':
      events.emit('remote-line', remoteId(node.id, String(d.id)), d.line);
      break;
    case 'chat':
      events.emit('remote-chat', remoteId(node.id, String(d.id)), d.message);
      break;
    case 'alert': {
      const a = d.alert ?? {};
      events.emit('remote-alert', { alert: { ...a, id: `${PREFIX}${node.id}~${a.id}`, serverId: a.serverId ? remoteId(node.id, a.serverId) : null, title: `${node.name}: ${a.title}` }, active: d.active });
      break;
    }
    case 'panel':
      s.restarting = d.status === 'restarting';
      events.emit('nodes');
      break;
  }
}

async function refreshServers(node: NodeRecord) {
  const list = await nodeJson<Record<string, unknown>[]>(node, 'GET', '/api/servers');
  const s = state(node.id);
  const seen = new Set<string>();
  for (const snap of list) {
    seen.add(String(snap.id));
    s.servers.set(String(snap.id), snap);
    events.emit('remote-server', decorate(node, snap));
  }
  for (const id of [...s.servers.keys()]) {
    if (!seen.has(id)) {
      s.servers.delete(id);
      events.emit('remote-removed', remoteId(node.id, id));
    }
  }
}

// The node pings its live stream every 25 s. A connection that dies without closing (network blip, the router
// forgetting an idle connection, the node sleeping or rebooting) would otherwise look connected forever, and every
// later change on the node (new servers, status) would be missed. No data for this long = dead: reconnect.
const STREAM_SILENCE_MS = 70_000;
// While connected, the full server list is fetched again this often too, in case an event was missed anyway.
const REFRESH_MS = 2 * 60_000;

/** A Tavern Vault-only node has no servers or live stream: it's checked every 30 s to know if it's up. */
function connectVault(node: NodeRecord) {
  const s = state(node.id);
  if (s.retry) clearTimeout(s.retry);
  (async () => {
    const was = s.online;
    try {
      const me = await nodeJson<{ version?: string }>(node, 'GET', '/api/me');
      s.online = true;
      s.error = null;
      s.version = me?.version ?? null;
    } catch (err) {
      s.online = false;
      s.error = (err as Error).message;
    }
    if (was !== s.online) events.emit('nodes');
    if (nodes.some((n) => n.id === node.id)) s.retry = setTimeout(() => connectVault(node), 30_000);
  })();
}

function connect(node: NodeRecord) {
  if (node.kind === 'vault') return connectVault(node);
  const s = state(node.id);
  if (s.retry) clearTimeout(s.retry);
  let watchdog: NodeJS.Timeout | null = null;
  let done = false;
  const retry = (err: string) => {
    if (done) return;
    done = true;
    if (watchdog) clearInterval(watchdog);
    const wasOnline = s.online;
    s.online = false;
    s.error = s.restarting ? 'Restarting (update)…' : err;
    s.stream = null;
    if (wasOnline) {
      events.emit('nodes');
      for (const snap of s.servers.values()) events.emit('remote-server', decorate(node, { ...snap, status: 'unknown', nodeOffline: true }));
    }
    if (nodes.some((n) => n.id === node.id)) s.retry = setTimeout(() => connect(node), s.restarting ? 3000 : 10_000);
  };
  (async () => {
    try {
      const me = await nodeJson<{ version?: string }>(node, 'GET', '/api/me');
      s.version = me?.version ?? null;
      await refreshServers(node);
      const res = await nodeRequest(node, 'GET', '/api/events', { timeoutMs: 0 });
      if ((res.statusCode ?? 500) >= 400) throw new Error(`The node refused the connection (${res.statusCode}). Its key may have been deleted.`);
      s.stream = res;
      s.online = true;
      s.error = null;
      s.restarting = false;
      events.emit('nodes');
      let lastData = Date.now();
      let lastRefresh = Date.now();
      watchdog = setInterval(() => {
        if (Date.now() - lastData > STREAM_SILENCE_MS) {
          res.destroy();
          retry('The node stopped answering.');
        } else if (Date.now() - lastRefresh > REFRESH_MS) {
          lastRefresh = Date.now();
          refreshServers(node).catch(() => {});
        }
      }, 10_000);
      watchdog.unref();
      let buf = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        lastData = Date.now();
        buf += chunk;
        let at: number;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          let ev = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7).trim();
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) handleEvent(node, ev, data.join('\n'));
        }
      });
      res.on('end', () => retry('The node closed the connection.'));
      res.on('close', () => retry('The node closed the connection.'));
      res.on('error', (err) => retry(err.message));
    } catch (err) {
      retry((err as Error).message);
    }
  })();
}

export function startNodes() {
  for (const n of nodes) connect(n);
}
