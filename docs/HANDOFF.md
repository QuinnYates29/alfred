# HANDOFF: state of the alfred build (keep this current)

Last updated: 2026-09-24 21:20 by the orchestrator (Claude Code session). Read with GOAL.md, PLAN.md, docs/LESSONS.md, docs/qwen/NOTES.md.

## What alfred is
One local agent platform on the Spark (`gx10-de9a`) that replaces Mission Deck, `~/tools/orchestrator` and ad-hoc Hermes/DSH. It has personas,
subagents, a mechanical done-gate, loud failures, automations, connections (MCP, Slack later), a Claude door (MCP), swappable models,
context economy, and workspaces on the Spark or the Mac (via `alfred-node`), git-connected through a hub on the Spark. The core is TypeScript
(Node 22, ESM, vitest). The LangGraph coder is a Python sidecar (`sidecar/`, venv via `sidecar/setup.sh`).

## How the build is run
- **Orchestrator = Claude.** It writes each phase's spec (`docs/phases/PN-*.md`) and **acceptance tests first** (`test/acceptance/pN/`), dispatches Qwen agents, verifies, and merges.
- **Implementers = Qwen3.8-Flash-Next via DSH headless**, one git worktree each (`~/repos/alfred-wt/<TASK>`), driven by `scripts/qwen-task.sh`:
  `scripts/qwen-task.sh NAME BRANCH docs/dispatch/NAME.md "CHECK_CMD" [attempts] [timeout_min]`. Always launch from a copy
  (`cp scripts/qwen-task.sh .dispatch/run.sh`) with `setsid nohup … &`. It loops until CHECK passes, commits WIP between attempts, restores protected
  files (acceptance tests, fixtures, contract.ts, types.ts, testing.ts) from the fork point, and appends every attempt to `docs/qwen/attempts.jsonl`.
- Status: `.dispatch/<TASK>/status.json`, `run.log`, `check<N>.txt`, `attempt<N>.{out,err}`.
- **Run at most 3 Qwen agents at once** (see docs/qwen/NOTES.md). Use trailing slashes in vitest paths (`test/acceptance/p1/`, since `p1` matches `p10`).
- To verify a finished task: diff vs the fork point excluding protected files, run its suites on the branch, merge into `master`, remove the worktree and branch, delete `.dispatch/<TASK>`.
- Performance report: `python3 scripts/qwen-stats.py` → `docs/qwen/PERF.md`.

## Phase status (master = 92 tests green, typecheck clean for implemented parts)
| Phase | State |
|---|---|
| P0 core store, gate, notifier, mirror | ✅ merged |
| P1 tools, personas, openai client, agent loop, scheduler | ✅ merged |
| P2 workspaces, dsh/pipeline/langgraph executors, allTools wiring | ✅ merged. P2d (orchestrator post-merge verify) merged into `~/tools/orchestrator` main (443 tests) |
| P3a MCP hub + sinks | 🔄 Qwen, attempt 2 (struggling: large surface). If it fails, split into P3a-1 MCP hub / P3a-2 sinks |
| P4a automations | 🔄 Qwen, attempt 1 |
| P7 model registry | 🔄 Qwen, attempt 1 |
| P3b approvals + Claude door (+ src/ops.ts) | ⏳ prompt ready: docs/dispatch/P3b.md |
| P11 extension API (plugins, config/alfred.yaml, /api/v1) | ⏳ prompt ready, must land before P4b |
| P8 context economy | ⏳ prompt ready |
| P4b server/main/CLI/deploy | ⏳ prompt ready (on top of P11) |
| P9 nodes + remote access (Mac-first addendum) | ⏳ prompt ready |
| P10 git hub + workspace modes | ⏳ prompt ready |
| P5 dashboard (**functional shell only**; control UX to be redesigned by Quinn) | ⏳ prompt ready |
| P6 soak (real multi-hour goal + impossible goal, hold-out tests in test/soak/) | ⏳ run by the orchestrator at the end |

Planned order: P3a/P4a/P7 (running) → P3b, P11, P8 → P4b → P9, P10 → P5 → P6.

## Open items / decisions pending with Quinn
- **Qwen decode speed investigation** (Sonnet subagent, read-only; report goes to `docs/qwen/SPEED-INVESTIGATION.md`). Quinn says the same UD-Q4_K_XL quant with 6 full-context slots should hit 10–30 tok/s.
  We see ~2.3 tok/s per agent with 3 agents and a GPU at ~24% util / 25 W → suspect tensor placement (`-ncmoe 26`, mmap), threads, build flags or fork kernels.
  **Experiments need a qwen-server restart → do them between waves** (a restart kills in-flight DSH agents; their WIP survives, costing an attempt).
- Control-side UX (dashboard/CLI/phone/Slack): Quinn will refine. Keep the core API-first (`/api/v1`, docs/API.md from P11).
- Quinn to do: `sudo systemctl disable --now deck-server`; Slack token/channel (later); the Obsidian MCP on the Mac (`100.82.152.2:3556`, currently timing out); install `alfred-node` on the Mac after P9.

## Server state (qwen-server.service, env ~/.config/qwen-server.env)
`QWEN_NP=6 QWEN_CTX=65536 (total 393216) QWEN_NCMOE=26 QWEN_EXTRA=--reasoning-budget 1536`. 6×98k caused NVRM OOM. Check `~/.dsh/crashes.log` for NVRM after any change.
DSH `defaultContextWindow` must equal the per-slot ctx (`qwenctl ctx N` syncs it).
