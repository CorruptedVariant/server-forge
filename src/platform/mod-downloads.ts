// What's downloading right now, for the progress panel. Download code just calls trackDownload(); which server it counts
// for comes from the request it's running in (withDownloads), so installers don't have to pass it along. Downloads outside
// a scope (game server installs, which have their own progress) aren't tracked. SF Mod Manager has one default scope.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface ModDownload {
  id: string;
  name: string;
  received: number;
  /** 0 when the size isn't known. */
  total: number;
  state: 'downloading' | 'done' | 'failed';
  at: number;
}

const FINISHED_KEEP_MS = 15_000;
const scopeOf = new AsyncLocalStorage<string>();
const scopes = new Map<string, Map<string, ModDownload>>();
let defaultScope: string | null = null;
let listener: ((list: ModDownload[]) => void) | null = null;
let notifyAt = 0;

export const withDownloads = <T>(scope: string, fn: () => T): T => scopeOf.run(scope, fn);

/** SF Mod Manager: everything counts, and changes go to `fn`. */
export function watchAllDownloads(scope: string, fn: (list: ModDownload[]) => void) {
  defaultScope = scope;
  listener = fn;
}

export function currentDownloads(scope: string): ModDownload[] {
  const map = scopes.get(scope);
  if (!map) return [];
  const now = Date.now();
  for (const [id, d] of map) if (d.state !== 'downloading' && now - d.at > FINISHED_KEEP_MS) map.delete(id);
  if (!map.size) scopes.delete(scope);
  return [...map.values()];
}

/** Temp prefixes and numbers off a download's file name, for showing it to people. */
export const downloadLabel = (file: string) => file.replace(/^.*[\\/]/, '').replace(/^(?:tavernhost-[\w-]+?-|\d+-)/, '').replace(/\.part$/, '');

export function trackDownload(name: string) {
  const scope = scopeOf.getStore() ?? defaultScope;
  if (!scope) return { progress() {}, done() {}, failed() {} };
  let map = scopes.get(scope);
  if (!map) scopes.set(scope, (map = new Map()));
  const item: ModDownload = { id: randomBytes(4).toString('hex'), name: downloadLabel(name), received: 0, total: 0, state: 'downloading', at: Date.now() };
  map.set(item.id, item);
  const tell = (force = false) => {
    if (!listener || (!force && Date.now() - notifyAt < 200)) return;
    notifyAt = Date.now();
    listener(currentDownloads(scope));
  };
  tell(true);
  return {
    progress(received: number, total?: number) {
      item.received = received;
      if (total) item.total = total;
      item.at = Date.now();
      tell();
    },
    done() {
      item.state = 'done';
      item.at = Date.now();
      tell(true);
    },
    failed() {
      item.state = 'failed';
      item.at = Date.now();
      tell(true);
    },
  };
}
