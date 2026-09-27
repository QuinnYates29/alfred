# P13 — Board (Jira/Notion-style work items that people and agents share)

Status: **SPEC** · Branch: `p13-board` · Acceptance: `npx vitest run test/acceptance/p13/`
Scope (files you own): `src/board/**`, `src/runtime/alltools.ts` (add `boardTool()` only), `personas/alfred.yaml`, `personas/researcher.yaml` (add the `board` tool only), `test/unit/board*.test.ts`.
Do NOT edit: `src/main.ts`, `src/server/app.ts`, `src/modules.ts`, `src/store.ts`, `test/acceptance/**`.

Quinn wants a familiar, adjustable board for ordinary work — not agent tasks — that he and the agents share.
Agents can list, create, update, comment on and complete items. An item can be **sent to an agent**, which creates a
goal linked to it, and the item follows that goal's outcome.

## 1. Module seam
`src/board/index.ts` exports `createBoardModule(deps: ModuleDeps): AlfredModule` (see `src/modules.ts`) returning
`{ name: 'board', router, tools: [boardTool], start, stop }`. Keep the code split: `src/board/board.ts` (data),
`src/board/routes.ts` (HTTP), `src/board/tool.ts` (agent tool), `src/board/sync.ts` (goal ↔ item sync).
`board.ts` exports `openBoard(store: Store): Board` so tests and other modules can use it directly. The module exposes the
instance as `(module as any).board` too (chat and slack use it).

## 2. Data (tables in the same SQLite file via `store.raw()`, `CREATE TABLE IF NOT EXISTS`)
```ts
type ColumnKind = 'backlog' | 'todo' | 'doing' | 'review' | 'done';
interface Column { id: string; name: string; kind: ColumnKind; wip?: number | null; color?: string | null }
interface FieldDef { id: string; name: string; type: 'text' | 'number' | 'select' | 'date' | 'checkbox' | 'url'; options?: string[] }
interface BoardDef { id: string; key: string; name: string; columns: Column[]; fields: FieldDef[]; createdAt: number; updatedAt: number }
type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
interface ChecklistEntry { id: string; text: string; done: boolean }
interface Item {
  id: string; boardId: string; key: string /* `${board.key}-${n}`, n from 1, never reused */; title: string;
  description: string /* markdown */; columnId: string; status: string /* the column's name, derived */; kind: ColumnKind /* derived */;
  rank: number; priority: Priority; labels: string[]; assignee: string | null /* 'quinn', 'alfred', 'agent:<persona>', any string */;
  due: string | null /* YYYY-MM-DD */; estimate: number | null; parentId: string | null; checklist: ChecklistEntry[];
  fields: Record<string, any> /* custom field values by FieldDef.id */; goalIds: string[]; createdBy: string;
  createdAt: number; updatedAt: number; completedAt: number | null; archived: boolean;
}
interface Comment { id: string; itemId: string; author: string; body: string; createdAt: number }
```
- On first open, if no board exists, create the default board `{ key: 'ALF', name: 'Alfred' }` with columns
  Backlog(backlog), To do(todo), In progress(doing), Review(review), Done(done). Column ids are short slugs (`backlog`, `todo`, `doing`, `review`, `done`).
- `key` of a board: 2–6 uppercase letters, unique. Item keys are unique across boards and case-insensitive on lookup (`alf-3` finds `ALF-3`).
- **Status resolution** (used everywhere a `status` string is accepted): exact column id, then column name (case-insensitive),
  then column kind (the first column of that kind). Unknown → error `unknown status: <s>`.
- Ranks: a new item goes to the bottom of its column. `moveItem` with `beforeId`/`afterId` puts it between its neighbours (midpoint);
  lists are sorted by column order, then rank.
- Moving into a `done`-kind column sets `completedAt`; moving out clears it.
- `listItems` excludes archived items unless `includeArchived`. Deleting archives by default; `hard: true` deletes the row and its comments.
- Changing columns (`updateBoard`): removing a column that still holds items needs `moveTo` (a column id of the new set), else error.
  Every board needs at least one column. Unknown field ids in `fields` values are rejected.

