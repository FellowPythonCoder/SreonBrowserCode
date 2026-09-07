#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/app"

echo "=========================================="
echo "  Sreon — starting up"
echo "=========================================="

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js isn't installed yet. Opening the download page..."
  echo "Install it, then double-click this file again."
  ( command -v open >/dev/null 2>&1 && open "https://nodejs.org" ) || \
  ( command -v xdg-open >/dev/null 2>&1 && xdg-open "https://nodejs.org" )
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo ""
  echo "Rust isn't installed yet. Opening the install page..."
  echo "Install it (follow the on-screen steps), restart this file, then run it again."
  ( command -v open >/dev/null 2>&1 && open "https://rustup.rs" ) || \
  ( command -v xdg-open >/dev/null 2>&1 && xdg-open "https://rustup.rs" )
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

PLATFORM_TAG="$(uname -s)-$(uname -m)"
MARKER="node_modules/.sreon-platform"

if [ -d "node_modules" ] && [ "$(cat "$MARKER" 2>/dev/null)" != "$PLATFORM_TAG" ]; then
  echo "This app folder's dependencies were installed for a different"
  echo "computer or OS — clearing them out so they get reinstalled here."
  rm -rf node_modules
fi

# A previous run can leave node_modules half-installed (closed mid-install,
# lost network, etc). The checks above only ask "does node_modules exist?",
# so a broken install just sits there and gets reused forever, failing with
# something like "Cannot find module './main'" every time. Actually verify
# the Tauri CLI's real entry point is present, not just the folder.
if [ -d "node_modules" ] && [ ! -f "node_modules/@tauri-apps/cli/main.js" ]; then
  echo "A previous install looks incomplete or corrupted — reinstalling..."
  rm -rf node_modules package-lock.json
fi

if [ ! -d "node_modules" ]; then
  echo ""
  echo "First-time setup needs to download some things before Sreon can run:"
  echo "  - npm packages (the Tauri CLI + JS tooling)  ~ 250-350 MB download"
  echo "  - Rust crates + a native build              ~ 300-600 MB download,"
  echo "                                                 ~1.5-2.5 GB once built"
  echo "  Total: roughly 600 MB-1 GB downloaded, ~2-3 GB of disk space used."
  echo "  (Exact numbers vary by OS/CPU — this only happens once.)"
  echo ""
  read -n 1 -s -r -p "Continue and download now? [Y/n] " REPLY
  echo ""
  case "$REPLY" in
    [nN]) echo "Setup cancelled — nothing was downloaded. Run this again anytime."; exit 0 ;;
  esac
  echo "Installing the app's building blocks..."
  npm install
  echo "$PLATFORM_TAG" > "$MARKER"
fi

echo ""
echo "Launching Sreon. The very first launch compiles some Rust code and"
echo "can take a few minutes — this window will show the progress."
echo "Every launch after this one is much faster."
echo ""

npm run dev

read -n 1 -s -r -p "Sreon closed. Press any key to close this window..."
