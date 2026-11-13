// Server Forge's own updates. New versions are published as GitHub releases (github.com/CorruptedVariant/server-forge); the
// service looks every 6 hours so the panel can say when one is out. Installing is done by the desktop app, which
// downloads the installer itself and runs it on this system (desktop/main.js).

const REPO = 'CorruptedVariant/server-forge';
const ASSET = process.platform === 'linux' ? /^Server-Forge-(\d+\.\d+\.\d+)-x86_64\.AppImage$/ : /^(?:Server-Forge|Tavern-Host)-Setup-(\d+\.\d+\.\d+)\.exe$/;
const EVERY = 6 * 3600_000;

export interface AppRelease {
  version: string;
  notes: string;
  url: string;
  publishedAt: string;
}

let latest: AppRelease | null = null;
let checkedAt = 0;
let lastError: string | null = null;
let checking: Promise<void> | null = null;

/** True when version a is newer than b ("0.3.12" > "0.3.9"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function fetchLatest(): Promise<void> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tavern-Host' },
      signal: AbortSignal.timeout(15_000),
    });
    // 404 = no release published yet.
    if (res.status === 404) {
      latest = null;
      lastError = null;
      return;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = (await res.json()) as { tag_name?: string; body?: string; html_url?: string; published_at?: string; assets?: { name: string }[] };
    const asset = r.assets?.map((a) => ASSET.exec(a.name)).find(Boolean);
    const version = asset?.[1] ?? String(r.tag_name ?? '').replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version) || !asset) throw new Error("The latest release doesn't have a Server Forge installer.");
    latest = { version, notes: String(r.body ?? '').slice(0, 4000), url: String(r.html_url ?? `https://github.com/${REPO}/releases/latest`), publishedAt: String(r.published_at ?? '') };
    lastError = null;
  } catch (err) {
    lastError = (err as Error).message;
  } finally {
    checkedAt = Date.now();
  }
}

/** Looks for a new version (at most every 6 hours unless forced). */
export async function checkAppUpdate(force = false): Promise<void> {
  if (!force && Date.now() - checkedAt < EVERY) return;
  checking ??= fetchLatest().finally(() => (checking = null));
  await checking;
}

export function appUpdateInfo(current: string) {
  return {
    current,
    latest: latest?.version ?? null,
    available: !!latest && isNewer(latest.version, current),
    notes: latest?.notes ?? '',
    url: latest?.url ?? `https://github.com/${REPO}/releases`,
    publishedAt: latest?.publishedAt ?? null,
    checkedAt: checkedAt || null,
    error: lastError,
  };
}

export function startAppUpdateChecks() {
  setTimeout(() => checkAppUpdate().catch(() => {}), 30_000).unref();
  setInterval(() => checkAppUpdate().catch(() => {}), EVERY).unref();
}
