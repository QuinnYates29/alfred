# Qwen3.8-Flash-Next performance ledger (alfred build)

_Generated 2026-09-24 22:45 by `scripts/qwen-stats.py`. Re-run anytime. Hand-written observations: [NOTES.md](NOTES.md)._

## Per attempt (one DSH headless session each)

| task | started | wall | server config | steps | tool calls | input tok | output tok | peak ctx | out tok/s* | reasoning share | top tools |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1b | 09-24 14:43 | 30m57s | np=6 ctx=64k, no reasoning cap | 3 | 8 | 12,709 | 545 | 8,552 | 1.72 | 11% | read×7, bash×1 |
| P1a | 09-24 14:43 | 30m57s | np=6 ctx=64k, no reasoning cap | 4 | 8 | 15,644 | 481 | 8,669 | 2.06 | 90% | read×6, bash×2 |
| P2d | 09-24 14:45 | 28m38s | np=6 ctx=64k, no reasoning cap | 8 | 13 | 34,059 | 1,834 | 15,272 | 1.79 | 83% | read×9, grep×3, bash×1 |
| P2c | 09-24 14:47 | 26m03s | np=6 ctx=64k, no reasoning cap | 6 | 12 | 27,392 | 1,869 | 10,183 | 1.91 | 76% | bash×6, read×6 |
| P2a | 09-24 14:47 | 26m03s | np=6 ctx=64k, no reasoning cap | 8 | 13 | 35,285 | 3,482 | 10,183 | 2.28 | 72% | read×7, bash×6 |
| P2b | 09-24 14:47 | 26m03s | np=6 ctx=64k, no reasoning cap | 5 | 10 | 23,686 | 2,577 | 8,844 | 2.10 | 79% | bash×10 |
| P1a | 09-24 15:15 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 18 | 27 | 24,059 | 12,848 | 8,785 | 3.58 | 29% | bash×11, write×8, read×5 |
| P2a | 09-24 15:15 | 44m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 19 | 25 | 20,872 | 6,222 | 8,462 | 2.33 | 32% | edit×13, bash×8, read×2 |
| P1b | 09-24 15:15 | 44m58s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 10 | 13 | 15,834 | 6,286 | 8,668 | 2.34 | 12% | bash×7, read×3, write×2 |
| P2c | 09-24 17:06 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 9 | 16 | 26,145 | 8,054 | 9,232 | 2.24 | 24% | read×5, write×5, bash×3 |
| P2b | 09-24 17:06 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 10 | 16 | 29,345 | 7,498 | 10,054 | 2.23 | 35% | bash×5, read×4, write×3 |
| P1c | 09-24 17:06 | 1h14m | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 13 | 18 | 40,236 | 9,478 | 9,940 | 2.24 | 28% | read×9, bash×7, write×2 |
| P2c | 09-24 18:06 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 18 | 22 | 10,999 | 8,820 | 3,527 | 2.54 | 33% | bash×14, read×5, edit×3 |
| P2b | 09-24 18:06 | 50m23s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 13 | 19 | 17,177 | 7,321 | 4,767 | 2.42 | 30% | bash×9, read×6, edit×3 |
| P1c | 09-24 18:22 | 50m11s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 21 | 25 | 24,405 | 9,244 | 6,986 | 3.08 | 51% | bash×16, read×5, edit×3 |
| P2e | 09-24 19:31 | 44m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 15 | 22 | 19,992 | 5,651 | 8,368 | 2.23 | 47% | bash×11, read×6, str_replace_editor×2 |
| P3a | 09-24 19:31 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 7 | 11 | 24,233 | 5,215 | 8,475 | 2.24 | 44% | bash×6, read×5 |
| P2d | 09-24 19:31 | 44m58s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 16 | 25 | 32,671 | 5,845 | 15,272 | 2.24 | 34% | read×9, edit×9, grep×5 |
| P2e | 09-24 20:18 | 44m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 18 | 22 | 13,814 | 5,958 | 2,466 | 2.29 | 57% | bash×20, write×1, edit×1 |
| P4a | 09-24 20:18 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 11 | 18 | 31,446 | 5,014 | 13,433 | 2.28 | 27% | bash×6, read×6, edit×6 |
| P3a | 09-24 20:31 | 59m59s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 9 | 15 | 14,743 | 7,454 | 3,201 | 2.33 | 42% | bash×10, read×4, write×1 |
| P2e | 09-24 21:03 | 4m07s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 1 | 1 | 1,386 | 437 | 1,386 | 2.35 | 83% | bash×1 |
| P7 | 09-24 21:07 | 26m08s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 9 | 15 | 31,729 | 3,178 | 8,457 | 2.18 | 65% | bash×11, read×4 |
| P4a | 09-24 21:18 | 15m08s | np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 7 | 12 | 10,855 | 1,597 | 2,730 | 2.27 | 51% | bash×8, read×4 |
| P7 | 09-24 21:38 | 0m46s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 1 | 0 | 8,400 | 13 | 8,400 | 0.28 | 93% |  |
| P7 | 09-24 21:39 | 33m46s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 55 | 70 | 39,042 | 23,801 | 5,742 | 11.79 | 24% | edit×27, bash×24, read×16 |

\* output tokens ÷ step wall time: what an agent actually experiences, including queueing behind other agents and prefill.

## By server configuration

| config | sessions | median out tok/s | median peak ctx | total output tok | median reasoning share |
|---|---|---|---|---|---|
| np=6 ctx=64k, no reasoning cap | 6 | 2.06 | 10,183 | 10,788 | 79% |
| np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 18 | 2.29 | 8,462 | 116,120 | 35% |
| np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 2 | 11.79 | 8,400 | 23,814 | 93% |

## Harness outcomes (acceptance-gated)

| task | attempt | started | wall | dsh exit | check | result |
|---|---|---|---|---|---|---|
| P7 | 1 | 09-24 21:07 | 26m11s | 1 |  Tests 92 passed (92) | fail |
| P7 | 2 | 09-24 21:34 | 0m18s | 1 |  Tests 92 passed (92) | fail |
| P7 | 3 | 09-24 21:34 | 0m19s | 1 |  Tests 92 passed (92) | fail |
| P7 | 4 | 09-24 21:34 | 0m19s | 1 |  Tests 92 passed (92) | fail |
| P7 | 1 | 09-24 21:38 | 0m50s | 0 |  Tests 92 passed (92) | fail |
| P7 | 2 | 09-24 21:39 | 33m49s | 0 |  Tests 102 passed (102) | PASS |

Tasks passed: **1/1**, first-attempt passes: **0**.
