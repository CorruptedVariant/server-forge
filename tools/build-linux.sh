#!/bin/sh
# Builds the Linux packages (AppImage, .deb, .rpm) inside a Linux system: on Windows, the WSL distro "sf-ubuntu".
# Run from the project folder: tr -d '\r' < tools/build-linux.sh | sh -s dist:linux   (or dist:client:linux)
# Works on a copy on Linux's own disk (Windows' node_modules has the Windows Electron), and puts the results in release/.
# Needs Node 24 plus the rpm and libfuse2 packages.
set -e
SRC="$PWD"
WORK=/opt/sf-build
mkdir -p "$WORK"
tar --exclude=node_modules --exclude=data --exclude=release --exclude=versions --exclude=dist --exclude=ui-tests -cf - . | tar -xf - -C "$WORK"
cd "$WORK"
find desktop companion public src tools -type f \( -name '*.js' -o -name '*.ts' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.html' -o -name '*.css' \) -exec sed -i 's/\r$//' {} + 2>/dev/null || true
sum=$(sha1sum package-lock.json | cut -d' ' -f1)
if [ ! -d node_modules ] || [ "$(cat .lock-sum 2>/dev/null)" != "$sum" ]; then
  npm ci --no-audit --no-fund
  echo "$sum" > .lock-sum
fi
rm -rf release
npm run -s "$1"
mkdir -p "$SRC/release"
cp release/*.AppImage release/*.deb release/*.rpm "$SRC/release/"
ls -la release | grep -E 'AppImage$|deb$|rpm$'
