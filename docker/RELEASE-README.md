# Server Forge @VERSION@ for Docker / TrueNAS (experimental)

This download contains a built Linux x86-64 image (`server-forge:@VERSION@`), Compose files,
the Dockerfile and the compiled application. No Docker Hub account is needed. ARM is not included.
It includes SteamCMD libraries, Wine/Xvfb and ClamAV. Game servers and signature updates download separately.

## Docker on Linux

Extract this archive into a new directory. With Docker Engine and Docker Compose installed:

```sh
sha256sum -c SHA256SUMS
docker load --input image.tar
cp .env.example .env
```

Edit `.env`: choose an absolute persistent state path, the UID/GID of the account owning it,
a memory limit that leaves RAM for the host, and your time zone. Create that dedicated directory
and give that account ownership before starting the container. It holds all SF accounts,
worlds, game software, mods, backups, certificates and Steam sessions; keep it private.

```sh
docker compose up -d
docker compose logs server-forge
```

Open `https://YOUR_HOST:8191`. Accept the self-signed certificate, sign in as `sfadmin`
using the random starting password in the logs, then choose your own password.
Settings can generate a node code to link this installation to your master panel.
The container is also usable by itself through its web UI.

Host networking lets games use the ports configured in SF. Allow HTTPS 8191 and your chosen
game ports through the host firewall. Do not run a second SF instance on the same listener ports.
No privileged mode or Docker socket mount is needed.

## TrueNAS with Docker Apps

This is a custom app, not a TrueNAS catalog entry. Extract the download on a healthy pool.
From an administrator shell, run `docker load --input /absolute/path/to/image.tar`.
Create a dedicated state dataset/folder with ownership matching the numeric UID/GID you will use.
In Apps, install a custom app via YAML using `compose.truenas.yaml`. Replace `CHANGE_ME` with
your pool/path, adjust `user`, `mem_limit` and `TZ`, then install. The Web UI button opens SF.
Never point the state mount at a pool root or a dataset holding unrelated files.

## Updating

Download/extract the next version and load its `image.tar`. Change only the image version in
your existing Compose/custom-app YAML, preserving the state mount, UID/GID, ports and limits.
Redeploy the app (`docker compose up -d` for ordinary Compose). Allow the full two-minute stop
period so game servers can save; SF remembers and resumes games that were running.
Container updates use a replacement image, rather than the desktop installer.

## Building instead of loading

Compiled files and a Dockerfile are included. From this extracted directory:

```sh
docker build -f docker/Dockerfile -t server-forge:@VERSION@ .
```

Only application runtime files are allowed into the build context. Never add your state folder
or saved credentials to the image. The supplied image's default runtime user is UID/GID 3002.

## Limits and validation

This is the Linux headless panel. Windows-only Space Engineers and Endstone are unavailable;
desktop mod-browser windows are replaced by opening websites and uploading/pasting links.
Wine support for V Rising/Enshrouded remains experimental. Authenticated Steam Workshop
downloads have not been verified with a real Steam account.

Release builds check container startup, initial owner creation, anonymous metadata hiding,
data/key permissions and a graceful stop. Windows/TrueNAS transfer and both UI themes were
tested using a disposable vanilla Minecraft copy; large modded migrations still need testing.
