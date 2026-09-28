#!/usr/bin/env bash
# P9: install alfred-node on the Mac as a LaunchAgent (KeepAlive).
# Usage: node-install-macos.sh --server wss://gx10-de9a.tail542084.ts.net:8443 \
#          --token $ALFRED_TOKEN --name macbook --root ~/code [--root …] [--with-dsh] [--repo /path/to/alfred]
# This script is SHIPPED, not run by the tests. It never prints the token to logs.
set -euo pipefail

SERVER=""; NAME="macbook"; TOKEN="${ALFRED_TOKEN:-}"; REPO="${ALFRED_REPO:-$HOME/alfred}"
ROOTS=(); WITH_DSH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER="$2"; shift 2;;
    --token)  TOKEN="$2"; shift 2;;
    --name)   NAME="$2"; shift 2;;
    --root)   ROOTS+=("$2"); shift 2;;
    --repo)   REPO="$2"; shift 2;;
    --with-dsh) WITH_DSH=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[[ -n "$SERVER" && ${#ROOTS[@]} -gt 0 ]] || { echo "--server and at least one --root are required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "token required (--token or ALFRED_TOKEN)" >&2; exit 2; }
command -v node >/dev/null || { echo "node >= 20 required" >&2; exit 1; }

# ws (and tsx) must exist in the repo; on a fresh clone do: cd "$REPO" && npm ci
[[ -d "$REPO/node_modules/tsx" ]] || { echo "tsx missing: run 'npm ci' in $REPO first" >&2; exit 1; }

ARGS=("$REPO/bin/alfred-node" --server "$SERVER" --name "$NAME" --token "$TOKEN")
for r in "${ROOTS[@]}"; do ARGS+=(--root "$r"); done
if [[ $WITH_DSH -eq 1 ]]; then
  ARGS+=(--dsh)
  # DSH settings overlay: headless profile pointed at the Spark's Qwen over the tailnet.
  mkdir -p "$HOME/.deepseek"
  cat > "$HOME/.deepseek/alfred-node.json" <<JSON
{ "profile": "headless", "apiBaseUrl": "http://gx10-de9a:1110/v1", "nodeName": "$NAME" }
JSON
fi

# `alfred` CLI shim (works with ALFRED_URL + ALFRED_TOKEN from the Mac, §4 addendum).
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/alfred" <<EOF
#!/usr/bin/env bash
exec npx --prefix "$REPO" tsx "$REPO/src/cli.ts" "\$@"
EOF
chmod +x "$HOME/.local/bin/alfred"

PLIST="$HOME/Library/LaunchAgents/com.alfred.node.plist"
mkdir -p "$HOME/Library/LaunchAgents"
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0"><dict>'
  echo '  <key>Label</key><string>com.alfred.node</string>'
  echo '  <key>ProgramArguments</key><array>'
  for a in "${ARGS[@]}"; do echo "  <string>$a</string>"; done
  echo '  </array>'
  echo '  <key>KeepAlive</key><true/>'
  echo '  <key>RunAtLoad</key><true/>'
  echo '  <key>StandardOutPath</key><string>/tmp/alfred-node.log</string>'
  echo '  <key>StandardErrorPath</key><string>/tmp/alfred-node.err</string>'
  echo '  <key>EnvironmentVariables</key><dict>'
  echo "    <key>ALFRED_TOKEN</key><string>$TOKEN</string>"
  # launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has no Homebrew/nvm node:
  # bake in the directory of the node found at install time.
  echo "    <key>PATH</key><string>$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
  echo '  </dict>'
  echo '</dict></plist>'
} > "$PLIST"
chmod 600 "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "alfred-node installed: $PLIST (logs: /tmp/alfred-node.log). Uninstall: launchctl unload $PLIST && rm $PLIST"
