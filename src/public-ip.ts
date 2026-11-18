// Public IPv4 of this network, used by share links, port forwarding help and the public IP monitor.
import { isIPv4 } from 'node:net';

let cached: { ip: string; at: number } | null = null;
let retryAt = 0;
let pending: Promise<string | null> | null = null;

async function refreshPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (isIPv4(ip)) {
        cached = { ip, at: Date.now() };
        return ip;
      }
    }
  } catch {}
  retryAt = Date.now() + 60_000;
  return null;
}

export async function lookupPublicIp({ maxAgeMs = 3600_000, allowStale = true } = {}): Promise<string | null> {
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.ip;
  if (pending || Date.now() >= retryAt) {
    pending ??= refreshPublicIp().finally(() => { pending = null; });
    const ip = await pending;
    if (ip) return ip;
  }
  return allowStale ? cached?.ip ?? null : null;
}
