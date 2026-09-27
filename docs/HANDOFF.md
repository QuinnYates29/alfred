# HANDOFF: state of the alfred build (keep this current)

## 2026-09-27 — Control-surface build (Quinn: "everything controllable from the Mac")
Goal set by Quinn: build all of it now; he sets up Slack + the Mac node afterward. Native Mac app + quick CLI backup + a website on the tailnet
(custom domain later) + a Jira/Notion-like board that agents can read/write and be sent items from. Qwen Flash on the Spark does the coding.

Plan (specs in docs/phases/, acceptance tests in test/acceptance/pNN/, dispatch prompts in docs/dispatch/):
| Phase | What | State |
|---|---|---|
| scaffold | src/modules.ts seam (modules add routers/tools without touching main/app), store.raw(), system events (goalId ''), /events/last, P12c fan-out fix, transcripts in turn/tool events, RepoHub wired into the scheduler (was never on), /nodes fixed, POST /goals node/mode | ✅ master (orchestrator) |
| P17a | web v2 shell + design system (web/src/styles, ui/, lib/, App.jsx, NewGoal/NewItem dialogs, palette); legacy P5 views under web/src/legacy until replaced | ✅ master (orchestrator) |
| P13 board · P14 ops/stats · P15 review/land | wave A (Qwen) | running |
| P16 chat · P20 slack · P17b board UI | wave B (after P13) | queued |
| P19 CLI v2 · P17c goals UI · P17d home/inbox/chat UI | wave C | queued |
| P17e system UI · P18 macOS app (Electron, app/) | wave D | queued |
Check commands: every phase runs its own suite + all ≤P12 suites + typecheck (see docs/dispatch/PNN.md). p17/p18 need `xvfb-run -a` for p18 only.
Harness note: worktrees symlink `web/dist` (excluded via .git/info/exclude) — a master `npm run build:web` changes what the P5 test sees in every worktree.
Quinn-only (sudo): `sudo tailscale serve --bg --https=8443 http://127.0.0.1:8790` (the website on the tailnet; `tailscale set --operator=quinna` once avoids sudo later).


Last updated: 2026-09-24 22:55 by the orchestrator (Claude Code session). Read with GOAL.md, PLAN.md, docs/LESSONS.md, docs/qwen/NOTES.md.

## ⚠️ LIVE AGENTS (check before launching anything)
As of 2026-09-24 22:47 the original session ALL build phases P0–P11 merged + P12 hardening (master 202 tests). P12b merged (206 tests); graceful restarts now requeue. Running: **soak S1b** on the installed service (goal soak-s1b-mdconv). S5 crash recovery verified.
`running` = leave it alone (verify + merge when `passed`); `failed`/`stopped` = relaunch per the table. Never launch a task whose status is `running`.

## What alfred is
One local agent platform on the Spark (`gx10-de9a`) that replaces Mission Deck, `~/tools/orchestrator` and ad-hoc Hermes/DSH. It has personas,
subagents, a mechanical done-gate, loud failures, automations, connections (MCP, Slack later), a Claude door (MCP), swappable models,
context economy, and workspaces on the Spark or the Mac (via `alfred-node`), git-connected through a hub on the Spark. The core is TypeScript
(Node 22, ESM, vitest). The LangGraph coder is a Python sidecar (`sidecar/`, venv via `sidecar/setup.sh`).

## How the build is run
- **Orchestrator = Claude.** It writes each phase's spec (`docs/phases/PN-*.md`) and **acceptance tests first** (`test/acceptance/pN/`), dispatches Qwen agents, verifies, and merges.
- **Implementers = Qwen3.8-Flash-Next via DSH headless**, one git worktree each (`~/repos/alfred-wt/<TASK>`), driven by `scripts/qwen-task.sh`:
  `setsid nohup scripts/qwen-task.sh NAME BRANCH $PWD/docs/dispatch/NAME.md "CHECK_CMD" [attempts=4] [timeout_min=60] >/dev/null 2>&1 </dev/null &`
  from the repo root. The script re-execs from a private temp copy, so editing it never breaks running jobs. It waits for qwen-server `/health` before each attempt,
  and a failure during a server outage doesn't count as an attempt. Worktree git needs the Python sidecar for LangGraph tests: `ln -sfn ~/repos/alfred/sidecar/.venv <wt>/sidecar/.venv`. It loops until CHECK passes, commits WIP between attempts, restores protected
  files (acceptance tests, fixtures, contract.ts, types.ts, testing.ts) from the fork point, and appends every attempt to `docs/qwen/attempts.jsonl`.
- Status: `.dispatch/<TASK>/status.json`, `run.log`, `check<N>.txt`, `attempt<N>.{out,err}`.
- **Run at most 3 Qwen agents at once** (see docs/qwen/NOTES.md). Use trailing slashes in vitest paths (`test/acceptance/p1/`, since `p1` matches `p10`).
- To verify a finished task: diff vs the fork point excluding protected files, run its suites on the branch, merge into `master`, remove the worktree and branch, delete `.dispatch/<TASK>`.
- Performance report: `python3 scripts/qwen-stats.py` → `docs/qwen/PERF.md`.

