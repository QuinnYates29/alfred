# P0 — Core store & fail-loud

Status: **DISPATCHED** · Acceptance: `npm run test:p0` (tests in `test/acceptance/p0/`, do not edit them)

The contract types live in `src/types.ts`. Implement the four modules below.
Dependencies: `better-sqlite3` (already installed). No other runtime deps without a reason.

## `src/store.ts`

```ts
export function openStore(path: string, opts?: { now?: () => number }): Store
```
`path` may be `':memory:'`. Use `opts.now` for every timestamp and lease check, so tests can control time.
Use WAL mode and a single `BEGIN IMMEDIATE` transaction for claims. JSON columns are fine for `acceptance`/`budget`/`data`.

`Store` methods:

| Method | Behaviour |
|---|---|
| `createGoal({title, body?, acceptance?, budget?: Partial<Budget>})` → `Goal` | `slug` = kebab-case title, unique (append `-2`, `-3`…). status `active`. budget merged over `DEFAULT_BUDGET`. Emits event `goal_created`. |
| `getGoal(id)`, `listGoals()` | `getGoal` returns `undefined` if missing. |
| `createTask({goalId, parentTaskId?, persona, title, spec?, acceptance?, budget?: Partial<Budget>})` → `Task` | Root task: depth 0, budget = goal budget merged with the given one. Child: depth = parent+1. **Throws `BudgetError`** if depth > goal.budget.maxDepth, if parent already has `parent.budget.maxSubtasks` children, or if any numeric child budget field exceeds the parent's. Child budget defaults to the parent's budget. Status `queued`. Emits `task_created`. |
| `getTask(id)`, `listTasks(goalId)`, `children(taskId)` | |
| `claim(taskId, workerId, leaseMs)` → `boolean` | Atomic. Only a `queued` task can be claimed → `running`, `attempt+1`, lease set. Returns false otherwise. |
| `claimNext(workerId, {leaseMs, persona?})` → `Task \| null` | Oldest queued task (optionally filtered by persona), claimed atomically. |
| `heartbeat(taskId, workerId, leaseMs)` → `boolean` | Extends the lease only if `workerId` owns a live lease on a `running` task. |
| `reclaimExpired()` → `string[]` | Every `running` task whose lease has expired → `queued`, lease cleared, **notes kept**, event `reclaimed`. Returns ids. |
| `transition(taskId, to, {reason?, by?})` → `Task` | See the state machine below. Throws `IllegalTransitionError` for illegal edges, `ReasonRequiredError` if `to ∈ NEEDS_REASON` and the reason is empty or whitespace, and `DoneGateError` if `to === 'done'` (only the gate may complete a task). Leaving `running` clears the lease. Emits `transition` `{from, to, reason, by}`. Then runs goal rollup. |
| `appendNote(taskId, text)` | Appends `text` + `\n` to `notes`. |
| `appendEvent(goalId, taskId \| null, kind, data)` → `EventRow` | |
| `events(goalId, {sinceId?})` → `EventRow[]` | Ascending by id. |
| `onEvent(cb)` → `() => void` | Synchronous callback for every event appended after subscription; returns an unsubscribe function. |
| `close()` | |

Internal (exported for the gate): `_markDone(taskId, by)` takes a `verifying` task to `done`. The gate is the only caller.

### State machine

```
queued      → running | blocked | stopped
running     → verifying | failed | blocked | needs_claude | stopped | queued
verifying   → done(gate only) | running | failed
blocked     → queued | failed | stopped
needs_claude→ queued | running | failed | stopped
done, failed, stopped → (nothing)
```

### Goal rollup (after every transition)
Consider all tasks of the goal. If there is at least one task and every task is TERMINAL:
all `done` → goal `done`, otherwise → goal `failed`. Emit `goal_status` when it changes. PARKED tasks keep the goal `active`.

## `src/gate.ts`

```ts
export const defaultRunner: CheckRunner   // bash -c, honours cwd + timeoutMs (default 10 min), output tail ≤ 4000 chars, kills on timeout
export async function verifyAndComplete(store, taskId, opts?: { runner?: CheckRunner; by?: string }):
  Promise<{ ok: boolean; results: CheckResult[] }>
```
- The task must be `verifying`; otherwise throw `IllegalTransitionError`.
- **Zero acceptance checks → not ok.** Transition to `failed` with reason `no acceptance checks: refusing to mark done`. A task that can't be verified is never done.
- Run every check sequentially and record event `verify` with the results.
- All pass → `_markDone`. Any fail → transition back to `running` with reason `acceptance failed: <names>`, and append the failing output tails to notes.

## `src/notify.ts`

```ts
export class Notifier {
  constructor(sinks: Sink[], opts?: { timeoutMs?: number })   // default 10s per sink
  notify(n: Notice): Promise<{ sink: string; ok: boolean; error?: string }[]>
}
export function wireLoudFailures(store: Store, notifier: Notifier): () => void
```
- Sinks run concurrently. A sink that throws or exceeds the timeout is reported `ok:false` and never blocks or breaks the others. `notify` itself never rejects.
- `wireLoudFailures`: on every `transition` event whose `to` is `failed`/`stopped`/`blocked` → `level:'failure'`; `needs_claude` → `level:'warn'`; `goal_status` → `failed` → `failure`. `title` includes the task title (or goal title). `body` includes the reason. Returns unsubscribe.

## `src/mirror.ts`

```ts
export function writeMirror(store: Store, goalId: string, dir: string): string  // returns path
```
- Writes `<dir>/<goal.slug>/GOAL.md` atomically (write a tmp file, then rename).
- Content: `# <title>`, a line `Status: **<STATUS UPPERCASE>**`, the body, acceptance checks, a markdown table of tasks (title, persona, status, attempt, reason), a `> [!failure] <task title>` callout with the reason for every failed/stopped/blocked task, then `## Recent events` (last 20, one line each).
- **Deterministic:** no wall-clock "now". Two calls with no store change give byte-identical files.

## Done when
`npm run test:p0` and `npm run typecheck` both pass, and the code is committed on branch `p0-core-store`.
