// Container supervisor: stop game servers through SF before Docker terminates their namespace.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const data = process.env.PANEL_DATA_DIR || '/srv/server-forge/data';
mkdirSync(data, { recursive: true });
for (const dir of ['GameServers', 'tmp', 'clamav']) mkdirSync(path.join(process.env.HOME, dir), { recursive: true });
const configFile = path.join(data, 'config.json');
if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify({ port: 8190, remote: { enabled: true, port: 8191 } }), { mode: 0o600 });
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const resumeFile = path.join(data, 'container-resume.json');
const child = spawn(process.execPath, ['dist/main.js'], { stdio: 'inherit', env: process.env });
let stopping = false;
let finished = false;
child.on('exit', (code, signal) => { finished = true; process.exitCode = stopping ? 0 : code ?? 1; if (!stopping) process.exit(process.exitCode); });
child.on('error', error => { console.error(error.message); process.exit(1); });
const base = `http://127.0.0.1:${config.port}`;
async function request(method, route, body, cookie = '') {
  const r = await fetch(base + route, { method, headers: { 'X-Panel': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || `HTTP ${r.status}`);
  return { value, cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
}
// Bootstrap only through the loopback API. The owner gets a random starting password, shown in this container's log
// (TrueNAS: Apps → server-forge → Logs) until they choose their own on first login; SF then deletes the file.
const ownerFile = path.join(data, 'container-owner.json');
function showStartingLogin() {
  if (!existsSync(ownerFile)) return;
  const { username, password } = JSON.parse(readFileSync(ownerFile, 'utf8'));
  const port = config.remote?.port ?? 8191;
  console.log(['', '==================== Server Forge first login ====================', `  Open:      https://<this system's address>:${port}`, `  Username:  ${username}`, `  Password:  ${password}`, '  You choose your own password after logging in, and this message stops.', '==================================================================', ''].join('\n'));
}
async function initialize() {
  for (let i = 0; i < 60 && !finished; i++) {
    try {
      const { value } = await request('GET', '/api/me');
      if (value.needsSetup) {
        const password = randomBytes(12).toString('base64url');
        await request('POST', '/api/setup', { username: 'sfadmin', password });
        writeFileSync(ownerFile, JSON.stringify({ username: 'sfadmin', password }), { mode: 0o600 });
      }
      showStartingLogin();
      const key = readFileSync(path.join(data, 'desktop.key'), 'utf8').trim();
      const { cookie } = await request('POST', '/api/desktop-login', { key });
      if (existsSync(resumeFile)) {
        const ids = JSON.parse(readFileSync(resumeFile, 'utf8'));
        const { value: servers } = await request('GET', '/api/servers', undefined, cookie);
        for (const id of ids) {
          const s = servers.find(s => s.id === id);
          if (!s || !['stopped', 'crashed'].includes(s.status)) continue;
          try { await request('POST', `/api/servers/${id}/start`, {}, cookie); }
          catch (error) { console.error(`Could not resume ${s.name}: ${error.message}`); }
        }
        writeFileSync(resumeFile, '[]', { mode: 0o600 });
      }
      return;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}
initialize().catch(error => console.error('Initialization failed: ' + error.message));

// ClamAV signatures for SF's mod scans: fetched on start, then twice a day. Until the first download finishes, scans
// report "no virus scanner" as on a Linux system without ClamAV.
let freshclam = null;
function updateSignatures() {
  if (freshclam || stopping) return;
  freshclam = spawn('freshclam', ['--config-file=/opt/server-forge/freshclam.conf', '--stdout', '--quiet'], { stdio: ['ignore', 'inherit', 'inherit'] });
  freshclam.on('error', error => { console.error('ClamAV update: ' + error.message); freshclam = null; });
  freshclam.on('exit', () => { freshclam = null; });
}
setTimeout(updateSignatures, 15000).unref();
setInterval(updateSignatures, 12 * 3600_000).unref();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  freshclam?.kill();
  console.log('Container shutdown: saving and stopping game servers...');
  const forceTimer = setTimeout(() => { child.kill('SIGTERM'); process.exit(1); }, 110000);
  try {
    const key = readFileSync(path.join(data, 'desktop.key'), 'utf8').trim();
    const { cookie } = await request('POST', '/api/desktop-login', { key });
    const { value: servers } = await request('GET', '/api/servers', undefined, cookie);
    const active = servers.filter(s => !s.id.startsWith('n~') && ['running', 'starting'].includes(s.status));
    writeFileSync(resumeFile, JSON.stringify(active.map(s => s.id)), { mode: 0o600 });
    await Promise.allSettled(active.map(s => request('POST', `/api/servers/${s.id}/stop`, {}, cookie)));
    for (let i = 0; i < 90; i++) {
      const { value: list } = await request('GET', '/api/servers', undefined, cookie);
      if (!list.some(s => !s.id.startsWith('n~') && ['running', 'starting', 'stopping'].includes(s.status))) break;
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (error) { console.error('Shutdown API: ' + error.message); }
  child.kill('SIGTERM');
  clearTimeout(forceTimer);
  const timer = setTimeout(() => process.exit(0), 3000);
  if (finished) { clearTimeout(timer); process.exit(0); }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