## Phase status (master = 102 tests green; `src/` typechecks clean)
| Phase | State |
|---|---|
| P0 core store, gate, notifier, mirror | ✅ merged |
| P1 tools, personas, openai client, agent loop, scheduler | ✅ merged |
| P2 workspaces, dsh/pipeline/langgraph executors, allTools wiring | ✅ merged. P2d (orchestrator post-merge verify) merged into `~/tools/orchestrator` main (443 tests) |
| P7 model registry (config/models.yaml, roles, per-call resolution) | ✅ merged |
| P3a1 MCP hub | ✅ merged 23:02 (was: relaunch: worktree `~/repos/alfred-wt/P3a` (branch p3a-mcp-sinks) has a 209-line `src/connectors/mcp.ts` draft. Prompt docs/dispatch/P3a1.md, check `npx vitest run test/acceptance/p3/mcp.test.ts`. Reuse that worktree (NAME=P3a, BRANCH=p3a-mcp-sinks, or rename). |
| P3a2 notification sinks | ✅ merged 22:58 (attempt 1, 11 min) |
| P4a automations | ✅ merged 23:28 (was: relaunch: worktree `~/repos/alfred-wt/P4a` (branch p4a-automations) has store additions only (78 lines). Prompt docs/dispatch/P4a.md |
| P3b approvals + Claude door (+ src/ops.ts); now also owns the guardCommand tests | ✅ merged 00:45 (attempt 2; ops/store conflicts with P4a resolved) |
| P11 extension API (plugins, config/alfred.yaml, /api/v1) | ✅ merged 01:40 (also built main.ts/app.ts; P4 server tests pass) |
| P8 context economy | ✅ merged 01:08 (attempt 2) |
| P4b server/main/CLI/deploy | ✅ merged 02:33 (attempt 1). `deploy/install.sh` not yet run |
| P9 nodes + remote access (Mac-first addendum) | ✅ merged 04:32 (attempt 3) |
| P10 git hub + workspace modes | ✅ merged 05:47 (attempt 1) |
| P12 runtime hardening (soak findings) | ✅ merged 06:40 |
| P12b shutdown requeues | ✅ merged 07:02 |
| P5 dashboard (**functional shell only**; control UX to be redesigned by Quinn) | ✅ merged 04:10 (attempt 2). Build: `npm run build:web` |
| Live smoke on real Qwen (docs/SOAK.md) | ✅ 04:15: coder goal done, alfred→coder delegation done, impossible goal failed loudly with a precise reason |
| Service | ✅ installed: `systemctl --user status alfred`, 127.0.0.1:8790, token in ~/.config/alfred.env, supervises Mission Deck on :8787 |
| P6 soak (real multi-hour goal + impossible goal, hold-out tests in test/soak/) | ⏳ run by the orchestrator at the end |

**Before relaunching P3a/P4a:** in each kept worktree run `git merge master` first (the P3 tests were split and the harness was hardened after they forked).

**Next wave (3 agents):** P3a1 (reuse the P3a worktree), P3a2, P4a (reuse the worktree). Then P3b, P11, P8 → P4b → P9, P10 → P5 → P6.
With the fast server (~35 tok/s aggregate), tasks now pass in ~30–35 min (P7: attempt 2, 34 min).

## Open items / decisions pending with Quinn
- **Qwen decode speed: FIXED** (see Server state). Investigation → docs/qwen/SPEED-INVESTIGATION.md. Finding: decode is sync-bound. `-ncmoe 26` forces ~26 GPU↔CPU round trips per token (attention on GPU, experts on CPU, layers sequential). Per-slot rate is flat at 2.4–2.5 tok/s whether 1 or 4 slots are active; GPU ~25% and CPU ~25% busy. Experiments queued for the next wave boundary: (1) pin 10 threads to the X925 cores, (2) np 3 + ncmoe 14, (3) np 2 + ncmoe 8, (4) -ot per_layer_token_embd=CPU + low ncmoe, (5) -v load placement capture, (6) rebuild with GGML_CPU_KLEIDIAI=ON. Also: the qwenctl presets `fast`/`balanced` are stale (would NVRM at np 6), and --cache-ram 8 GiB is thrashing.
  We see ~2.3 tok/s per agent with 3 agents and a GPU at ~24% util / 25 W → suspect tensor placement (`-ncmoe 26`, mmap), threads, build flags or fork kernels.
  **Experiments need a qwen-server restart → do them between waves** (a restart kills in-flight DSH agents; their WIP survives, costing an attempt).
- Control-side UX (dashboard/CLI/phone/Slack): Quinn will refine. Keep the core API-first (`/api/v1`, docs/API.md from P11).
- Quinn to do: `sudo systemctl disable --now deck-server`; Slack token/channel (later); the Obsidian MCP on the Mac (`100.82.152.2:3556`, currently timing out); install `alfred-node` on the Mac after P9.

## Server state (qwen-server.service, env ~/.config/qwen-server.env)
**Fast config since 2026-09-24 21:36:** `QWEN_NP=3 QWEN_CTX=262144 QWEN_NCMOE=8 QWEN_EXTRA="--reasoning-budget 1536 --tensor-read-lazy on -t 10 --cpu-mask 0xF83E0 --cpu-strict 1"`.
Measured 15.4 tok/s single, 11.8 each / 35.5 aggregate at 3 parallel (5x the old 2.35/slot). DSH defaultContextWindow = 262144.
The old config backup is ~/.config/qwen-server.env.bak.20260924-ncmoe26. qwenctl presets `fast`/`balanced` are stale. Check ~/.dsh/crashes.log for NVRM after any change.
