# P16 — Chat with alfred (conversational front door)

Status: **SPEC** · Branch: `p16-chat` · Acceptance: `npx vitest run test/acceptance/p16/`
Scope (files you own): `src/chat/**` (+ `test/unit/chat*.test.ts`). Do NOT edit `src/main.ts`, `src/server/app.ts`, `src/modules.ts`,
`src/store.ts`, `src/board/**`, `test/acceptance/**`.

Quinn talks to alfred like an assistant: "what's running?", "add 'renew passport' to my board for Friday", "have the coder
fix the flaky test in ~/code/x". The chat agent answers from live state, edits the board, and starts goals. It never does
long work itself: anything bigger than a lookup or a board edit becomes a goal.

## 1. Module seam
`src/chat/index.ts` exports `createChatModule(deps)` → `{ name: 'chat', router, tools: [] }` and exposes the engine as
`(module as any).chat` (the Slack module uses it). Split: `store.ts` (tables), `engine.ts` (the loop), `tools.ts`, `prompt.ts`, `routes.ts`.

## 2. Data (via `deps.store.raw()`, CREATE TABLE IF NOT EXISTS)
```ts
interface Thread { id: string; title: string; createdAt: number; updatedAt: number }
interface ChatMessage { id: string; threadId: string; role: 'user' | 'assistant'; content: string;
  /** Tool calls the assistant made while producing this message: name + short args + ok. */
  actions: { name: string; args: string; ok: boolean; output: string /* ≤ 300 chars */ }[]; createdAt: number }
```
A new thread's title is `'New chat'` until the first user message; then the first 60 chars of that message.
Every stored message emits the system event `chat_message { threadId, message }` (`store.appendEvent('', null, …)`).

## 3. Engine
`class ChatEngine { createThread(title?: string): Thread; getThread(id: string): Thread | undefined; send(threadId: string, text: string, o?: { by?: string }): Promise<ChatMessage /* the assistant reply */>; busy(threadId): boolean }` (other modules — Slack — use these)
- LLM: `deps.extra.llm` if set (tests), else `deps.models?.llm('planner')`, else `deps.llm`. Read lazily on every call.
- Request: `system` = the chat prompt (§4) + a **state snapshot** built fresh each time: today's date (ISO), counts of active goals,
  running / queued / parked tasks, pending approvals, and board items per column kind (skip the board part when no board module).
  `messages` = the thread's last 20 stored messages as user/assistant text, in order; the new user message was stored first, so it is the last one (assistant `actions` are NOT replayed).
  `tools` = the chat tools' schemas. `maxTokens` 2048.
- Loop: call the LLM; for each tool call run the tool and append the assistant tool-call message and the tool result (as in
  `src/runtime/agent.ts`); repeat until a response has no tool calls, max **6** LLM calls. The final response's `content` is the reply
  (empty → `'(no reply)'`). Hitting the cap → reply `'I stopped after 6 steps; ask me to continue.'` plus whatever text was produced.
- An LLM error → the stored assistant reply is `⚠ <message>` (the promise still resolves). The user message is stored before the LLM is called.
- One reply at a time per thread: `send` on a busy thread rejects with `ChatBusyError` (exported).

## 4. Prompt and tools (`prompt.ts`, `tools.ts`) — system prompt + tool schemas ≤ **2500** estimated tokens (`src/runtime/tokens.ts`)
Prompt essentials: you are alfred, Quinn's chief of staff, answering in chat; be brief; use tools for facts, never guess ids or keys;
board items are Quinn's personal/work tasks; to get real work done start a goal (pick persona `coder` for code in a repo, `researcher`
for investigation, `alfred` to plan+delegate anything bigger), and say which goal you started; never claim work is done unless the
tools say so.
Tools (each `{ok, output}`; errors are results, not throws; ToolContext `persona: 'chat'`, `taskId: 'chat:<threadId>'`):
- `board` — the board module's tool, taken from `deps.modules.board?.tools` (absent → not offered).
- `goals({ op: 'list' | 'get', ref?, status? })` — list: one line per goal, newest first, max 20: `<slug> [<status>] <title> — <counts>`;
  get: title, status, body (≤ 1500 chars), each task `<id8> [<status>] <persona> <title> — <reason or result ≤ 200>`.
- `start_goal({ title, spec, persona?, acceptance?, repo?, node?, item? })` — `createGoalWithRoot` (src/ops.ts), persona default `alfred`,
  unknown persona (when `deps.personas` is non-empty) → error result. `node` → `store.setGoalMeta(id, {node})`. `item` (a board key) →
  link through the board (`deps.modules.board.board.linkGoal(item, goalId)`) when the board module exists.
  Output: `started goal <slug> (<persona>)`.
- `approvals({ op: 'list' | 'approve' | 'deny', id? })` — list pending; approve/deny via `store.decideApproval(id, …, 'chat')`.

## 5. HTTP
| Route | |
|---|---|
| `GET /chat/threads` | `[{ ...Thread, last: string /* last message ≤ 120 chars */ }]`, most recently updated first |
| `POST /chat/threads` | `{title?}` → 201 Thread |
| `GET /chat/threads/:id` | `{ thread, messages }` (ascending) · 404 |
| `DELETE /chat/threads/:id` | → `{ok:true}` (messages deleted too) · 404 |
| `POST /chat/threads/:id/messages` | `{ text, wait?: boolean }` → `wait` true: 200 `{ reply: ChatMessage }`; otherwise 202 `{ accepted: true }` and the reply arrives as a `chat_message` event. Empty text → 400; busy → 409; unknown thread → 404 |
| `POST /chat` | `{ text, threadId? }` → creates a thread when absent, waits → 200 `{ threadId, reply }` (the CLI's one-shot) |

## Done when
`npx vitest run test/acceptance/p16/` passes; earlier suites + `npx tsc --noEmit` stay green.
