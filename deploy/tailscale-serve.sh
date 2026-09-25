#!/usr/bin/env bash
# P9: expose the Spark's Alfred over the tailnet only, on 8443, while keeping
# the existing `/` → :3080 mapping (dsh-web). Alfred itself binds 127.0.0.1.
# Run on gx10-de9a:  deploy/tailscale-serve.sh
set -euo pipefail
ALFRED_PORT="${ALFRED_PORT:-8790}"
command -v tailscale >/dev/null || { echo "tailscale not installed" >&2; exit 1; }
# Serve Alfred at https://<machine>.<tailnet>.ts.net:8443 (HTTPS via the tailnet cert).
tailscale serve --bg --https=8443 "http://127.0.0.1:$ALFRED_PORT"
# Keep the dsh-web mapping on the root path untouched (idempotent re-assert).
tailscale serve --bg 3080 || true
echo "tailnet-only: https://gx10-de9a.tail542084.ts.net:8443  (ALFRED_TOKEN required; set it in the systemd unit)"
