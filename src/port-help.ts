// "Let players outside your network join": which ports to forward on the router for a server, to which address, and
// problems Server Forge can spot (e.g. a Bedrock server-udp-ports line still holding an old public IP).
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readProperties } from './properties.ts';
import { lanAddress, listInstances, foldersUsedElsewhere } from './instances.ts';
import { lookupPublicIp } from './public-ip.ts';
import type { ServerRecord } from './games/types.ts';

export interface Forward {
  protocol: 'UDP' | 'TCP' | 'TCP & UDP';
  ports: string;
  why: string;
}
export interface PortProblem {
  text: string;
  /** A server.properties change that fixes it (the page applies it through PUT /properties). */
  fix?: { key: string; value: string; label: string };
}

const RANGE_SIZE = 20;
const RANGE_START = 35570;

/** Bedrock's "server-udp-ports=IP:from-to:from-to" (NetherNet: players outside the network connect through these). */
export function parseUdpPorts(value: string | undefined): { ip: string; from: number; to: number } | null {
  const m = /^\s*(\d{1,3}(?:\.\d{1,3}){3}):(\d+)-(\d+)(?::\d+-\d+)?\s*$/.exec(value ?? '');
  return m ? { ip: m[1], from: Number(m[2]), to: Number(m[3]) } : null;
}

function bedrockProps(record: ServerRecord) {
  return readProperties(path.join(record.installDir, 'server.properties')).values;
}

/**
 * A free block of 20 UDP ports for server-udp-ports, clear of every other Bedrock server's block and game port, here
 * and in the other Server Forges on this system (e.g. the development panel next to the installed one).
 */
function freeUdpRange(selfId: string): { from: number; to: number } {
  const folders = [
    ...listInstances()
      .filter((i) => i.record.game === 'bedrock' && i.id !== selfId)
      .map((i) => i.record.installDir),
    ...foldersUsedElsewhere(),
  ];
  const used: { from: number; to: number }[] = [];
  for (const dir of folders) {
    const file = path.join(dir, 'server.properties');
    if (!existsSync(file)) continue;
    try {
      const values = readProperties(file).values;
      const udp = parseUdpPorts(values.get('server-udp-ports'));
      if (udp) used.push(udp);
      for (const key of ['server-port', 'server-portv6']) {
        const p = Number(values.get(key));
        if (p) used.push({ from: p, to: p });
      }
    } catch {}
  }
  for (let from = RANGE_START; from < 65000; from += RANGE_SIZE) {
    const to = from + RANGE_SIZE - 1;
    if (!used.some((u) => from <= u.to && to >= u.from)) return { from, to };
  }
  return { from: RANGE_START, to: RANGE_START + RANGE_SIZE - 1 };
}

export async function portHelp(record: ServerRecord, connection: { port: number | null; protocol: string } | null) {
  const lanIp = lanAddress();
  const publicIp = await lookupPublicIp();
  const forwards: Forward[] = [];
  const problems: PortProblem[] = [];
  const notes: string[] = [];
  const port = connection?.port;

  if (record.game === 'bedrock') {
    const props = bedrockProps(record);
    const gamePort = Number(props.get('server-port')) || 19132;
    forwards.push({ protocol: 'UDP', ports: String(gamePort), why: 'The game port players connect to.' });
    const udp = parseUdpPorts(props.get('server-udp-ports'));
    if (udp) {
      forwards.push({ protocol: 'UDP', ports: `${udp.from}-${udp.to}`, why: 'Player connections (server-udp-ports). Newer Bedrock versions connect players outside your network through these.' });
      if (publicIp && udp.ip !== publicIp) {
        problems.push({
          text: `server-udp-ports still has your old public IP (${udp.ip}). Your public IP is now ${publicIp}, so players outside your network can't join until it's updated (then restart the server).`,
          fix: { key: 'server-udp-ports', value: `${publicIp}:${udp.from}-${udp.to}:${udp.from}-${udp.to}`, label: `Update it to ${publicIp}` },
        });
      }
      if (gamePort >= udp.from && gamePort <= udp.to) problems.push({ text: `The game port ${gamePort} is inside the server-udp-ports range ${udp.from}-${udp.to}. Use a range that doesn't include it.` });
    } else {
      const r = freeUdpRange(record.id);
      problems.push({
        text: 'No server-udp-ports set. Since Bedrock 1.26.50 players outside your network also connect through a range of UDP ports, so without one only players on your network (or friends via Xbox) can join.',
        fix: publicIp ? { key: 'server-udp-ports', value: `${publicIp}:${r.from}-${r.to}:${r.from}-${r.to}`, label: `Use ports ${r.from}-${r.to}` } : undefined,
      });
    }
    notes.push('Restart the server after changing server-udp-ports.');
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
    joinAddress: publicIp && port ? `${publicIp}:${port}` : null,
  };
}
