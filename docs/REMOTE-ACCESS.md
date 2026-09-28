# Reaching alfred from your devices

All compute runs on the Spark (`gx10-de9a`, tailnet `100.89.202.75`). Everything else is a client.

## 1. The website on the tailnet (do this first — needs sudo once)
```bash
# on the Spark
sudo tailscale set --operator=$USER        # once: lets tailscale serve run without sudo afterwards
tailscale serve --bg --https=8443 http://127.0.0.1:8790
```
Then open `https://gx10-de9a.tail542084.ts.net:8443/?token=<ALFRED_TOKEN>` on any tailnet device (Mac, iPhone, iPad).
The token is saved in the browser after the first visit. On the iPhone: Share → "Add to Home Screen" gives an app icon (PWA).
Token: `grep ALFRED_TOKEN ~/.config/alfred.env` on the Spark. Set `ALFRED_DASHBOARD_URL=https://gx10-de9a.tail542084.ts.net:8443`
in `~/.config/alfred.env` so notifications, Slack and the board link to the right place, then `systemctl --user restart alfred`.

## 2. A nicer URL (later): `alfred.popotomodem.com`
Tailscale serve only answers to the `*.ts.net` name, so a custom name needs a reverse proxy with its own certificate.
Recommended (tailnet-only, no ports opened to the internet):
1. DNS: an `A` record `alfred.popotomodem.com → 100.89.202.75` (the Spark's tailnet IP). It resolves anywhere, but only tailnet
   devices can connect. Put it in the public zone so phones on cellular resolve it; the internal view on baleen (10.0.0.22) must
   have it too (split horizon). Note: `*.popotomodem.com` is a wildcard to orca2 (10.0.0.16) internally — the explicit record overrides it.
2. Certificate: Caddy on the Spark with the DNS-01 challenge for your DNS provider (HTTP-01 cannot work because the name points at a
   private IP). Caddyfile:
   ```
   alfred.popotomodem.com {
     bind 100.89.202.75
     tls { dns <provider> {env.DNS_API_TOKEN} }
     reverse_proxy 127.0.0.1:8790
   }
   ```
   (Caddy needs the matching `caddy-dns/<provider>` module, e.g. `xcaddy build --with github.com/caddy-dns/cloudflare`.)
3. Point the Mac app / CLI at `https://alfred.popotomodem.com` (Settings in the app; `alfred login --url …`).
Alternative with no certificate work: keep the ts.net URL and add a redirect page on your site.

## 3. The Mac
- **App** (menu bar + window + notifications + quick add): `app/README.md`.
- **CLI**: the app's menu "Install command-line tool…", or copy `dist/alfred.mjs` (built with `npm run build:cli`) to `~/.local/bin/alfred`
  and run `alfred login --url https://gx10-de9a.tail542084.ts.net:8443 --token <token>`.
- **Node** (the Mac as a workspace): enable it in the app's Settings, or `deploy/node-install-macos.sh` (README).
- **Claude Code on the Mac**: `claude mcp add --transport http alfred https://gx10-de9a.tail542084.ts.net:8443/mcp --header "Authorization: Bearer <token>"`.

## 4. Slack
Fastest: api.slack.com/apps → Create New App → **From an app manifest** → paste `deploy/slack-manifest.yaml`. Or by hand: a Slack app with Socket Mode on (no public URL needed): bot scopes `chat:write`, `commands`, `app_mentions:read`, `im:history`,
`im:write`; an app-level token with `connections:write`; a slash command `/alfred`; event subscriptions `app_mention`, `message.im`;
interactivity on. Put `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL` and `SLACK_ALLOWED_USERS` (your Slack member id, e.g. `U0123ABCD`; comma-separate several) in `~/.config/alfred.env` and restart. Anyone not listed is refused, and the refusal message shows their id, so the easy way to find yours is to DM the bot once. Check with
`GET /api/v1/slack/status` or System → Overview.
