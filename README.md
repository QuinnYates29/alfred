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
| **Agent powers** | tools `platform`, `connectors`, `alfred_dev`, `board`, `contacts`, `message`, `call` | Agents run the platform, add connectors, propose changes to alfred itself (you review → deploy → roll back if needed; see below), text and call. Reading is free; changes, messages, calls and deploys need your approval (pre-approve in `config/powers.yaml`). |
| **Coding agents** | Qwen3.8-Flash on the Spark (`:1110`) via DSH | Goals run on a branch (a worktree or a hub clone); review diffs in Goals → Changes, merge from there, Roll back to undo. **Edit where** on a goal changes its repo/machine. |

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

**alfred working on itself** — a goal (or board item) with repo `alfred` changes this platform. Safety rails:
- Sandbox only (`mode: sandbox`): an isolated clone of the Spark hub (`~/.alfred/work/<goal>/<id8>`) with its own `.git`.
  A worktree or in-place work on `alfred` is refused. The server's `node_modules` are linked in read-only.
- Checks: **Auto** by default — you don't need to know them up front. The gate starts with the suites (minus the Electron
  app suite p18) + `tsc`, and at finish adds what the diff needs: touching `web/` adds the web build and a **UI smoke test**
  (a sandboxed copy of alfred, every page at desktop + phone width, fails on page errors; screenshots land on the goal).
  **Edit goal** switches to a custom list (applied to retries too). Jev's done-gate review runs on top.
- Agents can click through their UI change themselves with the `ui_test` tool (a copy built from their workspace; scripted
  goto/click/fill/expect/screenshot); the screenshots reach you as a gallery output on the goal.
- Partial work is never lost: every exit (stop, failure, turn budget) commits and pushes the attempt's branch, and
  **Retry** continues on that same branch and workspace (a fresh clone of the branch if the workspace was cleaned up).
- Agents can only push their own `alfred/<goal>/<id>` branch to the hub; base branches are hook-protected. A push to any
  other remote from these goals always asks you (Jev triage can't auto-approve it), and so do `deploy` and `rollback`.
- Landing = `alfred_dev deploy` (approved) or **Merge** in Goals → Changes: a merge commit on `master` in the hub, then
  `~/repos/alfred` fast-forwards. Deploy refuses to rebuild/restart if that checkout didn't move (dirty or off `master`).
- Optional second opinion: tick **Peer review by coder-lg** (Edit where), `alfred_dev propose {review:true}`, or
  `peerReview: true` on the goal. When the goal is done (or on **LG review** in Goals → Changes / `alfred_dev review`),
  the LangGraph sidecar reviews the exact commit in a fresh clone: re-runs the checks, reviews each changed file with
  read-only tools at temperature 0, checks scope against the spec. The verdict is computed in code: `approve` only with
  passing checks and nothing above minor; a change to a safety rail (sandbox, approvals, gates, Jev policy, hub/landing,
  workspaces, the reviewer, acceptance tests) is always `needs_human`. `deploy` then lands only a commit coder-lg approved;
  your own Merge is never blocked. Report: the goal's **Peer review** output.
- Every landing is reversible: **Roll back** (Goals → Changes) or `alfred_dev rollback` reverts the merge with a new commit,
  then rebuilds/restarts as a deploy would. Nothing is rewritten, so a rollback can be rolled back too.
- Nothing leaves the Spark on its own: `~/repos/alfred`'s own remote (GitHub etc.) is only ever pushed by you, after review.

**Claude Code on the Mac** — the door is also HTTP MCP:

```bash
claude mcp add --transport http alfred https://gx10-de9a.tail542084.ts.net:8443/mcp \
  --header "Authorization: Bearer $ALFRED_TOKEN"
```

**CLI from anywhere:** `alfred login --url https://gx10-de9a.tail542084.ts.net:8443 --token …` once, then `alfred status` (the Mac app's menu installs it).
**Phone:** the dashboard over the tailnet HTTPS URL — same token.
