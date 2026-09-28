# alfred

A local agent platform: goals, tasks with an acceptance gate, worker agents, and a door for Claude.
Everything runs on the Spark (`gx10-de9a`); the Mac, phone, Slack and Claude are clients.

## What's in it

| Surface | Where | Notes |
|---|---|---|
| **Dashboard** (web) | `https://gx10-de9a.tail542084.ts.net:8443/?token=…` (tailnet only) | Home, Inbox, Board, Goals, Chat, Automations, System (services, Qwen, logs, config, models, personas, nodes, repos, builds, connectors, contacts). Skins: JARVIS (default), Mark 42, FRIDAY, Classic. Phone layout + tab bar. |
| **Board** | Dashboard → Board, `alfred board`, agents' `board` tool | Jira/Notion-style items: columns, WIP limits, priority, labels, due, checklist, sub-items, comments, list view, drag & drop. **Send to agent** turns an item into a goal; agents create, move and complete items. |
| **Mac app** | `app/` → `npm --prefix app run pack:mac` → `app/dist/Alfred-mac-arm64.zip` | Menu bar, quick add (global shortcut), notifications with Approve/Deny, dashboard window, embedded node (Mac as a workspace), bundled CLI. Install: `app/README.md`. |
| **CLI** | `npm run build:cli` → `dist/alfred.mjs` (single file, needs only `node`) | `alfred login --url … --token …`, then `status`, `inbox`, `board`, `add`, `send`, `ask`, `chat`, `diff`, `stats`, `tail` … (`alfred --help`). Mutations ask before acting; `--yes` in scripts. |
| **Slack** | Socket Mode app (`deploy/slack-manifest.yaml`) | DMs / @mentions → chat with alfred; `/alfred status\|inbox\|add …`; approval requests with buttons. Only `SLACK_ALLOWED_USERS` may act. |
| **Agent powers** | tools `platform`, `connectors`, `alfred_dev`, `board`, `contacts`, `message`, `call` | Agents run the platform, add connectors, propose changes to alfred itself (you review → deploy), text and call. Reading is free; changes, messages, calls and deploys need your approval (pre-approve in `config/powers.yaml`). |
| **Coding agents** | Qwen3.8-Flash on the Spark (`:1110`) via DSH | Goals run in git worktrees; review diffs in Goals → Changes and merge from there. |

Setup for remote access, the Mac, Slack and a custom domain: [`docs/REMOTE-ACCESS.md`](docs/REMOTE-ACCESS.md).
HTTP API: [`docs/API.md`](docs/API.md). Build history and orchestration notes: [`docs/HANDOFF.md`](docs/HANDOFF.md).

Operate: `systemctl --user restart alfred` (never with sudo) · logs `journalctl --user -u alfred -f` · config `~/.config/alfred.env`.

## Connecting Claude (the door)

The door is an MCP server over stdio (`src/door/server.ts`) that talks to the same
SQLite store the agents use. Claude can see what's parked, claim `needs_claude` /
`blocked` tasks, work them, and pass them back through the done-gate.

```sh
claude mcp add alfred -e ALFRED_DB=$HOME/.alfred/alfred.db -- ~/repos/alfred/bin/alfred-door
```

Environment:

- `ALFRED_DB` — path to the SQLite store (required).
- `ALFRED_WORK_ROOT` — base directory for task workspaces (default `~/.alfred/work`).

Tools Claude sees (every result is JSON text; errors come back as MCP errors, the server never crashes):

| Tool | What it does |
|---|---|
| `alfred_status` | goals with task counts, parked tasks, pending approvals |
| `alfred_goal` | one goal by id or slug: tasks + last 30 events |
| `alfred_claim` | take a parked/queued task (worker `claude`, 4 h lease); returns workspace, acceptance, notes |
| `alfred_note` | append a note (survives retry and handback) |
| `alfred_complete` | run the acceptance gate; on failure the task stays with Claude |
| `alfred_release` | hand a running task back to the Qwen agents (→ queued) |
| `alfred_fail` | fail a task with a reason |
| `alfred_retry` | clone a terminal task into a fresh queued one |
| `alfred_create_goal` | create a goal plus one root task |
| `alfred_approve` | decide a pending approval (blocked tasks go back to queued) |

Terminal tasks (`done`/`failed`/`stopped`) cannot be claimed — `alfred_retry` first.

## Using Alfred from the laptop and phone

All compute runs on the Spark (`gx10-de9a`). The Mac (and phone) are clients.

**One-time on the Spark** — export `ALFRED_TOKEN` (systemd unit) and expose the
server on the tailnet only:

```bash
deploy/tailscale-serve.sh    # https://gx10-de9a.tail542084.ts.net:8443 → 127.0.0.1:8790
```

`startAlfred` refuses a non-loopback bind without a token; with tailscale serve
it binds `127.0.0.1` and tailscale terminates TLS.

**The Mac as a workspace (node):** it dials *out*, so no open ports; sleeping
just means "node offline" (tasks park `blocked: node <name> offline` and are
re-queued automatically when it returns).

```bash
cd ~/alfred && npm ci
deploy/node-install-macos.sh --server wss://gx10-de9a.tail542084.ts.net:8443 \
  --token $ALFRED_TOKEN --name macbook --root ~/code [--messages] [--with-dsh]
```

That installs a KeepAlive LaunchAgent (`com.alfred.node`, absolute node path — no npx/nvm), an `alfred` CLI shim,
`--messages` lets agents text via Messages.app and hand calls to the iPhone (always with your approval),
and (with `--with-dsh`) the headless DSH overlay pointed at the Spark's Qwen.
Foreground/debug: `bin/alfred-node --server … --name … --root …`.
Give a goal `meta.node = "macbook"` and `meta.repo = "<path on the Mac>"` and
tools, the acceptance gate and the mirror (`ALFRED_MIRROR=node:macbook:/abs/path`)
run there. Desktop notifications reach the Mac (cap `notify`).

**Claude Code on the Mac** — the door is also HTTP MCP:

```bash
claude mcp add --transport http alfred https://gx10-de9a.tail542084.ts.net:8443/mcp \
  --header "Authorization: Bearer $ALFRED_TOKEN"
```

**CLI from anywhere:** `alfred login --url https://gx10-de9a.tail542084.ts.net:8443 --token …` once, then `alfred status` (the Mac app's menu installs it).
**Phone:** the dashboard over the tailnet HTTPS URL — same token.
