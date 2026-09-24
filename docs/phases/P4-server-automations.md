# P4 — Server, API, automations, CLI, service (the integration phase)

Status: **SPEC** · Branch: `p4-server` · Acceptance: `npm run test:p4` (do not edit `test/acceptance/p4/`)
Depends on: P0–P3. New deps allowed: `express` (v5), `@types/express`.
Reference (read-only): `~/repos/ai-task-dashboard/server/src/{automations,index,events}.ts`. Port its cron parser.

## 1. Store additions
- `allEvents({ sinceId?, limit? /* 500 */ }): EventRow[]`, ascending across all goals (for SSE replay).
- `src/ops.ts` (shared by the API, the CLI and the Claude door; refactor P3's door to use it):
  - `createGoalWithRoot(store, {title, body?, persona? /* 'alfred' */, spec? /* = body */, acceptance?, repo?, budget?}) → {goal, task}`
  - `retryTask(store, taskId, note?) → Task` (clone of a failed/stopped task, as specified for `alfred_retry`)
  - `goalSummary(store, goalId)` → goal + `counts` by status

## 2. `src/automations.ts`
```ts
export interface Automation { id: string; name: string; cron: string; enabled: boolean;
  template: { title: string; body?: string; persona?: string; spec?: string; acceptance?: AcceptanceCheck[]; repo?: string };
  source: 'db' | 'file'; lastRunAt: number | null; lastGoalId: string | null; lastStatus: 'fired' | 'skipped' | null; lastNote: string | null }
export function validCron(expr: string): boolean
export function cronMatches(expr: string, d: Date): boolean      // 5 fields: *, lists, ranges, steps; dow 0-6 (0 = Sunday), local time
export class Automations {
  constructor(store: Store, o?: { dir?: string /* markdown automations */; now?: () => number })
  list(): Automation[]; upsert(a: Partial<Automation> & { name; cron; template }): Automation; remove(id): boolean; setEnabled(id, on): Automation
  reloadFiles(): void          // dir/*.md: frontmatter {name, cron, persona, acceptance: [{name,cmd}], repo?, enabled?}; the body = spec; title = name + ' — ' + YYYY-MM-DD
  tick(): Automation[]         // fires every enabled automation whose cron matches now() (minute resolution). At most once per matching minute.
                               // If lastGoalId's goal is still 'active' → skipped (lastNote 'previous run still active'). Returns the ones that fired.
}
```
DB automations persist in SQLite (new table). File automations are reloaded, never persisted. Firing uses `createGoalWithRoot` and appends event `automation_fired` on the new goal.

## 3. `src/server/app.ts`
```ts
export function createApp(d: { store: Store; scheduler?: Scheduler; automations?: Automations; hub?: McpHub;
  personas?: Map<string, Persona>; registry?: ToolRegistry; token?: string; staticDir?: string; deckUrl?: string }): express.Express
```
All JSON. If `token` is set, every `/api/*` needs `Authorization: Bearer <token>` or `?token=` (else 401).
| Route | |
|---|---|
| `GET /api/health` | `{ok:true, mcp: hub?.status() ?? [], running: scheduler?.running() ?? [], deckUrl}` |
| `GET /api/goals` | goal summaries, newest first |
| `POST /api/goals` | body per `createGoalWithRoot`. 400 if the title is missing or the persona is unknown (when personas are given). → 201 `{goal, task}` |
| `GET /api/goals/:id` | `{goal, tasks, events (last 200)}` (404 if unknown). Accepts id or slug. |
| `POST /api/tasks/:id/stop` | `{reason?}` → `scheduler.cancel(id, reason)` if running there, else transition → stopped (reason default 'stopped by Quinn'). 409 on an illegal transition. |
| `POST /api/tasks/:id/retry` | `{note?}` → 201 new task |
| `POST /api/tasks/:id/note` | `{text}` |
| `GET /api/approvals?status=` / `POST /api/approvals/:id` `{decision}` | |
| `GET/POST /api/automations`, `DELETE /api/automations/:id`, `POST /api/automations/:id/enabled` `{on}` | |
| `GET /api/personas` | `[{name, description, tools, canSpawn, promptBudgetTokens, promptCost}]` |
| `GET /api/events` | **SSE**. First replays `allEvents({sinceId: ?since})`, then streams live via `store.onEvent`. Each event is `id: <id>\ndata: <json>\n\n`. Heartbeat comment every 15 s. Unsubscribes on close. |
| static | `staticDir` served at `/` if it exists (the P5 dashboard build) |

Scheduler addition: `cancel(taskId, reason): boolean` aborts that one run (the task ends `stopped` with the reason).

## 4. `src/main.ts`
```ts
export interface AlfredConfig { dbPath: string; mirrorDir: string; workRoot: string; personasDir?: string; automationsDir?: string;
  mcpConfigPath?: string; port?: number /* 0 = ephemeral */; host?: string; llm?: LLM /* override for tests */; llmSlots?: number /* 6 */;
  baseUrl?: string /* http://127.0.0.1:1110 */; model?: string; env?: Record<string,string|undefined>; tickMs?: number /* 30000 */;
  pollMs?: number; deck?: { dir: string; port: number } | null }
export interface Alfred { url: string; store: Store; scheduler: Scheduler; automations: Automations; hub: McpHub; stop(): Promise<void> }
export async function startAlfred(c: AlfredConfig): Promise<Alfred>
```
It wires: the store, `allTools()` + hub tools into a registry, personas, `limitLLM(openaiLLM(...))` (or `c.llm`), a Scheduler with
`workspaceFor(store, t, {root: workRoot})`, a Notifier (`sinksFromEnv`, logging each warning once; env `ALFRED_NOTIFY_DESKTOP=0` drops the desktop sink, which tests use) + `wireLoudFailures`, a **debounced (500 ms) markdown mirror**
of any goal that gets an event (to `mirrorDir`), the automations tick, the HTTP server, and `hub.connectAll()` in the background plus a retry every 5 min
(so the Mac MCP just shows up when Quinn connects it).
**Deck supervision** (when `c.deck`): if `http://127.0.0.1:<port>/api/health` (or `/`) answers, use it. Otherwise spawn `node dist/index.js` in `deck.dir` with `PORT=<port>`
and restart it with backoff if it exits. `stop()` kills it. `deckUrl` goes to the app.
`stop()` stops everything cleanly: the scheduler (running tasks → stopped 'cancelled'), timers, the server, the hub and the store.

## 5. CLI `bin/alfred` (→ `npx tsx src/cli.ts`), talking to the HTTP API (`ALFRED_URL`, default `http://127.0.0.1:8790`; `ALFRED_TOKEN`)
- `alfred serve` → `startAlfred` from env: `ALFRED_DB` (~/.alfred/alfred.db), `ALFRED_MIRROR_DIR` (~/vaults/alfred), `ALFRED_WORK_ROOT` (~/.alfred/work), `ALFRED_PORT` (8790), `ALFRED_HOST` (0.0.0.0), `ALFRED_DECK_DIR` (~/mission-deck/server), `ALFRED_DECK_PORT` (8787)
- `alfred goal "<title>" [--spec S] [--check "name=cmd"]... [--repo PATH] [--persona P] [--file GOAL.md]`. `--file` reads frontmatter (title, persona, repo, acceptance) + body.
- `alfred status`, `alfred show <goal>`, `alfred stop <taskId> [reason]`, `alfred retry <taskId> [note]`, `alfred approve <id> [--deny]`, `alfred tail` (SSE, one line per event)
- `deploy/alfred.service` (systemd **user** unit, `Restart=always`, EnvironmentFile=-%h/.config/alfred.env) + `deploy/install.sh` (copies the unit, `systemctl --user daemon-reload`, enable --now). Do NOT run install.sh; the orchestrator does.

## Done when
`npm run test:p4` + the full suite + typecheck are green on `p4-server`.
