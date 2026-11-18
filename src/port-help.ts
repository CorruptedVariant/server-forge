// "Let players outside your network join": which ports to forward on the router for a server, to which address, and
// problems Server Forge can spot (e.g. a Bedrock server-udp-ports line still holding an old public IP).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { readProperties } from './properties.ts';
import { lanAddress, listInstances, foldersUsedElsewhere } from './instances.ts';
import { lookupPublicIp } from './public-ip.ts';
import type { ServerRecord } from './games/types.ts';

export interface Forward {
  protocol: 'UDP' | 'TCP' | 'TCP & UDP';
  ports: string;
  insidePorts?: string;
  why: string;
}
export interface PortProblem {
  text: string;
  /** A server.properties change that fixes it (the page applies it through PUT /properties). */
  fix?: { key: string; value: string; label: string };
}

interface PortRange { from: number; to: number }
interface UdpMapping {
  ip: string | null;
  outside: PortRange | null;
  inside: PortRange;
}

function portRange(value: string): PortRange | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2] ?? m[1]);
  return from > 0 && to >= from && to <= 65535 ? { from, to } : null;
}

function rangeLabel(range: PortRange): string {
  return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
}

function udpValues(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const value = /^\s*server-udp-ports\s*=(.*)$/.exec(line)?.[1]?.trim();
    return value ? [value] : [];
  });
}

function udpMappings(values: string[]): UdpMapping[] {
  return values.flatMap((value) => value.split(',')).flatMap((entry) => {
    const m = /^(?:(\[[^\]]+\]|\d+(?:\.\d+){3}):)?(?:(\d+(?:-\d+)?):)?(\d+(?:-\d+)?)$/.exec(entry.trim());
    if (!m) return [];
    const ip = m[1]?.replace(/^\[|\]$/g, '') ?? null;
    const outside = m[2] ? portRange(m[2]) : null;
    const inside = portRange(m[3]);
    if (!inside || (ip && (!m[2] || !isIP(ip))) || (m[2] && (!outside || outside.to - outside.from !== inside.to - inside.from))) return [];
    return [{ ip, outside, inside }];
  });
}

/** Used by the existing single-range public IP health warning. */
export function parseUdpPorts(value: string | undefined): { ip: string; from: number; to: number } | null {
  const [mapping, ...rest] = udpMappings(value ? [value] : []);
  return mapping?.ip && isIP(mapping.ip) === 4 && mapping.outside && !rest.length && !value?.includes(',')
    ? { ip: mapping.ip, ...mapping.outside }
    : null;
}

function freeUdpRange(record: ServerRecord, gamePort: number, size: number): PortRange | null {
  const used = [{ from: gamePort, to: gamePort }];
  const folders = [
    ...listInstances().filter((i) => i.record.game === 'bedrock' && i.id !== record.id && !i.record.archivedAt).map((i) => i.record.installDir),
    ...foldersUsedElsewhere(),
  ];
  for (const dir of folders) {
    const file = path.join(dir, 'server.properties');
    if (!existsSync(file)) continue;
    try {
      const { lines, values } = readProperties(file);
      const port = Number(values.get('server-port')) || 19132;
      used.push({ from: port, to: port });
      for (const mapping of udpMappings(udpValues(lines))) {
        used.push(mapping.inside);
        if (mapping.outside) used.push(mapping.outside);
      }
    } catch {}
  }
  for (let from = 35570; from + size - 1 <= 65535; from += size) {
    const to = from + size - 1;
    if (!used.some((range) => from <= range.to && to >= range.from)) return { from, to };
  }
  return null;
}

/** Merge adjacent mappings with the same offset into one router rule. */
function udpForwards(mappings: UdpMapping[]): Forward[] {
  const ipv4 = mappings.flatMap(({ ip, outside, inside }) =>
    outside && (!ip || isIP(ip) === 4) ? [{ outside: { ...outside }, inside: { ...inside } }] : []);
  ipv4.sort((a, b) => a.outside.from - b.outside.from);
  const merged: typeof ipv4 = [];
  for (const current of ipv4) {
    const last = merged.at(-1);
    if (last && last.outside.to + 1 === current.outside.from && last.inside.to + 1 === current.inside.from) {
      last.outside.to = current.outside.to;
      last.inside.to = current.inside.to;
    } else merged.push(current);
  }
  return merged.map(({ outside, inside }) => ({
    protocol: 'UDP', ports: rangeLabel(outside), insidePorts: rangeLabel(inside), why: 'NetherNet gameplay (server-udp-ports).',
  }));
}

