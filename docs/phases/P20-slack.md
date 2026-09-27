# P20 — Slack: act on notifications, slash command, DM chat (Socket Mode)

Status: **SPEC** · Branch: `p20-slack` · Acceptance: `npx vitest run test/acceptance/p20/`
Scope (files you own): `src/slack/**`, `src/notify/sinks.ts` (`slackSink` only), `test/unit/slack*.test.ts`. Do NOT edit
`src/main.ts`, `src/server/app.ts`, `src/modules.ts`, `src/store.ts`, `src/chat/**`, `src/board/**`, `test/acceptance/**`.

Quinn will create the Slack app later. Socket Mode needs no public URL (the Spark stays private on the tailnet).
Env: `SLACK_BOT_TOKEN` (xoxb-), `SLACK_APP_TOKEN` (xapp-, connections:write), `SLACK_CHANNEL` (the notification channel id).

## 1. Buttons on approval notices (`slackSink` in src/notify/sinks.ts)
When `n.approvalId` is set and the sink uses the bot token (not a webhook), post `chat.postMessage` with `text` (the same fallback
text as today) **and** `blocks`: a `section` (mrkdwn: title + "```detail```" body), then an `actions` block with two buttons:
`{ action_id: 'approve', value: approvalId, style: 'primary', text: 'Approve' }` and `{ action_id: 'deny', value: approvalId, style: 'danger', text: 'Deny' }`.
Webhook mode and notices without approvalId are unchanged.

## 2. Module (`src/slack/index.ts` → `createSlackModule(deps)`; split `socket.ts`, `handlers.ts`, `routes.ts`)
Returns `{ name: 'slack', router, start, stop }`. `start()` connects only when both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `deps.env`.
Injection: `deps.extra.fetch` (default global fetch), `deps.extra.WebSocket` (default `ws`'s WebSocket), `deps.extra.slackApi`
(default `https://slack.com/api`), `deps.extra.slackBackoffMs` (default `[1000, 5000, 30000]`).

**Connection.** `POST <slackApi>/apps.connections.open` with `Authorization: Bearer <app token>` → `{ok, url}`; open a WebSocket to `url`.
Every envelope `{ envelope_id, type, payload }` is **acked immediately** by sending `{ envelope_id }` (or `{ envelope_id, payload }` for
slash commands, below). `type: 'disconnect'` or a socket close → reconnect with the backoff list (the last value repeats). `stop()` closes and stops reconnecting.

**Handlers** (never throw; failures go to `lastError`):
- `interactive`, `payload.type === 'block_actions'`: for an action with `action_id` `approve`/`deny` and `value` = approval id →
  `store.decideApproval(value, 'approved' | 'denied', 'slack:' + (payload.user.username ?? payload.user.id))`, then POST
  `payload.response_url` with `{ replace_original: true, text: '<✅ Approved | ❌ Denied> by <user>: <detail>' }`.
  An unknown/already-decided approval → POST `response_url` with `{ replace_original: false, text: '⚠ <error message>' }`.
- `slash_commands` (`payload.command === '/alfred'`), `payload.text`:
  - `status` → ack payload `{ text }` listing active goals (`<slug> [status] title`) and counts of running/queued/parked tasks.
  - `inbox` → ack payload listing pending approvals (`<id8> <action>: <detail>`) and parked tasks (`<id8> [status] <title> — <reason>`), or `Inbox zero.`
  - `add <title>` → with a board module (`deps.modules.board.board`): `createItem({ title }, 'slack:<user_name>')` → ack `{ text: 'Added ALF-n: <title>' }`.
  - anything else → ack `{ text: 'On it…' }`, then run the chat engine (`deps.modules.chat.chat.send(threadId, text)`) on the thread mapped to
    `slack:<user_id>` and POST `payload.response_url` with `{ text: reply.content }`. No chat module → ack `{ text: 'chat is not available' }`.
- `events_api`, `payload.event`: `app_mention`, or `message` with `channel_type === 'im'` and no `bot_id` and no `subtype` → chat engine on the
  thread mapped to `slack:<channel>:<thread_ts ?? ts>` with the text (strip a leading `<@U…>` mention), then `chat.postMessage`
  `{ channel, thread_ts: thread_ts ?? ts, text: reply.content }` with the bot token.
- Thread mapping: table `slack_threads(key TEXT PRIMARY KEY, threadId TEXT)` via `store.raw()`; create the chat thread on first use with
  `deps.modules.chat.chat.createThread('Slack: <key>')` (a mapped thread that no longer exists — `getThread` → undefined — is recreated).

## 3. HTTP
`GET /slack/status` → `{ configured: boolean, connected: boolean, lastError: string | null }`.

## Done when
`npx vitest run test/acceptance/p20/` passes; earlier suites + `npx tsc --noEmit` stay green.
