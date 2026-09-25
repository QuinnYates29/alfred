# GOAL: Alfred — one local agentic platform

Status: **IN PROGRESS** · Started 2026-09-24 · Orchestrator: Claude Code (dispatch + verify only)

## The goal

One platform that replaces three overlapping tools: Mission Deck / A.L.F.R.E.D.
(dashboard), `~/tools/orchestrator` (the coding pipeline) and the loose Hermes/DSH setup.
It has personalities, automations and connections. It codes and spawns its own
subagents. **You can hand it a long task and trust it to either finish or stop at a
reasonable point and fail loudly.**

## Decisions (from Quinn, 2026-09-24)

| Topic | Decision |
|---|---|
| Core | **New thin repo** (`~/repos/alfred`), TypeScript. Reuses Mission Deck modules (agentloop, slots, trace, obsidian, mcpclient, automations, UI). |
| Model | Qwen3.8-Flash-Next at `127.0.0.1:1110` handles every subtask. No Claude calls from inside the platform. |
| Claude door | An MCP server that Claude Code/Desktop connects to so it can list goals, pick up `needs_claude` tasks, resume them and post results. Claude comes in; the platform never calls out. |
| Context | Personas must stay lean. A stock Hermes agent costs 58 KB (~15k tokens: 16.5 KB system prompt + 40.5 KB for 18 tool schemas). Every persona has a **hard prompt budget** that is enforced by a test. |
| Storage | **SQLite** is the source of truth (goals, tasks, runs, events, leases). A **markdown mirror** goes to an agent vault. Access to the personal Obsidian vault goes through MCP and is read-mostly. |
| Coding | **DSH headless** for single-agent coding. **orchestrator pipeline** for large fan-out work. **LangGraph coder** (Python sidecar) for a second, more constrained flow. |
| Fail loudly | Dashboard red card + desktop notification, **Slack** push, and a FAILED block in the goal's markdown. |
| Autonomy | Free to edit, test and commit on local branches. Pushes, deploys, external messages and anything that costs money need approval. |
| Mission Deck | Absorb it. The old `deck-server` is shut down now (Quinn runs the sudo command). |
| Context economy (added 2026-09-24) | Keep the main agent's context small: the chief of staff delegates, children return **compact summaries** (never transcripts), conversations are **compacted** when they reach a per-persona context budget, tool output is paged, and every task reports its context peak and token total. |
| Swappable models (added) | `config/models.yaml` registry of OpenAI-compatible endpoints (llama.cpp, vLLM, Ollama, OpenRouter, …). Personas, goals and executors refer to models **by name**. Switching is one edit or an API call, with no code change. |
| Topology (added) | **Compute on the Spark** (`gx10-de9a`). Laptop and phone connect over Tailscale (dashboard as a PWA via `tailscale serve`, the Claude door over HTTP MCP). **Workspaces live on the Spark or on the laptop**: a small `alfred-node` daemon on the Mac dials in and runs file/shell/git/acceptance ops in its allowed roots. |
| Personas v1 | `alfred` (chief of staff/dispatcher), `coder` (DSH/orchestrator), `researcher`, `coder-lg` (LangGraph, constrained). |

## Definition of done (whole project)

1. `npm test` is green, and each phase's acceptance suite in `docs/phases/` passes.
2. **Soak test:** a real multi-hour coding goal that runs through the finish or stops loudly, with no silent hang. This is checked by a no-progress watchdog with a known timeout.
3. A deliberately impossible goal ends as `failed`/`blocked` with a written reason, a Slack message and a red card within its budget. It never reports "done".
4. No persona's system prompt plus tool schemas exceeds its budget (default 6k tokens).
5. Claude Code (on the Spark **or the laptop**) can connect with `claude mcp add alfred …` and complete a `needs_claude` task end to end.

## Status log

- 2026-09-24: Clarifying questions answered; repo created; PLAN.md written; Phase 0 dispatched.
- 2026-09-24 14:40: Qwen set to 6 slots x 64k (6x98k hit NVRM OOM). P0 done (Claude subagent), 34 tests.
- 2026-09-24 15:15: First 6-agent Qwen wave stalled (0 files in 30 min): long-context 6-way decode ~1 tok/s/agent and Qwen drafted code in reasoning. Fixed with --reasoning-budget 1536 + economy preamble; waves capped at 3. See docs/LESSONS.md.
- 2026-09-24 16:15: Wave 1 (P1a tools/personas, P1b openai client, P2a workspaces) all passed attempt 1 on Qwen; verified + merged (60 tests). Personas cost ~0.9-1.1k tokens (vs Hermes ~15k).
- 2026-09-24 17:06: Wave 2 dispatched: P1c agent loop+scheduler, P2b dsh/pipeline executors, P2c LangGraph sidecar.
- 2026-09-24 17:20: Quinn added context economy, swappable models, and Spark-compute/laptop-workspace topology → phases P7 (models), P8 (context), P9 (nodes + remote access).
- 2026-09-24 19:31: Wave 2 passed on attempt 2 (P1c agent loop+scheduler 74 tests, P2b dsh/pipeline, P2c LangGraph sidecar); merged, 88 tests green. Wave 3 dispatched: P2d orchestrator post-merge verify, P2e wiring, P3a MCP hub + sinks.
- 2026-09-24 20:20: P2d merged into ~/tools/orchestrator main (post-merge verify; 443 tests). Harness bugs found+fixed: editable-install import trap (PYTHONPATH), persona tests needed allTools. Added P10 (git hub + workspace modes) and P11 (extension API); control-side UX deferred to Quinn, P5 reduced to a functional shell.
- 2026-09-24 21:36: Qwen decode fixed: np3 x 262k, ncmoe 8, --tensor-read-lazy on, X925 pinning → 15.4 tok/s single / 35.5 aggregate (was ~2.35/slot). Root cause: -ncmoe 26 was sync-bound.
- 2026-09-24 22:15: P7 model registry merged (102 tests). P3a/P4a lost their last attempts to the server restart and a harness-script overwrite; WIP kept in their worktrees; P3a split into P3a1 (hub) / P3a2 (sinks) because its test imported P3b's approvals module. Harness hardened (private copy, outage-aware). Session handed off: see docs/HANDOFF.md.
