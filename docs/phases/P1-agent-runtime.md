# P1 — Agent runtime

Status: **DISPATCHED** · Branch: `p1-agent-runtime` · Acceptance: `npm run test:p1` (do not edit `test/acceptance/p1/`)

Contracts: `src/types.ts` (P0), `src/runtime/contract.ts` (P1). Test doubles: `src/runtime/testing.ts`.
Reference implementation to port ideas from (read-only): `~/repos/ai-task-dashboard/server/src/{agentloop,slots,trace,openai}.ts`.
New deps allowed: `yaml`.

## Modules

### `src/runtime/tokens.ts`
`estimateTokens(text: string): number` = `Math.ceil(Buffer.byteLength(text, 'utf8') / 3)` (conservative on purpose).

### `src/runtime/tools.ts`
```ts
export class ToolRegistry {
  register(tool: Tool): void          // duplicate name → throws
  get(name: string): Tool | undefined
  schemasFor(names: string[]): ToolSchema[]   // unknown name → throws PersonaConfigError
}
export function builtinTools(): Tool[]
```
Built-ins (exact names): `read_file{path}`, `write_file{path, content}`, `list_dir{path?}`, `run_shell{cmd, timeoutSec?}`, `note{text}`,
plus the control tools `finish{summary}`, `give_up{reason}`, `ask_claude{reason, question}`, `spawn_subagent{persona, title, spec, acceptance?, budget?}`, `wait_subtasks{}`.
- Paths resolve against `ctx.workspace`. Any path that resolves outside it (`..`, or an absolute path elsewhere) → `{ok:false, output: 'path outside workspace: …'}`. Never throw from `run`.
- `run_shell`: `bash -c` in the workspace, default timeout 120 s, max 600 s, kills the process group, output tail ≤ 8000 chars, `ok` = exit 0. Output includes `exit=<code>`.
- Control tools' `run` just returns `{ok:true, output:''}`. The agent loop intercepts them.
- Schema descriptions must be **short** (one sentence). The context budget is a hard constraint.

### `src/runtime/personas.ts`
```ts
export function promptCost(p: Persona, reg: ToolRegistry): number
  // estimateTokens(p.system) + estimateTokens(JSON.stringify(reg.schemasFor(p.tools)))
export function loadPersonas(dir: string, reg: ToolRegistry): Map<string, Persona>
```
- Reads every `*.yaml` in `dir`. Fields as in `Persona`. `name` must equal the file basename.
- `PersonaConfigError`: missing required field, unknown tool, `canSpawn` names a persona that doesn't exist, or a persona that lists `spawn_subagent` with an empty `canSpawn` (or the reverse).
- `PersonaBudgetError` if `promptCost > promptBudgetTokens`. The message contains the persona name, the cost and the budget.
- Ship `personas/alfred.yaml`, `coder.yaml`, `researcher.yaml`, `coder-lg.yaml`. Each `promptBudgetTokens` ≤ 6000.
  - `alfred`: chief of staff. Breaks goals into subtasks, spawns `coder`/`researcher`/`coder-lg`, waits, and integrates. Tools: read-only plus note, control tools.
  - `coder`: implements in the workspace with file and shell tools. P2 adds executor tools. No spawning in P1 (canSpawn: []).
  - `researcher`: read_file/list_dir/run_shell (for curl/grep)/note/finish/give_up/ask_claude.
  - `coder-lg`: placeholder for the P2 LangGraph flow. Same tools as coder for now.
  - Every persona's system prompt must say: call `finish` only when the acceptance checks should pass; `give_up` with a concrete reason if the task is impossible; `ask_claude` if stuck on something hard. Never claim success in plain text.

### `src/runtime/openai.ts`
```ts
export function openaiLLM(o: { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number; temperature?: number }): LLM
export function limitLLM(llm: LLM, maxConcurrent: number): LLM & { active(): number; queued(): number }
```
- POST `${baseUrl}/chat/completions` (non-streaming is fine). System prompt as the first message. Tools as `{type:'function', function: schema}`. Tool results as `role:'tool'` with `tool_call_id`.
- Strip any `<think>…</think>` block from `content`. Ignore `reasoning_content`.
- Parse `tool_calls[].function.arguments`. On a JSON parse failure, use `{__raw: <string>}`.
- Honour `req.signal` and `timeoutMs` (default 15 min). HTTP errors throw an Error whose message contains the status code.
- `limitLLM`: FIFO semaphore. At most `maxConcurrent` in-flight `chat` calls. A queued call whose signal aborts leaves the queue.

