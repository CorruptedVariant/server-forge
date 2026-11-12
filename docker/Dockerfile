FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# Game server needs: SteamCMD (32-bit libraries), .NET servers (ICU/SSL), Wine + Xvfb for the Windows-only servers
# (Enshrouded, V Rising), ClamAV for mod scans, tzdata so TZ applies to schedules and logs.
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl curl tar xz-utils unzip procps tzdata \
    lib32gcc-s1 lib32stdc++6 libatomic1 libicu74 libssl3t64 libcurl4t64 \
    libgssapi-krb5-2 zlib1g libunwind8 \
    wine wine64 wine32:i386 xvfb xauth \
    clamav \
    && rm -rf /var/lib/apt/lists/* \
    # ClamAV's signatures live in the persistent state folder (clamscan always reads /var/lib/clamav).
    && rm -rf /var/lib/clamav && ln -s /srv/server-forge/clamav /var/lib/clamav
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/server-forge
COPY dist ./dist
COPY public ./public
COPY assets ./assets
COPY scripts ./scripts
COPY package.json CHANGELOG.md ./
COPY docker/container.mjs ./container.mjs
COPY docker/freshclam.conf ./freshclam.conf
ENV NODE_ENV=production PANEL_CONTAINER=1 PANEL_DATA_DIR=/srv/server-forge/data HOME=/srv/server-forge TMPDIR=/srv/server-forge/tmp
LABEL org.opencontainers.image.title="Server Forge" org.opencontainers.image.description="Game server control panel (web UI on HTTPS 8191)" org.opencontainers.image.source="https://github.com/Volatile111/server-forge"
USER 3002:3002
STOPSIGNAL SIGTERM
EXPOSE 8191/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "--input-type=module", "-e", "fetch('http://127.0.0.1:8190/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "container.mjs"]
