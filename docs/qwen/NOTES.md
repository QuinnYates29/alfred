# Qwen3.8-Flash-Next: observations from the alfred build

Numbers: [PERF.md](PERF.md) (regenerate with `python3 scripts/qwen-stats.py`). Harness: `scripts/qwen-task.sh` (DSH headless in a git worktree,
loop until the acceptance command passes, ≤ 4 attempts, 45–75 min each). Every attempt appends to `attempts.jsonl` (from 2026-09-24 21:05 on).

## Setup
- Model: Qwen3.8-Flash-Next UD-Q4_K_XL, llama.cpp qwen4exp fork, GB10 (DGX Spark / ASUS GX10), `-ncmoe 26 --load-mode mmap`, q8_0 KV, flash-attn.
- Agent: DSH (DeepSeek Harness) headless profile, `workspace-write` sandbox, no turn limit of its own.

## Timeline of tuning
| when | change | effect |
|---|---|---|
| 14:38 | `np 6 × 98k` (589k total) | NVRM `NV_ERR_NO_MEMORY` at start → silent CPU fallback, 1.4 tok/s. Reverted. |
| 14:39 | `np 6 × 64k` (393k total, same total as the old 4×98k) | clean. Short-prompt bench: 9.3 tok/s single, 24.5 aggregate ×6. |
| 14:43 | 6 agents at once, no reasoning cap | **0 files written in 30 min.** Reasoning share 72–90%. Qwen drafted whole files inside its thinking. ~2 tok/s per agent. Killed. |
| 15:14 | `--reasoning-budget 1536` + "don't draft in reasoning" preamble, ≤ 3 agents | reasoning share → ~35% median. Output tokens per session up ~10×. P1a/P1b/P2a all passed on attempt 1. |
| 21:36 | **np 3 × 262k, `-ncmoe 8`, `--tensor-read-lazy on`, `-t 10 --cpu-mask 0xF83E0 --cpu-strict 1`** | **15.4 tok/s single, 11.8 each / 35.5 aggregate at 3 parallel** (was 2.35/slot). Root cause of the slowness: `-ncmoe 26` meant ~26 GPU↔CPU round trips per token (sync-bound: GPU 25%, CPU 25%). Lazy PLE frees 26.8 GiB of device memory → 18 more expert blocks fit on the GPU. See SPEED-INVESTIGATION.md. |

## What the numbers say so far
- **Per-agent speed is ~2.2–2.5 tok/s with 3 concurrent agents** (≈ 7 tok/s aggregate), vs 9.3 tok/s for one short-prompt request. Contexts sit at 8–15k tokens
  (DSH `inputTokens`, which appears to exclude DSH's cached system-prompt prefix: the server log shows slots at 25–36k `n_tokens`).
- **Many sessions end exactly at the harness timeout** (44m59s / 59m59s). Tasks are often time-bound, not capability-bound. The retry loop (commit WIP, feed the test
  failures back) rescues them: all of wave 2 passed on attempt 2.
- **Reasoning cap works.** Uncapped: 79% of streamed text was thinking. Capped: 35%. The cap did not hurt correctness (8/8 tasks that finished have passed their acceptance tests).
- **Tool mix:** with the cap, `bash` dominates (running tests), then read/edit/write. Uncapped sessions were almost all `read`.
- **Good at:** well-specified modules with a precise contract and executable tests (tools, openai client, workspaces, executors, agent loop, orchestrator fix: 443 tests green).
  Code quality is good: comments explain why, and edge cases are handled.
- **Struggles with:** a large surface in one task (P3a: MCP hub + 4 sinks + config). Attempt 1 wrote no files in 60 min; attempt 2 also drafted the hub in reasoning (78% reasoning share).
  → Split large tasks.

## Harness lessons (not the model's fault)
- A qwen-server restart made every DSH call fail instantly, and the harness burned all remaining attempts in seconds (P7 lost all 4). Fixed: wait for `/health` before each attempt, and don't count a sub-2-minute failure during an outage.
- A shared editable-install `.venv` imported the main checkout instead of the worktree. The model's correct work looked "failing" (P2d). Fix: `PYTHONPATH=.`.
- Tests that load real personas with only built-in tools broke once personas listed executor tools. Fixed in the tests.
- `vitest run test/acceptance/p1` also matches `p10`/`p11` (prefix filter). P2e had actually passed (41/41) but was marked failing. Fix: trailing slashes.
- Restoring protected files from a moving `master` copied newer files into running worktrees. Fixed: restore from the fork point.

## Tuning ideas to try after the build
1. `--reasoning-budget` 1024 vs 1536 vs 2048 on the same task: time-to-pass.
2. 2 vs 3 concurrent agents: per-agent tok/s vs total throughput on real tasks.
3. `-ncmoe` 20–24 with np 3 (fewer slots → maybe room for more experts on device).
4. Speculative decoding / n-gram draft if the fork supports it for qwen4exp.
5. Longer harness timeouts (75–90 min) vs more attempts: which passes sooner.
6. Prompt-cache hit rate (`f_keep` in server.log) across DSH steps.
