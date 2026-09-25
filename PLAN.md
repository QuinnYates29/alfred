# PLAN

Each phase has a spec plus acceptance in `docs/phases/PN-*.md`, and **executable
acceptance tests written by the orchestrator before implementation** under
`test/acceptance/pN/`. A phase is done only when those tests pass unmodified.
Implementers may add tests but may not weaken the acceptance ones.

## Architecture (target)

```
            Slack ◄──┐        Claude Code/Desktop
 desktop notify ◄────┤              │ MCP (the "Claude door")
                 notify/        mcp-door/
                     │              │
 Dashboard (React) ─ HTTP/SSE ─ core (TS, Express) ──── SQLite (truth) ──► md mirror (agent vault)
                                  │
             ┌────────────────────┼────────────────────────┐
         runtime/             executors/               connectors/
   persona loader +       dsh-headless adapter     obsidian MCP (personal vault)
   agentloop (from Deck)  orchestrator pipeline    automations/cron (from Deck)
   spawn_subagent tool    langgraph sidecar (py)
   watchdog + budgets
                                  │
                        Qwen3.8-Flash-Next :1110
```

## The "trust it" contract (applies to every phase)

A task finishes in exactly one of these states: `done` | `failed` | `blocked` | `needs_claude` | `stopped`.
- `done` requires **every acceptance check to pass mechanically**. The model saying it's done is not enough.
- Every run has a turn budget, token budget, wall clock, **no-progress watchdog** (no new
  event or diff within N minutes) and a **repeat-error detector** (the same error 3 times).
  Hitting any of them ends the run as a loud stop with a written reason, never a silent hang.
- Subagent spawning is bounded by depth (default 2), fan-out (default 4) and a budget
  inherited from the parent, which can only shrink.
- Leases plus heartbeats: if a worker crashes, its task is reclaimed, and a retry gets the
  previous attempt's notes and workspace. It does not start from scratch (orchestrator lesson #1).

## Phases

| # | Phase | Delivers | Acceptance highlights |
|---|---|---|---|
| P0 | **Core store & fail-loud** | SQLite schema, task state machine, leases, done-gate, md mirror, notifier fan-out | illegal transitions throw; double claim rejected; `done` refused unless checks pass; one failing sink doesn't block the others; mirror is idempotent |
| P1 | **Agent runtime** | persona manifests (YAML), prompt-budget enforcement, agentloop port, `spawn_subagent`, watchdog, Qwen client | persona over budget → load error; spawn depth/fan-out/budget limits; watchdog stops a stalled mock agent; all of it tested with a scripted fake LLM |
| P2 | **Coding executors** | DSH headless adapter, orchestrator-pipeline adapter (+ fix integration-merge gap), LangGraph coder sidecar | each adapter completes a fixture task in a temp git repo and returns a structured result; a failing test in the fixture → `failed`, not `done` |
| P3 | **Connections** | Obsidian MCP connector, Slack notifier + approval buttons, desktop notify, **Claude door MCP server** | Claude door: list / claim / resume / complete a `needs_claude` task via MCP; Slack message is sent (mocked in CI, live smoke test) |
| P4 | **Automations** | cron/trigger engine ported from Deck, goal templates | a scheduled goal fires, runs and mirrors |
| P5 | **Dashboard** | Mission Deck UI absorbed: goals board, run timeline, red failure cards, approvals | Playwright smoke test; the failure card appears within 5 s of a failure event |
| P7 | **Model registry** | `config/models.yaml`, named models + roles, per-persona/per-goal model, hot reload, executors take model from registry | swap a persona's model by editing yaml → next turn hits the new endpoint; unknown model → config error; API lists + switches |
| P8 | **Context economy** | compaction at a context budget, compact child summaries, paged reads, per-task context/token accounting, delegation-first prompts | a long scripted run never sends a prompt over budget; `wait_subtasks` output ≤ 600 chars/child; accounting totals match LLM usage |
| P9 | **Nodes + remote access** | `alfred-node` daemon (laptop workspaces over an outbound WebSocket), routed tools + gate, HTTP MCP door, tailscale serve, PWA | a task whose workspace is on a (test) node writes files there and passes the gate there; the node going away parks the task loudly; door reachable over HTTP with a token |
| P10 | **Git hub + workspace modes** | bare hub repos on the Spark, `spark` remote in every workspace (Spark or Mac, over SSH), sandbox vs existing-repo (worktree or in-place) modes, repo registry, auto commit+push on done | see docs/phases/P10 |
| P11 | **Extension API** | plugins (tools, personas, sinks, MCP, routes, static UIs, event hooks), built-ins as plugins, `config/alfred.yaml`, `/api/v1` contract + docs/API.md + docs/EXTENDING.md | see docs/phases/P11 |
| P6 | **Soak** | real multi-hour goal + impossible goal | project Definition of Done in GOAL.md |

Order (2026-09-24, revised: **core + extensibility first; control-side UX is refined by Quinn later**):
wave 3 P2d/P2e/P3a → wave 4 P3b/P4a/P7 → wave 5 P11/P8 → wave 6 P4b (on top of P11) → wave 7 P9/P10 → wave 8 P5 (**functional shell only**: the acceptance views, no polish) → P6 soak.

## Ops prerequisites (Quinn)

- `sudo systemctl disable --now deck-server` (shuts down the old Mission Deck).
- Raise Qwen parallelism: `QWEN_NP=1` means subagents queue behind each other. Decision pending.
- Slack bot token + channel (needed by P3).
- Install `alfred-node` on the Mac (P9 ships `deploy/node-install.sh`).
- Start the Obsidian MCP on the Mac (`100.82.152.2:3556`, currently unreachable).

## Build workflow

The orchestrator (Claude) writes the spec and acceptance tests, dispatches one implementer
subagent per phase or sub-phase, then verifies by running the acceptance suite itself and
reading the diff. Findings and lessons go into `docs/LESSONS.md`.
