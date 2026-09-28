# alfred HTTP API

Base URL: `http://<host>:<port>` (default `127.0.0.1:8790`).
Every route is served under **`/api/v1/…`**; **`/api/…` is a permanent alias** (same handlers).
All bodies are JSON. When `ALFRED_TOKEN` is set, every `/api…` request needs
`Authorization: Bearer <token>` or `?token=<token>` — otherwise `401 {error:"unauthorized"}`.

## Health & contract

| Route | Response |
|---|---|
| `GET /api/v1/health` | `{ok:true, mcp:[{name,ok,tools,error?}], running:[taskIds], deckUrl, plugins:{loaded:[names], failed:[{name,error}]}}` |
| `GET /api/v1/schema/events` | `[{kind, meaning}]` — the event contract for UIs (see below) |
| `GET /api/v1/tools` | `[{name, description, kind, parameters}]` — every registered tool, plugins included |
| `GET /api/v1/plugins` | `{loaded:[names], failed:[{name,error}]}` |
| `GET /api/v1/personas` | `[{name, description, tools, canSpawn, promptBudgetTokens, promptCost}]` |

## Goals & tasks

| Route | Body → Response |
|---|---|
| `GET /api/v1/goals` | → `[goalSummary]` newest first; `goalSummary = {goal, counts:{<status>:n}}` |
| `POST /api/v1/goals` | `{title, body?, persona?, spec?, acceptance?[{name,cmd,cwd?,timeoutMs?}], repo?, budget?, model?, node?, mode?: 'sandbox'\|'repo', inPlace?}` → `201 {goal, task}`; `400` missing title / unknown persona |
| `GET /api/v1/goals/:id` | id **or slug** → `{goal, tasks, events(last 200), usage?}`; `404` if unknown |
| `POST /api/v1/tasks/:id/stop` | `{reason?}` → `{ok:true}` (running → cancelled via scheduler, else transition `stopped`); `409` illegal transition |
| `POST /api/v1/tasks/:id/retry` | `{note?}` → `201 {task}` (clone, notes carry over) |
| `POST /api/v1/tasks/:id/note` | `{text}` → `{ok:true}` |
| `GET /api/v1/approvals?status=` | → `[]` (the approval door lands with P3b; shape is stable) |
| `POST /api/v1/approvals/:id` | `{decision}` → `404` until the door lands |

## Automations

| Route | |
|---|---|
| `GET /api/v1/automations` | → `[Automation]` (db + file-backed) |
| `POST /api/v1/automations` | `{name, cron, template{title,persona?,spec?,acceptance?,repo?}, id?, enabled?}` → `201`; `400` bad cron |
| `DELETE /api/v1/automations/:id` | → `{ok:true}` / `404` |
| `POST /api/v1/automations/:id/enabled` | `{on:true|false}` |

## Models (P7)

| Route | |
|---|---|
| `GET /api/v1/models` | `{models:[{name,baseUrl,model,roles}], roles:{role:model}}` |
| `POST /api/v1/models/roles` | `{role, model}` → `{ok, roles}`; `400` on ModelConfigError |
| `POST /api/v1/models/reload` | re-reads the models yaml |

## SSE — `GET /api/v1/events`

`text/event-stream`. Optionally `?since=<eventId>`: everything newer than that id is
replayed first (up to 500), then live events follow. Each event:

```
id: <numeric event id>
data: {"id":12,"goalId":"…","taskId":"…"|null,"ts":1730000000000,"kind":"tool","data":{…}}
```

A `: ping` comment is written every 15 s. Event kinds (see `/api/v1/schema/events`):
`goal_created`, `goal_status`, `goal_meta`, `task_created`, `transition`, `turn`,
`tool`, `progress`, `verify`, `reclaimed`, `automation_fired`, `approval_requested`.

## Plugins (P11)

| Route | |
|---|---|
| `GET /api/v1/plugins/:name/*` | handlers registered with `ctx.registerRoute(method, path, handler)`; behind the same token |
| `/plugins/<name>/…` | static dirs registered with `ctx.registerStatic(dir)` (no token — static UI assets; register nothing sensitive) |

See `docs/EXTENDING.md` for writing plugins.

## Feature modules (P13–P21)

Each module mounts its routes under `/api/v1` (and the `/api` alias), behind the same token. The route
tables live with their specs:

| Module | Routes | Spec |
|---|---|---|
| board | `/boards…`, `/items…` (CRUD, move, check, comments, dispatch), `/board/dispatch` | `docs/phases/P13-board.md` |
| ops | `/stats`, `/ops/services…`, `/ops/qwen`, `/ops/logs`, `/ops/config…`, `/ops/repos`, `/ops/dispatch`, `/ops/alfred/build-web` | `docs/phases/P14-ops.md` |
| review | `/goals/:id/changes`, `/goals/:id/files`, `/goals/:id/file`, `/goals/:id/merge` | `docs/phases/P15-review.md` |
| chat | `/chat`, `/chat/threads…` | `docs/phases/P16-chat.md` |
| slack | `/slack/status` | `docs/phases/P20-slack.md` |
| powers | `/connectors…` | `docs/phases/P21-agent-powers.md` (P21a) |
| comms | `/contacts` (GET, PUT) | `docs/phases/P21-agent-powers.md` (P21b) |

Live event kinds (including the module ones: `item_*`, `ops`, `chat_*`, `power`, `comms`) are listed by `GET /api/v1/schema/events`;
every tool agents can call is listed by `GET /api/v1/tools`.
