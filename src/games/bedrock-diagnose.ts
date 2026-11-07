// Crash checker for Bedrock servers (vanilla and Endstone): reads the console log since the last start, including the
// runner's "Server exited (code N)" line, and explains what went wrong in plain words, with a fix (and a one-click
// action where Server Forge can do it, e.g. installing the Visual C++ runtime BDS needs).
//
// Windows exit codes: a process that Windows itself stops reports an NTSTATUS code, e.g. 3221225781 = 0xC0000135 (a DLL
// it needs is missing). Those say more than the log, which is often empty because the server never got going.
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { ServerRecord } from './types.ts';
import type { Diagnosis, Finding } from './java-diagnose.ts';
import { isEndstone, listPlugins } from './endstone.ts';

/** DLLs bedrock_server.exe loads that Windows doesn't include: the Microsoft Visual C++ 2015-2022 runtime (x64). */
export const VC_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
export const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/** The Visual C++ DLLs that Windows can't find for this server (System32, or next to the exe). */
export function missingVcDlls(installDir: string): string[] {
  if (process.platform === 'linux') return []; // the Linux server doesn't use them
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  return VC_DLLS.filter((d) => !existsSync(path.join(sys, d)) && !existsSync(path.join(installDir, d)));
}

/** Last `bytes` of a text file. */
function tail(file: string, bytes = 400_000): string {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** Windows' own reasons for stopping a program (NTSTATUS), as they appear as exit codes. */
const WINDOWS_CODES: Record<number, { name: string; title: string; detail: string; fix: string; vc?: boolean; crash?: boolean }> = {
  0xc0000135: {
    name: 'STATUS_DLL_NOT_FOUND',
    title: "A file the server needs is missing from Windows (Visual C++ runtime)",
    detail: "Windows couldn't start bedrock_server.exe because a DLL it needs isn't on this system. The server never got as far as loading the world, so the world isn't the problem.",
    fix: 'Install the Microsoft Visual C++ Redistributable (x64), then start the server again.',
    vc: true,
  },
  0xc000007b: {
    name: 'STATUS_INVALID_IMAGE_FORMAT',
    title: 'A Windows runtime file is the wrong kind or damaged',
    detail: 'Windows found the DLLs the server needs, but one of them is a 32-bit or damaged copy, so bedrock_server.exe could not start.',
    fix: 'Install (or Repair) the Microsoft Visual C++ Redistributable x64. If it still happens, use "Update server software" with Force to download the server files again.',
    vc: true,
  },
  0xc0000142: {
    name: 'STATUS_DLL_INIT_FAILED',
    title: 'Windows could not start the server (a runtime library failed to load)',
    detail: 'A DLL bedrock_server.exe uses failed while starting. Common causes: a damaged Visual C++ runtime, antivirus blocking the server, or Windows running out of desktop resources with many programs open.',
    fix: 'Repair the Microsoft Visual C++ Redistributable (x64), make sure your antivirus allows the server folder, or restart the PC.',
    vc: true,
  },
  0xc0000005: {
    name: 'STATUS_ACCESS_VIOLATION',
    title: 'The Bedrock server crashed (access violation)',
    detail: 'bedrock_server.exe crashed while running. This is a bug inside the server, usually set off by something it loaded: an addon or behavior pack script, a damaged part of the world, or (on Endstone) a plugin.',
    fix: 'Check the log lines just before the crash. Switch off addons added or updated recently and start again; if it only happens in one area, a world backup from before it started may help.',
    crash: true,
  },
  0xc0000409: {
    name: 'STATUS_STACK_BUFFER_OVERRUN',
    title: 'The Bedrock server stopped itself after an internal error',
    detail: 'bedrock_server.exe hit an error it could not recover from and closed itself (a "fail fast"). Like other crashes, this is usually set off by an addon, a damaged part of the world, or a plugin.',
    fix: 'Check the log lines just before it stopped. Switch off addons added or updated recently and start again.',
    crash: true,
  },
  0xc00000fd: {
    name: 'STATUS_STACK_OVERFLOW',
    title: 'The Bedrock server crashed (stack overflow)',
    detail: 'Something made the server recurse until it ran out of stack, often a redstone/command-block loop, an addon script calling itself, or a very deep structure.',
    fix: 'Switch off recently added addons; if it happens in one area, look for command blocks or redstone loops there.',
    crash: true,
  },
  0xc0000017: {
    name: 'STATUS_NO_MEMORY',
    title: 'The system ran out of memory',
    detail: 'Windows could not give the server the memory it asked for.',
    fix: 'Close other programs or servers on this system, or lower view-distance / tick-distance in Properties.',
  },
  0xc000013a: {
    name: 'STATUS_CONTROL_C_EXIT',
    title: 'The server was closed with Ctrl+C',
    detail: 'The server was told to close (Ctrl+C or its console window was closed), so the world may not have saved its last minutes.',
    fix: 'Use Stop in Server Forge so the server saves first.',
  },
};

// The console log is started fresh on every start, so all of it is "since the last start".
export function diagnoseBedrock(record: ServerRecord, panelLog: string, _since: number): Diagnosis {
  const sources: string[] = [];
  let text = '';
  if (panelLog && existsSync(panelLog)) {
    sources.push('console');
    text = tail(panelLog);
  }
  const lines = [...new Set(text.split(/\r?\n/))].map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''));
  const all = lines.join('\n');
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const push = (key: string, f: Finding) => {
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  const grep = (re: RegExp, max = 4) => lines.filter((l) => re.test(l)).slice(0, max).map((l) => l.trim().slice(0, 400));
  let m: RegExpExecArray | null;

  // ---------- how it ended: the runner's exit code ----------
  const exits = [...all.matchAll(/Server exited \(code (-?\d+)\)/g)];
  const last = exits.at(-1);
  const code = last ? Number(last[1]) >>> 0 : null;
  const known = code !== null ? WINDOWS_CODES[code] : undefined;
  const missing = missingVcDlls(record.installDir);
  if (known) {
    const hex = `0x${code!.toString(16).toUpperCase()}`;
    push(`exit-${code}`, {
      severity: code === 0xc000013a ? 'warn' : 'error',
      title: known.title,
      detail: `${known.detail} (Exit code ${code} = ${hex}, Windows' ${known.name}.)${known.vc && missing.length ? ` Missing on this system: ${missing.join(', ')}.` : ''}`,
      fix: known.fix,
      evidence: grep(/Server exited \(code/i, 2),
      actions: known.vc ? [{ type: 'install-vcredist', label: 'Install Visual C++ runtime' }] : known.crash ? [{ type: 'open-tab', tab: 'addons', label: 'Open Addons' }] : [],
    });
  } else if (code !== null && code !== 0) {
    const hex = `0x${code.toString(16).toUpperCase()}`;
    push('exit-other', {
      severity: 'error',
      title: `The server stopped with exit code ${code}`,
      detail: code >= 0xc0000000 ? `Windows stopped bedrock_server.exe with error ${hex}. That's a crash or a problem starting it rather than a normal stop.` : `bedrock_server.exe ended with code ${code} (${hex}).`,
      fix: 'Check the log lines just before it stopped. Searching the web for the hex code usually says which Windows error it is.',
      evidence: grep(/Server exited \(code/i, 2),
      actions: [],
    });
  }
  // Missing runtime even without an exit code (e.g. checked before the first start).
  if (missing.length && !seen.has('exit-3221225781')) {
    push('vc-missing', {
      severity: 'error',
      title: 'The Visual C++ runtime the Bedrock server needs is not installed',
      detail: `bedrock_server.exe needs ${missing.join(', ')}, which come with the Microsoft Visual C++ Redistributable (x64), not with Windows. Without them Windows refuses to start it (exit code 3221225781).`,
      fix: 'Install the Microsoft Visual C++ Redistributable (x64), then start the server.',
      evidence: [],
      actions: [{ type: 'install-vcredist', label: 'Install Visual C++ runtime' }],
    });
  }

  // ---------- messages in the log ----------
  if (/Network port occupied|Port \[\d+\] may be in use|address already in use/i.test(all)) {
    push('port', {
      severity: 'error',
      title: 'The port is already in use',
      detail: 'Another program (often another Bedrock server, or this one still running in the background) already uses this server\'s port, so it could not open it.',
      fix: 'Give this server its own port in Properties (server-port and server-portv6), or stop the other server first. Each Bedrock server on a system needs different ports.',
      evidence: grep(/Network port occupied|Port \[\d+\] may be in use|address already in use/i),
      actions: [{ type: 'open-tab', tab: 'properties', label: 'Open Properties' }],
    });
  }
  if (/(could not|couldn't|failed to) (open|load) (the )?level|Level ?DB.*(corrupt|error)|Corruption:/i.test(all)) {
    push('world', {
      severity: 'error',
      title: "The world's files could not be opened",
      detail: "The server could not read the world's database. It may be damaged (for example the PC lost power while saving) or locked by another program.",
      fix: 'Restore a backup from before the problem (Backups tab), or run a world check. Make sure no other program (another server, a world editor) has the world open.',
      evidence: grep(/level|LevelDB|Corruption/i),
      actions: [{ type: 'open-tab', tab: 'backups', label: 'Open Backups' }],
    });
  }
  // Addons: packs the server rejected.
  const packErrors = grep(/\[(Pack|Packs|Manifest|Json|Scripting|Molang)\].*(error|fail|invalid|missing|could not)/i, 6);
  if (packErrors.length) {
    push('packs', {
      severity: 'warn',
      title: 'An addon reported errors while loading',
      detail: 'One or more behavior/resource packs logged errors. A broken addon can stop features working or crash the server.',
      fix: 'See which pack the lines name; update it, or switch it off in the Addons tab.',
      evidence: packErrors,
      actions: [{ type: 'open-tab', tab: 'addons', label: 'Open Addons' }],
    });
  }
  if ((m = /Content logging to console is disabled/i.exec(all)) && (code !== null && WINDOWS_CODES[code]?.crash)) {
    push('content-log', {
      severity: 'info',
      title: 'Addon errors are not being shown',
      detail: "This server doesn't print addon (script and pack) errors to the console, so a crash caused by an addon leaves no clue in the log.",
      fix: 'In Properties, set content-log-console-output-enabled to true, start the server again and let it crash once more: the addon errors will show here.',
      evidence: [m[0]],
      actions: [{ type: 'open-tab', tab: 'properties', label: 'Open Properties' }],
    });
  }

  // ---------- Endstone ----------
  if (isEndstone(record)) {
    if ((m = /A newer version of Bedrock Dedicated Server \(v([\d.]+)\)[^\n]*/.exec(all))) {
      push('es-newer-bds', {
        severity: 'error',
        title: 'This Bedrock version is newer than Endstone supports',
        detail: `The server files are Bedrock ${m[1]}, and the installed Endstone can't run a newer Bedrock than its own. This happens if vanilla server files were installed over an Endstone server.`,
        fix: 'Use "Update server software" on this server: Server Forge installs the newest Endstone and the Bedrock version it supports.',
        evidence: [m[0]],
        actions: [],
      });
    }
    if (/No module named|ModuleNotFoundError|Unable to find Python executable|endstone\.exe.*not found/i.test(all)) {
      push('es-python', {
        severity: 'error',
        title: "Endstone's Python environment is broken",
        detail: 'Endstone could not find part of its Python setup.',
        fix: 'Use "Update server software" with Force: Server Forge sets Endstone up again (worlds, plugins and settings are kept).',
        evidence: grep(/No module named|ModuleNotFoundError|Unable to find Python/i),
        actions: [],
      });
    }
    // Plugins that failed. Endstone stops loading all plugins when one wheel won't install.
    const pluginErrors = grep(/Error occurred when (trying to load|enabling)|is not a supported wheel|Invalid name\./i, 6);
    if (pluginErrors.length) {
      const plugins = (() => {
        try {
          return listPlugins(record.installDir);
        } catch {
          return [];
        }
      })();
      const named = plugins.filter((p) => pluginErrors.some((l) => l.toLowerCase().includes(p.name.toLowerCase()) || l.toLowerCase().includes(p.id.replace(/-/g, '_'))));
      push('es-plugins', {
        severity: pluginErrors.some((l) => /not a supported wheel|trying to load plugins in/i.test(l)) ? 'error' : 'warn',
        title: named.length ? `Plugin problem: ${named.map((p) => p.name).join(', ')}` : 'A plugin failed to load or start',
        detail: pluginErrors.some((l) => /not a supported wheel|trying to load plugins in/i.test(l))
          ? "A plugin file couldn't be installed, and when that happens Endstone stops loading every plugin, not just that one."
          : 'A plugin hit an error while loading or starting; the others keep working.',
        fix: named.length ? `Switch off ${named.map((p) => p.name).join(', ')} in the Plugins tab and start again, then look for an update or a fix from its author.` : 'Open the Plugins tab and switch off the plugin the log lines name.',
        evidence: pluginErrors,
        actions: [{ type: 'open-tab', tab: 'plugins', label: 'Open Plugins' }],
      });
    }
  }

  return { at: Date.now(), sources, findings, description: null };
}
