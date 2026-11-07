// Safety checks for mod files before they're installed (Server Forge and the Tavern Client Mod Manager).
// Nothing can prove a mod is safe; this layers three checks:
//   1. Windows Defender scans the file (a detection blocks it).
//   2. Thunderstore status: removed or deprecated versions are flagged (removal is how malicious uploads are handled).
//   3. A behaviour scan of .NET DLLs: the names of Windows APIs, file paths and commands a DLL uses are stored readably
//      in the file, so patterns typical of malware (stealing Discord/browser/Steam data, injecting into other programs,
//      starting with Windows, hidden PowerShell, downloading .exe files, obfuscators) are spotted. It can flag innocent
//      mods, so it asks for a review rather than refusing.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ZipFile } from './zip.ts';

export type Verdict = 'clean' | 'review' | 'blocked';

export interface ScanFlag {
  level: 'high' | 'medium';
  text: string;
  file?: string;
}

export interface ScanResult {
  verdict: Verdict;
  defender: 'clean' | 'threat' | 'unavailable' | 'error';
  threat?: string;
  flags: ScanFlag[];
  /** Short one-line summary for lists. */
  summary: string;
}

// ---------- Windows Defender (ClamAV on Linux) ----------

/** The virus scanner's name in messages. */
export const SCANNER = process.platform === 'linux' ? 'ClamAV' : 'Windows Defender';
/** Linux desktops often have no scanner, which isn't worth a warning on every mod the way Defender being off is. */
export const noScannerIsNormal = process.platform === 'linux';

