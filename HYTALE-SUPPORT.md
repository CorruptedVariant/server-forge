# Hytale support (unreleased)

Hytale is offered in New Server and Import on Windows and Linux x64. The module is `src/games/hytale.ts`.

- New Server runs the official Hytale downloader and streams its account authorization URL/code into SF's Console. The user must own/access Hytale and complete authorization in their browser.
- Java 25 JDK is provisioned through SF's existing Temurin runtime manager.
- Start/Stop and console input use the existing runner. Default port: 5520 UDP (QUIC); default maximum heap: 4096 MB.
- Once started, send `/auth login device` in Console and finish the separate server authorization. Use Hytale's auth help for persistence options.
- Import accepts either a game folder with `Server/HytaleServer.jar` and `Assets.zip`, or the Server folder itself, or a flat folder with both files.
- Gameplay options are edited in the server's `config.json` using Files while stopped. SF currently exposes port and heap settings only.
- Backups require the server stopped. They include universe, gameplay/access configuration and mods, and exclude auth credentials. Authentication must be repeated on a fresh restored host.
- The installer can also refresh binaries/assets while preserving world/config/mod files. No automatic update polling, Hytale wrapper self-update integration, player tracking is implemented.
- Downloader credentials stay in `.sf-hytale` under the server folder. That directory is not part of SF's world backups.

Verified: TypeScript check; JS syntax; fixture tests for settings validation, import layouts, UDP connection, backup safety and log readiness; official Windows downloader `-version`; creation card and port/memory controls in both Basic and Fancy UI.

Still unverified: authenticated download, real server startup/stop/player connection, updates using a real payload, and Linux execution. These need a Hytale account; no real Hytale server was created and no live servers were changed.

Official reference: https://support.hytale.com/hc/en-us/articles/45326769420827-Hytale-Server-Manual

## Mods tab

Supports .jar plugins and .zip asset packs with a root Hytale manifest.json. Shows name, version and authors; browse CurseForge, upload files, replace/update by Group:Name, disable/enable and remove. All mutations require the server stopped. Disabled files are moved outside mods/ to .sf-disabled-mods and are included in backups. Updates preserve the disabled state. Archives are checked by the existing antivirus scanner before installation. Missing dependency IDs produce warnings; dependency versions and Hytale version compatibility are not automatically verified.

Verified with test archives (not gameplay mods): ZIP/JAR installation, metadata, disable/enable, updates under a different filename while disabled, removal, bad archive rejection and path traversal rejection. The actual Mods tab is checked in Basic and Fancy UI on a stopped test fixture. Real mod loading and Linux execution remain untested. The existing global CurseForge search UI flag remains unchanged; the CurseForge website browse button is available.

## Mod sites and download monitor

Browse buttons: CurseForge, Nexus Mods, Modtale, Thunderstore and BuiltByBit. Nexus nxm:// downloads now accept Hytale with a configured API key, preserving JAR filenames; manual website downloads need no API key. Nexus authenticated downloads have not been tested with a real key.

Site wrapper ZIPs are supported when they contain valid Hytale JAR/ZIP payloads. Payloads are bounded, inspected before installation and scanned; arbitrary archive paths are never extracted. Required third-party dependencies are warned about, not downloaded automatically. Tested against the actual Thunderstore AzureDoom LevelingCore 1.1.1 package on a stopped fixture; no Hytale game server was launched.

The existing desktop download monitor handles Hytale browser downloads: progress, percent, MB, Cancel, waiting for confirmation and installation status. Verified with a throttled local transfer of the real package: 37% and 94% visible in Basic and Fancy, and the browser overlay also visible. Individual authenticated download flows on Nexus/BuiltByBit and downloads on CurseForge/Modtale remain untested.
