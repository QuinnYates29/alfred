# Qwen3.8-Flash-Next decode speed investigation (2026-09-24, read-only)

Investigated while `qwen-server.service` was live and in use by 3 coding agents.
No restarts, no env-file edits, no second server. All findings below are from
`server.log`, `~/.dsh/crashes.log`, `journalctl`, `/proc`, `nvidia-smi`,
`CMakeCache.txt`, the `llama.cpp-qwen4exp` source tree, and `qwenctl`'s own
scripts — plus 0 live test requests (log data over the last hour was
sufficient; didn't want to add a 4th consumer to an already-contended server).

## Current running config (PID 982357, up since 15:14, clean — 0 NVRM events since)
```
-ngl 999 -ncmoe 26 -c 393216 --load-mode mmap -fa on -ctk q8_0 -ctv q8_0 -np 6
```
= `QWEN_NCMOE=26` (of 48), `QWEN_NP=6`, `QWEN_CTX=65536`/slot, no `-t`/`-C` (default
`n_threads=20`, confirmed in log: `init: llama threadpool init, n_threads = 20`).
GPU process memory: 49,380 MiB resident on device. GPU util 24–29%, 25 W, SM clock
2424 MHz (not clock-capped — rules out the 2026-07 GPU-clock bug). Every CPU thread
in the pool sits at ~22–25% busy during decode (mpstat + `top -H`, ~24% system-wide
= ~5 of 20 cores worth of work). **Neither device is saturated.** Per-slot decode
rate is flat at 2.4–2.5 tok/s in `server.log` across the last ~300 `eval time` lines,
*regardless of how many slots are concurrently active* (ids 0/2/3/5 all present).
A single uncontended short request elsewhere measured 9.3 tok/s. These two numbers
are consistent with one shared, largely-serialized decode stream worth ~9–10 tok/s
total, sliced across however many agents are asking for output — not four
independently-throttled slots.

## Ranked hypotheses

**1. `-ncmoe 26` forces a CPU↔GPU round trip on 26 of 48 layers, every token — this is the primary bottleneck.** (High confidence)
`-ncmoe N` keeps only the *MoE expert* tensors of the first N layers on CPU; the
surrounding attention/norm/router tensors for those same layers stay on GPU (source:
`common/arg.cpp:2781`, confirmed against `qwenctl explain`'s per-tensor GiB table).
Because compute is strictly sequential layer-to-layer, every one of those 26 layers
needs: GPU (attn) → host sync → CPU (expert matmul) → host sync → GPU (next layer's
attn). That's up to 26 host/device handoffs per generated token. Each handoff pays
fixed kernel-launch + sync latency on top of whatever compute it does — and with
`np=6` batching single-token continuations from up to 6 sequences, none of that
per-layer barrier work overlaps with the next slot's work in a way that hides the
latency. This is the textbook shape for "both devices <30% busy, throughput flat
regardless of concurrency": neither is doing enough compute per unit time because
they're mostly *waiting on each other*, not on FLOPs or memory bandwidth.
This also matches `docs/qwen/NOTES.md`'s own next-step idea #3 ("`-ncmoe` 20–24
with np 3") and is corroborated by the 2026-08-31 measurement that *raising*
ncmoe from 12→24 (i.e. moving MORE onto CPU, but out of an NVRM-fallback state)
raised speed from 3.3→8.6 tok/s — the true, non-fallback ncmoe=24 number is a much
closer match to the "10–30 tok/s" reports than what's running now.

**2. `qwenctl`'s presets don't account for the current `np`/`ctx`, and are unsafe as shipped.** (High confidence — plainly misconfigured, see below)

**3. `per_layer_token_embd` (26.82 GiB) offload is not the free lunch the comment in the env file implies.** (Medium confidence, untested)
`qwen4exp.cpp:324-325` calls `build_ple()` *inside the per-layer loop*, and
`build_ple()` (line 1093) constructs a fresh `llm_graph_input_ple` — i.e. a fresh
graph input/lookup — on every layer where `hparams.is_ple(il)` is true, not once
per token. If PLE fires on most/all 48 layers, moving the table to CPU via
`-ot per_layer_token_embd=CPU` could add close to as many round trips as lowering
`-ncmoe` removes. It's still likely to be *cheaper per round trip* than an expert
block (it's a row-gather into a small per-token vector, not a matmul over the full
hidden dim), so it's worth testing, just not worth assuming it's free.

**4. Threads run unpinned across all 20 cores, including the 10 slower Cortex-A725 efficiency cores.** (Medium confidence, untested)
GB10 is a 10×X925 (perf, ≤3.9 GHz) + 10×A725 (efficiency, ≤2.8 GHz) big.LITTLE part.
`llama-server` was launched with no `-t`/`-C`/`-Cr`, so its 20-thread CPU pool
(confirmed via log) spans both clusters. `ggml`'s CPU backend uses a barrier-style
thread pool per op — every layer's CPU-side work waits for the *slowest* thread in
the pool. If X925 threads are finishing their chunk and stalling on A725 threads
every barrier, that's throughput left on the table for free (no memory-safety risk,
cheap to test). No direct evidence either way from the CPU sampling done here (it
shows uniform ~22–25% busy across all 20 threads, which is also consistent with the
whole pool being idle waiting on GPU most of the time) — flagged as untested, not
confirmed.

**5. Missing `GGML_CPU_KLEIDIAI` build flag.** (Medium confidence, plainly misconfigured — see below.) Independent of 1–4: whatever fraction of the model ends up CPU-resident will run through generic/NEON GEMM kernels instead of ARM's KleidiAI-optimized int4/int8 microkernels, which are usually the single biggest lever for quantized-matmul throughput on Cortex cores.

**6. Unsupported/fallback ops in the unmerged qwen4exp fork.** (Low confidence — no positive evidence found)
Grepped the entire `server.log` for `warn|fallback|error|fail|mmap|cuda error`:
the only hits are the (harmless) Qwen-VL image-token warning and routine prompt-cache
eviction notices — nothing about an unsupported op or CPU-scheduled fallback for a
GPU-requested tensor. `graphs reused` counters are healthy (9,000+ reuses between
recaptures), so CUDA graph capture for the GPU-resident portion of the graph is
working, not silently falling back per-token. This doesn't rule out a fallback for
a specific qwen4exp-only op (GatedDeltaNet state update, QSA indexer) since this
build's log doesn't print per-tensor backend placement at its current verbosity —
rank this low until a `-v`/`GGML_SCHED_DEBUG=2` capture (experiment 5 below) either
confirms or clears it.

## What's plainly misconfigured (independent of the ranking above)

- **`qwenctl preset balanced` (`-ncmoe 12`) would almost certainly NVRM-crash right now.** At the *current* `np=6`/`ctx=65536` (28.3 GiB of KV+state+checkpoint overhead, roughly 12 GiB more than the `np=2`/`ctx=262144` config the 12-vs-24 test was run under), `-ncmoe 12`'s on-device weight footprint (~86.6 GiB) plus that overhead (~114.9 GiB total) is comfortably past the ~102.6 GiB commit that triggered `NV_ERR_NO_MEMORY` on 2026-08-31. **`qwenctl preset fast` (`-ncmoe 0`) is worse: ~103.67 GiB of weights alone, before any KV, already exceeds that failure point.** Neither preset was re-validated after `np`/`ctx` moved from 2×262144 to 6×65536; both are landmines in the current tool. Recommend either removing `fast`/`balanced` or teaching `cmd_preset` to check `slot_cost` against a measured ceiling before restarting.
- **The device memory ceiling itself is still just bounded, not measured** (>84.6 GiB commit succeeds, <102.6 GiB commit NVRMs, and `nvidia-smi` reports memory as `[N/A]` on this part so it can't be read directly). Every experiment below should be treated as "try it, then immediately check `~/.dsh/crashes.log` for a new NVRM line" rather than assumed-safe from arithmetic alone.
- **`server.log` never logs load-time tensor placement** (no `load_tensors:`, no `CUDA0 model buffer size` lines) at whatever verbosity `qwen-server.service` currently runs at — the log has per-slot `print_timing` but nothing from the loader confirming which tensors actually landed where. That's a real observability gap for a fork built around manual tensor placement.
- **`--cache-ram` is still the 8 GiB default, shared across 6 slots**, and `server.log` shows very frequent "making room for prompt cache entry, removing oldest entry" evictions. This mostly costs prompt reprocessing (prefill), not decode tok/s, so it's not in the ranking above, but it's free money if increased — worth ~4-8 GiB more if a `-ncmoe`/`-ot` change below frees headroom.

## Experiments, in the order to run them

All are env-file edits (`~/.config/qwen-server.env`) followed by `qwenctl restart`
(or hand-edit + `systemctl --user restart qwen-server`), except #5 which is a
one-shot diagnostic launch, and #6 which is a rebuild, not a launch flag. Check
`~/.dsh/crashes.log | tail` for a new NVRM line after every restart before judging
speed — a silent CPU fallback looks like *lower* memory pressure with much worse
tok/s, not a crash.

**1. Pin threads off the efficiency cores (zero memory risk — do this first).**
```
QWEN_EXTRA=--reasoning-budget 1536 -t 10 -Cr 0-9 --cpu-strict 1
```
(Verify core numbering first with `lscpu -e` — this assumes cores 0-9 are the
X925 performance cluster and 10-19 are A725, matching `lscpu`'s block order in
this session's output; a wrong range makes this a no-op, not a crash.)
Expected effect: if hypothesis 4 contributes, decode should speed up with *no*
change in memory footprint. If it does nothing, hypothesis 4 is cleared cheaply.
Risk: none (no memory impact; worst case, no speed change).

**2. Match `np` to actual concurrency and spend the freed headroom on `ncmoe` (targets hypothesis 1 directly).**
```
QWEN_NP=3
QWEN_CTX=65536
QWEN_NCMOE=14
```
(`qwenctl slots 3` then `qwenctl ctx 65536` then `qwenctl offload 14`, or hand-edit
all three plus let `qwenctl restart` recompute `QWEN_CTX_TOTAL`.) Math: overhead
drops from 6×4.716≈28.3 GiB to 3×4.716≈14.1 GiB, freeing ~14.2 GiB — enough
headroom to drop ncmoe from 26 to roughly 14-16 while staying under the ~95-100 GiB
ballpark ceiling implied by the 84.6-GiB-succeeds/102.6-GiB-fails bracket. This
also matches the 3-agents-in-practice reality already baked into
`--reasoning-budget`/DSH's `<=3 agents` policy — `np=6` was never actually used
concurrently. Expected effect: roughly halves the number of per-layer CPU↔GPU
round trips (26→14-16); if hypothesis 1 is right, decode should move well above
the current flat ~2.4/slot toward something like the 8.6 tok/s single-request
number from the ncmoe=24 test, likely higher given lower ncmoe. Risk: NVRM if the
ceiling estimate is off — check crashes.log immediately after restart; back off
`ncmoe` upward in steps of 2 if it fires.

**3. If #2 is clean and faster, push further: fewer slots, lower ncmoe still.**
```
QWEN_NP=2
QWEN_CTX=65536
QWEN_NCMOE=8
```
Overhead drops to 2×4.716≈9.4 GiB, freeing another ~4.7 GiB versus #2 — enough for
another ~3 blocks off `ncmoe`, pushed a bit further here since #2's result will
tell you how much margin was actually left. Expected effect: further reduction
in round trips (14→8), diminishing returns as `ncmoe` approaches single digits.
Risk: NVRM, same caveat as #2; also fewer concurrent slots caps aggregate agent
count to 2, which needs the DSH-side "≤3 agents" policy adjusted downward if kept.

**4. Test whether trading the embed table for expert blocks is a net win (targets hypothesis 3, exploratory).**
```
QWEN_NP=3
QWEN_CTX=65536
QWEN_NCMOE=4
QWEN_EXTRA=--reasoning-budget 1536 -ot per_layer_token_embd=CPU
```
Frees the 26.82 GiB embed table from device residency instead of expert blocks,
letting `ncmoe` drop much further (down to ~4, per the qwenctl GiB table: fixed
floor becomes 5.96 GiB instead of 32.78 GiB once the embed table moves). Expected
effect: uncertain per-directum — if PLE round trips are cheap (small gather output)
this should beat #2/#3 at equal ncmoe; if `is_ple()` fires on most of the 48
layers, it could be no better than a straight ncmoe reduction, or worse. This is
the one experiment worth an actual before/after tok/s comparison rather than just
a memory-safety check. Risk: NVRM, same caveat.

**5. Diagnostic-only: capture load-time tensor placement (do on whichever restart above you run first — free to fold in).**
Add `-v` to `QWEN_EXTRA` for that one restart (or set `GGML_SCHED_DEBUG=2` in the
env file if the build honors it), grab the first ~500 lines of the new
`server.log` section for `CUDA0 model buffer size` / `CPU_Mapped model buffer size`
/ any "op not supported" line, then remove `-v` again. This directly confirms or
clears hypothesis 6 and gives an exact GiB figure for the on-device commit at
whatever config you're running, replacing the arithmetic estimates above with
real numbers. Risk: none beyond normal restart; more log volume.

**6. Rebuild with KleidiAI (not a launch experiment — separate from the above, do independently).**
```
cmake -B build -DGGML_CUDA=ON -DGGML_CPU_KLEIDIAI=ON -DCMAKE_CUDA_ARCHITECTURES=121a-real ...(existing flags)...
```
Current `CMakeCache.txt` has `GGML_CPU_KLEIDIAI:BOOL=OFF` — ARM's optimized
int4/int8 GEMM microkernels for Cortex-X925/A725 are not being used, so whatever
fraction of the model stays CPU-resident after 1-4 above runs through generic/NEON
kernels instead. This is orthogonal to the ncmoe/np tuning and worth doing
regardless of which offload split wins — it should speed up the CPU side without
touching the memory budget at all. Needs a full rebuild (`build/` dir), not just a
restart; do it in a separate `build2/` dir first and A/B the binary before
replacing the one `qwen-server.service` points at.

## Bottom line
The evidence (flat ~2.4-2.5 tok/s per slot independent of concurrency, ~24-29%
GPU util, ~22-25% per-thread CPU util, both devices idle rather than busy) points
at **per-layer CPU↔GPU synchronization overhead from `-ncmoe 26` being too high
for the current `np=6`/`ctx=65536` overhead budget**, not raw compute or memory
bandwidth limits on either device — consistent with the user's correction that
this exact quant should do 10-30 tok/s on this hardware. The fastest, lowest-risk
path to test that is experiment 1 (thread pinning, zero risk) followed by
experiment 2 (np=3/ncmoe=14, matches actual 3-agent concurrency and the project's
own prior "try ncmoe 20-24 with np 3" note in NOTES.md).
