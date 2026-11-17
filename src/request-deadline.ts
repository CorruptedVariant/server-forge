import type { IncomingMessage, ServerResponse } from 'node:http';

// Node's native whole-request deadline cannot be relaxed for just one route. Keep its
// header protection and enforce body deadlines here, where authentication has context.
export const STREAMING_HTTP_OPTIONS = { requestTimeout: 0, headersTimeout: 60_000 };
const deadlines = new WeakMap<IncomingMessage, () => void>();

export function trackRequestDeadline(req: IncomingMessage, res: ServerResponse, timeoutMs = 300_000): void {
  if (req.complete) return;
  const clear = () => {
    clearTimeout(timer);
    deadlines.delete(req);
    req.off('end', clear);
    req.off('close', clear);
  };
  const timer = setTimeout(() => {
    clear();
    if (res.headersSent || res.writableEnded) {
      req.destroy();
      return;
    }
    res.writeHead(408, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: 'The request upload timed out.' }), () => req.destroy());
  }, timeoutMs);
  timer.unref();
  deadlines.set(req, clear);
  req.once('end', clear);
  req.once('close', clear);
}

/** Call only after authorizing a streaming upload. Active transfers have no total-duration limit. */
export function allowStreamingBody(req: IncomingMessage, idleMs = 120_000): void {
  deadlines.get(req)?.();
  // An abandoned upload must still release its socket and extractor.
  req.setTimeout(idleMs, () => req.destroy());
}
