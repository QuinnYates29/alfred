# P21 — Agent powers: agents run the platform, its connectors, its own code, and can text and call

Status: **SPEC** · Branches: `p21a-platform`, `p21b-comms` · Acceptance: `npx vitest run test/acceptance/p21/`
Depends on: P13 board, P14 ops, P16 chat (merged first).

Quinn wants the agents (alfred in chat and in goals) to know that they control most of the system, and to actually be able to use
it: manage tasks, run and reconfigure the platform, add or fix connectors, change the dashboard's own code, and text or call people.
**Autonomy rule (GOAL.md, unchanged): reading is free; changing the platform, external messages, calls and deploys need Quinn's
approval**, except where Quinn pre-approved something in config (below). Approvals use the existing mechanism
(`store.requestApproval` → Inbox / Mac notification / Slack buttons); an approved request is spent once with `consumeApproval`.

## Shared rules
- Paths: config files live under `<root>/config/` where `root = deps.extra.repoRoot ?? deps.repoRoot` (tests pass a temp root). The MCP config file is `deps.mcpConfigPath`.
- Tools read deps lazily (store/hub/nodes/selfUrl/token are assigned during startup).

## The approval gate for tools (`src/powers/gate.ts`, P21a)
`gated(ctx, action: string, detail: string, run: () => Promise<ToolResult>): Promise<ToolResult>`:
- When the task was pre-approved for exactly this `detail` (`store.consumeApproval(taskId, detail)`) → run it.
- Else when `detail` is allowed by policy (`config/powers.yaml`, below) → run it (the event log records `power {action, detail, auto:true}`).
- Else `requestApproval(taskId, action, detail)` and return `{ ok:false, output:'approval needed: <action>: <detail>', park:{status:'blocked', reason:'approval needed: <action>'} }`
  (the task resumes after Quinn approves, exactly like the run_shell guard).
- In chat (ctx.taskId starts with `chat:`) there is no task to park, and Quinn is in the conversation: return
  `{ok:false, output:'needs Quinn’s OK: <action>: <detail> — ask him, then call again with confirm:true'}`; a chat call with `confirm: true` runs it.
Every gated call records a `power` system event `{action, detail, outcome: 'ran'|'parked'|'asked', auto?}`.
`config/powers.yaml` (optional; missing = everything mutating needs approval):
```yaml
autoApprove:
  - action: board            # board edits never need approval (they are Quinn's own lists)
  - action: message
    to: ["+15551234567", "Mom"]   # texting these contacts is pre-approved
  - action: ops
    detail: "qwen:status"     # exact detail strings, or a prefix ending in '*'
```

## P21a — platform, connectors, self-development, capability card
Scope: `src/powers/**` (new), `personas/alfred.yaml`, `personas/researcher.yaml` (tools + one line each), `src/chat/tools.ts` + `src/chat/prompt.ts`
(add the new tools to chat), `web/src/views/system/Connectors.jsx` + one line in `web/src/views/System.jsx` to add the tab, `config/powers.example.yaml`.
The module: `src/powers/index.ts` exports `createPowersModule(deps)` → `{ name:'powers', router, tools }`; the orchestrator adds it to MODULES
after chat (already done in `src/main.ts`).

1. **Capability card** `src/powers/card.ts` — `capabilityCard(deps): string`, ≤ 900 estimated tokens, built live: what the agent can do
   and with which tool (board, platform, connectors, alfred_dev, message, call, contacts, start_goal/spawn_subagent), which nodes are online,
   which connectors are connected, what needs approval. The chat engine appends it to its system prompt; the tool `platform({op:'capabilities'})`
   returns it for goal agents. alfred.yaml's prompt gets one line: "You run this platform: call platform({op:'capabilities'}) to see
   everything you can control."
