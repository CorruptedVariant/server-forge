# Server Forge container (experimental)

Runs the Linux service without Electron. The game servers run inside the same container and are controlled by SF's normal runner. The image carries what every game SF supports on Linux needs:

- SteamCMD (32-bit libraries) for Steam games, .NET/ICU for tModLoader, Java downloaded by SF for Minecraft/Hytale.
- Wine (64 and 32-bit) + Xvfb for the Windows-only servers: Enshrouded and V Rising. Wine's output is kept in `data/servers/<id>/wine.log` and its last lines appear in the console after a crash.
- ClamAV for mod scans. Signatures are downloaded on start and twice a day into `clamav/` in the state folder (about 110 MB).
- tzdata, so `TZ` applies to schedules and logs.

Not available in the container (same as SF on Linux, or because there's no desktop): Space Engineers (Windows-only and not runnable under Wine in SF), Endstone for Bedrock, the desktop mod browser window and download tray (the web page opens mod sites in a new tab; paste links or upload files instead), and "Update from file" installers.

## Standalone web UI

The web page is SF's remote-access listener: `https://<host>:8191`. Remote access is always on in the container; its toggle and firewall button are hidden. The certificate is self-signed, so browsers warn once.

First login: the container creates an owner `sfadmin` with a random starting password and prints it in the container log (TrueNAS: Apps → server-forge → Logs) on each start. Logging in with it asks for a new password straight away; once changed, the starting password file is deleted and the log message stops.

The web page can also make a node code (Settings → Use this system as a node) to link the container to a main panel, and sign in to Steam for Workshop downloads (password and Steam Guard code go to SteamCMD once and aren't saved).

On TrueNAS, the compose file adds a **Web UI** button to the app (`x-portals`) and first-login notes (`x-notes`).

## Build and run

Build from the repository root after installing build dependencies:

```sh
npm ci
npm run build
docker build -f docker/Dockerfile -t server-forge:local .
```

Set `SF_STATE_DIR` to a dedicated persistent directory owned by the numeric UID/GID in Compose, then run:

```sh
SF_STATE_DIR=/mnt/ssd/server-forge/state docker compose -f docker/compose.yaml up -d --build
```

The provided Compose uses host networking so newly created game servers can open their own ports. No Docker socket, host PID namespace or privileged mode is required. The service runs as UID/GID 3002 by default (override `SF_UID`/`SF_GID` for another host). Allow HTTPS 8191 and the game ports you choose. HTTP 8190 listens only on host loopback. Do not deploy two instances with the same listener ports on one host.

Persistent data includes SF accounts, certificates, node keys, backups, game binaries, worlds, mods, ClamAV signatures and temporary download space (`tmp/`). Never publish the data directory or pairing codes in a Docker image.

On a normal Docker/TrueNAS stop, the supervisor asks SF to stop local game servers and waits for them to finish saving before exiting. It remembers which games were running and starts them after the next container launch. A forced kill or power failure cannot guarantee a final save. Allow the full two-minute stop grace period.

Update by rebuilding/replacing the container image, preserving the state mount. The panel's Update card says so in the container instead of offering the desktop installer. Starting with 0.12.0, GitHub and the website offer a versioned Docker download containing a built Linux x86-64 image, Compose files, the Dockerfile and compiled application. See RELEASE-README.md for loading, TrueNAS setup and updates. This is not a Docker Hub/TrueNAS catalog listing.
