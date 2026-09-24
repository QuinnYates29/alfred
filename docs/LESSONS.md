# Lessons (orchestrator log)

## 2026-09-24 — Qwen concurrency vs. agent contexts
- 6 slots × 64k (`QWEN_NP=6, QWEN_CTX=65536`, total 393k) is the NVRM-safe layout; 6 × 98k hit `NV_ERR_NO_MEMORY` → silent CPU fallback (1.4 tok/s).
- Short prompts: 9.3 tok/s single, **24.5 tok/s aggregate** with 6 parallel.
- Real agent work (DSH, 25–35k-token contexts): **~0.95 tok/s per slot with 6 busy → ~5.7 aggregate, worse than one slot**. Long-context attention dominates; more slots do not add throughput.
- Qwen drafted whole files inside its reasoning (3,708 reasoning chunks vs 236 tool chunks in one step), then would re-emit them in the tool call: 2× tokens at 1 tok/s. Fix: `--reasoning-budget 1536` on the server + a dispatch preamble ("never draft files in reasoning").
- Consequence for Alfred's design: `limitLLM` default should be ~3, not 6, for agentic work; the scheduler can hold more *workers* (waiting parents) than LLM slots.
- `pkill -f <pattern>` from the Bash tool matches the tool's own shell command line and kills it (exit 144). Use `ps | grep '[x]yz'` + explicit PIDs.