```ts
interface Board {
  listBoards(): BoardDef[];
  getBoard(idOrKey: string): BoardDef | undefined;
  defaultBoard(): BoardDef;
  createBoard(i: { name: string; key: string; columns?: Column[]; fields?: FieldDef[] }): BoardDef;
  updateBoard(idOrKey: string, patch: { name?: string; columns?: Column[]; fields?: FieldDef[]; moveTo?: string }): BoardDef;
  listItems(q?: { board?: string; status?: string; assignee?: string; label?: string; q?: string /* title+description substring, case-insensitive */;
    parentId?: string | null; includeArchived?: boolean; limit?: number }): Item[];
  getItem(idOrKey: string): Item | undefined;
  createItem(i: { board?: string; title: string; description?: string; status?: string; priority?: Priority; labels?: string[];
    assignee?: string | null; due?: string | null; estimate?: number | null; parent?: string /* id or key */; checklist?: (string | ChecklistEntry)[];
    fields?: Record<string, any> }, by?: string): Item;
  updateItem(idOrKey: string, patch: Partial<{ title: string; description: string; status: string; priority: Priority; labels: string[];
    assignee: string | null; due: string | null; estimate: number | null; parent: string | null; checklist: (string | ChecklistEntry)[];
    fields: Record<string, any> /* merged */; archived: boolean }>, by?: string): Item;
  moveItem(idOrKey: string, to: { status: string; beforeId?: string; afterId?: string }, by?: string): Item;
  toggleCheck(idOrKey: string, entry: string /* id or exact text */, done?: boolean, by?: string): Item;
  deleteItem(idOrKey: string, o?: { hard?: boolean }, by?: string): void;
  comment(idOrKey: string, author: string, body: string): Comment;
  comments(idOrKey: string): Comment[];
  linkGoal(idOrKey: string, goalId: string): Item;
  itemsForGoal(goalId: string): Item[];
}
```
Validation errors throw `BoardError` (exported) with a clear message; routes map it to 400, "no such item/board" to 404.
`by` defaults to `'quinn'`. Titles are trimmed and required. Priority must be one of the five values.

## 3. Events (system events: `store.appendEvent('', null, kind, data)`)
`item_created {boardId,key,by}`, `item_updated {boardId,key,changes: string[] /* field names */,by}`, `item_moved {boardId,key,from,to /* column ids */,by}`,
`item_deleted {boardId,key,hard,by}`, `item_comment {boardId,key,commentId,author}`, `board_updated {boardId}`.
A move emits `item_moved` (not `item_updated`). An update that also changes status emits both.

## 4. HTTP (router paths; mounted under /api/v1 and /api behind the token)
| Route | |
|---|---|
| `GET /boards` | `[BoardDef]` (the default board exists after the first call) |
| `POST /boards` | `{name,key,columns?,fields?}` → 201 BoardDef |
| `GET /boards/:id` | id or key → BoardDef, 404 |
| `PATCH /boards/:id` | `{name?,columns?,fields?,moveTo?}` → BoardDef |
| `GET /items` | query `board,status,assignee,label,q,parent,archived=1,limit` → `[Item]` |
| `POST /items` | createItem body (+ `by`) → 201 Item |
| `GET /items/:key` | → `{item, comments, children: Item[], goals: GoalSummary[] /* ops.goalSummary for each linked goal */}` |
| `PATCH /items/:key` | updateItem patch (+ `by`) → Item |
| `POST /items/:key/move` | `{status, beforeId?, afterId?, by?}` → Item |
| `POST /items/:key/check` | `{entry, done?}` → Item |
| `DELETE /items/:key` | `?hard=1` → `{ok:true}` |
| `POST /items/:key/comments` | `{body, author?}` → 201 Comment (author default 'quinn') |
| `POST /items/:key/dispatch` | see §5 → 201 `{item, goal, task}` |
| `POST /board/dispatch` | `{keys: string[], persona?, …same options}` → 201 `[{item, goal, task}]` (one goal per item) |