export async function portHelp(record: ServerRecord, connection: { port: number | null; protocol: string } | null) {
  let lanIp = lanAddress();
  const publicIp = await lookupPublicIp();
  const forwards: Forward[] = [];
  const problems: PortProblem[] = [];
  const notes: string[] = [];
  let port = connection?.port;
  let bedrockSetup: { title: string; properties: string } | undefined;

  if (record.game === 'bedrock') {
    const { values: props, lines } = readProperties(path.join(record.installDir, 'server.properties'));
    const gamePort = port = Number(props.get('server-port')) || 19132;
    const bind = props.get('server-ip')?.trim() ?? '';
    const raknet = props.get('transport')?.trim().toLowerCase() === 'raknet';
    if (raknet) {
      forwards.push({ protocol: 'UDP', ports: String(gamePort), why: 'Game connection for this server’s current RakNet configuration.' });
      notes.push('Current Bedrock clients use NetherNet. If players get Unsupported Transport (Error 149), update the server, set transport=nethernet in server.properties and reopen this guide to get the new router rules.');
    } else {
      if (isIP(bind) === 4 && bind !== '0.0.0.0' && !bind.startsWith('127.')) lanIp = bind;
      forwards.push({ protocol: 'TCP & UDP', ports: String(gamePort), why: 'Main server port. NetherNet starts the connection over TCP.' });
      const values = udpValues(lines);
      const mappings = udpMappings(values);
      const stale = [...new Set(mappings.flatMap(({ ip }) => ip && isIP(ip) === 4 && ip !== publicIp ? [ip] : []))];
      const udp = udpForwards(mappings);
      forwards.push(...udp);
      if (publicIp && stale.length) {
        const single = values.length === 1 && lines.filter((line) => /^\s*server-udp-ports\s*=/.test(line)).length === 1 && parseUdpPorts(values[0]);
        problems.push({
          text: `The gameplay mappings advertise ${stale.join(', ')}. This network reports ${publicIp}. If you forward directly to this system, use its current public IPv4 in the mappings.`,
          fix: single && single.ip !== publicIp
            ? { key: 'server-udp-ports', value: values[0].replace(single.ip, publicIp), label: `Update it to ${publicIp}` }
            : undefined,
        });
      }
      if (mappings.some(({ inside, outside }) => [inside, outside].some((range) => range && gamePort >= range.from && gamePort <= range.to))) {
        problems.push({ text: `The gameplay UDP ports include the main port ${gamePort}. Use a separate range when forwarding both protocols on the main port.` });
      }
      const localOnly = mappings.filter((mapping) => !mapping.outside).map(({ inside }) => rangeLabel(inside));
      if (localOnly.length) notes.push(`Allow local UDP ${localOnly.join(', ')} in the host firewall. These entries set the ports Bedrock can use locally.`);
      if (values.length && mappings.length !== values.join(',').split(',').filter((entry) => entry.trim()).length) {
        problems.push({ text: 'Some server-udp-ports entries could not be read. Check the file before applying the router rules.' });
      }
      const playerLimit = Math.max(1, Math.floor(Number(props.get('max-players')) || 10));
      const range = !values.length ? freeUdpRange(record, gamePort, Math.min(playerLimit, 15)) : null;
      const suggested = range ? Array.from({ length: range.to - range.from + 1 }, (_, i) => {
        const p = range.from + i;
        return `${publicIp ?? '<public IPv4>'}:${p}:${p}`;
      }) : [];
      if (range) {
        const label = rangeLabel(range);
        if (publicIp && lines.filter((line) => /^\s*server-udp-ports\s*=/.test(line)).length <= 1) {
          problems.push({
            text: `If the main port is reachable but outside players still cannot join, you can explicitly forward UDP ${label} to the same ports on ${lanIp}.`,
            fix: { key: 'server-udp-ports', value: suggested.join(','), label: `Configure UDP ${label}` },
          });
        }
        notes.push(`For the optional setup below, forward UDP ${label} to the same ports on ${lanIp}, and allow them in the host firewall.`);
        if (playerLimit > 15) notes.push(`The example provides 15 gameplay ports for a server configured for ${playerLimit} players. Verify larger pools with your Bedrock build before relying on them.`);
      }
      bedrockSetup = {
        title: values.length ? 'Your Bedrock server.properties' : 'Bedrock server.properties for explicit UDP forwarding',
        properties: [
          'transport=nethernet', `server-port=${gamePort}`, `server-ip=${bind}`,
          ...values.map((value) => `server-udp-ports=${value}`),
          ...suggested.map((entry) => `server-udp-ports=${entry}`),
        ].join('\n'),
      };
      notes.push(
        `Reserve ${lanIp} on your router and forward to that LAN address. For a TrueNAS host-network app, use the TrueNAS LAN address. After a move or LAN IP change, point the router rules at the new host.`,
        `Leave server-ip empty to listen on all interfaces. If the console says ready but there is no TCP listener on port ${gamePort}, set server-ip to the host's LAN IPv4, then restart. This restored the listener on TrueNAS.`,
        'Fixed gameplay ports are optional on networks that allow UDP and its return traffic. For the setup that worked on TrueNAS, use one explicit UDP port per simultaneous player. Put the public IPv4 in each server-udp-ports mapping. Each entry is PUBLIC_IP:OUTSIDE_PORT:INSIDE_PORT.',
        'ASN Converter Test used 19442 for the main port and UDP 19450–19464 for 15 players. The tested Bedrock build rejected more than 16 explicit mappings. Check the startup console before using larger pools.',
        'Allow the ports shown in the host firewall. Stop Bedrock before editing server.properties in the Files tab, then start it again. Server Forge updates mappings that use the previous public IPv4 when it detects a change. Restart a running server to apply the new address.',
        'Test an actual join from outside your network using the public IPv4 and main port, such as a laptop on a phone hotspot. If the TCP port answers but joining stalls, recheck the advertised IP and gameplay UDP rules.',
      );
    }
  } else if (record.game === 'valheim') {
    const p = port ?? 2456;
    // The game itself talks over UDP (Steam networking); many guides and routers forward TCP too, which is harmless.
    forwards.push({ protocol: 'TCP & UDP', ports: `${p}-${p + 1}`, why: 'The game port and the one after it. UDP is what the game uses; forwarding TCP as well is harmless and what many guides suggest.' });
    if (record.settings.crossplay === true || record.settings.crossplay === 'true') {
      notes.push('Crossplay is on: players can also join with the join code, which goes through a relay and needs no port forward (so joining by code works even without the forward).');
      notes.push(
        "Crossplay is on, so players on your own network can't join by this system's local IP: Valheim's crossplay finds the server through its public address only. They can use the join code or the public IP. If nobody plays on Xbox or Game Pass, turning crossplay off makes the local IP work again.",
      );
    }
    notes.push('Players join from the Join Game tab → Add server, with your public IP and port.');
  } else if (record.game === 'spaceengineers') {
    forwards.push({ protocol: 'UDP', ports: String(port ?? 27016), why: 'The game port players connect to.' });
    notes.push('Don’t forward the Remote API port: only Server Forge on this system uses it.');
    notes.push('Players join from the in-game server list (Public) or Join Game → the IP and port.');
  } else if (record.game === 'satisfactory') {
    forwards.push({ protocol: 'TCP & UDP', ports: String(port ?? 7777), why: 'The game port; the server’s HTTPS API (used by the in-game Server Manager) is on it too.' });
    forwards.push({ protocol: 'TCP', ports: String(Number(record.settings.reliablePort) || 8888), why: 'Reliable messaging (needed since Satisfactory 1.1).' });
    notes.push('Players join from Server Manager → Add Server, with your public IP and the game port.');
  } else if (record.game === 'beammp') {
    forwards.push({ protocol: 'TCP & UDP', ports: String(port ?? 30814), why: 'BeamMP uses the same port for both: TCP for joining and mod downloads, UDP for car positions.' });
    notes.push(
      record.settings.public === true || record.settings.public === 'true'
        ? 'Players find the server in the BeamMP launcher’s server list, or use Direct Connect with your public IP and port.'
        : 'The server is private: players join from the BeamMP launcher with Direct Connect, using your public IP and port.',
    );
  } else if (port) {
    forwards.push({ protocol: connection?.protocol === 'UDP' ? 'UDP' : 'TCP', ports: String(port), why: 'The port players connect to.' });
  }

  return {
    lanIp,
    publicIp,
    forwards,
    problems,
    notes,
    bedrockSetup,
    joinAddress: publicIp && port ? `${publicIp}:${port}` : null,
  };
}
