# Coding executor recon: DSH headless, orchestrator pipeline, LangGraph

Scope: exact invocation contracts for the three coding executors named in
`PLAN.md` P2 (DSH headless adapter, orchestrator-pipeline adapter, LangGraph
coder sidecar), so acceptance tests can be written against real behavior
instead of assumptions. All findings below are either read from source/docs
or verified with one tiny live call each against the local Qwen3.8-Flash-Next
server at `http://127.0.0.1:1110` (OpenAI-compatible, `QWEN_NP=1`, one
parallel slot). No service was restarted. Full pipeline runs were **not**
executed (per instructions); the orchestrator-pipeline section is
code/docs-only.

---

## A. DSH (DeepSeek Harness) headless mode

### Exact command

```bash
dsh --profile headless "<task text>"
```

- Binary: `/home/quinna/.local/bin/dsh`, a launcher script that sets
  `DSH_HOME=/home/quinna/.dsh`, `QWEN_FLASH_API_KEY=local-no-auth`, checks
  `curl -sf http://127.0.0.1:1110/health` (warns, does not abort, if down),
  and execs `node /home/quinna/repos/deepseek-harness/apps/cli/lib/bin.js "$@"`.
- **cwd = the agent's workspace.** DSH does not take a `--cwd`/`--repo` flag;
  the adapter must `cd` (or spawn with `cwd:`) into the target workspace
  before invoking `dsh`. Internally the headless runner does
  `agentOptions: { ...}, meta: { cwd: process.cwd() }` — confirmed in
  `packages/bundle/headless/src/index.ts`.
- Multi-word tasks: everything after `--profile headless` is joined with
  spaces into one task string (commander `argument('[task...]')`). No
  `--task-file` equivalent — pass the whole prompt on argv (fine for
  alfred-sized task specs; very large task text should go through env/stdin
  if it risks argv limits — UNVERIFIED whether DSH accepts that).
- **Model/endpoint**: not a per-invocation flag. Configured once in
  `~/.dsh/settings.yaml` under `agent-default-model: {provider: qwen-flash,
  model: qwen3.8-flash-next}` plus an `llm-pi-ai.providers.qwen-flash` block
  pointing `baseURL: http://127.0.0.1:1110/v1`. Headless always uses
  `agentDefaultModel.currentSelection()` — there is no `dsh --profile headless
  --model ...` override at the CLI. To point at a different model/endpoint,
  edit `~/.dsh/settings.yaml` (hot-reloaded, per its own comment) or pass a
  `--patch` overlay.
- **Turn/time limits**: **none, at the DSH layer.** `dsh-agent-loop` has no
  max-turns/max-time config; headless drives the agent "to quiescence" with
  no external cap. The only timeouts that exist are per-tool
  (`dsh-bash-sandbox.timeoutMs = 60000` default; `dsh-tool-web` search/fetch
  60s/30s) via `dsh-tool-call-timeout-policy`, which only *cancels a hung
  tool call* and returns an error to the model — it does not end the run.
  **Alfred's own watchdog (wall-clock, no-progress, turn count via event
  count) is the only thing that will stop a runaway DSH headless task.**
- **Session resume**: **not exposed for headless.** Each invocation creates a
  brand-new session (`SessionId('session-' + randomUUID())`) and there is no
  `--resume` option on the headless command (`dsh --profile headless --resume
  x "task"` → `error: unknown option '--resume'`, verified live). `--resume`
  exists only for the `tui`/interactive profile. Consequence: multi-turn
  continuation on the same DSH session is not possible through the headless
  CLI as shipped; a "continue this task" adapter would have to build its own
  follow-up prompt (e.g. quoting the prior task + result) as a new headless
  invocation, or use the DSH SDK/ACP profile directly instead of headless.

### Tool permissions (can it edit files / run shell without prompting?)

Yes, within the workspace, by default — **no interactive prompt exists in
headless anyway; there's no UI to answer one.** Confirmed by reading
`dsh-base`'s composition and `dsh-user-approval`'s README:

- Default sandbox mode is `workspace-write` (`DSH_PERMISSION_MODE` env,
  defaults to `workspace-write`; `danger-full-access` and `read-only` are the
  other presets). `workspace-write` lets `tool-fs`/`tool-bash` read and write
  freely **inside the session's cwd** without any approval step — the sandbox
  enforces the boundary directly, not through the approval gate.
