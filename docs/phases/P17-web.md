# P17 — The website (web v2): views on the new shell

Status: **SPEC** · Branches: `p17b-board`, `p17c-goals`, `p17d-home`, `p17e-system` · Acceptance: `npx vitest run test/acceptance/p17/<view>.test.ts`

The shell, design system and data layer already exist (P17a, written by the orchestrator). **Read these first and use them; do
not invent new styling systems:**
- `web/src/styles/tokens.css`, `base.css`, `components.css` — every class you need (`.page`, `.page-head`, `.card`, `.btn`, `.chip`,
  `.input`, `.select`, `.textarea`, `.field`, `.tabs`, `.seg`, `.list-item`, `.table`, `.stat`, `.meter`, `.diff`, `.md`, `.timeline/.tl`,
  `.drawer`, `.modal`, `.menu`, `.empty`, `.kbd`, `.prio`, `.avatar`, `.label-tag`, `.key` …). Colors only via CSS variables.
  View-specific CSS goes in `web/src/views/<View>.css` imported by the view (keep it small).
- `web/src/ui/index.jsx` — `Button, Icon, Spinner, Empty, StatusChip, Prio, Avatar, Field, Tabs, Seg, Modal, Drawer, Menu, Markdown,
  Meter, Sparkline, Stat, useToast (toast + confirm), useAction`. `web/src/ui/icons.jsx` — icon names.
- `web/src/lib/live.jsx` — `useResource(path, { on, interval })` (fetch + refetch on matching SSE events), `useLive(on, cb)`.
- `web/src/lib/router.js` — `useRoute, go, href, setQuery`. `web/src/lib/format.js` — `timeAgo, duration, clock, dateTime, compact, dueInfo, initials, isAgent, shortId, goalNeedsAttention`.
- `web/src/api.js` — `api(path, {method, body})`, `post(path, body)`, `del(path)`. Paths start with `/api/` (the `/api` alias of `/api/v1`).
- `web/src/App.jsx` — routes, and `useApp()` → `{ newGoal(prefill), newItem(prefill), palette(), attention }`. The top bar owns the
  **only** "New goal" button (and `NewGoalDialog` its "Create" button): views must not render another button whose accessible
  name matches `/new goal/i` or `/^create$/i` while on `#/` (the P5 test relies on it). Use "Add", "Save", "Start" etc.
- The API: `docs/API.md` + `docs/phases/P13-board.md`, `P14-ops.md`, `P15-review.md`, `P16-chat.md` (routes and shapes).
- Look at an existing view for structure, e.g. `web/src/views/Home.jsx`. Legacy P5 views in `web/src/legacy/` are being replaced;
  do not import them in the views you write.

General rules: responsive (works at 390 px wide: stack columns, no hover-only actions); keyboard friendly; optimistic updates
where natural (then refetch); errors via `useToast().toast(msg, 'bad')`; confirmation via `useToast().confirm({...})` for destructive
things; empty states via `<Empty>`. Build must stay clean: `npm --prefix web run build`. No new npm dependencies.

---

## P17b — Board (`web/src/views/Board.jsx` + `web/src/views/board/*.jsx`, `Board.css`)
Familiar like Linear/Jira/Notion. Route `#/board` (default board; `?board=KEY` selects another), `#/board/<ITEMKEY>` opens that item's drawer over the board.
1. **Toolbar**: board name (a `<select data-testid="board-switch">` when there are several boards), `Seg` Board | List
   (`data-testid="view-board"` / `"view-list"`, remembered in localStorage), a text filter `data-testid="board-filter"` (title/key/label contains,
   case-insensitive, client-side), a "Mine" toggle (assignee `quinn`), and a settings button `data-testid="board-settings"`.
2. **Kanban**: columns side by side, horizontally scrollable (`data-testid="board-column-<columnId>"`). Column header: name, count, and
   `n/wip` in red when over its WIP limit. Each column has a quick-add input at the bottom (`data-testid="quick-add-<columnId>"`, placeholder
   "Add item…"; Enter creates the item in that column and keeps focus; Escape clears).
   **Card** (`data-testid="card-<KEY>"`): key, title, priority bars, labels, due (red if overdue, amber if ≤ 2 days), assignee avatar,
   checklist progress `2/5` when there is a checklist, and a bot icon with the linked goal's status when `goalIds` is non-empty.
   Cards are draggable (HTML5 drag and drop) within and across columns; dropping calls `POST /api/items/<KEY>/move {status: columnId, beforeId|afterId}`
   (insert before the card under the pointer, or at the end of the column). Every card also has a "⋯" menu button (`aria-label="More actions"`, always visible on touch screens) using `<Menu>` with
   **Move to → <column>**, Open, and Archive, so phones can move cards without dragging.
3. **List view**: a `.table` with Key, Title, Status (an inline `<select>` that moves the item), Priority, Assignee, Due, Labels, Updated;
   rows `data-testid="list-row-<KEY>"`; clicking a header sorts by it (click again to reverse). Clicking a row opens the drawer.
