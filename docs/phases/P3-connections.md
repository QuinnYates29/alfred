# P3 — Connections: MCP hub, notification sinks, approvals, Claude door

Status: **SPEC** · Branch: `p3-connections` · Acceptance: `npm run test:p3` (do not edit `test/acceptance/p3/`)
Depends on: P0, P1, P2 (`goal.meta`, `src/workspace.ts`).
New deps allowed: `@modelcontextprotocol/sdk`, `zod`.
Reference (read-only): `~/repos/ai-task-dashboard/server/src/{mcpclient,obsidian}.ts`, `server/mcp/server.ts`.

Slack and the Mac Obsidian MCP are **not live yet**; Quinn connects them later. Everything must work with them
absent: missing config means the feature is off with a warning, never a crash. It all must be testable with fakes.

## 1. `src/connectors/mcp.ts`, the MCP hub
```ts
export interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string, string>;    // stdio
  url?: string; headers?: Record<string, string>;                      // streamable HTTP
  disabled?: boolean;
  readOnly?: boolean;          // default true. Hides write-like tools
  allowWrite?: string[];       // write-like tool names still exposed on a readOnly server
}
export class McpHub {
  constructor(cfg: { servers: Record<string, McpServerConfig> }, o?: { connectTimeoutMs?: number /* 15000 */ })
  connectAll(): Promise<void>          // never rejects. Calling it again retries only the failed/unconnected servers
  status(): { name: string; ok: boolean; tools: string[]; error?: string }[]
  tools(): Tool[]                      // runtime Tools named `<server>_<tool>` (non [a-zA-Z0-9_] → _)
  close(): Promise<void>
}
export function loadMcpConfig(path: string, env?: Record<string, string | undefined>): { servers: Record<string, McpServerConfig> }
  // missing file → {servers:{}}. `${VAR}` in any string value is replaced from env (a missing var → '').
```
- Write-like = tool name matching `/(write|create|update|delete|append|move|rename|patch|put|remove|edit)/i`.
- **Hard rule:** any string anywhere in the arguments (deep) matching `/(^|\/)Independent(\/|$)/i` → `{ok:false, output:'Independent/ is off-limits'}` **without calling the server**.
- Result text = the text contents joined by `\n`, truncated to 8000. An `isError` result or a thrown call → `ok:false`.
- Ship `config/mcp.example.json` with an `obsidian` entry: `url: "http://100.82.152.2:3556/mcp"`, `headers: {Authorization: "Bearer ${OBSIDIAN_MCP_TOKEN}"}`. `config/mcp.json` is gitignored.

## 2. `src/notify/sinks.ts`
```ts
export function desktopSink(o?: { exec?: (cmd: string, args: string[]) => Promise<void> }): Sink
  // name 'desktop'. notify-send -a Alfred -u <critical|normal|low for failure|warn|info> "<title>" "<body>"
export function slackSink(o: { webhookUrl?: string; botToken?: string; channel?: string; dashboardUrl?: string; fetch?: typeof fetch }): Sink
  // name 'slack'. webhook → POST {text}. bot → POST https://slack.com/api/chat.postMessage {channel,text} with Bearer.
  // Non-2xx, or a bot reply with ok:false → throw (the Notifier records it). text starts with ':rotating_light:' (failure),
  // ':warning:' (warn) or ':information_source:' (info), contains title and body, and `${dashboardUrl}/#/goal/${goalId}` when set.
export function markdownSink(store: Store, dir: string): Sink    // name 'markdown': writeMirror(store, n.goalId, dir)
export function sinksFromEnv(env: Record<string, string | undefined>, store: Store, mirrorDir: string):
  { sinks: Sink[]; warnings: string[] }
  // always desktop + markdown. slack only if SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN + SLACK_CHANNEL; otherwise
  // the warning 'slack not configured'. ALFRED_DASHBOARD_URL → dashboardUrl.
```

## 3. Approvals (`src/approvals.ts` + store + runtime)
```ts
export function guardCommand(cmd: string): string | null   // name of the matching guard, or null
```
Guards (at minimum): `git push`, `gh pr create|merge`, `gh release`, `npm publish`, `docker push`, `sudo`, `ssh `/`scp `,
`systemctl` (except `systemctl --user status|is-active`), `curl`/`wget` sending data (`-X POST|PUT|DELETE`, `-d`, `--data`, `-F`)
to a host that is not localhost/127.0.0.1, `rm -rf` of `/` or `~` or `$HOME`, `shutdown`/`reboot`.

Store additions: `requestApproval(taskId, action, detail): Approval`, `decideApproval(id, 'approved'|'denied', by): Approval`,
`approvals({status?}): Approval[]`, `consumeApproval(taskId, detail): boolean` (true once for an approved match, then spent).
`Approval = {id, taskId, goalId, action, detail, status: 'pending'|'approved'|'denied', createdAt, decidedAt, decidedBy}`. Events `approval_requested` / `approval_decided`.
- Deciding an approval whose task is `blocked` → `queued`, with a note `approved: <detail>` or `denied: <detail> — find another way`.

Runtime: `ToolResult` gains an optional `park?: { status: 'blocked' | 'needs_claude'; reason: string }` (add it to the contract).
The agent loop must honour it: transition to that status with that reason and return. `run_shell`: if `guardCommand(cmd)`
and not `consumeApproval(taskId, cmd)` → `requestApproval` + `park blocked` with reason `approval needed: <guard>: <cmd>`.
After approval, the re-run task executes that exact command once.

Goal reactivation: creating a task on a `done`/`failed` goal sets it back to `active` (event `goal_status`).

## 4. Claude door: `src/door/server.ts` (MCP over stdio)
Run: `npx tsx src/door/server.ts` with env `ALFRED_DB` (path) and optional `ALFRED_WORK_ROOT`. Opens the store directly.
Tools (all names exact; every result is JSON text):

| Tool | Args | Does |
|---|---|---|
| `alfred_status` | – | `{goals:[{id,slug,title,status,counts}], parked:[{taskId,title,status,reason}], approvals:[pending…]}` |
| `alfred_goal` | `goal` (id or slug) | goal + tasks + last 30 events |
| `alfred_claim` | `taskId` | from `needs_claude`: → `running`. From `blocked`/`queued`: → queued → claim. Worker `claude`, lease 4 h. Returns `{task, workspace, acceptance, notes, events}`. Refuses terminal tasks with an error telling Claude to use `alfred_retry`. |
| `alfred_note` | `taskId, text` | appendNote |
| `alfred_complete` | `taskId, summary` | → verifying → gate. Returns `{ok, results}`. On failure the task is back in `running` (Claude keeps it). |
| `alfred_release` | `taskId, note` | running → queued with the note (hand back to the Qwen agents) |
| `alfred_fail` | `taskId, reason` | → failed |
| `alfred_retry` | `taskId, note?` | for a failed/stopped task: a new queued task, same goal/parent/persona/spec/acceptance, notes = old notes + note. Returns the new id. |
| `alfred_create_goal` | `title, body?, persona, spec, acceptance[], repo?` | goal (meta.repo) + one root task |
| `alfred_approve` | `approvalId, decision: approved\|denied` | decideApproval by `claude` |

Errors → MCP `isError: true` with a message. Never crash the server.
Ship `bin/alfred-door` (bash: `exec npx --prefix <repo> tsx <repo>/src/door/server.ts`) and document in README:
`claude mcp add alfred -e ALFRED_DB=$HOME/.alfred/alfred.db -- ~/repos/alfred/bin/alfred-door`.

## Done when
`npm run test:p3` + the full suite + typecheck are green, committed on `p3-connections`.