- The approval gate (`dsh-user-approval`, policy `ask` by default under
  `workspace-write`) only fires for *escalations beyond the sandbox* (e.g. a
  tool asking to touch paths outside the workspace, or to switch sandbox
  mode). Per its README: "Missing, non-owning, or throwing answerers fail
  closed to `unavailable`" — headless mounts no UI answerer, so any such
  escalation attempt is **rejected outright (`unavailable`), not hung**.
  There is no risk of headless blocking forever on an approval prompt.
- To allow the agent to escalate outside the workspace anyway, set
  `DSH_PERMISSION_MODE=danger-full-access` (bundles `sandbox:
  danger-full-access` + `approval: never`, i.e. deterministic auto-allow with
  no gate at all) before invoking `dsh`. Not needed for ordinary in-workspace
  coding tasks.

### Output format

**Plain text, not JSON/stream-json.**

- `stdout`: exactly one line — the final assistant message text — then the
  process exits. No structured envelope.
- `stderr`: reasoning deltas streamed live under a `dsh: reasoning:\n` header
  per section (blank when the model does no visible reasoning for a turn);
  on failure, a line `dsh: <code>: <message>`. No per-tool-call output is
  printed (a documented limitation) — to see tool calls you need the session
  log (`~/.dsh/sessions/`, JSONL) or `dsh-session-query`, not headless's own
  streams.
- **Exit codes**: `0` iff the run's last `turn/end` event had
  `reason.kind === 'completed'`. Any other outcome (aborted, error, or no
  turn at all in the owned interval) → exit `1`. A driver-level failure
  (e.g. Agent creation error) also → exit `1`, message via `dsh: <message>`
  on stderr. There is no exit code 2/3 distinction for different failure
  classes — an adapter that needs to distinguish "task failed" vs "DSH
  crashed" must parse stderr text, not the exit code alone.

### Live smoke test (verified)

```bash
cd <scratch-git-repo>
/home/quinna/.local/bin/dsh --profile headless \
  "Create a file named hello.txt in the current directory containing exactly the text: hi"
```

- **Exit code**: `0`
- **Wall time**: 59 s
- **stdout**: `Created \`hello.txt\` in the workspace containing exactly \`hi\` — verified it's 2 bytes with no trailing newline.`
- **stderr**: three `dsh: reasoning:` sections (short, a few lines each)
- **File result**: `hello.txt` created in cwd, mode `0600`, content `hi` (2 bytes, no trailing newline) — task followed literally, including "exactly" constraint
- No approval prompt, no hang, no manual intervention needed for an
  in-workspace file write under the default `workspace-write` sandbox.

### Recommended adapter interface

```ts
interface DshHeadlessResult {
  ok: boolean;              // exitCode === 0
  exitCode: number;
  stdout: string;           // final assistant text, single line
  stderr: string;           // reasoning + any "dsh: <code>: <msg>" error line
  wallMs: number;
  timedOut: boolean;        // adapter-imposed, not DSH's
}

function runDshHeadless(opts: {
  cwd: string;              // required: the workspace DSH will edit
  task: string;
  wallClockTimeoutMs: number;   // enforced by the adapter (spawn + kill), not DSH
  permissionMode?: 'workspace-write' | 'danger-full-access' | 'read-only'; // env DSH_PERMISSION_MODE
}): Promise<DshHeadlessResult>;
```

Gotchas to encode in acceptance tests:
- Fixture task must assert on **files on disk / git diff**, not stdout parsing — stdout is prose, not structured.
- A test repo must be a real git repo (or at least a real dir) since DSH's cwd model assumes a real workspace; there's no chroot beyond `workspaceRoot`.
- A hung/runaway task will never self-terminate; the acceptance test for the watchdog phase (P1) must supply the external timeout DSH doesn't have.
- No resume: "continue the same DSH session" is not a supported operation; don't design the adapter contract around a `sessionId` resume parameter for headless.

---

## B. `~/tools/orchestrator` `pipeline` package

### Is the routing proxy (`:8080`) running?

**No.** `curl http://127.0.0.1:8080/health` → connection refused (curl exit
7). The orchestrator HTTP proxy is not up right now. `pipeline` does not
require it, though — see below.

### CLI subcommands (from `pipeline/cli.py`, `--help` + source reading only)

