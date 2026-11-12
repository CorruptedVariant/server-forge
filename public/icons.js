// Server type icons, one per game / Java server type: each game's own icon (public/game-icons, from the game's Steam
// client icon, the Microsoft Store, the Minecraft Launcher or its official website) and, for Minecraft Java, the server software's own logo
// (Fabric, Forge, NeoForge, Paper, Spigot, Sponge), so the server list says at a glance what each server is.
// BungeeCord has no logo of its own and imported jars aren't one product, so those two stay drawn tiles.

const tile = (bg, inner) =>
  `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="32" height="32" rx="7" fill="${bg}"/>${inner}</svg>`;

/** The game's own icon (public/game-icons/<name>.png). Pixel-art logos scale with hard edges. */
const logo = (name, { ext = 'png', pixel = false } = {}) =>
  `<img src="/game-icons/${name}.${ext}" alt="" draggable="false"${pixel ? ' class="pixel"' : ''}>`;

const ICONS = {
  // Minecraft Java (vanilla): the Minecraft Launcher's Java Edition grass block. Bedrock: Minecraft for Windows' icon
  // (Microsoft Store), like the launcher's flat Bedrock Edition tile.
  vanilla: logo('vanilla', { pixel: true }),
  bedrock: logo('bedrock'),
  // Bedrock running on Endstone: the same icon with end stone below the wordmark and "ENDSTONE" in endstone.dev's
  // title colour (made by tools/make-endstone-icon.py in the session folder).
  endstone: logo('bedrock-endstone'),
  paper: logo('paper'),
  spigot: logo('spigot'),
  fabric: logo('fabric', { pixel: true }),
  forge: logo('forge'),
  neoforge: logo('neoforge', { pixel: true }),
  sponge: logo('sponge', { ext: 'svg' }),
  // Proxy network: one hub linking three servers
  bungeecord: tile(
    '#3b2a63',
    '<g stroke="#c9b8ff" stroke-width="2"><path d="M16 12v5M16 17 9 22M16 17l7 5M16 17v5"/></g><circle cx="16" cy="9" r="3.5" fill="#f0eaff"/><rect x="5" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/><rect x="12.5" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/><rect x="20" y="21" width="7" height="5" rx="1.5" fill="#c9b8ff"/>',
  ),
  // A plain jar (imported server with its own jar)
  custom: tile(
    '#3a4250',
    '<rect x="10" y="7" width="12" height="3" rx="1" fill="#b3bccb"/><path d="M9 11h14v12a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3z" fill="#dfe5ee"/><rect x="12" y="15" width="8" height="5" rx="1" fill="#8d99ab"/>',
  ),
  // The games' own icons ("terraria" is Terraria with tModLoader: tModLoader's icon).
  terraria: logo('terraria'),
  'terraria-vanilla': logo('terraria-vanilla'),
  satisfactory: logo('satisfactory'),
  spaceengineers: logo('spaceengineers'),
  factorio: logo('factorio'),
  palworld: logo('palworld'),
  enshrouded: logo('enshrouded'),
  sevendays: logo('sevendays'),
  zomboid: logo('zomboid'),
  vrising: logo('vrising'),
  hytale: tile('#244052', '<path d="M8 6h5v8h6V6h5v20h-5v-8h-6v8H8z" fill="#e7c984"/>'),
  valheim: logo('valheim'),
};

/** Icon key for a server (Java servers use their type, e.g. "paper"). */
export function iconKey(server) {
  if (server.game === 'java') return ICONS[server.settings?.flavor] ? server.settings.flavor : 'custom';
  if (server.game === 'bedrock' && server.settings?.software === 'endstone') return 'endstone';
  return ICONS[server.game] ? server.game : 'custom';
}

/** An element with the server's icon. */
export function serverIcon(server, className = 'srv-icon') {
  const span = document.createElement('span');
  span.className = className;
  span.innerHTML = ICONS[iconKey(server)];
  return span;
}
