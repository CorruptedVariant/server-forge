// Downloading and unpacking server software.
import { createWriteStream, renameSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { trackDownload } from './platform/mod-downloads.ts';
import { isLinux } from './platform/host.ts';
import { unzipFile } from './platform/archive.ts';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Unpacks a .tar.gz or .tar.xz with the system's tar (every Linux has it; Linux game downloads come this way). */
export async function extractTar(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await execFileAsync('tar', ['-xf', archive, '-C', dest], { timeout: 30 * 60_000 });
}

/** Downloads a file, reporting progress (percent, or null when the size is unknown). Writes to <dest>.part first. */
export async function downloadFile(url: string, dest: string, onProgress?: (percent: number | null, received: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'TavernHost' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) from ${new URL(url).host}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tracked = trackDownload(dest);
  tracked.progress(0, total);
  const part = `${dest}.part`;
  const file = createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      tracked.progress(received, total);
      if (!file.write(chunk)) await once(file, 'drain');
      onProgress?.(total ? (received / total) * 100 : null, received);
    }
    await new Promise<void>((resolve, reject) => file.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    file.destroy();
    if (existsSync(part)) rmSync(part, { force: true });
    tracked.failed();
    throw err;
  }
  if (total && received !== total) {
    tracked.failed();
    throw new Error('Download was cut off before it finished.');
  }
  tracked.done();
  renameSync(part, dest);
}

/** Unpacks a .zip with Windows' built-in tools. Paths go through environment variables, never into the command text. */
export async function extractZip(zip: string, dest: string): Promise<void> {
  if (isLinux) return unzipFile(zip, dest);
  await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:TH_ZIP -DestinationPath $env:TH_DEST -Force'],
    { env: { ...process.env, TH_ZIP: zip, TH_DEST: dest }, windowsHide: true, timeout: 10 * 60_000 },
  );
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
