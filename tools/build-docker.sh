#!/bin/sh
# Run in Linux from the repository root. The release recipe uses the sf-ubuntu WSL distro.
set -eu
SRC="$PWD"
VERSION=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
case "$VERSION" in *[!0-9A-Za-z.-]*|'') echo 'Invalid release version' >&2; exit 1;; esac
test "$(uname -m)" = x86_64 || { echo 'This package targets Linux x86-64' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Install Docker Engine in the build distro first' >&2; exit 1; }
docker info >/dev/null
WORK=$(mktemp -d /tmp/sf-docker-release.XXXXXX)
SMOKE="sf-release-check-$$"
cleanup() {
    docker rm -f "$SMOKE" >/dev/null 2>&1 || true
    case "$WORK" in /tmp/sf-docker-release.*) rm -rf -- "$WORK";; esac
}
trap cleanup EXIT INT TERM
mkdir -p "$WORK/context/docker" "$WORK/bundle" "$WORK/state"
chown 3002:3002 "$WORK/state"
chmod 700 "$WORK/state"
for folder in dist public assets scripts; do
    test -d "$SRC/$folder"
    cp -a "$SRC/$folder" "$WORK/context/$folder"
done
for file in package.json CHANGELOG.md .dockerignore; do cp "$SRC/$file" "$WORK/context/$file"; done
for file in Dockerfile container.mjs freshclam.conf; do cp "$SRC/docker/$file" "$WORK/context/docker/$file"; done
find "$WORK/context/docker" -type f -exec sed -i 's/\r$//' {} +
IMAGE="server-forge:$VERSION"
docker build --platform linux/amd64 --label "org.opencontainers.image.version=$VERSION" \
    --label 'org.opencontainers.image.source=https://github.com/CorruptedVariant/server-forge' \
    -f "$WORK/context/docker/Dockerfile" -t "$IMAGE" "$WORK/context"
docker run -d --name "$SMOKE" --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --user 3002:3002 --mount "type=bind,src=$WORK/state,dst=/srv/server-forge" "$IMAGE" >/dev/null
healthy=false
for i in $(seq 1 60); do
    if docker exec "$SMOKE" node --input-type=module -e '
      const fs=await import("node:fs");
      const me=await fetch("http://127.0.0.1:8190/api/me").then(r=>r.json());
      if(me.needsSetup || "version" in me || "platform" in me || !me.container)process.exit(1);
      const file="/srv/server-forge/data/";
      if((fs.statSync(file).mode&511)!==448 || (fs.statSync(file+"desktop.key").mode&511)!==384)process.exit(1);
      if(JSON.parse(fs.readFileSync("/opt/server-forge/package.json")).version!==process.argv[1])process.exit(1);
      if(!fs.existsSync(file+"container-owner.json"))process.exit(1);
    ' "$VERSION" >/dev/null 2>&1; then healthy=true; break; fi
    sleep 2
done
if [ "$healthy" != true ]; then
    echo 'Container smoke check failed (logs retained only inside the temporary test container until cleanup).' >&2
    docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$SMOKE"
    exit 1
fi
echo "PASS Docker $VERSION: startup, owner bootstrap, anonymous metadata, private data/key permissions"
docker stop --time 120 "$SMOKE" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE")" = 0
docker rm "$SMOKE" >/dev/null
cp -a "$WORK/context/." "$WORK/bundle/"
cp "$SRC/docker/RELEASE-README.md" "$WORK/bundle/README.md"
cp "$SRC/docker/compose.release.yaml" "$WORK/bundle/compose.yaml"
cp "$SRC/docker/compose.truenas.release.yaml" "$WORK/bundle/compose.truenas.yaml"
cp "$SRC/docker/release.env.example" "$WORK/bundle/.env.example"
for file in README.md compose.yaml compose.truenas.yaml .env.example; do
    sed -i "s/@VERSION@/$VERSION/g;s/\r$//" "$WORK/bundle/$file"
done
printf 'Exporting %s\n' "$IMAGE"
docker save -o "$WORK/bundle/image.tar" "$IMAGE"
(cd "$WORK/bundle" && sha256sum image.tar > SHA256SUMS)
mkdir -p "$SRC/release"
OUTPUT="$SRC/release/Server-Forge-Docker-$VERSION-linux-amd64.tar.gz"
tar -czf "$OUTPUT" -C "$WORK/bundle" .
test "$(stat -c %s "$OUTPUT")" -lt 2147483648 || { echo 'Docker download exceeds GitHub asset limit' >&2; exit 1; }
# Validate both outer archive integrity and the saved-image manifest without loading a duplicate image.
gzip -t "$OUTPUT"
tar -tf "$WORK/bundle/image.tar" | grep -qx manifest.json
printf 'Docker download ready: %s (%s bytes)\n' "$OUTPUT" "$(stat -c %s "$OUTPUT")"
