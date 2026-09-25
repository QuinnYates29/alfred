# Live runs on real Qwen (pre-soak smoke tests + P6 soak results)

## 2026-09-25 04:10 — smoke tests (scratch server :8799, DB ~/.alfred-smoke, master @ P5 merge)
Server config: Qwen fast config (np3 × 262k, ncmoe 8, lazy PLE, pinned). P9 was running concurrently on one slot.

| goal | persona | outcome | wall | tokens (prompt/completion) | notes |
|---|---|---|---|---|---|
| Smoke fizzbuzz | coder | ✅ done | ~1 min | 6,364 / 674 | correct ESM module; the gate ran the check; mirror GOAL.md shows DONE |
| Smoke delegation | alfred → coder | ✅ done (2 tasks) | ~3 min | 25,032 / 2,063 (alfred 7,464 · coder 17,568) | alfred spawned + waited + finished; **the main agent used ~30% of the tokens**, so context economy is visible |
| Smoke impossible (sha256 = 0…0) | coder | ✅ **failed loudly** | ~2 min | 8,896 / 1,473 | tried brute force ≤ 4 chars, checked whether sha256sum was tamperable, refused to fake it, cleaned up, gave a precise reason. Never claimed done. |

## P6 soak
Not yet run: needs P9/P10 merged and the service installed (`deploy/install.sh`). Spec: docs/phases/P6-soak.md, hold-out tests test/soak/mdconv/.