| Subcommand | Purpose | Exit code |
|---|---|---|
| `run --repo PATH (--task "..." \| --task-file FILE)` | plan → fan out N workers in isolated `git clone --local` clones → deterministic merge | `0` if no chunk outcome != `COMPLETED`, else `1` |
| `solo --repo PATH --task "..."` | one agent, edits the repo dir directly, no clone/fan-out | `0` if `result.ok` else `1` |
| `explore --repo PATH --question "..."` | read-only fan-out research, no writes | non-zero only on hard errors (SystemExit paths) |
| `review --repo PATH [--rev REV \| --staged] [--format text\|json]` | read-only diff review; static checks + optional model pass; **no write tools given to the agent at all** (not just discouraged) | `2` for a couple of early/setup conditions, `1` if `has_errors`, else `0` |
| `resume --repo PATH RUN_ID [--replan]` | reloads `state.json`, re-runs only non-`COMPLETED` chunks, proceeds to merge | same as `run` |
| `runs --repo PATH` | text list of past runs (chunk counts, merge status, token totals) | `0` |
| `chat --repo PATH` | interactive; a model drives `run`/`resume`/`runs` for you via shell | n/a (interactive) |

`run` is the default/legacy positional (pre-subcommand invocations still work).

### Required inputs / "Writing a good task file" (from `~/vaults/orchestrator-pipelines/Reference/Writing a good task file.md`)

A good task file for `run`:
- **Seeds the shared contract first** (shared dataclasses/interfaces, committed before the run) — agents in the same wave can't see each other's work.
- **Splits by feature (vertical slice: impl + its own tests), never by activity** ("write all the tests" is explicitly the wrong shape — the planner now forbids this pattern by name after real failures).
- **Names file ownership explicitly** — no two chunks may touch the same file.
- **Declares dependencies** so later-wave chunks aren't written against modules that don't exist yet.
- **States which directory the agent is already in** and that it must never `cd` elsewhere (a real observed failure mode: naming a venv path in the task made an agent `cd` to the wrong repo and lose most of its turn budget).
- **Gives exact commands including the interpreter** (`python3`, never `python` — `python` doesn't exist on this box; a real run burned ~40/60 turns on this).
- Recommended structure: one intro paragraph, numbered chunks each with exact file paths + function signatures + edge cases, then a "Requirements for every piece" section with the exact verify command.

### How it picks models/endpoints — can it point straight at :1110?

**Yes, deliberately supported.** `pipeline` is "a pure HTTP client of the
orchestrator" with no import of the `orchestrator` package — every subcommand
takes `--orchestrator-url` (default `http://127.0.0.1:8080/v1`) and
`--admin-url` (default `http://127.0.0.1:8080`), and there is a `--no-load`
flag on `run`/`solo`/`explore`/`resume`/`review` whose help text says
verbatim: *"Required when pointing --orchestrator-url straight at a
llama-server rather than at the routing proxy."*

Verified by reading `pipeline/client.py`: `/admin/load`, `/admin/unload`,
`/admin/status` are called **only** from `ensure_model_resident()`, and that
function is skipped entirely whenever `--no-load` is passed (all call sites
in `cli.py`/`chat.py`/`explore.py`/`solo.py` gate it on `ensure_resident`).
So pointing directly at llama.cpp on `:1110` never touches a nonexistent
`/admin/*` endpoint — only ordinary `/v1/chat/completions` calls go out.

To run against Qwen directly:
```bash
pipeline run --repo <target-repo> --task "..." \
  --orchestrator-url http://127.0.0.1:1110/v1 \
  --admin-url http://127.0.0.1:1110 \
  --no-load \
  --config <a pipeline-*.yaml with every role pointed at qwen3.8-flash-next>
```
A `pipeline-*.yaml` needs every role (`planner`, `worker`, `supervisor`,
`merger`, `explorer`) set to the model id the llama.cpp server actually
serves — `qwen3.8-flash-next` — the same single-model pattern already used by
the shipped `pipeline-ds4.yaml` (every role on `ds4`) for boxes where a
role-split fleet can't be resident together. **Because `QWEN_NP=1` (one
parallel slot), `pipeline.limits.max_concurrent_workers` should be set to
`1`** — the README already documents that with one backend serving every
role, "parallel workers queue against each other rather than running truly
concurrently"; setting it above 1 against a 1-slot server just queues
requests at the pipeline layer instead of the server layer, and lets more
chunks appear "started" than are actually being worked, muddying watchdog
signals.

