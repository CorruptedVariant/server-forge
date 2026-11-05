# Changelog

## Server Forge 0.9.5

Change all of Palworld's world settings from Server Forge.

**New**
- **World settings tab for Palworld servers.** Every setting in `PalWorldSettings.ini` can now be changed here, with a plain name, an explanation and its default, grouped into sections such as Pals, Bases and building, Guilds and PvP. Search finds any setting, and **Show advanced** lists the rarely used ones. Changes apply when the server restarts.
- Values outside Pocketpair's documented limits, and values of the wrong kind, are refused with a message saying why.
- The tab warns if a world has a `WorldOption.sav`, which makes Palworld ignore most of these settings.

**Changed**
- Palworld's Difficulty, On death, XP rate, Capture rate and PvP moved from Settings to the World settings tab. Server Forge no longer overwrites them at each start, so values you've set in the file stay as they are.
- PvP is now two settings, **PvP** and **Players can damage each other**. Turn on both for full PvP.

## SF Mod Manager 0.6.2

A full Palworld mod manager, with Play now.

**New**
- **Palworld mods.** The Palworld tab now lists every mod in your game and works without following a server. Add your own by dropping a **.zip**, **.pak** or mod folder, or with **Add a mod file**. Mods made for Palworld's mod loader, older .pak mods, older UE4SS script mods and UE4SS itself all work.
- **Browse CurseForge** and **Browse Nexus Mods** open in a window, and mods you download there install after you confirm. Nexus "Mod Manager Download" works with your Nexus API key.
- Your own mods have **On/off** and **Remove**. Each mod is labelled **yours**, **from a server** or **Steam Workshop**.
- **▶ Play now** syncs with your servers, then starts Palworld through Steam. If a server can't be reached, the game starts anyway.
- **UE4SS through sync.** When a server's mods need UE4SS and the server shares it (Server Forge 0.9.4), Sync installs it for you. It's skipped if you already have your own copy, because two copies crash the game.

**Changed**
- The tab warns when a mod needs UE4SS and you don't have it, when a mod is made for servers only, and when a manual UE4SS install (dwmapi.dll) won't run mods from the mod loader.

## Server Forge 0.9.4

Palworld players get UE4SS through the share link.

**Changed**
- A Palworld server's share link now includes **UE4SS** whenever a shared mod needs it, so players can get it with a sync (SF Mod Manager 0.6.2 or newer). If no shared mod needs it, players aren't sent it. UE4SS now shows as **Server + players** on the Mods tab. UE4SS already on a server doesn't need adding again.
- Mods that need UE4SS now point you to adding it on the Mods tab, with the download link.

## Server Forge 0.9.3

UE4SS and Lua mods on Palworld servers.

**New**
- **UE4SS on Palworld servers.** Drop `UE4SS-Palworld.zip` on the Mods tab and it's packaged for the server's own mod loader. The server loads it directly, so no manual `dwmapi.dll` is needed. Stop the server first, then start it to set UE4SS up.
- **Older UE4SS script mods** (with `Scripts\main.lua` and no Info.json) now install too. They run on the server and reach players through the share link. Players need UE4SS in their own game for these.

**Changed**
- Mods that need UE4SS now say so: with the download link if the server needs it, or pointing to "UE4SS Experimental (Palworld)" on the Steam Workshop if it's the players who need it.
- The Mods tab warns if a manual `dwmapi.dll` is still in `Pal\Binaries\Win64`, because two copies of UE4SS crash the server.

**Fixed**
- Server Forge refused UE4SS and older UE4SS script mods, saying Palworld's mod loader couldn't install them (the 0.9.2 notes said this too). It can.

## SF Mod Manager 0.6.1

Palworld server mods for players, and a Settings window for updates.

