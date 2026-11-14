# Tavern Host HTTP API

Reference for Tavern Host 0.12.1. This file is generated from the list in `public/app.js` (the same one the panel shows in Settings → API reference) by `node tools/make-api-docs.mjs`.

> Tavern Host is in beta and updates are frequent. Routes can change between versions; check this file for the version you run.

## Basics

- **Address:** `http://127.0.0.1:8190` on the system running Tavern Host. From other devices, turn on Remote access (Settings) and use `https://<address>:8191` (self-signed certificate: pin its fingerprint rather than turning checks off).
- **API key:** make one in Settings → API keys, and send it with every request: `Authorization: Bearer th_…` (or `X-Api-Key: th_…`). Keys from before the Tavern Host rename start with `gsp_` and still work.
- **Permissions:** each request needs the permission shown in the tables, on that server (or all servers) for the key. The owner account can do everything.
- **Bodies:** JSON, with `Content-Type: application/json`. Uploads are the raw file as the body, with the file name in an `X-Filename` header.
- **Server ids:** `{id}` is the `id` from `GET /api/servers`. Servers on nodes (other systems) have ids like `n~<node>~<server>` and work the same way.
- **Errors:** a non-2xx status with `{"error": "message"}`. Common ones: 400 bad request, 401 no or bad key, 403 missing permission, 404 not found or not available for that game, 409 not possible right now (e.g. server running), 428 start refused by the pre-start check (repeat with `{"force": true}` to start anyway).
- **Live updates:** `GET /api/events` is a Server-Sent Events stream: `server` (status changes), `line` (console lines), `chat`, `removed` and `panel` (`{status: "up"|"restarting", reason}`) events, for everything the key can see.

## Examples

```
curl -H "Authorization: Bearer th_…" http://127.0.0.1:8190/api/servers

curl -X POST -H "Authorization: Bearer th_…" -H "Content-Type: application/json" \
     -d "{\"command\":\"say hi\"}" http://127.0.0.1:8190/api/servers/{id}/command

curl -X POST -H "Authorization: Bearer th_…" -H "Content-Type: application/json" \
     -d "{\"countdownMinutes\":5}" http://127.0.0.1:8190/api/servers/{id}/restart
```

## Contents