2. **`platform` tool** (one tool, op-based, ≤ 450 schema tokens), backed by the ops module (`deps.modules.ops`) via **in-process HTTP**:
   call the app's own routes with `fetch(deps.selfUrl + '/api/v1/…')` (deps.selfUrl is set by main after listen; read it lazily) with
   `Authorization: Bearer <token>` when a token is configured (`deps.token`). Ops:
   - read (free): `capabilities`, `status` (goals/tasks counts + running), `stats`, `services`, `qwen`, `logs {name, lines}`, `config_list`, `config_get {path}`, `models`, `nodes`, `repos`
   - mutating (gated, action `ops`): `service {name, action}` (detail `service:<name>:<action>`), `qwen_set {preset|slots|ctx|offload}` (detail `qwen:<k>=<v>`),
     `config_set {path, content}` (detail `config:<path>`; the approval detail must include a sha256 of the content so an approved change can't be swapped),
     `model_role {role, model}` (detail `role:<role>=<model>`), `automation {name, cron, title, persona?, spec?}` / `automation_delete {id}`.
   Output is compact text, never raw JSON over 4000 chars.
3. **Connectors** (`src/powers/connectors.ts` + routes): the MCP servers alfred uses (config `config/mcp.json`, format of `loadMcpConfig`).
   HTTP: `GET /connectors` → `[{name, transport, ok, tools: string[], error?}]` (config + live status from the MCP hub);
   `POST /connectors {name, command?, args?, url?, env?, headers?, confirm:true}` → validates, writes `config/mcp.json` (backup like P14), reconnects;
   `DELETE /connectors/:name {confirm:true}`; `POST /connectors/:name/reconnect`. Needs a hub reload: implement `reloadMcp()` in the powers module by
   calling `deps.hub.reconfigure(servers)` — the orchestrator adds `hub` to ModuleDeps and `McpHub.reconfigure(servers)` (close removed/changed, connect new).
   Tool `connectors({op:'list'|'add'|'remove'|'reconnect', …})`, add/remove gated (action `connectors`, detail `connector:<name>:<add|remove>`).
   UI: System → **Connectors** tab: list with status chips + tools count, Add form (name; transport stdio → command/args/env, or http → url/headers), Remove, Reconnect.
4. **Self-development** `alfred_dev` tool (the agents can change alfred itself, safely):
   - `propose {title, spec, area?: 'web'|'server'|'app'|'cli'}` → starts a goal with persona `coder` on repo `alfred` (ALF-7: sandbox clone, not a worktree — see below; registered on first use:
     `store.upsertRepo({name:'alfred', paths:{local: deps.repoRoot}})`), `mode: 'repo'` (a worktree; never in place), acceptance
     `npm run build:web` (area web) + `npx vitest run test/acceptance/ test/unit/` + `npx tsc --noEmit -p tsconfig.src.json`. Not gated (it only creates a branch).
     Output: `started goal <slug>: review it in Goals → Changes, then deploy`.
   - `status {goal}` → the goal's status and its pushed branch.
   - `deploy {goal}` → gated (action `deploy`, detail `deploy:<goal slug>`): merge the goal's branch into master (`POST /goals/:id/merge`), then
     `POST /ops/alfred/build-web`, then (only when the diff touched `src/` or `personas/` or `config/`) `POST /ops/services/alfred/restart`. Reports each step.
   The persona prompt line: "To change the dashboard or alfred itself, use alfred_dev: propose → Quinn reviews → deploy."
   **ALF-7 additions (2026-09-30)** — any goal on repo `alfred` (alfred_dev, a board item, the API), not only proposals:
   - Repo `alfred` → `repoRoot` is registered at boot (`ensureSelfRepo`), so a board item can name it before any propose.
     Goal creation (every path, `createGoalWithRoot`) and `PATCH /goals/:id` refuse a repo that is not a registered name,
     a registered path or an absolute path (`checkRepo`) — it used to fail only inside the scheduler.
   - Workspace: sandbox only — an isolated hub clone (`meta.mode: 'sandbox'`, set at creation and by propose; `mode: 'repo'`
     or `inPlace` are refused by goal creation, PATCH and `resolveWorkspace`), so an agent can't move the live checkout's refs.
     (Quinn, 2026-09-30: the P21 acceptance test now expects `mode: 'sandbox'`.) `node_modules` and `web/node_modules` are symlinked from `repoRoot`
     and mounted read-only in the bwrap sandbox (`registerSharedReadonly`), so the dev gate can run.
   - No acceptance → `devAcceptance()` (also on retry of a check-less task).
   - Jev triage (`src/jev/triage.ts`): a `git push` (to anything but the hub's `spark`) from such a goal always goes to Quinn;
     `deploy` can't be removed from `approvals.alwaysAsk` by `config/jev.yaml`.
   - `deploy` (and `rollback`) refuse to rebuild/restart when the merge didn't fast-forward `repoRoot` (`localUpdated: false`).
   - `propose {…, review: true}` → `meta.peerReview` (P15 §4c); `review {goal}` runs coder-lg's peer review and waits for it;
     `deploy` of an opted-in goal refuses (no approval asked) unless that review `approve`d exactly the commit it would land.
   - `rollback {goal}` → gated (action `deploy`, detail `rollback:<slug> <merge sha>`): `POST /goals/:id/revert` (P15 §4b), then
     the same build-web / Mac app / restart steps as deploy. HTTP for the dashboard button: `POST /goals/:id/rollback {confirm:true}`
     (a non-alfred goal just gets the revert).

## P21b — people: contacts, texting, calling
Scope: `src/comms/**` (new module `createCommsModule`, after powers), `src/node/client.ts` + `src/node/protocol.ts` + `src/node/hub.ts` (new node ops + `call`),
`deploy/node-install-macos.sh` (`--messages` flag), `config/contacts.example.yaml`, `personas/alfred.yaml` (tools), `src/chat/tools.ts` (add tools),
`web/src/views/system/Contacts.jsx` + tab line.
1. **Contacts** `config/contacts.yaml` (`[{name, phone?, email?, imessage?, notes?}]`), read fresh on each call. Tool `contacts({op:'find', q})` / `list`.
   HTTP `GET /contacts`, `PUT /contacts {contacts, confirm}` (validated, backed up). UI tab to edit them.
2. **Texting** `message({to, text})` — `to` is a contact name or an E.164 number. Gated (action `message`, detail `message:<resolved number>:<sha256(text) first 12>`;
   the approval shows the full text in its detail line: use detail `message to <name> (<number>): <text>` and the hash only for matching — i.e. `consumeApproval`
   matches on the full detail string, so keep the text in it).
   Providers, first available wins: (a) a connected node with cap `messages` (the Mac): node op `sendMessage {to, text}` runs
   `osascript` against Messages.app (iMessage, or SMS through the paired iPhone); (b) Twilio when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` are set
   (`POST https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json`, form-encoded, basic auth; `deps.extra.fetch` in tests). None → error result naming both options.
3. **Calling** `call({to, say?})` — gated (action `call`). Providers: Twilio (`Calls.json` with `Twiml` `<Response><Say>…</Say></Response>` when `say` is given,
   else a bridge is not supported → error), or a node with cap `calls`: node op `placeCall {to}` runs `open "tel:<number>"` (the Mac hands the call to the paired iPhone;
   Quinn confirms on the Mac). Output says which provider was used and that a Mac call needs his click.
4. Node side: `alfred-node --messages` advertises caps `messages` and `calls`. `connectNode` accepts `comms?: { run(op: 'sendMessage'|'placeCall', args): Promise<{ok:boolean, error?:string}> }`
   (tests inject it; the default runs osascript / `open`). Server side: add `NodeHub.call(node, op, args, timeoutMs?)` (in `src/node/hub.ts`) for these ops and pick the first connected
   node whose caps include `messages` (texting) or `calls` (calling). The tool output names the provider, e.g. `sent via macbook (Messages)`. (macOS only; on Linux the ops return an error). The osascript for Messages:
   `tell application "Messages" to send "<text>" to participant "<to>" of (1st account whose service type = iMessage)`, falling back to SMS service;
   arguments passed via `osascript -e` with proper escaping (never string-concatenate unescaped user text into AppleScript: pass text through `argv`
   with `on run argv`). Every send/call is recorded as a `comms` system event `{kind:'message'|'call', to, provider, ok}` (text not stored beyond the approval).

## Acceptance (`test/acceptance/p21/powers.test.ts`, `comms.test.ts`)
powers: the card lists tools and fits its budget; `platform` read ops return text; a mutating op without approval parks the task `blocked` with a pending
approval whose detail is exact, and after `decideApproval(approved)` a re-run succeeds once (and a third run parks again); `powers.yaml` autoApprove bypasses;
chat `confirm:true` runs; connectors add/remove round-trips `config/mcp.json` (temp repoRoot) and calls `hub.reconfigure`; `alfred_dev propose` creates a coder goal on repo
`alfred` in repo mode with the acceptance checks; `deploy` is gated and, once approved, calls merge → build-web (→ restart when src changed) through a fake ops.
comms: contacts resolve by name; `message` is gated, then sends through a fake node with cap `messages` (node op receives `{to, text}`), else Twilio (fake fetch sees
the form body and basic auth), else a clear error; `call` with `say` uses Twilio TwiML; node client handles `sendMessage` by invoking an injected runner with argv (no
string-built script containing the text).
