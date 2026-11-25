#!/bin/bash
# Build Thaana PDF to Word for Mac (Intel + Apple chip) — double-click this file in Finder.
# Needs Node.js once: download the macOS installer from https://nodejs.org (LTS) and install it first.
cd "$(dirname "$0")" || exit 1
echo "== Thaana PDF to Word — Mac build =="
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close…" _; exit 1
fi
echo "Installing build tools (first time takes a few minutes)…"
npm install || { echo "npm install failed"; read -r -p "Press Enter to close…" _; exit 1; }
echo "Building the app…"
if ! npm run dist:mac; then
  echo "Universal build failed - building separate Intel and Apple-chip versions instead…"
  npm run dist:mac-separate || { echo "Build failed — copy the messages above and open an issue on the project's GitHub page with them."; read -r -p "Press Enter to close…" _; exit 1; }
fi
echo
echo "Done! The installer is in the 'dist' folder:"
ls dist/*.dmg
open dist
read -r -p "Press Enter to close…" _