function defenderExe(): string | null {
  const candidates = [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe')];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Scans one file (archives included) with Windows Defender, without letting it delete anything. */
export function defenderScan(file: string): Promise<{ result: ScanResult['defender']; threat?: string }> {
  // No Defender on Linux: ClamAV does the same job when it's installed. Exit code 1 = found something.
  if (process.platform === 'linux') {
    return new Promise((resolve) => {
      execFile('clamscan', ['--no-summary', '--infected', file], { timeout: 300_000 }, (err, stdout) => {
        const code = (err as { code?: number | string } | null)?.code ?? 0;
        if (code === 1) resolve({ result: 'threat', threat: /: (.+) FOUND/.exec(String(stdout))?.[1] ?? 'unknown threat' });
        else if (code === 0) resolve({ result: 'clean' });
        else resolve({ result: 'unavailable' });
      });
    });
  }
  const exe = defenderExe();
  if (!exe) return Promise.resolve({ result: 'unavailable' });
  return new Promise((resolve) => {
    execFile(exe, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation'], { windowsHide: true, timeout: 180_000 }, (err, stdout) => {
      const code = (err as { code?: number } | null)?.code ?? 0;
      const threat = /Threat\s*:\s*(.+)/.exec(String(stdout))?.[1]?.trim();
      if (code === 2 || threat) resolve({ result: 'threat', threat: threat ?? 'unknown threat' });
      else if (code === 0) resolve({ result: 'clean' });
      // Another antivirus is active, Defender is off, or the scan failed: say so rather than claim "clean".
      else resolve({ result: /disabled|not running|0x800106ba/i.test(String(stdout)) ? 'unavailable' : 'error' });
    });
  });
}

// ---------- behaviour scan of .NET DLLs ----------

interface Rule {
  level: 'high' | 'medium';
  text: string;
  /** All of these must appear (case-insensitive), as UTF-8 or UTF-16 text in the DLL. */
  all: string[];
}

const RULES: Rule[] = [
  // Stealing accounts and data
  { level: 'high', text: 'Reads Discord login data (a common token-stealer trick)', all: ['discord', 'local storage', 'leveldb'] },
  { level: 'high', text: 'Reads saved browser passwords or cookies', all: ['user data', 'login data'] },
  { level: 'high', text: 'Reads saved browser passwords or cookies', all: ['user data', 'network\\cookies'] },
  { level: 'high', text: "Reads Steam's saved logins", all: ['loginusers.vdf'] },
  { level: 'high', text: 'Looks for crypto wallets', all: ['wallet.dat'] },
  { level: 'high', text: 'Looks for crypto wallets', all: ['exodus', 'wallet'] },
  { level: 'high', text: 'Takes screenshots of the desktop and sends them somewhere', all: ['copyfromscreen', 'webhook'] },
  { level: 'high', text: 'Contains a Discord webhook address (used to send stolen data)', all: ['discord.com/api/webhooks'] },
  { level: 'high', text: 'Contains a Discord webhook address (used to send stolen data)', all: ['discordapp.com/api/webhooks'] },
  { level: 'high', text: 'Contains a Telegram bot address (used to send stolen data)', all: ['api.telegram.org/bot'] },
  // Tampering with other programs / the system
  { level: 'high', text: 'Injects code into other programs', all: ['createremotethread', 'writeprocessmemory'] },
  { level: 'high', text: 'Injects code into other programs', all: ['virtualallocex', 'writeprocessmemory'] },
  { level: 'high', text: 'Makes itself start with Windows', all: ['currentversion\\run'] },
  { level: 'high', text: 'Creates scheduled tasks', all: ['schtasks', '/create'] },
  { level: 'high', text: 'Runs hidden or encoded PowerShell commands', all: ['powershell', '-encodedcommand'] },
  { level: 'high', text: 'Runs hidden or encoded PowerShell commands', all: ['powershell', ' -enc '] },
  { level: 'high', text: 'Runs hidden or encoded PowerShell commands', all: ['powershell', '-windowstyle hidden'] },
  { level: 'high', text: 'Downloads and runs programs', all: ['downloadfile', '.exe', 'process'] },
  { level: 'high', text: 'Turns off Windows Defender', all: ['set-mppreference'] },
  { level: 'high', text: 'Turns off Windows Defender', all: ['disablerealtimemonitoring'] },
  { level: 'high', text: 'Is hidden with an obfuscator (tools often used to hide malware)', all: ['confuserex'] },
  { level: 'high', text: 'Is hidden with an obfuscator (tools often used to hide malware)', all: ['confused by'] },
  // Worth a look, but common in normal mods too
  { level: 'medium', text: 'Starts other programs or opens files/links', all: ['system.diagnostics', 'processstartinfo'] },
  { level: 'medium', text: 'Runs command-line commands', all: ['cmd.exe', '/c'] },
  { level: 'medium', text: 'Changes the Windows registry', all: ['microsoft.win32', 'registrykey', 'setvalue'] },
  { level: 'medium', text: 'Reads keys pressed outside the game (keylogger-like)', all: ['getasynckeystate', 'user32'] },
  { level: 'medium', text: 'Loads extra code from raw bytes at runtime', all: ['assembly', 'load', 'frombase64string'] },
];

/** The DLL's text in both encodings .NET uses (UTF-8 names, UTF-16 string literals), lower-cased. */
function dllText(data: Buffer): string {
  // UTF-16 text can start on an odd byte, so read it at both alignments.
  return (data.toString('latin1') + '\n' + data.toString('utf16le') + '\n' + data.subarray(1).toString('utf16le')).toLowerCase();
}

export function scanDll(data: Buffer, name: string): ScanFlag[] {
  const text = dllText(data);
  const flags: ScanFlag[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (seen.has(rule.text)) continue;
    if (rule.all.every((s) => text.includes(s))) {
      seen.add(rule.text);
      flags.push({ level: rule.level, text: rule.text, file: name });
    }
  }
  return flags;
}

/** Well-known, widely used loader packages whose core DLLs legitimately use low-level tricks (Harmony patching). */
const TRUSTED_PACKAGES = new Set(['denikson-bepinexpack_valheim']);

// ---------- whole package ----------

function summarise(r: Omit<ScanResult, 'summary'>): string {
  if (r.defender === 'threat') return `${SCANNER} found ${r.threat}`;
  const high = r.flags.filter((f) => f.level === 'high');
  if (r.verdict === 'blocked') return r.flags[0]?.text ?? 'Blocked';
  if (high.length) return `Needs review: ${high[0].text.toLowerCase()}${high.length > 1 ? ` (+${high.length - 1} more)` : ''}`;
  const def = noScannerIsNormal ? (r.defender === 'clean' ? 'ClamAV: clean' : r.defender === 'unavailable' ? 'No virus scanner on this system' : 'ClamAV scan failed') : r.defender === 'clean' ? 'Defender: clean' : r.defender === 'unavailable' ? 'Defender not available' : 'Defender scan failed';
  const med = r.flags.filter((f) => f.level === 'medium').length;
  return `${def}${med ? ` · ${med} thing${med === 1 ? '' : 's'} to be aware of` : ' · nothing suspicious found'}`;
}

/**
 * Checks a mod file (a .zip package, .jar or .dll) before it's installed. `fullName` ("Author-Mod") lets trusted loader
 * packages skip the behaviour scan; `thunderstoreActive` false means the version was removed from Thunderstore.
 */
export async function scanPackage(file: string, opts: { fullName?: string; thunderstoreActive?: boolean | null; deprecated?: boolean } = {}): Promise<ScanResult> {
  const flags: ScanFlag[] = [];
  const def = await defenderScan(file);
  if (opts.thunderstoreActive === false) flags.push({ level: 'high', text: 'This version was removed from Thunderstore (mods are removed when found to be harmful or broken)' });
  if (opts.deprecated) flags.push({ level: 'medium', text: 'Marked as deprecated on Thunderstore (no longer maintained)' });

  const trusted = opts.fullName ? TRUSTED_PACKAGES.has(opts.fullName.toLowerCase()) : false;
  if (!trusted) {
    if (/\.dll$/i.test(file)) flags.push(...scanDll(readFileSync(file), path.basename(file)));
    else if (/\.zip$/i.test(file)) {
      const zip = new ZipFile(file);
      try {
        for (const name of zip.names()) {
          if (!/\.dll$/i.test(name)) continue;
          const data = zip.get(name, 64 * 1024 * 1024);
          if (data) flags.push(...scanDll(data, ZipFile.normalise(name)));
        }
      } finally {
        zip.close();
      }
    }
  }
  // One flag per text, keeping the first file it was seen in.
  const unique = flags.filter((f, i) => flags.findIndex((g) => g.text === f.text) === i);
  const verdict: Verdict = def.result === 'threat' ? 'blocked' : unique.some((f) => f.level === 'high') ? 'review' : 'clean';
  const base = { verdict, defender: def.result, threat: def.threat, flags: unique };
  return { ...base, summary: summarise(base) };
}

/** Scans bytes that aren't on disk yet (writes them to a temp file first, so Defender can see them). */
export async function scanBuffer(data: Buffer, name: string, opts: Parameters<typeof scanPackage>[1] = {}) {
  const dir = path.join(os.tmpdir(), `tavernhost-scan-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name.replace(/[^\w.-]/g, '_'));
  try {
    writeFileSync(file, data);
    return await scanPackage(file, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
