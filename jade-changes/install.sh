#!/bin/sh
# Copy the mod into the Herdr app home (hot-reloads). A copy, not a symlink:
# Herdr doesn't see saves through a symlinked mod folder.
set -e
cd "$(dirname "$0")"
D="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/jade-changes"
mkdir -p "$D"
cp main.js model.js mod.json "$D"/
echo "installed to $D"
if command -v herdr-app >/dev/null; then herdr-app check "$D"; fi
