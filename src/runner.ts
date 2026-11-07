// The runner: a small helper process that owns a game server's console, so Server Forge can send typed commands to
// servers that read them (Minecraft Java/Bedrock) and still restart or update without stopping the game.
//
// Started by the panel (in its own hidden console) with a JSON spec in TH_RUNNER_SPEC:
//   { exe, args, cwd, env, logFile, pipe, token }
// It starts the game with piped input/output, appends all output to logFile, and listens on a Windows named pipe for
// {"token": "...", "command": "..."} lines. It exits when the game exits.
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, rmSync } from 'node:fs';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

interface RunnerSpec {
  exe: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  logFile: string;
  pipe: string;
  token: string;
}

const spec: RunnerSpec = JSON.parse(process.env.TH_RUNNER_SPEC ?? '{}');
delete process.env.TH_RUNNER_SPEC; // don't pass the token on to the game

const log = createWriteStream(spec.logFile, { flags: 'a' });
log.on('error', () => {}); // a log problem must never take the runner, and with it the server's console, down
const stamp = () => new Date().toISOString();
const note = (msg: string) => log.write(`[runner ${stamp()}] ${msg}\n`);

// Ctrl+C on our console also reaches the game; stay alive to record its final output and exit code.
process.on('SIGINT', () => note('Ctrl+C received; waiting for the server to exit.'));

const game = spawn(spec.exe, spec.args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
note(`Started ${spec.exe} (PID ${game.pid}).`);
game.stdout.pipe(log, { end: false });
game.stderr.pipe(log, { end: false });
game.stdin.on('error', () => {}); // writing after the game has exited must not crash the runner

const expected = Buffer.from(spec.token);
function tokenOk(token: unknown) {
  const given = Buffer.from(String(token ?? ''));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const server = net.createServer((socket) => {
  let buffer = '';
  socket.setEncoding('utf-8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let msg: { token?: string; command?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        socket.end('error bad-request\n');
        return;
      }
      if (!tokenOk(msg.token)) {
        socket.end('error unauthorized\n');
        return;
      }
      const command = String(msg.command ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!command) {
        socket.write('error empty\n');
        continue;
      }
      if (game.exitCode !== null || !game.stdin.writable) {
        socket.write('error not-running\n');
        continue;
      }
      game.stdin.write(`${command}\n`);
      socket.write('ok\n');
    }
  });
  socket.on('error', () => {});
});
if (process.platform === 'linux') rmSync(spec.pipe, { force: true });
server.listen(spec.pipe, () => {
  if (process.platform === 'linux') chmodSync(spec.pipe, 0o600);
  note(`Listening for commands.`);
});
server.on('error', (err) => note(`Command pipe error: ${err.message}`));

game.on('exit', (code, signal) => {
  note(`Server exited (${signal ?? `code ${code}`}).`);
  server.close(); // on Linux this also removes the socket file
  log.end(() => process.exit(code ?? 0));
});
game.on('error', (err) => {
  note(`Could not start the server: ${err.message}`);
  server.close();
  log.end(() => process.exit(1));
});
