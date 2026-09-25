# alfred

A local agent platform: goals, tasks with an acceptance gate, worker agents, and a door for Claude.

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
  --token $ALFRED_TOKEN --name macbook --root ~/code --with-dsh
```

That installs a KeepAlive LaunchAgent (`com.alfred.node`), an `alfred` CLI shim,
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

**CLI from anywhere:** `ALFRED_URL=https://gx10-de9a.tail542084.ts.net:8443 ALFRED_TOKEN=… alfred status`.
**Phone:** the dashboard over the tailnet HTTPS URL — same token.
