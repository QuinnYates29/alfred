# P14 — Ops & stats API (run the Spark from the Mac)

Status: **SPEC** · Branch: `p14-ops` · Acceptance: `npx vitest run test/acceptance/p14/`
Scope (files you own): `src/ops/**` (plus `test/unit/ops*.test.ts`). Do NOT edit `src/main.ts`, `src/server/app.ts`, `src/modules.ts`, `src/store.ts`, `test/acceptance/**`.

Everything Quinn used to SSH into the Spark for becomes an API call: services, the Qwen server, logs, config files,
the Qwen build harness, the repo registry, and live statistics (GPU, host, Qwen slots, token usage).

## 1. Module seam
`src/ops/index.ts` exports `createOpsModule(deps: ModuleDeps): AlfredModule` → `{ name: 'ops', router }`. Split the code:
`stats.ts`, `services.ts`, `qwen.ts`, `logs.ts`, `config-files.ts`, `dispatch.ts`, `repos.ts`, `routes.ts`.

**Injection (tests use every one of these; production falls back to the real thing):**
```ts
deps.extra.exec?: (cmd: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>
   // default: child_process.execFile, never throws (non-zero exit → code), default timeout 30 s, maxBuffer 8 MB
deps.extra.spawnDetached?: (cmd: string, args: string[], o?: { cwd?: string; delayMs?: number }) => void
   // default: setTimeout(delayMs ?? 0) then spawn(cmd, args, { detached: true, stdio: 'ignore', cwd }).unref()
deps.extra.fetch?: typeof fetch                    // default global fetch
deps.extra.qwenUrl?: string                        // default env.QWEN_URL ?? first model's baseUrl in deps.models ?? 'http://127.0.0.1:1110'
deps.extra.qwenEnvPath?: string                    // default env.QWEN_ENV_FILE ?? ~/.config/qwen-server.env
deps.extra.dispatchDir?: string                    // default <repoRoot>/.dispatch
deps.extra.backupDir?: string                      // default <repoRoot>/.alfred-backup
```
Every mutating route requires `confirm: true` in the body (else **400** `{error:'confirm required'}`) and records a system event
`store.appendEvent('', null, 'ops', { action, target, ok, by: body.by ?? 'api' })`.

## 2. Stats
`GET /stats` →
```ts
{ ts: number,
  host: { hostname: string, uptimeS: number, load: [number, number, number], cpus: number, mem: { totalMb: number, usedMb: number },
          disk: { path: '/', totalGb: number, usedGb: number } | null },
  gpu: { name: string, utilPct: number, smMhz: number, tempC: number, powerW: number, memUsedMb: number | null } | null,
  qwen: { ok: true, url: string, slots: { id: number, processing: boolean, nCtx: number, promptTokens: number }[], busy: number, total: number }
      | { ok: false, url: string, error: string },
  tokens: { last1h: { prompt: number, completion: number, turns: number }, last24h: { prompt: number, completion: number, turns: number },
            byPersona24h: Record<string, { prompt: number, completion: number }> },
  tasks: { running: number, queued: number, parked: number /* blocked + needs_claude */, done24h: number, failed24h: number },
  goals: { active: number, done: number, failed: number } }
```
- host from `node:os`; disk from `exec('df', ['-k', '/'])` (second line: 1K-blocks, used) → GB with 1 decimal; failure → null.
- gpu from `exec('nvidia-smi', ['--query-gpu=name,utilization.gpu,clocks.sm,temperature.gpu,power.draw,memory.used', '--format=csv,noheader,nounits'])`.
  First line, comma-separated, trimmed; numbers parsed with `Number`; `[N/A]`/non-numeric → null for memUsedMb (and 0 for the others). Exit ≠ 0 → `gpu: null`.
- qwen from `fetch(<qwenUrl>/slots)` (timeout 3 s): each slot `{id, is_processing, n_ctx, n_prompt_tokens}`. Error → `{ok:false, url, error}`.
- tokens from `turn` events (`data.usage.promptTokens/completionTokens`) with `ts` in the window, persona from the task (SQL join on `store.raw()`).
- tasks.done24h / failed24h: `transition` events into `done` / `failed` in the last 24 h. running/queued/parked: current task statuses.

`GET /stats/history?hours=24&bucket=3600` (hours ≤ 168, bucket seconds ≥ 60) → ascending buckets covering the window, every bucket present
(zeros when empty): `[{ t /* bucket start ms */, prompt, completion, turns, done, failed }]`.

## 3. Services
`GET /ops/services` → `[{ name, unit, controllable: string[], active: string, sub: string, since: number | null, pid: number | null, memMb: number | null, url?: string }]` for:
- `alfred` → unit `alfred.service`, controllable `['restart']`
- `qwen-server` → unit `qwen-server.service`, controllable `['start','stop','restart']`
- `deck` (Mission Deck, supervised by alfred) → no unit (`unit: null`), controllable `[]`, `active` = `'active'` if `deps.deckState.url` else `'inactive'`, `url`.
Unit state: `exec('systemctl', ['--user', 'show', <unit>, '--property=ActiveState,SubState,ActiveEnterTimestampMonotonic,ExecMainStartTimestamp,MainPID,MemoryCurrent'])`,
lines `Key=Value`. `active`=ActiveState, `sub`=SubState, `pid`=MainPID (0 → null), `memMb`=MemoryCurrent/1048576 rounded ([not set] → null),
`since` = `Date.parse(ExecMainStartTimestamp)` (invalid → null).

