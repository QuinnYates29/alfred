# Qwen3.8-Flash-Next performance ledger (alfred build)

_Generated 2026-09-25 07:07 by `scripts/qwen-stats.py`. Re-run anytime. Hand-written observations: [NOTES.md](NOTES.md)._

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
| P4a | 09-24 22:46 | 41m16s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 26 | 27 | 32,554 | 13,664 | 9,954 | 5.54 | 21% | bash×18, read×4, write×3 |
| P3a2 | 09-24 22:46 | 10m42s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 10 | 11 | 14,496 | 3,613 | 8,389 | 5.64 | 29% | bash×9, read×1, write×1 |
| P3a | 09-24 22:46 | 14m48s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 15 | 18 | 20,197 | 4,950 | 8,481 | 5.60 | 41% | bash×8, read×6, write×2 |
| P3b | 09-24 22:58 | 59m59s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 35 | 42 | 52,203 | 18,213 | 8,903 | 5.23 | 39% | edit×17, bash×13, read×10 |
| P11 | 09-24 23:02 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 25 | 38 | 46,166 | 18,045 | 8,489 | 5.23 | 25% | bash×13, read×11, write×7 |
| P8 | 09-24 23:28 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 31 | 56 | 53,493 | 22,449 | 11,376 | 5.06 | 27% | edit×23, bash×14, read×13 |
| P3b | 09-24 23:58 | 40m46s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 21 | 25 | 27,511 | 12,050 | 9,010 | 4.94 | 32% | bash×15, read×7, write×3 |
| P11 | 09-25 00:17 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 67 | 80 | 53,858 | 31,587 | 9,034 | 7.10 | 31% | bash×37, edit×19, read×16 |
| P8 | 09-25 00:43 | 23m31s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 13 | 16 | 20,010 | 9,691 | 4,385 | 6.88 | 65% | bash×9, read×5, edit×2 |
| P9 | 09-25 01:35 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 32 | 45 | 78,442 | 23,464 | 11,599 | 5.30 | 34% | read×16, bash×13, edit×13 |
| P5 | 09-25 01:35 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 33 | 46 | 32,959 | 22,443 | 8,474 | 5.28 | 21% | bash×26, write×16, edit×2 |
| P4b | 09-25 01:35 | 56m17s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 30 | 36 | 32,180 | 16,968 | 8,677 | 5.07 | 41% | bash×27, write×6, read×2 |
| P5 | 09-25 02:50 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 61 | 79 | 40,247 | 24,211 | 8,618 | 6.08 | 42% | bash×48, edit×18, read×9 |
| P9 | 09-25 02:50 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 54 | 81 | 62,200 | 28,519 | 8,907 | 6.43 | 42% | edit×44, bash×20, read×17 |
| P9 | 09-25 04:05 | 23m20s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 48 | 51 | 24,010 | 15,333 | 4,117 | 11.12 | 36% | bash×31, edit×9, read×8 |
| P10 | 09-25 04:30 | 1h14m | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 66 | 75 | 63,407 | 34,705 | 8,446 | 7.82 | 35% | bash×27, edit×27, read×16 |
| P12 | 09-25 05:49 | 48m07s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 42 | 51 | 40,168 | 24,664 | 10,444 | 8.63 | 39% | bash×23, edit×17, read×9 |
| P12b | 09-25 06:39 | 21m49s | np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 22 | 26 | 43,415 | 9,102 | 10,455 | 7.01 | 43% | bash×12, read×7, edit×6 |

\* output tokens ÷ step wall time: what an agent actually experiences, including queueing behind other agents and prefill.

## By server configuration

| config | sessions | median out tok/s | median peak ctx | total output tok | median reasoning share |
|---|---|---|---|---|---|
| np=6 ctx=64k, no reasoning cap | 6 | 2.06 | 10,183 | 10,788 | 79% |
| np=6 ctx=64k, --reasoning-budget 1536, <=3 agents | 18 | 2.29 | 8,462 | 116,120 | 35% |
| np=3 ctx=262k ncmoe=8 lazy-PLE, pinned X925, budget 1536 | 20 | 5.64 | 8,677 | 357,485 | 36% |

## Harness outcomes (acceptance-gated)

| task | attempt | started | wall | dsh exit | check | result |
|---|---|---|---|---|---|---|
| P7 | 1 | 09-24 21:07 | 26m11s | 1 |  Tests 92 passed (92) | fail |
| P7 | 2 | 09-24 21:34 | 0m18s | 1 |  Tests 92 passed (92) | fail |
| P7 | 3 | 09-24 21:34 | 0m19s | 1 |  Tests 92 passed (92) | fail |
| P7 | 4 | 09-24 21:34 | 0m19s | 1 |  Tests 92 passed (92) | fail |
| P7 | 1 | 09-24 21:38 | 0m50s | 0 |  Tests 92 passed (92) | fail |
| P7 | 2 | 09-24 21:39 | 33m49s | 0 |  Tests 102 passed (102) | PASS |
| P3a2 | 1 | 09-24 22:46 | 10m44s | 0 |  Tests 4 passed (4) | PASS |
| P3a | 1 | 09-24 22:46 | 14m50s | 0 |  Tests 4 passed (4) | PASS |
| P4a | 1 | 09-24 22:46 | 41m18s | 0 |  Tests 69 passed (69) | PASS |
| P3b | 1 | 09-24 22:58 | 1h00m | 124 |  Tests 84 passed | 3 skipped (87) | fail |
| P11 | 1 | 09-24 23:02 | 1h15m | 124 |  Tests 85 passed (85) | fail |
| P3b | 2 | 09-24 23:58 | 40m49s | 0 |  Tests 92 passed (92) | PASS |
| P8 | 1 | 09-24 23:28 | 1h15m | 124 |  Tests 2 failed | 116 passed (118) | fail |
| P8 | 2 | 09-25 00:43 | 23m35s | 0 |  Tests 118 passed (118) | PASS |
| P11 | 2 | 09-25 00:17 | 1h15m | 124 |  Tests 95 passed (95) | PASS |
| P4b | 1 | 09-25 01:35 | 56m23s | 0 |  Tests 133 passed (133) | PASS |
| P5 | 1 | 09-25 01:35 | 1h15m | 124 |  | fail |
| P9 | 1 | 09-25 01:35 | 1h15m | 124 |  Tests 10 failed | 124 passed (134) | fail |
| P9 | 2 | 09-25 02:50 | 1h15m | 124 |  Tests 5 failed | 129 passed (134) | fail |
| P5 | 2 | 09-25 02:50 | 1h15m | 124 |  Tests 5 passed (5) | PASS |
| P9 | 3 | 09-25 04:05 | 23m27s | 0 |  Tests 135 passed (135) | PASS |
| P10 | 1 | 09-25 04:30 | 1h15m | 124 |  Tests 161 passed (161) | PASS |
| P12 | 1 | 09-25 05:49 | 48m12s | 0 |  Tests 139 passed (139) | PASS |
| P12b | 1 | 09-25 06:39 | 21m57s | 0 |  Tests 130 passed (130) | PASS |

Tasks passed: **13/13**, first-attempt passes: **7**.
