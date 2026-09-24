# P8 — Context economy

Status: **SPEC** · Branch: `p8-context` · Acceptance: `npx vitest run test/acceptance/p8`
Depends on: P1 (agent loop), P7 (per-persona model/context window).

Principle: **the main agent's context is the scarcest resource.** Reading-heavy and implementation work goes to subagents, and only
compact results come back. No conversation grows without bound. Every task knows what it cost.

## 1. Compaction (deterministic, no extra LLM call) in `src/runtime/agent.ts` (+ `src/runtime/compact.ts`)
- `contextBudgetTokens` = `persona.contextBudgetTokens ?? min(24000, 0.6 × model contextWindow)`.
- Before **every** LLM call: `est = estimateTokens(system) + estimateTokens(JSON.stringify(tool schemas)) + estimateTokens(JSON.stringify(messages))`.
  If `est > budget`: keep `messages[0]` (the task brief), keep the newest messages that fit in 50 % of the budget (never split an assistant message
  from its tool results), and replace the middle with ONE user message starting `## Compacted history` that lists each dropped tool call as
  `- <tool>(<args, ≤100 chars>) → ok|FAILED: <first 160 chars of output>`. If that digest itself exceeds 25 % of the budget, drop its oldest lines,
  keeping a `(… N earlier steps omitted)` line. Append the digest to the task notes too (a retry sees it).
- Event `compacted` `{before: est, after: est2, dropped: n}`.
- **Invariant (tested):** no request the LLM receives has an estimate above the budget.

## 2. Compact child results
- `finish{summary}` stores `summary` (trimmed to 2000 chars) in `Task.result` (new nullable column; `store.setResult(taskId, text)`).
- `wait_subtasks` returns per child ONLY: `<title> [<status>] <result or reason>`, truncated to **600 chars per child**, plus one line
  `(details: alfred_goal / task notes)`. It never includes the child's notes or transcript.

## 3. Paged reads
- `read_file{path, offset?, limit?}`: default `limit` 400 lines. Output header `[<path> lines a-b of N]`. Output capped at 16000 chars.
  If truncated, the header says `(more: offset=<b>)`.
- `run_shell` keeps its 8000-char tail.

## 4. Delegation nudge
- For personas whose `canSpawn` is non-empty: the first time `est` passes **50 %** of the budget, add a user message
  `Context at <p>% of budget. Delegate remaining reading/implementation to a subagent (spawn_subagent) and keep only summaries here.` (once per run).
- Ship persona changes: `alfred` prompt says it must delegate all file reading beyond a quick look and all implementation. `coder` gets
  `canSpawn: [researcher]` + `spawn_subagent`, `wait_subtasks` and one line: "delegate broad exploration (many files) to researcher and use its summary".
  All personas still fit their prompt budgets.

## 5. Accounting
- `store.taskUsage(taskId)` → `{promptTokens, completionTokens, peakPromptTokens, turns, compactions}` from the task's `turn` / `compacted` events.
- `store.goalUsage(goalId)` → the same summed over every task of the goal, plus `byPersona: Record<string, {promptTokens, completionTokens}>`.
- (P4b / P5 expose these: `GET /api/goals/:id` includes `usage`; the dashboard shows totals + per-task peak.)

## Done when
`npx vitest run test/acceptance/p8` + all earlier suites + typecheck are green on `p8-context`.
