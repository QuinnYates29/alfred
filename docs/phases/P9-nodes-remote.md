# P9 — Nodes (laptop workspaces) + remote access

Status: **SPEC** · Branch: `p9-nodes` · Acceptance: `npx vitest run test/acceptance/p9`
Depends on: P1–P4 (runtime, gate, server, door). New dep: `ws` (installed).

Topology: **all compute (Qwen, agents, scheduler, store) runs on the Spark** (`gx10-de9a`, tailnet `100.89.202.75`). The MacBook and iPhone are clients.
A workspace is either local (the Spark) or on a **node**: a machine running `alfred-node`, which dials **out** to the Spark over the tailnet
(so the laptop needs no open ports, and sleeping or leaving is just "node offline").

## 1. Wire protocol (`src/node/protocol.ts`, shared by both sides)
WebSocket at `GET /api/nodes/connect?token=<ALFRED_TOKEN>` on the Alfred server.
- node → server first message: `{type:'hello', name, roots: string[] /* absolute */, caps: string[] /* 'fs','shell','git', optionally 'dsh' */, version}`
- server → node: `{type:'call', id, op, args}` with op ∈ `readFile{path}`, `writeFile{path, content}` (mkdir -p), `listDir{path}`,
  `exec{cmd, cwd, timeoutMs}`, `cancel{callId}`, `ping{}`
- node → server: `{type:'result', id, ok, value?, error?}`. For `exec`, value = `{exitCode, output /* tail ≤ 8000 */, timedOut}`.
- **The node enforces its roots:** every `path` / `cwd` is resolved with `realpath` (the nearest existing parent for new files) and must be
  inside one of `roots`, else `{ok:false, error:'outside node roots: …'}`. exec kills the process group on timeout/cancel.
- Heartbeat: server pings every 15 s; a node that misses 2 pings is dropped.

## 2. Server side (`src/node/hub.ts`)
```ts
export class NodeHub {
  constructor(o: { token?: string; callTimeoutMs?: number /* 60000; exec uses its own timeout + 10 s */ })
  attach(server: import('node:http').Server): void      // handles the upgrade on /api/nodes/connect
  list(): { name: string; roots: string[]; caps: string[]; connectedAt: number }[]
  backend(node: string): WorkspaceBackend                 // node === 'local' → LocalBackend; any call on an absent node rejects with NodeOfflineError
  onChange(cb: (e: { node: string; online: boolean }) => void): () => void
  close(): void
}
export class LocalBackend implements WorkspaceBackend {}   // fs + bash -c (process-group kill)
```
A second connection with the same name replaces the first (the first is closed).

