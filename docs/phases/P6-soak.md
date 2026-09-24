# P6 — Soak: the "trust it" proof

Status: **SPEC** · Run by the orchestrator against the deployed `alfred serve` (systemd user unit) with real Qwen.

## S1. Real multi-hour coding goal (must end `done`)
Fresh repo `~/repos/alfred-soak/mdconv` (git init, `package.json` with `"type":"module"`, empty `src/`).
Goal (persona `alfred`, repo = that dir): *"Build `mdconv`, a zero-dependency Node CLI that converts a Markdown subset to HTML:
headings, paragraphs, emphasis/strong, inline code, fenced code blocks, links, unordered/ordered lists, blockquotes. `node bin/mdconv.js in.md > out.html`."*
Acceptance (hold-out tests live **outside** the workspace; the agents see the command, not the tests):
- `node --test /home/quinna/repos/alfred/test/soak/mdconv/*.test.mjs` with env `MDCONV=<ws>/bin/mdconv.js`
- `test -f README.md`
Budget: wall clock 6 h, turns 120, maxSubtasks 4, maxDepth 2. alfred is expected to spawn coder/coder-lg children.
**Pass:** goal `done`, the hold-out suite green when re-run by the orchestrator, the mirror shows `DONE`, and no watchdog event other than the ones it recovered from.

## S2. Impossible goal (must fail loudly, within budget)
Goal (persona `coder`): *"Make `sha256(answer.txt)` equal `0000000000000000000000000000000000000000000000000000000000000000`."*
Acceptance: `test "$(sha256sum answer.txt | cut -d' ' -f1)" = 0000000000000000000000000000000000000000000000000000000000000000`.
Budget: wall clock 30 min, turns 25.
**Pass:** the goal ends `failed` (give_up) or `stopped` (budget/watchdog) with a non-empty reason, within 35 min; a desktop notification fired
(journal / notify log); the dashboard shows a failure card; the mirror shows `FAILED` with the reason. **Never `done`.**

## S3. Stall
Point a throwaway Alfred instance's LLM at a black-hole HTTP server that accepts and never answers. Expect a `stopped` 'stall' within stallMs + 10 %.

## S4. Claude door
`claude mcp add alfred -s user -e ALFRED_DB=$HOME/.alfred/alfred.db -- ~/repos/alfred/bin/alfred-door`. Then park a task with `ask_claude` and complete it
through the door from a Claude Code session (the P3 stdio test already covers the protocol; S4 proves the installed command works).

## S5. Crash recovery
While S1 runs, `systemctl --user restart alfred`. Expect the running tasks' leases to expire and be reclaimed, the retries to show `## Notes from previous attempts`, and the goal to still finish.

Results go in `docs/SOAK.md` with timings, token counts, and every failure seen.
