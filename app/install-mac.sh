#!/usr/bin/env bash
# Install Alfred.app on this Mac (run on the Mac, not the Spark).
#   bash install-mac.sh                      # Alfred.app next to this script, else ~/Downloads/Alfred-mac-arm64.zip
#   bash install-mac.sh ~/Downloads/Alfred-mac-arm64.zip
#   bash install-mac.sh /path/to/Alfred.app
# The build is unsigned: this clears the quarantine flag and ad-hoc signs it (Apple Silicon refuses to run
# an app whose signature no longer matches), so Gatekeeper lets it open.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  if [[ -d "$HERE/Alfred.app" ]]; then SRC="$HERE/Alfred.app"; else SRC="$HOME/Downloads/Alfred-mac-arm64.zip"; fi
fi
DEST="/Applications/Alfred.app"

if [[ "$(uname -s)" != "Darwin" ]]; then echo "install-mac.sh: run this on the Mac" >&2; exit 1; fi
if [[ ! -e "$SRC" ]]; then echo "install-mac.sh: $SRC not found" >&2; exit 1; fi

TMP=""
if [[ "$SRC" == *.zip ]]; then
  TMP="$(mktemp -d)"
  trap '[[ -n "$TMP" ]] && rm -rf "$TMP"' EXIT
  ditto -x -k "$SRC" "$TMP"
  SRC="$(find "$TMP" -maxdepth 2 -name 'Alfred.app' -type d | head -n1)"
  [[ -n "$SRC" ]] || { echo "install-mac.sh: no Alfred.app inside the zip" >&2; exit 1; }
fi

osascript -e 'tell application "Alfred" to quit' >/dev/null 2>&1 || true
pkill -x Alfred >/dev/null 2>&1 || true
sleep 1

echo "Installing to $DEST"
rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -cr "$DEST"
codesign --force --deep --sign - "$DEST"
echo "Done. Opening Alfred (first run opens Settings: paste the URL and token)."
open "$DEST"