### `src/runtime/agent.ts`
```ts
export interface RunOpts {
  store: Store; llm: LLM; personas: Map<string, Persona>; registry: ToolRegistry;
  workerId: string;
  workspaceFor: (t: Task) => string;
  watchdog?: Partial<WatchdogConfig>;
  runner?: CheckRunner;            // passed to verifyAndComplete
  leaseMs?: number;                // default 5 min; heartbeat every turn and while waiting
  pollMs?: number;                 // wait_subtasks poll interval, default 1000
  /** Starts a spawned child. Default: runTask(child, {...opts, workerId: `${workerId}/${childId}`}) without awaiting. The scheduler passes a no-op. */
  spawnRunner?: (childTaskId: string) => void;
  signal?: AbortSignal;
}
export async function runTask(taskId: string, o: RunOpts): Promise<Task>   // resolves with the final task row; never rejects for agent-level failures
```
Behaviour, in order of precedence:
1. **Claim**: if `queued`, claim it (lease). If `running` it must be leased by `workerId`. Otherwise throw.
2. **Prompt**: `system` = persona.system. The first user message contains the task title, spec, and each acceptance check `name: cmd`. **If `notes` is non-empty it adds a section `## Notes from previous attempts` with the notes** (retries are never from scratch).
3. **Loop.** Before each turn, check budgets. `turns` used ≥ `budget.turns` → `stopped` "turn budget exhausted (N)". Summed prompt+completion tokens ≥ `budget.tokens` → `stopped` "token budget exhausted". Elapsed ≥ `budget.wallClockMs` → `stopped` "wall clock exceeded". `o.signal` aborted → `stopped` "cancelled". On every stop, first `appendNote` the last assistant text (if any) so a retry has context.
4. Each LLM call gets an AbortSignal that fires on `o.signal`, the remaining wall clock, or the **stall watchdog** (no event recorded for this task in `stallMs`, measured in real time). A stall → `stopped` with a reason containing `stall`. A non-abort LLM error is retried twice (backoff 1 s, 4 s). The third failure → `failed` "llm error: …".
4b. **ToolContext**: supply `acceptance` (the task's checks) and `progress(msg)`, which appends event `progress` `{msg}` for the task (this resets the stall watchdog, since long executor tools can run for 30+ minutes). A ToolResult carrying `park` → transition the task to `park.status` with `park.reason` and return.
5. After every LLM response: heartbeat, then append event `turn` `{turn, tools: [names], usage}`.
6. **No tool calls**: increment idle. If idle ≥ `maxIdleTurns` → `stopped` with reason containing `no progress`. Otherwise add the assistant message plus a user nudge and continue. Any tool call resets idle.
7. **Tool calls** run sequentially in order. A tool that isn't in the persona's `tools` → error result `unknown tool: X`. Each tool call appends event `tool` `{name, ok}`. Consecutive identical error outputs (same tool + same output text) ≥ `maxRepeatedErrors` → `failed` with reason starting `repeated error:`.
8. **Control tools:**
   - `finish{summary}` → `transition(verifying)`, then `verifyAndComplete(store, id, {runner})`. **Acceptance checks without a `cwd` run in the task's workspace** (wrap the runner to default `cwd`). If ok → return (done). If not → the tool result carries each failing check's name and output tail, and the loop continues (the gate already put the task back to `running`, so the claim must be re-established: the implementation may re-claim or keep the lease; the acceptance tests only observe status). If the gate marked the task `failed` (no checks) → return.
   - `give_up{reason}` → `failed` with that reason. Return.
   - `ask_claude{reason, question}` → note the question, `needs_claude` with the reason. Return.
   - `spawn_subagent{…}` → the target persona must be in `persona.canSpawn` (else an error result). `store.createTask` with parentTaskId. A `BudgetError` becomes an error result with its message, not a crash. On success → `spawnRunner(childId)` and result `spawned <childId>`.
   - `wait_subtasks{}` → poll children every `pollMs` (heartbeating) until each is TERMINAL or PARKED. Result: one line per child, `<title>: <status> — <reason>`, plus the tail of the child's notes.

### `src/runtime/scheduler.ts`
```ts
export class Scheduler {
  constructor(o: Omit<RunOpts, 'workerId' | 'spawnRunner'> & { maxWorkers: number; pollMs?: number; idPrefix?: string })
  start(): void
  stop(): Promise<void>       // aborts running tasks (they end `stopped` "cancelled") and waits for them
  running(): string[]
}
```
- Every `pollMs`: `reclaimExpired()`, then while fewer than `maxWorkers` are running, `claimNext` and `runTask` with `spawnRunner` = no-op (children get picked up by polling).
- A task that is waiting in `wait_subtasks` holds a worker. The limit on concurrent model calls comes from `limitLLM`, not from workers, so a waiting parent doesn't block its children. `maxWorkers` must be large enough (default 12).

## Done when
`npm run test:p1`, the full `npx vitest run` (P0 still green) and `npm run typecheck` all pass, committed on `p1-agent-runtime`.
