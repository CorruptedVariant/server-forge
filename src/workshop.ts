// Steam Workshop items: reading a link or ID, and what Steam's public API says about an item. Downloads are in
// steamcmd.ts and use the Steam account signed in on this PC, which must own the game.

/** The item ID in a Workshop link, or a bare ID. */
export function workshopId(input: unknown): string {
  const id = /(?:[?&]id=|^)(\d{6,12})\b/.exec(String(input ?? '').trim())?.[1];
  if (!id) throw new Error('Paste a Steam Workshop link or ID (e.g. https://steamcommunity.com/sharedfiles/filedetails/?id=123456789).');
  return id;
}

/** A Workshop item's title, after checking that it belongs to this game. */
export async function workshopTitle(id: string, appId: number, game: string): Promise<string> {
  const res = await fetch('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `itemcount=1&publishedfileids%5B0%5D=${id}`,
    signal: AbortSignal.timeout(15_000),
  });
  const d = (await res.json()) as { response?: { publishedfiledetails?: { result: number; title?: string; consumer_app_id?: number }[] } };
  const item = d.response?.publishedfiledetails?.[0];
  if (!item || item.result !== 1) throw new Error(`Steam doesn't know Workshop item ${id} (or it's private).`);
  if (item.consumer_app_id && item.consumer_app_id !== appId) throw new Error(`Workshop item ${id} isn't a ${game} mod.`);
  return item.title || id;
}
