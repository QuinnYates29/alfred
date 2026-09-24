# P2 — Coding executors

Status: **SPEC** · Branch: `p2-executors` · Acceptance: `npm run test:p2` (do not edit `test/acceptance/p2/`)
Depends on: P0, P1. Recon: `docs/recon/executors.md` (read it; the facts in it are verified).

Three executors, each exposed to personas as a **tool** (kind `exec`). They run long, so each one must call
`ctx.progress(msg)` at least every 60 s while it has signs of life. Each one must honour `ctx.signal`, which kills the
process group. None of them decides whether the task is done: the runtime's gate re-runs the task's acceptance checks
against the workspace afterwards. This also covers the orchestrator's integration/merge gap from Alfred's side.

## 0. Store + workspace additions

- `Goal.meta: Record<string, any>` (default `{}`), set via `createGoal({..., meta})` and merged via `store.setGoalMeta(goalId, patch)`. Add the column with a migration-safe `ALTER TABLE` if needed. `meta.repo` = the absolute path of a git repo the goal works on.
- `src/workspace.ts`:
  ```ts
  export function workspaceFor(store: Store, task: Task, o?: { root?: string /* default ~/.alfred/work */ }): string
  ```
  - Resolve the task's **root ancestor** (follow parentTaskId). Children share their root's workspace.
  - Goal without `meta.repo` → `<root>/<goal.slug>/` (mkdir -p).
  - Goal with `meta.repo` → a git worktree at `<root>/<goal.slug>/<rootId first 8 chars>` on a new branch `alfred/<goal.slug>/<rootId first 8>` from the repo's current HEAD. Idempotent (second call returns the same path, no error). Never touches the repo's own working tree or current branch.

## 1. `src/executors/dsh.ts` → tool `dsh_code`
```ts
export function dshTool(o?: { bin?: string /* env ALFRED_DSH_BIN || 'dsh' */; defaultTimeoutMin?: number /* 30 */ }): Tool
```
Args `{task: string, timeoutMin?: number (max 120)}`. Runs `<bin> --profile headless <prompt>` with `cwd = ctx.workspace`, detached (own process group).
The prompt is the task text plus a line listing the acceptance commands (`ctx.acceptance`) so DSH can run them itself.
- Progress: every 20 s, if stderr grew or `git status --porcelain` changed, call `ctx.progress('dsh: …')`.
- Timeout or `ctx.signal` abort → SIGKILL the group, `ok:false`, output says `timed out` / `cancelled`.
- Output (≤ 8000 chars): `exit=<code>`, the stdout (final answer), the last 1500 chars of stderr, then `git status --short` and `git diff --stat` of the workspace (skip gracefully if not a git repo). `ok` = exit 0.

## 2. `src/executors/pipeline.ts` → tool `pipeline_run`
```ts
export function pipelineTool(o?: { bin?: string /* env ALFRED_PIPELINE_BIN || ~/tools/orchestrator/.venv/bin/pipeline */;
  baseConfig?: string /* repo config/pipeline-qwen.yaml */; baseUrl?: string /* http://127.0.0.1:1110 */ }): Tool
```
Args `{task: string, mode?: 'run' | 'solo' (default 'run'), timeoutMin?: number (default 90, max 240)}`.
- Writes the task to `<ws>/.alfred/pipeline-task-<ts>.md` and a per-call config `<ws>/.alfred/pipeline-<ts>.yaml` = baseConfig with
  `pipeline.verify.command` set to the acceptance commands joined by ` && ` (left unchanged if there are none).
- Runs `<bin> <mode> --repo <ws> --task-file <file> --config <cfg> --orchestrator-url <baseUrl>/v1 --admin-url <baseUrl> --no-load`, cwd = ws.
- Progress: every 15 s, if `<ws>/.pipeline-runs/*/events.jsonl` grew → `ctx.progress('pipeline: <last event kind>')`.
- After exit, for `run`: parse the newest `<ws>/.pipeline-runs/*/state.json`. `ok` = exit 0 **and** every `outcomes[].status === 'completed'`
  **and** (state has no `post_merge_verify`, or its `ok` is true). A missing state.json → `ok:false`, 'no state.json'.
  For `solo`: `ok` = exit 0.
- Output: `exit=<code>`, one line per chunk `<chunk.id>: <status> <kill_reason>`, then the last 1500 chars of stdout.
- Ship `config/pipeline-qwen.yaml`: every role `qwen3.8-flash-next`, `limits.max_concurrent_workers: 3`, `max_agent_turns: 60`, `verify` with `timeout_s: 900`, `max_repair_attempts: 2`, and no command (it's filled in per call).

## 3. LangGraph constrained coder → tool `langgraph_code`
Python sidecar in `sidecar/langgraph_coder/` (package, `python -m langgraph_coder`), venv at `sidecar/.venv` (gitignored) created by
`sidecar/setup.sh`: `uv venv --python 3.12 sidecar/.venv && uv pip install --python sidecar/.venv/bin/python langgraph langchain-openai`.

**Protocol:** stdin = one JSON object `{task, workspace, testCmd, maxIterations, baseUrl, model, maxStepsPerIteration?}`.
stderr = JSON lines `{"progress": "<msg>"}` (other stderr lines are allowed and ignored).
stdout **last line** = `{"ok": bool, "iterations": int, "testOutput": str (≤ 3000 chars), "filesChanged": [str]}`.

**Graph (the constraint is the point):** `agent` ⇄ `tools` loop with ONLY `read_file`, `write_file`, `list_dir` (workspace-scoped, and an escape
attempt returns an error string). No shell. When the agent replies without tool calls, or hits `maxStepsPerIteration` (default 20) → `test` node runs `testCmd`
(bash, cwd workspace, timeout 600 s). Pass → END ok. Fail and iterations < maxIterations → back to `agent` with the test output tail. Otherwise → END not ok.
Use `ChatOpenAI(base_url=baseUrl + '/v1', model=model, api_key='local', max_tokens=4096)`. Per the recon, reasoning can eat max_tokens, so keep it ≥ 4096.

TS side, `src/executors/langgraph.ts`:
```ts
export function langgraphTool(o?: { python?: string /* <repo>/sidecar/.venv/bin/python */; baseUrl?: string; model?: string; defaultTimeoutMin?: number /* 45 */ }): Tool
```
Args `{task: string, maxIterations?: number (default 6)}`. testCmd = `ctx.acceptance` cmds joined with ` && `. If there are none → `ok:false` 'no acceptance checks to test against'.
Relays `progress` lines to `ctx.progress`. Result: `ok` from the final JSON. Output includes iterations, filesChanged and testOutput.
Runs with `PYTHONPATH=<repo>/sidecar`.

## 4. Wiring
- `src/runtime/alltools.ts`: `export function allTools(o?): Tool[]` = builtins + dsh_code + pipeline_run + langgraph_code.
- Personas: `coder.tools` += `dsh_code`, `pipeline_run`. `coder-lg.tools` = `read_file, list_dir, note, langgraph_code, finish, give_up, ask_claude`.
  Update their system prompts: coder should prefer `dsh_code` for focused changes and `pipeline_run` for multi-part features that split cleanly. coder-lg must use `langgraph_code`.
  **All personas must still fit their budgets with `allTools()` registered.**

## Done when
`npm run test:p2` + the full suite + typecheck are green on `p2-executors`. Then the orchestrator runs the live smoke tests (`ALFRED_LIVE=1`).