## 5. Sending an item to an agent (`dispatch`)
Body: `{ persona?: string = 'alfred', acceptance?: AcceptanceCheck[], repo?: string, node?: string, mode?: 'sandbox'|'repo', model?: string, note?: string }`.
- Unknown persona (not in `deps.personas`, when that map is non-empty) → 400.
- Creates the goal with `createGoalWithRoot` (`src/ops.ts`): title `"<KEY>: <title>"`, body = the item's description, then a
  `## Checklist` section (`- [ ] text` / `- [x] text`) if any, then `note` if given; acceptance/repo/model passed through.
  Then `store.setGoalMeta(goal.id, { item: key, ...(node ? { node } : {}), ...(mode ? { mode } : {}) })`.
- Links the goal (`linkGoal`), sets `assignee = 'agent:<persona>'`, moves the item to the first `doing` column, and comments
  `Sent to <persona> as goal <slug>` (author `alfred`).

## 6. Sync (`src/board/sync.ts`, started in `start()`, unsubscribed in `stop()`)
Listen to store events. For a `goal_status` event whose goal has linked items (`itemsForGoal`, or `goal.meta.item`):
- `done` → if the goal has any `pushed` event (there is code to review) and the board has a `review` column → move there; else move to the first `done` column.
  Comment (author `alfred`) with the root task's `result` summary if present, else "Goal <slug> finished".
- `failed` → comment `Goal <slug> failed: <reason of the first failed/stopped task>`, add label `needs-attention`. The item does not move.
- A goal becoming `active` again (retry) removes the `needs-attention` label.
Never throw from the listener.

## 7. Agent tool `board` (`src/board/tool.ts`) — ONE tool, lean schema (≤ 350 estimated tokens as JSON)
`board({ op, key?, title?, description?, status?, priority?, labels?, assignee?, due?, text?, q? })`, kind `'write'`. `by` = `agent:<ctx.persona>`.
- `list` (filters: status, assignee, labels[0] as label, q): one line per item, max 40: `ALF-3 [In progress] (high) Title @assignee due:2026-10-01`. Empty → `no items`.
- `get` (key): header line + description (≤ 3000 chars) + checklist lines + last 5 comments.
- `create` (title, …) → `created ALF-7`.
- `update` (key + any of title/description/status/priority/labels/assignee/due) → `updated ALF-7`.
- `comment` (key, text) → `commented on ALF-7`.
- `done` (key) → moves to the first done column → `ALF-7 done`.
- `check` (key, text) → toggles that checklist entry.
Errors come back as `{ok:false, output: <message>}`, never thrown.

**Where the tool finds its board.** `boardTool(resolve?: (ctx: ToolContext) => Board | undefined)`. The module passes a resolver bound to
its own board. The default resolver (used when `resolve` is omitted) finds the store that owns `ctx.taskId` with `storeForTask`
(`src/approvals.ts`) and calls `openBoard(store)`. `openBoard` must be cheap and idempotent per store: cache the instance in a
`WeakMap<Store, Board>`, so tables and the default board are created once. Add `boardTool()` (default resolver) to `allTools()` in
`src/runtime/alltools.ts`, because many tests load `personas/` with `allTools()` and `alfred.yaml` will list `board`.
No store found → `{ok:false, output:'board unavailable: no store for this task'}`.
Add `board` to the `tools:` of `personas/alfred.yaml` and `personas/researcher.yaml`, and one sentence to alfred's prompt:
"Quinn's work items live on the board (tool `board`): check it when asked about tasks, and keep items you work on up to date."
Both personas must stay within their prompt budgets (the persona tests check this).

## Done when
`npx vitest run test/acceptance/p13/` passes, and all earlier suites (`npx vitest run test/acceptance/ test/unit/`) and `npx tsc --noEmit` stay green.
