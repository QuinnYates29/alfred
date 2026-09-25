# Live runs on real Qwen (pre-soak smoke tests + P6 soak results)

## 2026-09-25 04:10 — smoke tests (scratch server :8799, DB ~/.alfred-smoke, master @ P5 merge)
Server config: Qwen fast config (np3 × 262k, ncmoe 8, lazy PLE, pinned). P9 was running concurrently on one slot.

| goal | persona | outcome | wall | tokens (prompt/completion) | notes |
|---|---|---|---|---|---|
| Smoke fizzbuzz | coder | ✅ done | ~1 min | 6,364 / 674 | correct ESM module; the gate ran the check; mirror GOAL.md shows DONE |
| Smoke delegation | alfred → coder | ✅ done (2 tasks) | ~3 min | 25,032 / 2,063 (alfred 7,464 · coder 17,568) | alfred spawned + waited + finished; **the main agent used ~30% of the tokens**, so context economy is visible |
| Smoke impossible (sha256 = 0…0) | coder | ✅ **failed loudly** | ~2 min | 8,896 / 1,473 | tried brute force ≤ 4 chars, checked whether sha256sum was tamperable, refused to fake it, cleaned up, gave a precise reason. Never claimed done. |

## P6 soak (service installed 2026-09-25 04:31 via deploy/install.sh; systemd user unit, token in ~/.config/alfred.env)
Deploy bug found immediately: startAlfred didn't create ~/.alfred/ → crash loop. Fixed + regression test.

### S1 mdconv (08:32–08:54) — FAILED; exposed 3 runtime bugs → P12
Timeline from the event log: one alfred LLM turn took 5 min (1,855 completion tokens) → the lease (5 min, heartbeat only between turns) expired → the scheduler
**reclaimed and started a second run** while the first was still alive. The second run spawned a researcher and called `ask_claude` (the holdout tests are
outside its sandbox: legitimate use of the Claude door). Then the **first (zombie) run's stall watchdog moved the parked task needs_claude → stopped**.
Context economy was visible: the researcher used 99.5k prompt tokens, alfred 11.8k. Also noted: `run_shell` can read files outside the workspace (the researcher
could read the holdout tests). A bubblewrap sandbox for run_shell is a future hardening item.
Fixed in **P12** (run-long heartbeat, ownership checks, reacquire, timers cleared). Regression tests in test/acceptance/p12/.

### S2 impossible (08:36→) — correct behaviour, then exposed a shutdown bug → P12b
The guard caught a `sudo -n true` probe → task **blocked: approval needed** with the exact command. It survived a service restart (S5 ✓ for parked work).
Denied via CLI → queued → it resumed with a "find another way" note. It then kept trying (143k tokens) until the **next service restart cancelled it forever**
(`stopped: cancelled`). Shutdown must requeue, not cancel → **P12b**.

### S5 crash recovery ✅ (07:02)
With S1b's alfred mid-run, the service was **SIGKILLed** (simulated crash; the old code's graceful stop would still have cancelled). systemd restarted it on P12b code;
S1b's lease expired and the new process **reclaimed and resumed the task at 07:06** with its notes. From now on a graceful restart (SIGTERM) requeues immediately (P12b).
Also observed: a 14-minute gap between two alfred turns (10:42→10:56 UTC) with no reclaim or zombie, so the P12 run-long heartbeat works in production.

### S1b mdconv (06:47→) — re-run on the hardened runtime. In progress.
