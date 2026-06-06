#!/usr/bin/env bash
#
# Launcher for the OfficeVibe Electron app (dev mode).
# Double-clicked from the desktop shortcut, or run directly: ./start-officevibe.sh
#
set -e

# Always run from this script's own directory (the project root),
# so the shortcut keeps working even if the folder is moved.
cd "$(dirname "$(readlink -f "$0")")"

# First-run safety: install dependencies if they're missing.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run, this can take a few minutes)..."
  npm install
fi

echo "Starting OfficeVibe..."
exec npm run dev
