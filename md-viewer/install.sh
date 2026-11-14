#!/bin/sh
# Copy the mod into the Herdr app home (hot-reloads).
set -e
D="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/md-viewer"
mkdir -p "$D"
cp main.js mod.json render.mjs package.json "$D"/
rm -rf "$D/fonts"; cp -r fonts "$D"/
rm -rf "$D/node_modules"; cp -r node_modules "$D"/
echo "installed to $D"
# the file picker (Ctrl+Shift+M)
P="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/md-open"
mkdir -p "$P"; cp ../md-open/main.js ../md-open/mod.json "$P"/
echo "installed to $P"