### Run output/state locations, machine-readable status

- `.pipeline-runs/<run_id>/events.jsonl` — append-only event log, one JSON
  object per line, kinds: `run_start`, `plan`, `plan_rejected`,
  `chunk_started`/`chunk_finished`, `turn_budget_warning`, `chunk_skipped`,
  `merge_conflict`, `tool_call`, `usage`, `run_end`, `explore_*`, `solo_*`.
  This is what `resume` and `runs` read back, and per the vault docs is "the
  only way to know what actually happened" — a run can exit `0` with
  plausible output and be entirely wrong (documented real case: an `explore`
  run completed successfully with 31/31 tool calls failing because
  arguments arrived as an unparsed JSON string).
- `.pipeline-runs/<run_id>/state.json` — written after **every** state
  transition (not just at the end), round-trips the plan, each chunk's
  `AgentStatus` (`pending|running|completed|killed|timed_out|failed|
  verify_failed|skipped`), attempts, kill reason, verify result, workspace
  path, base commit. **This is the machine-readable status file** an
  orchestrator/alfred wrapper should poll/parse — it's authoritative even if
  the process died mid-run.
- Both live under the *target* repo (`--repo`), not `~/tools/orchestrator`.
- `RunReport.failed` (used for the process exit code) is simply "any outcome
  whose status != `COMPLETED`" — that includes `SKIPPED` (dependency failed)
  and `UNMERGED`-after-escalation-failure, not just hard crashes, so exit
  code `1` alone conflates several different failure shapes; read
  `state.json`'s per-chunk `status` to distinguish them.

### Known unfixed gap: integration-branch vs final-merge divergence

Confirmed **still open** by reading `pipeline/SCOPE_LESSONS.md` directly
("What this doesn't fix", items 1 and 2):

1. **Merge escalation has unscoped shell access** (Finding 3): the model
   resolving a real merge conflict gets full `run_shell` in the real repo
   with no diff-scope check afterward — in one observed run it left
   uncommitted, self-invented code for two unrelated, still-incomplete
   chunks sitting in the real repo's working tree (nothing was committed,
   but the working tree was polluted). **Not fixed.**
2. **The integration-branch/final-merge divergence itself** (Finding 2):
   `executor.py`'s `_integrate_chunk` (a plain, non-escalated `git merge`
   into a scratch `.pipeline-runs/<run>/integration/` clone that later-wave
   chunks branch from) and `merger.py`'s final pass into the *real* repo
   (`git cherry-pick` + escalation) are two independent merge code paths
   that **can disagree** about what a completed dependency's file contents
   actually are. Concretely observed: a later-wave chunk was built and
   verified against the integration branch's pre-escalation version of a
   dependency; the real final merge went on to replace that same file with
   a different, escalation-resolved version never reachable from the
   integration branch's history — the later chunk's own workspace tests
   then failed against what `main` would actually contain. **Not fixed.**
   The vault doc proposes two possible real fixes, neither implemented: make
   the integration side escalate its own conflicts the same way the final
   merge does, or rebuild the integration repo from the real repo's current
   HEAD before each new wave instead of replaying this run's own commits.

This is exactly what PLAN.md P2 calls out as "(+ fix integration-merge gap)"
— it is real, reproducible, and unaddressed in the current pipeline code as
of this recon (2026-09-24).

### Recommended adapter interface

```ts
interface PipelineRunResult {
  runId: string;
  exitCode: number;              // 0 | 1 (run/resume/solo), or 2 for review setup errors
  statePath: string;             // .pipeline-runs/<run_id>/state.json — parse this, not stdout
  eventsPath: string;            // .pipeline-runs/<run_id>/events.jsonl
  chunkStatuses: Record<string, 'pending'|'running'|'completed'|'killed'|
                                 'timed_out'|'failed'|'verify_failed'|'skipped'>;
  mergeCommit: string | null;
  mergeSummary: string;
}

function runOrchestratorPipeline(opts: {
  repo: string;
  taskFile: string;              // write the task as a file per "Writing a good task file"
  pipelineConfig: string;        // a pipeline-*.yaml with roles pinned to qwen3.8-flash-next
  orchestratorUrl?: string;      // default http://127.0.0.1:1110/v1 for alfred (no :8080 proxy needed)
  adminUrl?: string;
  noLoad?: boolean;              // must be true when orchestratorUrl points at :1110 directly
  maxConcurrentWorkers?: number; // must be 1 given QWEN_NP=1
}): Promise<PipelineRunResult>;
```

