# P19 — CLI v2 (the quick backup to the app and the website)

Status: **SPEC** · Branch: `p19-cli` · Acceptance: `npx vitest run test/acceptance/p19/`
Scope (files you own): `src/cli.ts` (you may split into `src/cli/*.ts` and keep `src/cli.ts` as the entry), `scripts/build-cli.mjs`,
`package.json` (scripts only), `test/unit/cli*.test.ts`. Do NOT edit server code or `test/acceptance/**`.

Every command talks to the HTTP API (docs/API.md, and the phase docs P13–P16 for board/ops/review/chat). The CLI must run on the Mac
with only Node installed: `npm run build:cli` bundles it with esbuild (already in node_modules) into ONE file `dist/alfred.mjs`
(`#!/usr/bin/env node` banner, platform node, format esm, target node20, all dependencies bundled). `serve` stays in the source entry only:
the bundle must not import server code (put `serve` behind a dynamic `import('./main.js')` that the bundle marks external, or exclude it).

## Connection
`ALFRED_URL` / `ALFRED_TOKEN` env win; else `~/.config/alfred/cli.json` `{ url, token }` (path overridable with `ALFRED_CLI_CONFIG`); else `http://127.0.0.1:8790`.
`alfred login --url <u> --token <t>` writes that file (mode 0600, dirs created), then checks `/api/v1/health` and prints `ok: <url>`.
Global flags: `--json` (print the raw API JSON instead of text), `--yes` (skip confirmations), `-h/--help`.
Errors: one line `alfred: <message>` on stderr, exit 1. Unknown command → usage + exit 2.

## Commands (text output is compact: one line per thing; the tests match the fragments shown)
| Command | API | Text output (fragments tests check) |
|---|---|---|
| `status` `show <goal>` `goal …` `stop` `retry` `approve` `tail` | existing | unchanged (keep the P4 behaviour and tests) |
| `inbox` | approvals?status=pending, goals, goal details for attention goals, items?label=needs-attention | sections `Approvals`, `Parked`, `Failed goals`, `Board`; each entry one line with its id8/key; all empty → `Inbox zero.` |
| `board [--board K] [--status s] [--mine]` | boards, items | per column: `== <Column name> (<n>)` then `  <KEY> (<prio>) <title> @<assignee> due:<d>` (omit empty parts); `--mine` = assignee quinn |
| `add "<title>" [--status s] [--prio p] [--label l]… [--assign a] [--due d] [--desc text] [--board K]` | POST items | `created <KEY>` |
| `item <KEY>` | GET items/:key | title line `<KEY> [<status>] <title>`, then fields, description, checklist `[x] text`, comments `<author>: <body>`, linked goals `<slug> [status]` |
| `mv <KEY> <status>` · `done <KEY>` · `comment <KEY> "<text>"` | move / move done / comments | `<KEY> → <status name>` · `<KEY> → Done` · `commented on <KEY>` |
| `edit <KEY> [--title t] [--prio p] [--assign a] [--due d] [--label l]… [--desc text]` | PATCH | `updated <KEY>` |
| `send <KEY> [--persona p] [--repo r] [--node n] [--check name=cmd]…` | POST items/:key/dispatch | `sent <KEY> → goal <slug> (<persona>)` |
| `ask "<text>" [--thread id]` | POST /chat | the reply text, then `(thread <id>)` on stderr |
| `chat [--thread id]` | same, interactive (readline, `you> ` prompt, `/quit`) | — |
| `stats` | GET stats | lines starting `GPU`, `Qwen`, `Tokens 24h`, `Tasks`, `Host` |
| `svc` · `svc <restart\|start\|stop> <name> [--force]` | ops/services | `<name> <active>/<sub> pid <pid> since <iso>` · asks `Really <action> <name>? [y/N]` unless `--yes`; prints `ok` |
| `qwen` · `qwen <preset\|slots\|ctx\|offload> <value> [--force]` | ops/qwen | env lines `QWEN_X=…` + `health ok\|down` · confirmation as above |
| `logs <name> [-n N] [-f]` | ops/logs | the lines; `-f` polls every 2 s and prints only lines not yet printed |
| `diff <goal> [--file p]` | goals/:id/changes | `branch <b> (base <base>)`, `<status> <path> +a -d` per file, then the diff (or the file diff) |
| `merge <goal> [--squash] [--into b] [--keep-branch]` · `discard <goal>` | merge / discard | confirmation; `merged <branch> into <into> @ <sha7>` · `discarded <branches>` |
| `transcript <taskId>` | tasks/:id/transcript | `turn N: <text>` / `  → <name> <args>` / `  ← <ok\|err> <output first line>` / `[<from>→<to>] <reason>` |
| `files <goal> [path]` · `cat <goal> <path>` | goals/:id/files · file | `<name>/` for dirs · raw content |
| `config ls` · `config get <path>` · `config edit <path>` · `config set <path> <localFile>` | ops/config | `<path> <kind> <size>` · raw content · `$EDITOR` on a temp file then PUT with mtime (unchanged → `no changes`) · PUT → `saved <path> (reloaded: …)` |
| `builds` · `build <name>` | ops/dispatch | `<name> <state> attempt <n> <branch>` · status + log tail + check |
| `nodes` · `models` · `personas` | existing routes | one line each |
| `open [goal\|KEY]` | — | opens `<url>/#/goal/<id>` or `<url>/#/board/<KEY>` (or `<url>/`) with `open` (macOS) / `xdg-open`; with `--print` just prints the URL |

Confirmations: mutating ops routes need `confirm: true` in the body — send it after the user confirms (or with `--yes`).
With stdin not a TTY and no `--yes`, refuse: `alfred: refusing to <action> without --yes (not a terminal)`.

## Done when
`npx vitest run test/acceptance/p19/` + earlier suites + `npx tsc --noEmit` are green, and `npm run build:cli` produces a `dist/alfred.mjs` that runs
from an empty directory with plain `node` (no node_modules).