`POST /ops/services/:name/:action` body `{confirm:true, force?:boolean, by?}`:
- unknown service → 404; action not in `controllable` → 400.
- `qwen-server` stop/restart while the scheduler has running tasks (`deps.scheduler?.running().length`) and not `force` → **409** `{error, running: [taskIds]}`
  (restarting the model kills in-flight agent calls).
- qwen-server: `exec('systemctl', ['--user', <action>, 'qwen-server.service'], {timeoutMs: 120000})` → `{ok: code===0, output}`.
- alfred restart: respond `202 {ok:true, restarting:true}` FIRST, then `spawnDetached('systemctl', ['--user','restart','alfred.service'], {delayMs: 500})`.
  (Running tasks are requeued by the P12b shutdown path.)

## 4. Qwen server
`GET /ops/qwen` → `{ env: Record<string,string> /* every QWEN_* KEY=VALUE line of the env file, quotes stripped */, health: boolean /* fetch <url>/health ok */,
  presets: ['fast','balanced','lean','min-ram'], limits: { slots: [1,8], ctx: [1024,262144], offload: [0,48] } }`.
`POST /ops/qwen` body `{confirm:true, force?, preset? | slots? | ctx? | offload? | extra?}` — exactly one setting, else 400.
Validation per `limits`; preset must be in `presets`. Same running-tasks rule as qwen-server restart (409 without force).
Runs `exec('qwenctl', [<verb>, String(value)], {timeoutMs: 300000})` with verb `preset|slots|ctx|offload|extra` → `{ok, output}` (output = stdout+stderr tail ≤ 4000).

## 5. Logs
`GET /ops/logs/:name?lines=200` (1..2000) → `{ name, lines: string[] }`.
- `alfred` → `exec('journalctl', ['--user', '-u', 'alfred.service', '-n', N, '--no-pager', '-o', 'short-iso'])`
- `qwen-server` → `exec('qwenctl', ['logs', N])`
- unknown → 404. Output split on `\n`, trailing empty line dropped.

## 6. Config files (edit personas / models / alfred.yaml from the Mac)
Paths are **repo-relative** and must match `^(personas/[A-Za-z0-9_.-]+\.ya?ml|config/[A-Za-z0-9_.-]+\.(ya?ml|json))$` (no `..`), else 400.
`personas/…` maps into `deps.personasDir`; `config/…` into `<repoRoot>/config`.
- `GET /ops/config` → `[{ path, kind: 'persona'|'models'|'alfred'|'mcp'|'other', size, mtime }]` for every existing matching file (sorted by path).
  kind: personas/* → persona; config/models*.yaml → models; config/alfred*.yaml → alfred; config/mcp*.json → mcp.
- `GET /ops/config/file?path=` → `{ path, content, mtime }`; missing → 404.
- `PUT /ops/config/file` `{ path, content, mtime?, confirm: true }`:
  - `mtime` given and ≠ the file's current mtime (ms, `Math.floor(stat.mtimeMs)`) → **409** (someone else edited it).
  - Validate BEFORE writing (400 with the error message on failure, file untouched):
    `.json` → JSON.parse; `.yaml` → `yaml` parse; persona → copy the whole personas dir to a temp dir with the new content and run
    `loadPersonas(tmp, deps.registry)` (budget + unknown tools are errors); models → `loadModels(tmpFile)` (from `src/models.ts`).
  - Back up the previous content (if any) to `<backupDir>/<path>.<Date.now()>`, write, then reload:
    persona → `deps.reloadPersonas?.()` (returned errors go in `warnings`); models → `deps.models?.reload()`.
  - → `{ ok: true, path, mtime, reloaded: ('personas'|'models')[], warnings: string[] }`.

## 7. Build harness (the Qwen dispatch used to build alfred itself)
- `GET /ops/dispatch` → `[{ name, branch, state, attempt, ts }]` from `<dispatchDir>/*/status.json` (unparseable → skipped).
- `GET /ops/dispatch/:name` → `{ status, log: string[] /* last 100 lines of run.log */, check: string | null /* highest-numbered check<N>.txt */ }`; 404.
- `POST /ops/dispatch` `{ name /* ^[A-Za-z0-9_-]+$ */, branch /* ^[A-Za-z0-9._/-]+$ */, promptFile /* repo-relative, must exist */, check, attempts?=4, timeoutMin?=60, confirm }`
  → 409 if 3 or more statuses are `running`; else
  `spawnDetached('bash', [<repoRoot>/scripts/qwen-task.sh, name, branch, <abs promptFile>, check, String(attempts), String(timeoutMin)], { cwd: repoRoot })` → 202 `{ ok: true, name }`.

## 8. Repos (P10 registry)
- `GET /ops/repos` → `[{ ...Repo, branches: string[] /* deps.repoHub.branches(name), [] on error */ }]`
- `POST /ops/repos` `{ name /* ^[A-Za-z0-9._-]+$ */, paths: Record<string,string>, defaultBranch?, confirm }` → `store.upsertRepo`; if `paths.local`
  exists on disk → `await deps.repoHub.ensure(name, paths.local)` → 201 Repo.

## 9. Web rebuild
`POST /ops/alfred/build-web` `{confirm}` → `exec('npm', ['run', 'build:web'], { cwd: repoRoot, timeoutMs: 600000 })` → `{ ok, output /* tail 4000 */ }`.

## Done when
`npx vitest run test/acceptance/p14/` passes; earlier suites + `npx tsc --noEmit` stay green.