- [Storage (Tavern Vault)](#storage-tavern-vault)
- [General](#general)
- [Servers](#servers)
- [Control & console](#control--console)
- [Players & statistics](#players--statistics)
- [Properties & world](#properties--world)
- [BungeeCord network](#bungeecord-network)
- [Valheim profiles](#valheim-profiles)
- [Backups](#backups)
- [Mods, plugins & addons](#mods-plugins--addons)
- [Tasks](#tasks)
- [Server files](#server-files)
- [Users, keys & panel](#users-keys--panel)

## Storage (Tavern Vault)

| Request | What it does | Permission |
|---|---|---|
| `GET /api/vault` | Storage on this system: {"state":"ok","status":{pools, disks, arrays, jobs, problems…}} or why it isn't available ("missing" = Tavern Vault not installed, "off" = its node mode is off, "nokey"/"down" = its service isn't reachable) | See storage |
| `GET /api/vault/summary` | Storage at a glance for this system and every node | See storage |
| `POST /api/vault/call` | Run a Tavern Vault call: {"method","args"} → {"ok","data"\|"error"}. Reading (state, inventory, arrays, schedules, activity, scrubInfo, discoverArrays, validateArray, snapraidRunning) needs See storage; everything else (createPool, createVolume, addDisks, retireDisk, removeDisk, repairVolume, resizeVolume, attachPool, rename, deleteVolume, deletePool, eraseDisk, saveArray, snapraidRun, createSchedule…) needs Manage storage. Tavern Vault's practice mode and safety checks apply. | See / Manage storage |
| `GET /api/vault/events?since=` | SnapRAID output and finish events after sequence number since | See storage |
| `GET /api/nodes/{node}/vault` | The same, for a node (through its node link; the node needs Server Forge 0.5.0+ and Tavern Vault in node mode) | See storage |
| `POST /api/nodes/{node}/vault/call` | Run a Tavern Vault call on a node | See / Manage storage |
| `GET /api/nodes/{node}/vault/events?since=` | SnapRAID output on a node | See storage |

## General

| Request | What it does | Permission |
|---|---|---|
| `GET /api/me` | Who you are, and your panel-wide permissions | Any key or login |
| `GET /api/games` | Supported games and their settings fields | Any key or login |
| `GET /api/games/{game}/versions?from={type}` | Versions you can install (e.g. Minecraft versions for "paper") | Any key or login |
| `GET /api/permissions` | Every permission, grouped, with descriptions and role presets | Any key or login |
| `GET /api/events` | Live updates stream (Server-Sent Events): server, line, chat, removed, panel ({status:"up"\|"restarting", reason}) | See the server (per server) |
| `GET /api/health` | Is the panel up: {ok, startedAt, lastRestart:{reason, downAt, upAt}} (no login needed) | Nothing |
| `POST /api/panel/restarting` | Announce a planned restart to live-stream clients: {"reason":"update"} | Panel settings |
| `GET /api/stats` | CPU/RAM right now for every running server you can see | See the server (per server) |
| `GET /api/alerts` | Health warnings (low disk/RAM, stuck starts, failed backup copies, world checks…), nodes included | See the server (per server) |
| `POST /api/alerts/{alert}/dismiss` | Dismiss a warning | See the server (per server) |
| `PUT /api/me/password` | Change your own password: {"current","password"} (logins only, not API keys) | Any login |
| `GET /api/app-update?check=1` | New Server Forge version on GitHub: {current, latest, available, notes, url, checkedAt, error}; check=1 looks right now (otherwise the 6-hourly check) | Panel settings |

## Servers

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers` | All servers you can see: status, players, version, join code, IP/port, your permissions | See the server |
| `GET /api/servers/{id}` | One server in detail (console included if allowed, Valheim bosses, crash check) | See the server |
| `POST /api/servers/new` | Create a server and download its software: {"game","name","installDir","settings","acceptEula"} | Create & import servers |
| `POST /api/servers` | Import an existing server folder: {"game","name","installDir"} | Create & import servers |
| `PUT /api/servers/{id}` | Change settings: {"name","installDir","autoRestart","settings"} | Change settings |
| `PUT /api/servers/{id}` | Change automatic backups only: {"backupSchedule":{"everyHours","keep"}} | Make backups |
| `PUT /api/servers/{id}` | Automatic game updates on/off only: {"autoUpdate":true} (Bedrock, Valheim) | Update server software |
| `POST /api/servers/{id}/clone` | Copy a server (in the background): {"name","installDir"} | Create & import servers + View & download files |
| `POST /api/moves` | Move a server to another system (this one or a node), in the background: {"serverId","to":"local" or a node id,"keepOld"?}. Answers the move; GET /api/moves/{id} follows it | Create & import servers + Remove the server + View & download files |
| `GET /api/servers/{id}/transfer-info` | What moving this server would send (used by the main panel): its settings, scheduled tasks and the size of each part | Remove the server + View & download files |
| `GET /api/servers/{id}/transfer-part` | One part as a tar stream: ?part=server\|world\|backups (the server must be stopped) | Remove the server + View & download files |
| `POST /api/transfer/begin` | Receive a moved server: {"record","platform","parts","tasks"}. Answers {"token","installDir","id"}; then POST /api/transfer/{token}/part?name=… (tar body) per part, POST /api/transfer/{token}/finish, or DELETE /api/transfer/{token} to cancel | Create & import servers |
| `POST /api/servers/{id}/update` | Download/update the server software | Update server software |
| `GET /api/servers/{id}/game-update?check=1` | Game update status (Bedrock, Valheim): {current, latest, available, updating, auto…}; check=1 looks it up now | See the server |
| `POST /api/servers/{id}/game-update` | Install the latest game version: {"countdownMinutes":5,"force":false} (progress in the console; 409 if already up to date unless force). /bedrock-update still works | Update server software (+ Stop when running) |
| `GET /api/servers/{id}/ports` | Port forwarding help: {lanIp, publicIp, forwards:[{protocol, ports, why}], problems:[{text, fix?}], notes, joinAddress} | See the server |
| `GET /api/servers/{id}/difficulty` | Current difficulty and the choices for this game | See the server |
| `PUT /api/servers/{id}/difficulty` | Set it: {"value":"hard"} (Minecraft: peaceful/easy/normal/hard, applied live; Valheim: casual/easy/normal/hard/hardcore/immersive/hammer, or "keep"; applies on the next start) | Change settings |
| `DELETE /api/servers/{id}?files=0&backups=0` | Remove the server from Server Forge. files=1 also sends its folder to the Recycle Bin (needs Edit & upload files too); backups=1 deletes its backups | Remove server |
| `POST /api/servers/{id}/eula` | Accept the Minecraft EULA | Change settings |
| `PUT /api/server-order` | Sidebar order: {"ids":[...]} in the new order (each listed server keeps a slot it already had; "position" in /api/servers) | Change settings (every listed server) |

## Control & console

| Request | What it does | Permission |
|---|---|---|
| `POST /api/servers/{id}/start` | Start. Answers 428 with the reason if the pre-start check fails (world damaged, files in use); send {"force":true} to start anyway | Start |
| `POST /api/servers/{id}/stop` | Stop (the world is saved first). Optional countdown: {"countdownMinutes":5,"message"?:"… {time} …"} | Stop |
| `POST /api/servers/{id}/restart` | Restart (same countdown options as stop) | Restart |
| `POST /api/servers/{id}/countdown/cancel` | Cancel a running stop/restart countdown | Stop or Restart |
| `POST /api/servers/{id}/kill` | Force-close a stuck server without saving | Kill |
| `GET /api/servers/{id}/console?lines=100` | Recent console lines | View console |
| `POST /api/servers/{id}/command` | Send a command: {"command":"say hi"} | Send commands |
| `GET /api/servers/{id}/chat?limit=200` | In-game chat history (Bedrock, with the chat relay on) and relay status. Live: "chat" events on /api/events | View console |
| `POST /api/servers/{id}/chat` | Say something in the game: {"message","name"?,"source"?} shows as "[source] name: message" (e.g. source "Discord") | Send commands |
| `POST /api/servers/{id}/chat/relay` | Chat relay on/off: {"enabled":true,"moduleVersion"?:"2.11.0-beta"} (applies when the server restarts) | Manage mods / plugins / addons |

## Players & statistics

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/players` | Everyone who has played: online first, last seen, joins, playtime, note, muted (Valheim: player ID, admin, banned, permitted, allowListOn); plus the actions this server has | See the server |
| `POST /api/servers/{id}/players/{name}/action` | Player action: {"action":"kick\|op\|deop\|allowlist-add\|allowlist-remove\|whitelist-add\|whitelist-remove\|ban\|pardon\|mute\|unmute\|note","reason"?,"note"?} (no ban on Bedrock; mute needs the Bedrock chat relay) | Edit player lists |
| `POST /api/servers/{id}/players/{name}/action` | Valheim: {"action":"admin-add\|admin-remove\|list-ban\|list-unban\|permit-add\|permit-remove"} edits adminlist/bannedlist/permittedlist by the player's ID (they must have joined once) | Edit player lists |
| `GET /api/servers/{id}/stats?range=3600` | CPU, RAM, players and uptime history (range in seconds, 30 to 86400) | See the server |
| `GET /api/servers/{id}/lists/{list}` | A player list (whitelist/allowlist, ops; Valheim: admins, banned, permitted) | See the server |
| `PUT /api/servers/{id}/lists/{list}` | Replace a list: {"entries":["name1","name2"]} | Edit player lists |
| `POST /api/servers/{id}/diagnose` | Run the crash checker (Java servers) | See the server |
| `DELETE /api/servers/{id}/diagnose` | Clear the crash checker result | See the server |

## Properties & world

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/properties` | The game's settings file with descriptions (server.properties; Palworld: PalWorldSettings.ini) | See the server |
| `PUT /api/servers/{id}/properties` | Change values: {"values":{"max-players":"20"}} | Edit properties & world |
| `GET /api/servers/{id}/world` | Bedrock world: cheats, cheat settings, experiments | See the server |
| `PUT /api/servers/{id}/world` | Change them: {"cheats","cheatSettings","experiments","restart"} | Edit properties & world (+ Restart when running) |
| `POST /api/servers/{id}/properties/repair` | Bedrock: rebuild server.properties from the official template, keeping your values and converting Java-format keys (a backup is kept) | Edit properties & world |
| `GET /api/servers/{id}/worlds` | Worlds in the server folder and which one is active (Bedrock, Java) | See the server |
| `POST /api/servers/{id}/worlds/{folder}/activate` | Make a world the active one (applies on the next start; "restartNeeded" says so) | Edit properties & world |
| `GET /api/servers/{id}/worlds/{folder}/export` | Download a world (.mcworld / .zip) | View & download files |
| `POST /api/servers/{id}/worlds/import?name=&activate=1` | Import a world (raw .mcworld/.zip body, X-Filename header) | Edit & upload files (+ Edit properties & world to activate) |
| `DELETE /api/servers/{id}/worlds/{folder}` | Delete a world (Recycle Bin) | Edit & upload files |

## BungeeCord network

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/network` | A proxy's servers (config.yml), where players land first (priorities), and Server Forge's Minecraft Java servers that can be added | See the server |
| `POST /api/servers/{id}/network` | Add a server: {"serverId"?: a Server Forge server (address filled in) \| "address": "host:port", "name", "first"?: true, "prepare"?: true (Paper/Spigot: bungeecord: true, online-mode=false)} | Edit properties & world (+ on the added server, to prepare it) |
| `DELETE /api/servers/{id}/network/{name}` | Remove a server from the proxy's list | Edit properties & world |
| `PUT /api/servers/{id}/network/default` | Where players land first: {"name"} | Edit properties & world |

## Valheim profiles

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/profiles` | Profiles (a world plus which mods are on, or vanilla) and the active one | See the server |
| `POST /api/servers/{id}/profiles` | Add a profile: {"name","world"?,"vanilla"?} (starts as a copy of how the server is set up now) | Change settings |
| `PUT /api/servers/{id}/profiles/{profile}` | Change a profile: {"name"?,"world"?,"vanilla"?} | Change settings |
| `DELETE /api/servers/{id}/profiles/{profile}` | Delete a profile (not the active one) | Change settings |
| `POST /api/servers/{id}/profiles/{profile}/activate` | Switch to a profile: {"restart":true} is needed while it's running (409 otherwise) | Change settings (+ Restart when running) |

## Backups

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/backups` | List backups | See the server |
| `POST /api/servers/{id}/backups` | Back up now | Make backups |
| `POST /api/servers/{id}/backups/{backup}/restore` | Restore a backup (server stopped) | Restore backups |
| `DELETE /api/servers/{id}/backups/{backup}` | Delete a backup | Delete backups |
| `POST /api/servers/{id}/backups/copies/{file}/bring-back` | Copy a backup from the backup copy folder back to this system, so it can be restored | Restore backups |
| `GET /api/servers/{id}/world-check` | World integrity check (Bedrock): last result, missing or regenerated chunks, last good backup | See the server |
| `POST /api/servers/{id}/world-check` | Check the world now | Make backups |
| `POST /api/servers/{id}/world-check/accept` | The flagged changes were on purpose: make the world as it is now the reference | Restore backups |

## Mods, plugins & addons

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/addons` | Installed mods/plugins/addons with compatibility warnings | See the server |
| `POST /api/servers/{id}/addons/upload` | Install a file (raw body, name in the X-Filename header) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/upload-folder` | Install an unpacked folder (Bedrock): 4-byte LE length of {"files":[{"path","size"}]}, then the file bytes in order | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/{item}/enabled` | Switch on/off: {"enabled":true} | Manage mods / plugins / addons |
| `DELETE /api/servers/{id}/addons/{item}` | Remove | Manage mods / plugins / addons |
| `PUT /api/servers/{id}/addons/order` | Bedrock load order: {"type":"behavior"\|"resource","ids":[...]} top first (top wins); "priority" in the list | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/check-updates` | Newer versions available (Valheim: Thunderstore/Hexium; Bedrock: CurseForge, for linked addons) | See the server |
| `POST /api/servers/{id}/addons/{item}/update` | Update one (Valheim; Bedrock: installs the newest CurseForge file on the chosen channel) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/{item}/curseforge` | Bedrock: link an addon to a CurseForge project for updates: {"projectId":123}, or {"projectId":null} to unlink | Manage mods / plugins / addons |
| `POST /api/servers/{id}/steam-login` | Open SteamCMD on the server's PC to sign in for Workshop downloads: {"username":"..."} (owner only). Then POST /steam-login/confirm with the same body; DELETE /steam-login signs out. In the container (no SteamCMD window) send {"username","password","code"?} instead: it signs in directly and answers {"account"} | Owner |
| `POST /api/servers/{id}/addons/by-id` | Add a mod by ID or link (Space Engineers: Steam Workshop): {"input":"https://steamcommunity.com/sharedfiles/filedetails/?id=…"} | Manage mods / plugins / addons |
| `GET /api/servers/{id}/addons/update-settings` | Bedrock addon updates: {channel: "release"\|"beta"\|"alpha", auto} | See the server |
| `PUT /api/servers/{id}/addons/update-settings` | Change them: {"channel":"beta","auto":true} (beta/alpha files only count when newer than the newest release) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/setup` | Turn on modding (Valheim: installs BepInEx; permanent) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/{item}/side` | Who gets a mod (Valheim: {"side":"both\|server\|clients"}; Minecraft Java mod servers: {"side":"both\|server"}). server = not shared with players | Manage mods / plugins / addons |
| `GET /api/servers/{id}/addons/settings` | Valheim: mod settings files in BepInEx/config: {files:[{file, plugin, version, mod, settings, shared}]} (mod = the installed mod it belongs to, if known) | Manage mods / plugins / addons |
| `GET /api/servers/{id}/addons/settings/{file}` | Valheim: one settings file: {entries:[{section, key, value, description, type, default, options, multi, range, shared}]} | Manage mods / plugins / addons |
| `PUT /api/servers/{id}/addons/settings/{file}` | Valheim: change values and choose what players get: {"values":[{"section","key","value"}],"shared":[{"section","key"}]} (shared = the full list sent to players through the share link) | Manage mods / plugins / addons |
| `PUT /api/servers/{id}/addons/location` | Where new addons go (games with more than one addon folder): {"location"} | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/{item}/move` | Move one addon to the other folder: {"to"} | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/move-all` | Move every addon to one folder: {"to"} | Manage mods / plugins / addons |
| `GET /api/servers/{id}/addons/{item}/icon` | An addon's icon (PNG) | See the server |
| `GET /api/servers/{id}/addons/curseforge/search?q=&page=0` | Search CurseForge (needs the CurseForge key in Integrations) | See the server |
| `POST /api/servers/{id}/addons/curseforge` | Install the latest file of a CurseForge project: {"projectId"} (answers needsBrowser when the author only allows website downloads) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/hexium` | Valheim: install from Hexium with dependencies: {"input":"https://valheim.hexium.gg/mods/Author/Mod"} or {"namespace","name","version"?} | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/nexus` | Valheim: install a Nexus Mods file: {"input":"nxm://…"} (needs the Nexus key in Integrations; a mod page address needs Premium) | Manage mods / plugins / addons |
| `POST /api/servers/{id}/addons/adopt` | Valheim: take over mods added without Server Forge (r2modman, by hand) so they can be shared: {adopted, skipped} | Manage mods / plugins / addons |
| `GET /api/servers/{id}/plugins` | Bedrock on Endstone: its plugins (.whl/.dll). Every /addons route above also works under /plugins for them (upload, {item}/enabled, DELETE, check-updates, {item}/update, setup) | See the server |
| `GET /api/servers/{id}/plugins/search?q=` | Endstone: search plugins on GitHub and PyPI: {results:[{id, name, summary, author, url, source, version?, stars?}], errors} | See the server |
| `POST /api/servers/{id}/plugins/found` | Endstone: install the newest file of a search result: {"id":"pypi:endstone-essentials"} or {"id":"github:owner/repo"} | Manage mods / plugins / addons |
| `GET /api/servers/{id}/share` | Players' share link (Valheim, Minecraft Java, Satisfactory, Bedrock, Terraria tModLoader, Space Engineers): links, public link, what's shared (summary, with mode sync\|links\|info), Remote access status | Share mods with players |
| `POST /api/servers/{id}/share` | Sharing on/off or a new link: {"enabled":true,"newLink":false} | Share mods with players |
| `GET /api/share/{token}` | What the players' SF Mod Manager reads (Remote access port): {server, game, gameName, mode, join:{port,protocol}, note, mods…}. Minecraft Java mod servers add loader, mcVersion, loaderVersion | The share link token (no login) |
| `GET /api/share/{token}/file/{name}` | Download a shared mod file (Valheim uploads, Nexus and Hexium copies; Minecraft Java mod jars players need) | The share link token (no login) |

## Tasks

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/tasks` | Scheduled tasks with next/last run | See the server |
| `POST /api/servers/{id}/tasks` | Create a task: {"name","enabled","trigger","jobs","onlyWhenRunning"} | Create & edit tasks |
| `PUT /api/servers/{id}/tasks/{task}` | Change a task | Create & edit tasks |
| `DELETE /api/servers/{id}/tasks/{task}` | Delete a task | Create & edit tasks |
| `POST /api/servers/{id}/tasks/{task}/run` | Run a task now | Run tasks |

## Server files

| Request | What it does | Permission |
|---|---|---|
| `GET /api/servers/{id}/files?path=` | List a folder in the server's folder | View & download files |
| `GET /api/servers/{id}/files/content?path=` | Read a text file | View & download files |
| `GET /api/servers/{id}/files/download?path=` | Download a file | View & download files |
| `PUT /api/servers/{id}/files/content` | Save a text file: {"path","content","modified"} | Edit & upload files |
| `POST /api/servers/{id}/files/upload?path=` | Upload a file into a folder (raw body, X-Filename) | Edit & upload files |
| `POST /api/servers/{id}/files/mkdir` | New folder or file: {"path","name","file":false} | Edit & upload files |
| `POST /api/servers/{id}/files/rename` | Rename: {"path","name"} | Edit & upload files |
| `POST /api/servers/{id}/files/delete` | Delete to the Recycle Bin: {"path"} | Edit & upload files |

## Users, keys & panel

| Request | What it does | Permission |
|---|---|---|
| `GET /api/users` | Users with role, access summary and last login | Manage users & API keys |
| `POST /api/users` | Add a user: {"username","password","role","grants","remote","mustChangePassword","note"} | Manage users & API keys |
| `PUT /api/users/{id}` | Change a user (same fields, plus "disabled") | Manage users & API keys |
| `POST /api/users/{id}/signout` | Sign a user out everywhere | Manage users & API keys |
| `DELETE /api/users/{id}` | Delete a user | Manage users & API keys |
| `GET /api/apikeys` | API keys (never the key itself) | Manage users & API keys |
| `POST /api/apikeys` | Create a key: {"name","preset","grants","expiresInDays"} (the key is returned once) | Manage users & API keys |
| `PUT /api/apikeys/{id}` | Change a key | Manage users & API keys |
| `DELETE /api/apikeys/{id}` | Delete a key | Manage users & API keys |
| `GET /api/activity?account=&q=` | Activity log (newest first) | View activity log |
| `GET /api/settings/remote` | Remote access status | Panel settings |
| `PUT /api/settings/remote` | Remote access on/off and port: {"enabled","port"} (on this system only) | Panel settings |
| `POST /api/settings/remote/firewall` | Add the Windows Firewall rule for the Remote access port (on this system only; Windows asks for admin) | Panel settings |
| `GET /api/settings/integrations` | Which integrations are set up: {curseforge, nexus} (never the keys) | Panel settings |
| `PUT /api/settings/integrations` | Set or remove keys: {"curseforgeKey"?,"nexusKey"?} ("" removes; the Nexus key is checked with Nexus) | Panel settings |
| `GET /api/servers/{id}/discord` | Discord notifications: {url, events:{started, stopped, crashed, join, leave, updateAvailable, updated, backupFailed}, labels} | Change settings |
| `PUT /api/servers/{id}/discord` | Set them: {"url":"https://discord.com/api/webhooks/…","events":{"join":true,…}} (url "" turns them off) | Change settings |
| `POST /api/servers/{id}/discord/test` | Post a test message: {"url"?} (else the saved webhook) | Change settings |
| `PUT /api/settings/integrations/factorio` | factorio.com login for Factorio servers and mods: {"username","token"} (checked with factorio.com; both "" removes). Answers {linked, username, spaceAge, canImport} | Panel settings |
| `POST /api/settings/integrations/factorio/import` | Take the factorio.com login the Factorio game saved on this system (player-data.json) | Panel settings |
| `GET /api/settings/backup-copy` | Backup copies to another drive or share: {enabled, folder, keepDays} | Panel settings |
| `PUT /api/settings/backup-copy` | Change them: {"enabled","folder","keepDays"} | Panel settings |
| `POST /api/settings/backup-copy/test` | Test a folder: {"folder"} → free space | Panel settings |
| `POST /api/settings/backup-copy/sync` | Copy every existing backup that isn't there yet (in the background) | Panel settings |
| `GET /api/nodes` | Nodes (other systems) managed from this panel | Panel settings |
| `GET /api/node-targets` | Systems you can create servers on (nodes with Server Forge, and whether they are online) | Create & import servers |
| `GET /api/nodes/{node}/games` | A node's games and their settings fields (for creating a server there) | Create & import servers |
| `GET /api/nodes/{node}/games/{game}/versions?from={type}` | Versions a node can install | Create & import servers |
| `POST /api/nodes/{node}/servers/new` | Create a server on a node (same body as POST /api/servers/new); the answer has its id here (n~node~server) | Create & import servers |
| `POST /api/nodes/{node}/servers` | Import a server folder on a node (same body as POST /api/servers) | Create & import servers |
| `POST /api/nodes` | Add a node: {"code":"thnode://…","name"?} | Panel settings |
| `PUT /api/nodes/{node}` | Rename a node: {"name"} | Panel settings |
| `DELETE /api/nodes/{node}` | Remove a node (its servers keep running there) | Panel settings |
| `POST /api/node-code` | Make a code so another panel can manage this system (servers, and storage if Tavern Vault is in node mode): {"label"?} (on this system only; needs Remote access on) | Panel settings |
| `GET /api/files?path=` | Browse any folder on this system | Browse all files on this system |
| `POST /api/files/mkdir` | New folder: {"parent","name"} | Browse all files on this system |
| `POST /api/files/rename` | Rename: {"path","name"} (not folders a running server uses) | Browse all files on this system |
| `POST /api/files/delete` | Delete to the Recycle Bin: {"path"} (not folders a running server uses) | Browse all files on this system |