4. **Item drawer** (`<Drawer testId="item-drawer">`, opened by clicking a card/row; closing returns to `#/board`):
   - Title: bare input `data-testid="item-title"`, saves on blur/Enter (PATCH).
   - Properties grid: Status `<select data-testid="item-status">` (moves), Priority `<select data-testid="item-priority">`,
     Assignee `<input data-testid="item-assignee" list=…>` with suggestions (quinn, alfred, agent:<each persona>), Due `<input type=date data-testid="item-due">`,
     Labels (`data-testid="item-labels"`, comma-separated input, saved on blur), Estimate, and every custom field of the board by type
     (text/number/date/url inputs, select, checkbox).
   - Description: rendered `<Markdown>`; an Edit button (`data-testid="edit-description"`) swaps in a textarea (`data-testid="item-description"`) with Save/Cancel.
   - Checklist: entries with checkboxes (toggle → `POST /items/:key/check`), an add input `data-testid="checklist-add"` (Enter appends
     via PATCH checklist), remove entry button.
   - Sub-items: children with status, plus an "Add sub-item" input (creates with `parent`).
   - Linked goals: each with `StatusChip` and a link to `#/goal/<id>`.
   - **Send to agent** button `data-testid="send-to-agent"` → Modal `testId="dispatch-dialog"`: persona `<select data-testid="dispatch-persona">`
     (from /api/personas, default alfred), Where (Spark + nodes), repo, acceptance rows, note → Start (`data-testid="dispatch-submit"`)
     → `POST /api/items/<KEY>/dispatch`, toast "Sent to <persona>", link to the goal.
   - Comments: list (avatar, author, timeAgo, Markdown body) and a composer `data-testid="comment-input"` + `data-testid="comment-send"` (⌘/Ctrl+Enter sends).
   - Header menu: Copy link, Archive, Delete permanently (confirm).
5. **Board settings** (`Modal testId="settings-dialog"`): rename; columns editor (rows: name, kind select, WIP number; move up/down; add
   `data-testid="add-column"`; delete — when the column still has items ask which column to move them to); custom fields editor (name, type,
   options for select); Save → `PATCH /api/boards/<KEY>`. Also "New board" (name + key) → POST /api/boards.
6. Live: `useResource('/api/items?board=…', { on: ['item_', 'board_'] })` so agent/Slack/CLI edits appear without reload.

## P17c — Goals and review (`web/src/views/Goals.jsx`, `GoalDetail.jsx`, `web/src/views/goal/*.jsx`)
1. **Goals list** `#/goals`: `Seg` Active | Needs attention | Done | Failed | All (default Active). Rows: status chip, title, slug, persona of
   the root task, where (`meta.node` or Spark), task counts, elapsed/age, token total when present. Click → detail. Text filter.
2. **Goal detail** `#/goal/<id>[/<tab>]`: header with title, `StatusChip`, slug, repo, node, created/elapsed, linked board item
   (`meta.item` → link `#/board/<KEY>`), and actions: Stop (every running/queued task), Retry (failed/stopped root), Add note.
   Tabs (`hrefFor` → `#/goal/<id>/<tab>`): **Overview** · **Transcript** · **Changes** · **Files**.
   - Overview: the task tree (children indented) with `StatusChip`, persona, attempt, reason/result, notes (collapsible), per-task
     **Stop** (`getByRole('button', {name: /^stop$/i})` must work for a running task), **Retry**, **Add note**; failure cards: every
     failed/stopped/blocked task and a failed goal render an element `data-testid="failure-card"` (red `.card.alert`) containing the task
     title and reason; `needs_claude` tasks render `data-testid="claude-card"` (amber) with "Waiting for Claude" and the door command
     `claude mcp add --transport http alfred <origin>/mcp --header "Authorization: Bearer <token>"`; a live timeline of the goal's events
     (`.timeline`); usage (prompt/completion tokens, per persona, peak context per task).
   - Transcript: a task picker (default root task); renders `GET /api/tasks/<id>/transcript` as a conversation: turns (text as Markdown,
     tool calls as compact chips `name(args…)`), tool results collapsible (monospace, first line visible), transitions as separators,
     workspace/pushed events as small notes. Auto-refreshes on the task's events. `data-testid="transcript"`.
   - Changes: `GET /api/goals/<id>/changes`: branch + base, commits list, file list with +/−, and a diff viewer (`.diff` with add/del/hunk
     line classes; one file at a time via `?file=`, the first file selected). Buttons **Merge** (`data-testid="merge-btn"`) — a confirm dialog with
     strategy (merge/squash), target branch, delete-branch checkbox → `POST merge {confirm:true,…}`, toast result; a 409 conflict shows the conflicting files —
     and **Discard** (`data-testid="discard-btn"`, danger confirm). No branches → Empty "No code changes pushed".
   - Files: breadcrumb path, directory listing (`GET files`), click a file → content in `.codeblock` (`GET file`); 503 → "node offline" Empty.
3. Live updates via `useResource(…, { on: ev => ev.goalId === id })`. A failure must show within 5 s without reload (P5 test).

