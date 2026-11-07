# Server Forge

> **Beta:** Server Forge and SF Mod Manager are both in beta. They're actively being worked on and updates are frequent, so expect changes and the odd rough edge. Please report problems on the [Issues](https://github.com/Volatile111/server-forge/issues) page (or **Help → Report a problem** in either app).

Server Forge is a Windows and Linux app for running your own game servers from one panel. It supports Minecraft Bedrock, Minecraft Java (including BungeeCord networks), Valheim, Terraria (vanilla and tModLoader), Satisfactory, Space Engineers, Factorio, Palworld, Enshrouded, V Rising, Project Zomboid and 7 Days to Die.

- Start, stop and restart servers, with a live console, player list and countdowns that warn players first.
- Run servers on other systems too (nodes), managed from one main panel.
- Automatic backups, plus a world integrity check that warns you before a damaged world gets backed up over a good one.
- Automatic game updates, and Server Forge updates itself too.
- Mods and addons: Valheim mods from Thunderstore, Hexium and Nexus Mods, Minecraft addons, mods and plugins (CurseForge, Modrinth and others), tModLoader mods, Steam Workshop mods for Space Engineers, Factorio mods from the mod portal, and Satisfactory mods through Satisfactory Mod Manager.
- Mod settings: edit Valheim (BepInEx) and Minecraft Java mod and plugin config files from the Mods tab. Valheim settings can be sent to players.
- Valheim: server profiles (world plus mods), difficulty presets and world modifiers, and admin, ban and allow-list controls.
- Discord notifications for each server: started, stopped, crashed, players joining and leaving, updates and failed backups.
- Port forwarding help for each server, and a warning when your public IP changes.
- Users with their own permissions, an HTTP API, and optional Remote access so you can manage your servers from another device.

## New names, same servers and mods

Tavern Host is now **Server Forge**, and Tavern Client Mod Manager is now **SF Mod Manager**. Existing server records, accounts, mods, profiles, share links and saved colours are kept. The internal application IDs and data folders stay the same so upgrading does not create a second setup.

New releases include the new installer names and identical legacy-named copies for older automatic updaters. The existing GitHub repository URLs continue to be used during this transition.

**Appearance:** Forge blue is the new default. Server Forge's **Basic / Fancy UI** button beside the colour wheel switches the appearance. Fancy adds frosted panels and animated effects; Basic stays the lightweight default. Existing colour choices are retained.

## Downloads

