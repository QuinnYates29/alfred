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