## P17d — Home, Inbox, Chat (`web/src/views/Home.jsx`, `Inbox.jsx`, `Chat.jsx`)
1. **Home** `#/`: greeting + date; a row of `Stat` tiles from `GET /api/stats` (refresh 10 s): GPU util % + temp, Qwen slots busy/total,
   tokens 24 h (with a `Sparkline` of `/api/stats/history?hours=24&bucket=3600` completion tokens), running/queued tasks; **Needs you**
   (pending approvals with Approve/Deny, parked tasks, failed goals, board items labelled needs-attention — max 6 with "Open inbox");
   **Running now** (active goals with their running task and elapsed); **Due soon** (board items due within 7 days or overdue, not done);
   **Recent** (last 8 goals). Every goal title links to its detail. Must list the titles of recent goals (the P5 test looks for a new goal's title on `#/`).
   No "New goal"/"Create" buttons (the top bar has them).
2. **Inbox** `#/inbox` (alias `#/approvals`): sections Approvals (each with action, the exact command in `.codeblock`, task + goal link,
   **Approve** `data-testid="approve-<id>"` and **Deny** `data-testid="deny-<id>"`), Waiting for Claude, Blocked, Failed goals (with Retry of
   the failed root task), Board items needing attention. Empty → `<Empty title="Inbox zero">`.
3. **Chat** `#/chat[/<threadId>]`: threads sidebar (new thread button `data-testid="new-thread"`, list with last message; delete in a menu),
   conversation pane: messages (user right-aligned bubble, assistant left with Markdown), each assistant message's `actions` as small chips
   (`name`, ok/err color, output in a tooltip/expand), a composer `data-testid="chat-input"` (Enter sends, Shift+Enter newline) and send button
   `data-testid="chat-send"`; while waiting show a typing indicator; replies arrive via the `chat_message` event (use `POST … /messages` without
   `wait`). `#/chat?ask=<text>` (from the palette) creates a thread and sends that text once. On phones the thread list collapses behind a button.

## P17e — System and automations (`web/src/views/System.jsx`, `web/src/views/system/*.jsx`, `Automations.jsx`)
`#/system/<tab>` tabs: **Overview** · **Services** · **Qwen** · **Logs** · **Config** · **Models** · **Personas** · **Nodes** · **Repos** · **Builds**.
(Legacy aliases `#/personas`, `#/models`, `#/nodes` land on those tabs; the P5 test expects the text `coder-lg` on the personas tab and `qwen-local` on models.)
- Overview: host (cpu load, mem meter, disk meter, uptime), GPU (util meter, clock, temp, power), Qwen (health, slots with processing
  dots and prompt tokens), tokens (1 h / 24 h, per persona table), a 24 h chart (bars or sparklines from /stats/history). Refresh 5 s.
- Services: each service row with state chip, pid, memory, since; action buttons from `controllable`, named Start/Stop/Restart (confirm via `useToast().confirm`, whose OK button repeats the action name; a 409 shows the running
  tasks and offers "Force"). Alfred restart shows "reconnecting…" until the event stream is back.
- Qwen: env table (QWEN_*), health, preset buttons, slots/ctx/offload number inputs with Apply (confirm; 409 → force prompt), limits shown.
- Logs: service select (alfred, qwen-server), line count, auto-refresh toggle (every 3 s), `.codeblock` scrolled to bottom, text filter.
- Config: file list (grouped by kind) → editor (`.textarea.code`, `data-testid="config-editor"`), Save (`data-testid="config-save"`, sends
  `mtime`, `confirm:true`; no extra confirmation dialog needed): 400 → show the validation error inline (`data-testid="config-error"`); 409 → "changed elsewhere, reload?"; success
  toast with what reloaded.
- Models: models table + a role → model select per role (`POST /api/models/roles`), Reload button.
- Personas: cards with description, tools, canSpawn, promptCost vs budget `Meter`, and a link "Edit" → Config tab with that file.
- Nodes: connected nodes (name, roots, caps, connectedAt) + a short "connect your Mac" help with the node-install command.
- Repos: registry table (name, paths per machine, branches count) + register form (name, machine, path).
- Builds: dispatch jobs (name, state chip, attempt, branch, ts) → detail drawer (log tail, last check output), and a "New build" form
  (name, branch, prompt file, check command, attempts, timeout) → POST /api/ops/dispatch.
**Automations** `#/automations` (a "New automation" button; the modal's inputs are labelled Name, Cron, Title, Persona, Spec, and its submit button is "Save"): table (name, cron in words where easy + raw, template persona/title, enabled toggle, last run with status
chip and goal link), create/edit modal (name, cron with presets hourly/daily 8am/weekdays 9am/weekly Mon, title, persona, spec, acceptance rows),
delete with confirm; invalid cron shows the API's 400 inline.

## Acceptance
Each sub-phase has `test/acceptance/p17/<view>.test.ts` (Playwright, same harness as P5: `startAlfred` with a scripted/idle LLM on an
ephemeral port, the cached headless Chromium, `npm run build:web` before the run). The test IDs and accessible names above are the
contract; layout and styling are yours within the design system. The P5 suite must keep passing.
