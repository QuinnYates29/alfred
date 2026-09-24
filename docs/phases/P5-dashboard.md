# P5 — Dashboard (absorbs Mission Deck)

> **Scope note (2026-09-24):** Quinn will redesign the control side. Build a *functional shell* that passes the acceptance test and talks only to the documented `/api/v1` + SSE contract (docs/API.md). Keep components small and replaceable, with no business logic in the UI. It is served as the default static UI; alternate UIs can be added as plugins (`registerStatic`).

Status: **SPEC** · Branch: `p5-dashboard` · Acceptance: `npm run test:p5` (do not edit `test/acceptance/p5/`)
Depends on: P4 API. Stack: Vite + React 19 (same as Mission Deck) in `web/`, built to `web/dist`, served by `createApp({staticDir})`.
Reference for look and feel (read-only): `~/repos/ai-task-dashboard/src/` (App.jsx, index.css, components/). Reuse its CSS variables and
touch-sized controls so it looks like the same product.

## Absorbing Mission Deck
Mission Deck keeps running as a child process supervised by `startAlfred` (P4 `deck` option, port 8787). The dashboard has a **Deck** tab
that shows it in an iframe at `health.deckUrl`. It shows a clear "Deck not running" panel when `deckUrl` is null or unreachable.
Personal tasks, calendar, chat and briefing keep working exactly as they do today, with one URL for everything.

## Views (hash routing: `#/`, `#/goal/<id>`, `#/approvals`, `#/automations`, `#/personas`, `#/deck`)
1. **Goals** (`#/`): cards grouped Active / Needs attention (any task failed|blocked|needs_claude, or goal failed) / Done. Each card shows the title,
   status chip, task counts, and elapsed time. A **"New goal"** form: title, persona select (from /api/personas), spec, acceptance rows (name + cmd), optional repo.
2. **Goal detail** (`#/goal/<id>`): the task tree (children indented) with status chips; per task: persona, attempt, reason, notes (collapsible),
   and **Stop** / **Retry** / **Add note** buttons. A live **timeline** of events from SSE. **Failure cards**: every failed/stopped/blocked task, and the goal itself if failed, is rendered
   as an element with `data-testid="failure-card"` and a red style, containing the task title and reason. `needs_claude` tasks show an amber card
   `data-testid="claude-card"` with the text "Waiting for Claude" and the door command `claude mcp add alfred …`.
3. **Approvals**: pending approvals with **Approve** / **Deny** (`data-testid="approve-<id>"` / `deny-<id>`).
4. **Automations**: list + create (name, cron, persona, spec, acceptance) + enable toggle + delete. Invalid cron → an inline error from the API's 400.
5. **Personas**: name, description, tools, canSpawn, and a promptCost / budget bar.
6. **Deck**: iframe as above.
A header with a live connection dot (SSE connected), the count of running tasks, and a **global red banner** `data-testid="alert-banner"` whenever any goal
needs attention. The banner links to the first such goal.

Live updates: one `EventSource('/api/events?since=<lastId>')`. Reconnect with backoff. On each event, refetch only what changed (the goal it belongs to).
Token: if the page URL has `?token=…`, store it in localStorage and send it as a Bearer header / `?token=` on SSE.

## Build + serve
- `web/package.json` with `vite build` → `web/dist`. Root `package.json` script `build:web` = `npm --prefix web ci && npm --prefix web run build` (or `install`).
- `startAlfred` passes `staticDir: <repo>/web/dist` by default.

## Acceptance (`test/acceptance/p5/dashboard.test.ts`, Playwright via `playwright-core` + the cached Chromium in ~/.cache/ms-playwright or /usr/bin/chromium-browser)
Boots `startAlfred` with a scripted LLM, opens the dashboard, and checks: the goals list renders; creating a goal via the form works; a task failing
shows a `failure-card` with its reason **within 5 s** without a reload (SSE); `alert-banner` appears; Stop works; a pending approval can be approved from the UI.

## Addendum (P7/P8/P9, 2026-09-24)
- **Models** view (`#/models`): lists models + roles, with a select per role to switch it (`POST /api/models/roles`). Shows which endpoint each role hits.
- Goal detail shows **context economy**: goal prompt/completion token totals, per-persona split, and per task its peak prompt tokens + compaction count (from `usage`).
- **Nodes** view (`#/nodes`): connected nodes (`GET /api/nodes` → hub.list()) with roots/caps. The New-goal form gets a "Where" select (`local` + connected nodes) and a repo path input.
- PWA: `web/public/manifest.webmanifest` + icons + `<meta name="apple-mobile-web-app-capable">` so the iPhone can add it to the home screen.