Gotchas to encode in acceptance tests:
- `done` must be gated on `state.json`'s per-chunk status, never on process exit code alone (exit `0` has a documented real-world false-positive: all tool calls failing while the run still "completes").
- A fixture task with a failing test must produce `verify_failed` or `unmerged`, not `completed` — exercise the verify/repair loop (`max_repair_attempts`), not just the happy path.
- Do not trust a later-wave chunk's own passing tests as proof the eventual `main` will pass — the integration/final-merge gap means they can be built against a dependency version that the final merge silently replaces. The P2 acceptance test for the "fix integration-merge gap" work should specifically construct a two-wave fixture where wave 1's chunk conflicts on the real-repo merge, forcing escalation to change its content, and assert wave 2's chunk (already built against the *pre*-escalation integration copy) is re-verified against the *post*-escalation real content before the run is allowed to report `done`.

---

## C. LangGraph feasibility

### Environment

- System Python: `3.14.6` (Homebrew, aarch64) — too new / not what we want for this sidecar.
- `uv 0.11.28` (aarch64-unknown-linux-gnu) is available and already knows about local interpreters, including `cpython-3.12.3` at `/usr/bin/python3.12` and `cpython-3.13.14` under uv's own managed store — no download needed for either.

### `uv venv --python 3.12` + install

```bash
uv venv --python 3.12 .venv        # -> Using CPython 3.12.3 interpreter at /usr/bin/python3.12
uv pip install --python .venv/bin/python langgraph langchain-openai
```

**Worked cleanly, no build-from-source, no aarch64-specific failures.**
Resolved 43 packages in <1s, installed in ~1s (all wheels, no compilation).
Versions actually installed:

| Package | Version |
|---|---|
| `langgraph` | 1.2.12 |
| `langgraph-checkpoint` | 4.2.0 |
| `langgraph-prebuilt` | 1.1.0 |
| `langgraph-sdk` | 0.4.5 |
| `langchain-core` | 1.6.5 |
| `langchain-openai` | 1.6.6 |
| `openai` (SDK dependency) | 3.19.2 |
| `pydantic` | 2.13.5 |

No gotchas installing on this box — this path is safe to standardize on for
the P2 LangGraph sidecar (pin these versions or newer in the sidecar's own
`pyproject.toml`/`uv.lock`).

### Minimal `ChatOpenAI` + `bind_tools` live test (verified)

```python
llm = ChatOpenAI(base_url="http://127.0.0.1:1110/v1", api_key="local-no-auth",
                  model="qwen3.8-flash-next", temperature=0)
llm_with_tools = llm.bind_tools([get_weather])
resp = llm_with_tools.invoke("What is the weather in Boston? Use the tool to find out.")
```

Result: **works correctly.**
- `resp.tool_calls` = `[{"name": "get_weather", "args": {"city": "Boston"}, "id": "...", "type": "tool_call"}]`
- `resp.content` = `""` (empty — model put everything into the tool call, nothing in plain text)
- `resp.response_metadata.finish_reason` = `"tool_calls"`
- `response_metadata.token_usage.completion_tokens` = 91 for a trivial one-arg call

### Gotchas found

1. **Reasoning/thinking tokens are real but not surfaced by `langchain-openai`.**
   A raw `curl` to `/v1/chat/completions` (bypassing LangChain, separate
   verification) shows llama.cpp returns a **non-standard
   `message.reasoning_content` field** alongside `content` — e.g. asking the
   model to "Say OK" with `max_tokens: 20` returned `content: ""` and
   `reasoning_content: "We need to respond to user: \"Say OK.\" Simple.
   Final just OK.\n"`, `finish_reason: "length"` — the reasoning ate the
   entire token budget before any visible answer. In the LangChain
   `bind_tools` test above, 91 completion tokens were spent but
   `additional_kwargs` contained only `{"refusal": null}` — **no
   `reasoning_content` anywhere in the LangChain `AIMessage`.**
   `langchain-openai` 1.6.6 does not appear to parse/expose this
   llama.cpp-specific field, so reasoning tokens are consumed (cost +
   latency) but invisible if you only look at the LangChain response object.
   **Practical consequence for the sidecar: always give generous
   `max_tokens` headroom** (a tool call or short answer can silently lose to
   reasoning burning the whole budget, producing an empty `content` with
   `finish_reason: "length"` and no tool call at all) and, if reasoning needs
   to be inspected/logged for debugging, go around `langchain-openai` with a
   raw HTTP call or check whether a newer `langchain-openai` version parses
   `reasoning_content` into `additional_kwargs` before relying on it.