## 3. Workspaces on nodes
- Goal meta: `{ node?: string /* default 'local' */, repo?: string /* path on that machine */ }`.
- `resolveWorkspace(store, task, {root, nodes}) → { backend: WorkspaceBackend; path: string }`:
  - local → exactly as `workspaceFor` today (dir or git worktree on the Spark).
  - node → `repo` required; the worktree is created **on the node** via `exec` (`git -C <repo> worktree add -b alfred/<slug>/<id8> <repo>/.alfred-worktrees/<id8> HEAD`,
    idempotent: if the dir exists, reuse it). Without git (caps lacks 'git' or the repo isn't a repo) → use `repo` directly.
- `RunOpts` gains `nodes?: NodeHub` and `workRoot?: string`. When `workspaceFor` is absent, the runtime calls `resolveWorkspace(store, task, {root: workRoot, nodes})` (async; the Scheduler and `startAlfred` pass `nodes` + `workRoot`). The runtime passes `ctx.backend`. **Built-in tools** (`read_file`, `write_file`, `list_dir`, `run_shell`) use `ctx.backend` when present
  (path checks against `ctx.workspace` still happen on the server too). **The gate** runs acceptance checks through the same backend (`verifyAndComplete`
  gets a runner built from `backend.exec`).
- Executors: `dsh_code` on a node requires cap `dsh` (the node runs `dsh --profile headless` there, pointing at the Spark's Qwen via the tailnet).
  Otherwise → `{ok:false, output:'dsh_code is not available on node <name>'}`. `pipeline_run` and `langgraph_code` are local-only in v1 and give the same kind of message on a node.
- **Node goes away mid-task:** any backend call → `NodeOfflineError` → the tool result carries `park: {status:'blocked', reason:'node <name> offline'}`.
  When that node reconnects, NodeHub `onChange` → main re-queues every task blocked with exactly that reason (note `node <name> back online`).

## 4. `alfred-node` (the laptop daemon): `src/node/client.ts` + `bin/alfred-node`
```ts
export function connectNode(o: { url: string /* ws(s)://host:port */; token?: string; name: string; roots: string[]; caps?: string[];
  reconnect?: boolean /* true: backoff 1 s → 30 s */; onNotify?: (n: {level: string; title: string; body: string; url?: string}) => void /* default: osascript / notify-send */ }): { close(): void; connected(): boolean }
```
It depends only on `ws` + Node stdlib (it has to run on the Mac with `npx tsx`). CLI:
`alfred-node --server wss://gx10-de9a.tail542084.ts.net:8443 --token $ALFRED_TOKEN --name macbook --root ~/code [--root …] [--dsh]`.
`deploy/node-install-macos.sh`: writes `~/Library/LaunchAgents/com.alfred.node.plist` (KeepAlive) from args. It is shipped, not run.

## 5. Remote access
- `createApp` / `startAlfred`: the Claude door is **also** served over Streamable HTTP MCP at `POST/GET /mcp` (same tools as the stdio door, same `ops.ts`),
  behind the token (Bearer header). Claude Code on the laptop: `claude mcp add --transport http alfred https://gx10-de9a.tail542084.ts.net:8443/mcp --header "Authorization: Bearer $ALFRED_TOKEN"`.
- `deploy/tailscale-serve.sh`: `tailscale serve --bg --https=8443 http://127.0.0.1:8790` (tailnet only, keeps the existing `/` → :3080 mapping for dsh-web).
- `startAlfred` refuses to bind a non-loopback host without `ALFRED_TOKEN` (throws). Tailscale serve lets it bind 127.0.0.1 by default.
- README "Using Alfred from the laptop and phone" section.

## Done when
`npx vitest run test/acceptance/p9` + all earlier suites + typecheck are green on `p9-nodes`.

## Addendum: the Mac is the primary client (2026-09-24)
Quinn works from the Mac almost all the time. Coding happens either on the Mac (through its node) or on the Spark, and is always driven from the Mac.
1. **Notifications reach the Mac.** Nodes may advertise cap `notify`. A `nodeNotifySink(hub)` (name `node`) sends `{type:'notify', level, title, body, url}`
   to every connected node with that cap. `alfred-node` shows it with `osascript -e 'display notification … with title "Alfred"'` on macOS
   (`notify-send` on Linux). Clicking opens nothing in v1; the body includes the dashboard URL. `sinksFromEnv` adds it when a hub is given.
   `ALFRED_NOTIFY_DESKTOP` defaults to `0` in the systemd unit (the Spark has no one at its screen).
2. **The markdown mirror can live in the Mac's Obsidian vault.** `ALFRED_MIRROR` = `local:/path` (default `local:~/vaults/alfred`) or `node:<name>:/abs/path`
   (e.g. `node:macbook:/Users/quinnyates/Vault/Alfred`). The node variant writes through the node backend (debounced as before). If the node is offline, the write is
   skipped and retried on the next event or on reconnect, and it never fails a task. The node's roots must include that folder.
3. **Every executor works on a Mac workspace.**
   - `langgraph_code`: the sidecar still runs on the Spark (Python + Qwen are there), but on a node workspace its three file tools and the test command go
     through a **file bridge**. The TS adapter serves a one-shot localhost HTTP endpoint (`POST /fs {op, path, content?}`, `POST /exec {cmd}`) backed by
     `ctx.backend`, and passes `bridgeUrl` in the sidecar's stdin JSON. When `bridgeUrl` is present, the sidecar uses it instead of the local filesystem.
   - `pipeline_run` on a node: `{ok:false}` with the message "pipeline_run needs a Spark workspace; use dsh_code or langgraph_code" (the pipeline clones repos
     and needs a local git). The coder persona prompt mentions this.
   - `dsh_code` on a node needs cap `dsh` (DSH installed on the Mac, pointed at `http://gx10-de9a:1110/v1` over the tailnet). `deploy/node-install-macos.sh --with-dsh`
     writes that DSH settings overlay. Without it → `{ok:false}` pointing to langgraph_code.
4. **CLI from the Mac:** `bin/alfred` works unchanged on the Mac with `ALFRED_URL=https://gx10-de9a.tail542084.ts.net:8443` and `ALFRED_TOKEN`
   (only Node + tsx are needed; `deploy/node-install-macos.sh` also installs an `alfred` shim).
