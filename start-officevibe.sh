#!/usr/bin/env bash
#
# Launcher for the OfficeVibe Electron app (dev mode).
# Double-clicked from the desktop shortcut, or run directly: ./start-officevibe.sh
#

# Keep this terminal window open if startup fails. The desktop entry uses
# Terminal=true, so without this the window (and any error message) would vanish
# the instant the script exits — making failures impossible to read.
on_error() {
  local code=$?
  echo
  echo "OfficeVibe failed to start (exit code $code). The error is shown above ^"
  read -rp "Press Enter to close this window..."
  exit "$code"
}
trap on_error ERR
set -e

# Always run from this script's own directory (the project root),
# so the shortcut keeps working even if the folder is moved.
cd "$(dirname "$(readlink -f "$0")")"

# Desktop shortcuts launch a NON-interactive shell, which skips ~/.bashrc and so
# never adds ~/.local/bin to PATH. That's where the `claude` CLI lives, which the
# app spawns for each agent — add it back so agents can start.
export PATH="$HOME/.local/bin:$PATH"

# First-run safety: install dependencies if they're missing.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run, this can take a few minutes)..."
  npm install
fi

echo "Starting OfficeVibe..."
npm run dev