2. **Tool-call format matches the standard OpenAI shape** (`resp.tool_calls`
   list, LangGraph-native) — no custom parsing needed, `bind_tools` +
   `create_react_agent`/`ToolNode` should work as documented for a
   constrained `coder-lg` persona.
3. Only one live model call is safe at a time (`QWEN_NP=1`) — a LangGraph
   graph with parallel tool-calling branches or a supervisor+worker fan-out
   will **serialize** against this single endpoint exactly like DSH/pipeline
   do; do not assume LangGraph's async graph execution buys real concurrency
   against this backend.

### Recommended adapter interface

```python
# sidecar/coder_lg/graph.py
def build_coder_graph(base_url: str = "http://127.0.0.1:1110/v1",
                       model: str = "qwen3.8-flash-next",
                       max_tokens: int = 4096) -> CompiledGraph: ...

# invoked by the TS core over a small JSON-over-stdio or local HTTP contract, e.g.:
class CoderLgRequest(TypedDict):
    cwd: str
    task: str
    max_turns: int
    timeout_s: float

class CoderLgResult(TypedDict):
    status: Literal["done", "failed", "timed_out"]
    diff_summary: str
    tool_call_log: list[dict]   # explicit, since langchain-openai won't give you reasoning for free
```

Gotchas to encode in acceptance tests:
- Assert `max_tokens` is high enough that a fixture tool-call task doesn't hit `finish_reason: "length"` with an empty `content` and no tool call — this is a real failure mode observed directly on this endpoint, not hypothetical.
- Treat the LangGraph sidecar's own turn/token budget as the only enforcement (same as DSH) — nothing at the Qwen server layer stops a runaway loop.
- Because it's a Python sidecar next to a TypeScript core, the acceptance test for P2 should launch it exactly the way production will (subprocess with the pinned `uv`-built venv), not via an interactive Python shell, to catch venv/path issues early.

---

## Cross-cutting summary for the P2 spec

| | DSH headless | orchestrator pipeline | LangGraph sidecar |
|---|---|---|---|
| Endpoint | `~/.dsh/settings.yaml` → `:1110` (already configured) | `--orchestrator-url :1110/v1 --no-load` (proxy on `:8080` confirmed **not running**) | `ChatOpenAI(base_url=".../1110/v1")` directly |
| Turn/time cap | **none built in** — adapter must watchdog | `pipeline.limits.max_agent_turns` (config), plus adapter wall-clock | LangGraph graph's own recursion limit + adapter wall-clock |
| Tool approval | auto-allowed in-workspace (`workspace-write`), escalations fail closed (`unavailable`), never hangs | no sandboxing at all — full shell in an isolated `git clone --local`; **merge escalation has unscoped shell access in the real repo (unfixed)** | whatever tools the graph binds — sidecar owns its own sandboxing (not yet built) |
| Output | plain text stdout + reasoning on stderr; exit 0/1 | `state.json` (authoritative, machine-readable) + `events.jsonl`; exit 0/1/2 conflates failure kinds | LangChain `AIMessage`/graph state; reasoning tokens invisible by default |
| Session resume | **not supported** for headless | `pipeline resume RUN_ID` (real, reuses `state.json`) | up to the sidecar's own checkpointer (`langgraph-checkpoint` is installed; not tested) |
| Known unfixed gap | none found | **integration-branch vs final-merge divergence (SCOPE_LESSONS.md Finding 2) confirmed still open**, plus unscoped merge-escalation shell access (Finding 3) | N/A — not yet built |

Everything above marked without "UNVERIFIED" was confirmed either by reading
source/docs directly or by a live call. The one explicit UNVERIFIED item:
whether DSH headless accepts task text via stdin/env instead of argv for
very long task specs.