| App | Who it's for | Download |
|---|---|---|
| **Server Forge** | Server owners | [Latest release](https://github.com/Volatile111/server-forge/releases/latest) |
| **SF Mod Manager** | Players (Valheim, Minecraft Java, Satisfactory, Star Valor and more) | [Latest release](https://github.com/Volatile111/sf-mod-manager-releases/releases/latest) |

Both apps tell you when a new version is out and can install it for you.

## Quick start (server owners)

1. **Install.** Download `Server-Forge-Setup-<version>.exe` from the latest release and run it. Server Forge opens when it's done and asks you to create the owner account.
2. **Create a server.** Click **+ New**, pick the game, give it a name and a folder, and Server Forge downloads the official server software. Already have a server? Use **Import** and point it at the folder.
3. **Start it.** Players on your own network can join straight away with the IP and port shown under the server's name.
4. **Let friends outside your network join.** Click **🌐 Port forwarding** under the server's name. It lists exactly which ports to forward on your router, and your public IP for players to use.
5. **Mods for players (optional).** On the server's **Mods** tab, add mods, then turn on **Share mods with players**. Players install SF Mod Manager and paste the link once. Valheim and modded Minecraft Java mods then stay matched to the server; Satisfactory players get the mod list for Satisfactory Mod Manager; other games get the join details.

Your game servers keep running when you close the Server Forge window, and while it updates.

## Quick start (players)

1. Download `Tavern-Client-Mod-Manager-Setup-<version>.exe` from the [mod manager releases](https://github.com/Volatile111/sf-mod-manager-releases/releases/latest) and run it.
2. Paste the link the server owner gives you (it starts with `thmods://`) and click **Add server**. The server shows on its game's tab.
3. **Valheim:** click **▶ Play Valheim**. Your mods are matched to the server first. A **Vanilla** profile switches mods off for playing other servers.
4. **Minecraft Java:** click **Sync now**, then pick the server's profile in the Minecraft Launcher. It has its own folder, so your other worlds and mods aren't touched. (Forge and NeoForge: run the installer the app gives you once.)

**Star Valor** (single player, no server link needed): the **Star Valor** tab is the built-in Achilles Mod Manager. It turns BepInEx mods and ship files on and off, checks them against your game version, updates them, manages BepInEx, and edits ship stats.

## Linux and SteamOS

Both apps run on SteamOS and on the main Linux distros (64-bit Intel/AMD).

**Which download:**

- **SteamOS, Arch, and anything else: the `.AppImage`.** Make it executable and open it. It copies the app to `~/.local/share` and adds it to your applications menu, so nothing is installed system-wide and SteamOS updates leave it alone. You can delete the AppImage afterwards.
- **Ubuntu, Debian, Mint: the `.deb`.**
- **Fedora, openSUSE, RHEL: the `.rpm`.**

If an AppImage won't open on an older Ubuntu, install `libfuse2` (`libfuse2t64` on 24.04), or use the `.deb`.

**Which servers run how on Linux:**

| Game | On Linux |
|---|---|
| Minecraft Bedrock (vanilla), Minecraft Java, Valheim, Terraria, tModLoader, Satisfactory, Factorio, Palworld, Project Zomboid, 7 Days to Die | Native Linux server |
| Enshrouded, V Rising | Windows-only servers, run through Wine. Install `wine` and `xvfb` first. Not available on SteamOS, which has no Wine package |
| Space Engineers | Not available |
| Minecraft Bedrock with Endstone | Not available yet |

Steam servers need SteamCMD's 32-bit libraries. SteamOS has them; on other distros Server Forge tells you the exact command to run.

**Mods that behave differently:**

- **Palworld UE4SS mods don't run on the Linux server**, because UE4SS is Windows code. Server Forge warns you on the Mods tab. Other Palworld mods install, but whether the Linux server loads them hasn't been confirmed yet.
- **Valheim players** have to paste one launch option into Steam once. SF Mod Manager shows it, with a Copy button, on the Valheim tab.
- **The Star Valor tab** isn't available in SF Mod Manager on Linux yet.
- **Virus scanning** uses ClamAV if it's installed. Without it, mods only get the behaviour scan.

**Running without a desktop:** the `.deb` and `.rpm` can run just the service on a headless machine, and you then manage it from a browser or a main panel:

```
cd "/opt/Server Forge/resources/app"
PANEL_DATA_DIR="$HOME/.config/Server Forge/data" ELECTRON_RUN_AS_NODE=1 "/opt/Server Forge/server-forge" dist/main.js
```

## Privacy

Server Forge and the mod manager don't collect or send any usage data. They only contact these services, and only for the feature named:

| Service | Why |
|---|---|
| GitHub | Checking for and downloading new versions of Server Forge and the mod manager, and downloading the BepInEx mod loader |
| Mojang / Microsoft, Steam (SteamCMD), PaperMC, Fabric, Forge, NeoForge, Sponge, SpigotMC, BungeeCord, terraria.org, tModLoader (GitHub) | Downloading and updating server software (and Microsoft's XNA Framework for vanilla Terraria) |
| Adoptium, Microsoft (.NET) | Downloading the Java runtime Minecraft Java servers need, and the .NET runtime tModLoader needs |
| Mojang (api.mojang.com), mc-heads.net | Looking up Minecraft Java player names for the player lists, and showing player head pictures |
| Thunderstore, Hexium, Nexus Mods, CurseForge, Steam (Workshop details) | Browsing, downloading and checking mods, when you use them (Nexus and CurseForge only with your own API key) |
| Modrinth, Fabric (meta.fabricmc.net) | Mod manager, Minecraft Java only: checking whether a server's mod file is the same as on Modrinth, and setting up Fabric in the Minecraft Launcher |
| factorio.com, mods.factorio.com | Factorio only: checking your factorio.com login, downloading and updating the Factorio server, and browsing and downloading mods (with your own factorio.com login) |
| Discord | Sending a server's notifications to the Discord webhook you set for it |
| api.ipify.org | Looking up your public IP, for share links, port forwarding help and the "public IP changed" warning |

Everything else (accounts, servers, settings, backups, logs) stays on your own system. Players' mod managers only connect to your Server Forge through the share link you give them.

## API

Server Forge has an HTTP API for bots, dashboards and other programs: start and stop servers, send commands, read players and the console, run backups, manage mods and more. Make an API key in **Settings → API keys**. Every request is listed in [API.md](API.md) (also shown in the app under **Settings → API reference**).

## Running from source

You need Node.js 24 or newer.

```
npm install
npm run desktop          # the Server Forge desktop app
npm run client           # the mod manager
npm run dist             # build the Server Forge installer (release/)
npm run dist:client      # build the mod manager installer
npm run release          # build Server Forge and publish it as a GitHub release (needs GH_TOKEN)
npm run release:client   # build the mod manager and publish it to tavern-client-releases
```

## Licence

GPL-3.0. See [LICENSE](LICENSE). Server Forge is not affiliated with Mojang, Microsoft, Iron Gate, Coffee Stain, Valve, Keen Software House, Re-Logic, Wube Software, Pocketpair, Keen Games, Stunlock Studios, The Indie Stone, The Fun Pimps, Discord, Thunderstore, Hexium, Nexus Mods or CurseForge.