**New**
- **Palworld tab.** Paste a Palworld server's share link and SF Mod Manager installs that server's mods for your game through Palworld's own mod loader, and keeps them matched: added, updated and removed with the server. Use **Sync now** while Palworld is closed, because the game sets mods up when it starts.
- Your own Palworld mods, from the Steam Workshop or elsewhere, are left alone. Only mods the app installed itself are ever removed.
- **⚙ Settings button** at the top right, with an **Update SF Mod Manager** section: your version, the newest version, when it last checked, what's new, and **Install update**, **Check for updates** and **Update from a file…**. The button shows a green dot when an update is out. **About & help** now has an **Updates…** button that opens it.

## Server Forge 0.9.2

Palworld mod manager for servers.

**New**
- **Mods tab for Palworld servers**, using Palworld's own mod loader. Switch mods on, then add them:
  - Drop a mod **.zip** (or its unpacked folder).
  - Use the **CurseForge** or **Nexus Mods** buttons: in the desktop app the site opens in a Server Forge window, and mods downloaded there install on the server by themselves. Nexus "Mod Manager Download" works with your Nexus API key (Settings → Integrations).
- Each mod shows who it's for (**Server + players**, **Server only** or **Players only**), with its thumbnail, version and author, an On switch and Remove. Palworld sets new mods up, and removes switched-off ones, the next time the server starts; the list says when a change is still waiting for a restart.
- Older mods that are only **.pak** files are converted for the mod loader automatically. Paks built for the server ("WindowsServer" in the name) are used on the server; the others are for players. Older UE4SS script mods without an Info.json are refused, with an explanation.
- Switching a mod off really removes it on the next start (taking it off Palworld's active list alone leaves its files in place, where they still load), and mod folders are named the way the loader needs (a number, like a Workshop ID; Palworld silently skips folders with any other name).
- Palworld share links now list the server's mods for players. SF Mod Manager doesn't install them yet (that's coming in its next update); until then it shows the join details as before.

## Server Forge 0.9.1

**New**
- **Resizable server list.** Drag the line between the server list and the server page to make the list wider or narrower (arrow keys work too when it's selected). Double-click the line to put it back. The width is remembered on each device, in both Basic and Fancy UI.
- The desktop app opens in a larger window by default (1500 × 950, or smaller to fit your screen).

**Changed**
- Panel role names now include the full app name: **Server Forge Master**, **Super Server Forge**, **Server Forge Node** and **Super Server Forge Node**.
- The player companion is now called **SF Mod Manager**. Share-link help, download links and the rebrand notice use the new name; its releases now come from [sf-mod-manager-releases](https://github.com/Volatile111/sf-mod-manager-releases).

**Fixed**
- In Fancy UI, the health warnings list opened behind the server page instead of on top of it.
- Update warnings called every game "Bedrock". They now name the right game or server software, for example "7 Days to Die server build …" or "Endstone 0.11.14".
- In Fancy UI, the server list could scroll sideways because its game headings were slightly too wide.

## Server Forge 0.9.0

**New name and look**
- Tavern Host is now **Server Forge**, with a blue server-and-hammer icon, a blue default accent and updated names throughout the panel. Depending on its role, the header can show Forge Master, Super Forge, Forge Node or Super Forge Node.
- **Basic / Fancy UI switch** beside the colour wheel at the bottom left. Fancy UI adds frosted panels, drifting glows, stars, animated active borders, polished scrollbars, controls and dialogs. Basic remains the default and does not load the effects. Animation can be switched off; reduced-motion preferences are respected. The Fancy UI header hammer animation pauses when hidden.
- Your selected appearance and colour remain local to each viewing browser or desktop app, so a main panel can use Fancy while server PCs use Basic. Existing colour choices are retained.

**Fixed**
- Palworld could stay on Starting when its console output was buffered even though the game was ready. Server Forge now also checks its authenticated local API while starting, then reports Running once readiness is confirmed.

**Upgrading**
- Server records, users, settings, backups and node connections keep their existing data locations and application identity.
- Installers use the Server Forge name. An identical Tavern-Host-named installer remains available for automatic updaters in older versions. New versions recognize both names.
- The optional paid-hosting portal is a separate, paused project and is not included in this update. Server Forge remains usable on your own hardware without a hosting account or payment setup.

## SF Mod Manager 0.6.0

**New name and look**
- Tavern Client Mod Manager is now **SF Mod Manager**, with the matching blue puzzle-piece-and-hammer icon, blue default accent, updated help and download text, and new installer/shortcut labels.
- Achilles keeps its own name, icon and UI inside Star Valor. Its version line now identifies SF Mod Manager as its host app.
- New Minecraft Launcher installations use the SF Mod Manager name. Existing installation IDs, folders and player-customized profile names are preserved.
- **Basic / Fancy UI switch** beside the colour wheel, like Server Forge's. Fancy UI adds frosted glass, drifting glows, stars and an animated edge on the selected game and profile. Basic remains the default and does not load the effects. Animation can be switched off in the colour pop-up; reduced-motion preferences are respected.

**Upgrading**
- Existing server links, settings, mod profiles, protected Nexus credentials, game folders and saved colours stay in their existing locations.
- Releases now come from [sf-mod-manager-releases](https://github.com/Volatile111/sf-mod-manager-releases). The old repository addresses redirect there, so earlier versions still find this update.
- Installers use the SF Mod Manager name, with an identical legacy-named copy for older automatic updaters. New versions accept both names.

## Tavern Host 0.8.1

Crash reports for Bedrock servers, and BungeeCord networks shown together.

**New**
- **Crash check for Bedrock servers.** When a Bedrock server (vanilla or Endstone) crashes or won't start, the Overview tab explains why in plain words, with a fix:
  - **Windows error codes** are translated. For example, exit code 3221225781 now says the server is missing the **Microsoft Visual C++ runtime**, which Windows doesn't include, with an **Install Visual C++ runtime** button. It downloads Microsoft's installer and runs it on the server's PC (Windows asks for admin rights there once). Crashes like access violations, stack overflows and running out of memory are explained too.
  - **Checked before starting:** if the Visual C++ runtime is missing, Tavern Host says so straight away instead of the server failing with a bare number.
  - **From the log:** the port already in use, a world that can't be opened, addons reporting errors (with a tip to turn on addon error logging when a crash leaves no clues).
  - **Endstone:** a Bedrock version newer than Endstone supports, a broken Python setup, and plugins that failed, named, including when one bad plugin file stops all plugins loading.
- **BungeeCord networks in the server list.** Servers listed in a BungeeCord proxy's config.yml now appear under the proxy in the list on the left, with the name the proxy knows them by, and the proxy shows how many servers it has. Servers on another system stay with that system and are marked "via" the proxy.

## Tavern Host 0.8.0

Endstone servers with plugins, a Plugins tab, and importing existing Endstone servers.

**New**
- **Endstone for Bedrock servers.** Bedrock servers have a new **Server software** setting: Vanilla (Mojang) or **Endstone**, which adds plugin support (Python and C++ plugins) and still loads addons. Choose it when creating a server, or switch an existing one in Settings: worlds, settings and addons are kept. Tavern Host sets everything up itself on the server's PC: its own Python, its own copy of Endstone for each server, and the Bedrock version Endstone supports. Nothing is installed system-wide.
- **Endstone updates.** Endstone supports one Bedrock version at a time, so Endstone servers are offered Endstone updates (each brings its Bedrock version) instead of Mojang's. If a vanilla server already runs a newer Bedrock than Endstone supports, switching it is stopped rather than going back a version, which could break the world.
- **Plugins tab.** Endstone servers get a **Plugins** tab next to Addons: drop in `.whl` or `.dll` plugin files, switch plugins on and off, remove them, and check for updates. Plugins get the same Windows Defender check as addons.
- **Find plugins.** Search Endstone plugins on GitHub and PyPI from the Plugins tab and install one with a click. The **Get plugins** buttons open GitHub, PyPI and the Endstone docs, and plugins downloaded there install on the server by themselves (desktop app).
- **Import existing Endstone servers.** Choose the folder you ran Endstone in (or its `bedrock_server` folder) under **Import**. Its addons come along in the same order, plugin files in its plugins folder come along, and plugins installed with pip into its old Python are brought in too, as the same version from PyPI or rebuilt from the installed files. It keeps the Endstone version it was running, and your old Python isn't changed. Tavern Host tells you what it found and brought in.
- **Endstone icon.** Endstone servers show the Bedrock icon with end stone below the Minecraft logo and "ENDSTONE" in Endstone's blue, and "Bedrock · Endstone" in the server list.

**Fixed**
- **Updating an addon kept moving it to the top.** An updated addon now keeps its place in the load order. Only newly added addons go to the top.

**Good to know**
- On a PC that has never run Endstone, Windows may ask once for permission (UAC) so a Minecraft client on that same PC can connect to it. The server starts either way.
- Servers on other PCs (nodes) need Tavern Host 0.8.0 there too for the Plugins tab and Endstone.

## Tavern Host 0.7.2

**Fixed**
- **Valheim stuck as "not ready" after a Steam blip.** When a running Valheim server briefly lost its connection to Steam ("Game server disconnected") and reconnected a few seconds later, Tavern Host treated it as the server stopping: it stayed "not ready" until the server was restarted, and its crossplay join code disappeared. Anything reading the API, like a website status page, showed the server as offline. Tavern Host now shows it as not ready only while Steam is away, and ready again as soon as it reconnects, keeping the join code and player list.

## Tavern Client Mod Manager 0.5.5

**New**
- **Star Valor tab: Achilles Mod Manager is now built in.** Achilles, the Star Valor mod manager, is now the mod manager's **Star Valor** tab, with its own look and ship icon, and the tab fills the window while it's open. It finds Star Valor through Steam and handles BepInEx plugins and We Mod Any Ship ship files:
  - turn mods on and off one at a time, in bulk or with profiles (**Vanilla** turns everything off), and drop in `.dll`, `.shipmod` or `.zip` files
  - a compatibility check for every mod against your installed game version, plus errors from your last launch, named after the mod that caused them
  - **Update all** for mods from GitHub and Nexus Mods
  - install, update or roll back BepInEx, with a test launch that checks the game reaches the main menu
  - see your saves, then launch the game
  - Nothing is ever deleted: removed and replaced files go to `BepInEx\achilles_backups`.
- **Ships tab.** Ship mods have their own list, with search and filters (Edited, Problems, On, Off), so they no longer fill the Mods list.
- **Ship stats editor.** Hover a ship and click **Stats** to change its hull, handling, cargo and equipment space, crew seats, weapon slots, built-in bonuses, which NPC factions fly it, and whether shipyards sell it. For example, **Make it buyable** puts boss ships like the Tri-Cerberus on sale in their faction's shipyards. Values are checked so a typo can't stop We Mod Any Ship loading your ships, the original file is kept, and **Reset** puts it back.

**Moving from the standalone Achilles app**
- Your profiles, settings, Nexus key, update sources and BepInEx history are copied over the first time you open the Star Valor tab. Your old app's own files aren't changed.
- **Close the standalone Achilles app and stop using it.** Two managers moving the same mod files at once can undo each other's changes.

## Tavern Host 0.7.1

**Fixed**
- **Buttons stopped responding after a confirmation.** In the desktop app, answering a yes/no question (for example banning a player from the Players tab's Actions) could leave the panel ignoring clicks until Tavern Host was closed and opened again. Every confirmation now uses Tavern Host's own dialog. Thanks to Smart74 for reporting it.
- The Players tab no longer refreshes while you have an Actions menu or a dialog open, so the menu can't close under you.

**Changed**
- **Valheim: characters on the same account.** Valheim's admin, ban and allow lists hold Steam (or Xbox/PlayStation) accounts, not characters, so banning one character bans every character on that account. The Players tab now shows "Same Steam account as …" on those players, and the confirmation for Ban, Make admin and the allow list names the other characters it also applies to.
- **The real icons for every server type:** Minecraft Java servers show the Minecraft Launcher's Java Edition grass block, Bedrock the Minecraft for Windows tile, Valheim its own icon, and Paper, Spigot, Fabric, Forge, NeoForge and Sponge servers their project's logo.
- A thank-you to Smart74, Tavern Host's first user and tester, next to the colour button.

## Tavern Client Mod Manager 0.5.4

**Changed**
- Satisfactory servers are on the **Other servers** tab now (mods for Satisfactory are installed with Satisfactory Mod Manager, so it didn't need a tab of its own). Each one still lists the server's mods with **Install with SMM**.

**Fixed**
- Buttons could stop responding after answering a yes/no question (removing a server or a mod, deleting a profile, updating) until the app was reopened. Confirmations now use the app's own dialog.

## Tavern Host 0.7.0

**New**
- **Factorio servers.** Factorio's Windows server is the full game, so it's downloaded with your own factorio.com login: add it in Settings → Integrations (paste your username and token from factorio.com/profile, or **Import from this PC** if you play Factorio here). Create a new map (map preset and seed) or use an existing save, with the server settings, admin, allow and ban lists (changed in-game while the server runs, because Factorio rewrites them when it stops), Space Age on or off if your account owns it, and mods from the mod portal on the Mods tab (by name or link, with their required mods, update checks and thumbnails). Stop saves first. Factorio support is new and less tested than the other games, so please report anything that doesn't work.
- **Palworld servers.** Installed and updated with SteamCMD. The main settings are written into the game's settings line and the rest is kept; the overview shows live details through Palworld's REST API, and stop saves, then shuts down.
- **Enshrouded servers.** Installed and updated with SteamCMD, with the server name, max players, difficulty presets (or custom), text and voice chat, and the Admin, Friend, Guest and Visitor passwords. The rest of enshrouded_server.json is kept.
- **V Rising servers.** Installed and updated with SteamCMD, with game and difficulty presets. Saves stay in the server folder. Countdown warnings go out as in-game announcements (over RCON, only reachable from this system), and stop saves the world.
- **Project Zomboid servers.** Installed and updated with SteamCMD, with memory and admin password settings. Its files stay in the server folder, and stop saves first.
- **7 Days to Die servers.** Installed and updated with SteamCMD, with the map (Navezgane, pregenerated or random), listing and player-killing settings. Saves stay in the server folder, the Console tab talks to the server's own console (only reachable from this system), and stop saves the world, then shuts down.
- **Discord notifications.** Each server's Settings tab has a **Discord notifications** card: paste a channel webhook and choose the events (started, stopped, crashed, players joining and leaving, update available, updated, backup failed), and use **Send test message** to check it. Joins and leaves close together are sent as one message. New in this version, so please report anything that doesn't arrive.
- **Mod settings for Minecraft Java.** Modded and plugin servers get the same **Settings** editor as Valheim on the Mods/Plugins tab, for config files in TOML, YAML, JSON and .properties (config, defaultconfigs, the world's serverconfig and each plugin's folder). Saving changes only those lines; lists and multi-line values are shown but read-only. Mods with several files open a picker.
- **The games' own icons** in the server list and the New Server dialog for Factorio, Satisfactory, Space Engineers, Terraria and the new games.
- **Share links for the new games**, with how to join each one. Players need Tavern Client Mod Manager 0.5.3 to add them.
- The Mods tab's "add by ID or link" box says what each game takes, and games that also accept mod files keep the drop zone.

## Tavern Client Mod Manager 0.5.3

**New**
- Server links for Factorio, Palworld, Enshrouded, V Rising, Project Zomboid and 7 Days to Die servers (from Tavern Host 0.7.0) show on the **Other servers** tab with how to join.

## Tavern Client Mod Manager 0.5.2

**Fixed**
- 0.5.1 wouldn't open: it stopped with "A JavaScript error occurred in the main process" (Cannot find module … bepinex-config.js) because a file was left out of the installer. If you have 0.5.1, download and run this installer; the app can't update itself while it won't start.

## Tavern Host 0.6.1

**New**
- **Mod settings for Valheim servers.** Mods with a settings file (BepInEx/config) get a **Settings** button on the Mods tab once the server has started with them. Every setting is shown with its description, default and allowed values; saving changes only those lines in the file, and the mod uses them at the next restart. Files Tavern Host can't match to a mod are listed under **Other mod settings files**.
- **Send settings to players.** Tick **To players** on a setting and players' Tavern Client Mod Manager (0.5.1 or newer) sets it to the server's value in their own game every time they sync. That's how settings that only work on the player's side are set from the server, for example Server devcommands' automatic debug, god and fly mode for admins (devcommands only switch on for players on the server's admin list). Anyone with the share link can see those values, so don't send passwords or keys.
- Seeing and changing mod settings needs **Manage mods** (settings files can hold webhooks or passwords). Changes are written to the activity log.

## Tavern Client Mod Manager 0.5.1

**New**
- **Mod settings from the server.** When a Valheim server's owner sends mod settings (Tavern Host 0.6.1), syncing sets them in your game's config files. Only those settings change; the rest of each file stays yours. The review shows each one before it's applied.
- A server can only change values in mods' settings files: never BepInEx's own settings, and nothing outside the BepInEx config folder.

## Tavern Host 0.6.0

**New**
- **Create and import servers on your nodes** from the main panel: **+ New** and **Import** have a System choice (this system or any node). The games and versions come from that node, it downloads and installs the server itself, and the server shows under it in the list.
- **BungeeCord networks.** BungeeCord proxies get a Plugins tab (BungeeCord plugins, with a warning for Bukkit/Paper plugins that belong on the servers behind it) and, in Settings, **Servers behind this proxy**: add any of your Tavern Host Minecraft Java servers (on this system or a node) with the address filled in, choose where players land first, or remove one. Only that part of config.yml changes. Optionally sets a Paper/Spigot server up for the proxy (bungeecord: true, online-mode=false), with a warning to keep it reachable only through the proxy.
- **Space Engineers servers.** Installed and updated with SteamCMD. Tavern Host writes its settings (name, world, scenario for a new world, game mode, players, ports) into SpaceEngineers-Dedicated.cfg and keeps everything else in it, and uses the game's Remote API for live players, chat warnings before restarts and updates, and a clean stop. Steam Workshop mods are added by link or ID on the Mods tab (players' games download them by themselves); Admins and Banned lists by Steam ID, applied straight away while the server runs.
- **Satisfactory servers.** Installed and updated with SteamCMD. Tavern Host works with Satisfactory's own server tools instead of duplicating them: it claims a new server with your admin password, creates the first game (starting location, session name), and stops cleanly (save, then shut down) through the server's API; the overview shows the session, players, tech tier and tick rate, and console commands go through the API. Saves, sessions and the rest stay in the in-game Server Manager. Mods are managed with Satisfactory Mod Manager (it supports this server folder and players' games); the Mods tab lists them with links whose Install button opens SMM.
- **Terraria (vanilla) servers**, separate from tModLoader ones (vanilla and modded players can't join each other's servers): the official dedicated server from terraria.org, with the same world settings, Console, kick/ban, countdowns, backups and automatic updates. The install also puts on Microsoft's XNA Framework 4.0, which the Windows server needs (Windows asks for admin once).
- **Terraria (tModLoader) servers.** Create one with **+ New**: Tavern Host downloads tModLoader from its official GitHub releases (checksum-checked) and the .NET runtime it needs, creates the world (size, difficulty, seed), and runs it with the Console tab, commands, kick/ban, countdowns, backups and automatic tModLoader updates. Stop saves the world first. Add mods as .tmod files on the Mods tab; players' games download the server's mods by themselves when they join.
- **Bedrock addon updates from CurseForge.** Addons installed from CurseForge are linked to their project automatically; for others (from MCPEDL or elsewhere), use **Link to CurseForge…** on the addon. **Check for updates** then finds newer files, on the channel you pick: releases only, releases + beta, or releases + beta + alpha (betas and alphas only when they're newer than the newest release). **Update automatically** checks every 6 hours and installs them by itself (loaded at the next restart). Needs a CurseForge API key in Settings → Integrations.
- **Valheim world modifiers, fully customisable**, like a .bat file: start from any difficulty preset and change any modifier on top of it, now including **Normal** (e.g. Hardcore with a normal death penalty). The world settings are grouped under **World modifiers** in Settings, and **Other world keys** passes any other key with -setkey (e.g. nocraftcost, skillgainrate 200).
- Valheim with crossplay on: Tavern Host explains that the local IP can't be used to join (Valheim's crossplay only finds the server by its public address), and what to use instead.
- **Share links for every game** (Mods tab → Share mods with players), for the Tavern Client Mod Manager 0.5.0:
  - **Minecraft Java (Fabric, Forge, NeoForge)**: players' app sets up the same loader in their Minecraft Launcher, in a separate profile, and keeps the mods matched with the server. Each mod has **Server + players** or **Server only** (mods that say they're server-side only start as Server only).
  - **Satisfactory**: players see the server's mods with versions, each one opening in Satisfactory Mod Manager.
  - **Bedrock, Terraria (tModLoader), Space Engineers and Minecraft servers without mods**: these games download what they need when a player joins, so the link gives the join details.

**Fixed**
- Security: Tavern Vault calls that would hand out something secret (for example an encryption recovery key, a password or a token) always need **Manage storage**, even when they're named like a read-only call.

## Tavern Client Mod Manager 0.5.0

**New**
- **More games.** Server links now work for Valheim, Minecraft Java, Satisfactory, Minecraft Bedrock, Terraria (tModLoader) and Space Engineers servers (from Tavern Host 0.6.0). Paste any link in **Add a server**; each game has its own tab.
- **Minecraft Java (Fabric, Forge, NeoForge)**: each modded server gets its own Minecraft Launcher profile and folder, so its mods never mix with your other worlds. The server's mods are added, updated and removed with it; jars you add to that folder yourself are left alone. The server is in Multiplayer straight away. Fabric is set up automatically; for Forge and NeoForge the app gives you the right installer to run once.
- Minecraft mods are checked before they're installed: Windows Defender, and whether Modrinth has the exact same file. Files Modrinth doesn't know wait for your approval.
- **Satisfactory**: the server's mods with versions, each opening in Satisfactory Mod Manager to install.
- **Other games**: the server's address to copy, and how the game gets its mods.

**Fixed**
- Sync results no longer show twice in Activity.

## Tavern Host 0.5.3

**Improved**
- Storage works with everything new in Tavern Vault 0.3 (drive health, burn-in, hot spares, snapshots, backups, bay map, capacity forecasts, speed, encryption, moving data, TrueNAS and the health report). People with **See storage** can open all of its read-only pages; changes still need **Manage storage**.
- Things only the Tavern Vault window on that PC can do (its file pickers, saving files, node mode, its direct link, updating it) now say so clearly instead of failing.

## Tavern Host 0.5.2

**Fixed**
- Valheim: Kall no longer shows as defeated just because a world has a defeat marker Tavern Host doesn't recognise (older worlds and mods can carry other ones). Kall shows as unknown ("?") instead, with the marker named when you hover it.
- Storage changes made through a node link are logged with that link's own key name too, so a key can't make its changes look like someone else's.

## Tavern Host 0.5.1

**New**
- **Storage is now a switch**: Settings → Storage (Tavern Vault), off until you turn it on. It covers showing storage here and sharing this system's storage with a main panel. The "needs Tavern Vault" notes live there too, with each system's state (this system and every node).
- A system gets a **Storage** entry in the list on the left only when Tavern Vault is actually connected there. A main panel without Tavern Vault of its own no longer shows Storage for itself.
- **Systems with only Tavern Vault** (no Tavern Host) can be added as nodes: Tavern Vault makes its own code (thvault://…) in its Settings → Node mode; paste it into Settings → Nodes as usual. They show with their Storage. Needs Tavern Vault 0.2.0 or newer there.
- **The panel's name follows what it does**:
  - **Tavern Master**: manages other systems (nodes) and has no game servers or Tavern Vault of its own.
  - **Tavern Super**: manages other systems and has its own game servers or Tavern Vault too.
  - **Tavern Node**: another panel uses this system as a node (its node code has been used).
  - **Tavern Super Node**: a node with Tavern Vault on it.
  - **Tavern Host**: none of the above.
  The name shows in the header, the window title and the login screen, and changes by itself.

## Tavern Host 0.5.0

**New**
- **Storage, with Tavern Vault.** Each system in the list on the left now has a **Storage** entry: its drive pools (Storage Spaces), SnapRAID arrays, drive health and schedules, with everything Tavern Vault can do (create, grow and repair pools, replace drives, run SnapRAID…). This needs **Tavern Vault**, a separate app, on the system that has the drives, with its Node mode turned on. Without it, Storage explains what to install.
- Storage works for nodes too, through the same node link: a node's storage shows under it on the main panel. The main panel doesn't need Tavern Vault itself. Nodes need Tavern Host 0.5.0 or newer.
- New permissions: **See storage** and **Manage storage** (Manage can destroy data; it's marked as dangerous). Admins get both. Node links made before 0.5.0 get them automatically, once (noted in the activity log).
- Settings has a new **Storage (Tavern Vault)** section showing whether Tavern Vault is connected on this system.
- Storage changes made through Tavern Host show in Tavern Vault's activity log with who made them, and in Tavern Host's activity log. Tavern Vault's practice mode and safety checks apply exactly as in its own window.

## Tavern Host 0.4.3

**New**
- After an update, Tavern Host shows what's new in the version you just got (once).
- Every step of an update is written to update.log in Tavern Host's data folder, so a failed update can be traced.

## Tavern Host 0.4.2

**Fixed**
- Installing an update from inside Tavern Host closed the app without installing anything (and didn't reopen it). The update now installs and Tavern Host opens again by itself. If you're on 0.4.0 or 0.4.1, install this version by hand once; updates work from the app after that.
- The downloaded installer is deleted once the update is done.

## Tavern Client Mod Manager 0.4.1

**Fixed**
- **Update now** closed the app without installing anything. The update now installs and the app opens again by itself. If you're on 0.4.0, install this version by hand once; updates work from the app after that.

## Tavern Host 0.4.1

**Fixed**
- Importing a world (.mcworld or .zip) did nothing in the desktop app. The same went for kick/ban reasons, player notes, the countdown before a game update and renaming a node: they now use Tavern Host's own dialog.
- Servers added on a node now show up on the main panel even after the connection to the node dropped quietly (network blip, the node sleeping or restarting). The main panel reconnects by itself and re-checks each node's servers every 2 minutes.
- Port forwarding help for Valheim now says TCP & UDP.

## Tavern Host 0.4.0

The first public release.

**New**
- Tavern Host updates itself: it tells you when a new version is out (Settings → Update Tavern Host) and installs it for you. Game servers keep running.
- Port forwarding help for every server (🌐 under the server's name): which ports to forward, to which address, and what players outside your network use to join. For Bedrock it spots a missing or outdated `server-udp-ports` line and fixes it in one click.
- A warning when your public IP changes, and when a Bedrock server still has the old one.
- Valheim world modifiers (combat, death penalty, resources, raids, portals), world settings (no build cost, passive enemies, no map, player-based raids), instance ID and extra launch arguments.
- Help button: report a problem (the form fills in your version), what's new, and the licence.
- Permissions shown when making users and API keys now describe every feature.
- The API reference covers every request, and API.md has it for other programs.

**Fixed**
- A backup cut off by Tavern Host closing (e.g. during an update) no longer leaves the server's saving paused.
- Security: removing a hand-added Valheim mod can no longer reach outside the server's plugins folder; the local panel address only answers requests made to 127.0.0.1/localhost.
- Wording: "PC" is now "system" throughout.

## Tavern Client Mod Manager 0.4.0

The first public release.

**New**
- The app updates itself: a banner tells you when a new version is out, and **Update now** installs it. Your mods and settings are kept.
- About & help: report a problem, what's new, check for updates, and update from a file.
- A link to get Tavern Host, for players who want to run their own server.

**Fixed**
- Security: a server's shared mod list is checked before anything is installed or removed, so a list with unusual names can't touch folders outside Valheim.
