#!/usr/bin/env bash
# Install the alfred systemd USER service and start it. Safe to re-run.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cp "$SRC/alfred.service" "$UNIT_DIR/alfred.service"
systemctl --user daemon-reload
systemctl --user enable --now alfred.service
systemctl --user status alfred.service --no-pager || true
echo
echo "alfred is running as a user service. Logs: journalctl --user -u alfred -f"
