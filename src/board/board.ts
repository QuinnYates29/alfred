// P13 board — data layer. Own tables in the shared SQLite file via store.raw().
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

export type ColumnKind = 'backlog' | 'todo' | 'doing' | 'review' | 'done';
export interface Column { id: string; name: string; kind: ColumnKind; wip?: number | null; color?: string | null }
export interface FieldDef { id: string; name: string; type: 'text' | 'number' | 'select' | 'date' | 'checkbox' | 'url'; options?: string[] }
export interface BoardDef { id: string; key: string; name: string; columns: Column[]; fields: FieldDef[]; createdAt: number; updatedAt: number }
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export interface ChecklistEntry { id: string; text: string; done: boolean }
export interface Item {
  id: string; boardId: string; key: string; title: string; description: string; columnId: string;
  status: string; kind: ColumnKind; rank: number; priority: Priority; labels: string[];
  assignee: string | null; due: string | null; estimate: number | null; parentId: string | null;
  checklist: ChecklistEntry[]; fields: Record<string, any>; goalIds: string[]; createdBy: string;
  createdAt: number; updatedAt: number; completedAt: number | null; archived: boolean;
}
export interface Comment { id: string; itemId: string; author: string; body: string; createdAt: number }

export interface ListQuery {
  board?: string; status?: string; assignee?: string; label?: string; q?: string;
  parentId?: string | null; includeArchived?: boolean; limit?: number;
}

export interface Board {
  listBoards(): BoardDef[];
  getBoard(idOrKey: string): BoardDef | undefined;
  defaultBoard(): BoardDef;
  createBoard(i: { name: string; key: string; columns?: Column[]; fields?: FieldDef[] }): BoardDef;
  updateBoard(idOrKey: string, patch: { name?: string; columns?: Column[]; fields?: FieldDef[]; moveTo?: string }): BoardDef;
  listItems(q?: ListQuery): Item[];
  getItem(idOrKey: string): Item | undefined;
  createItem(i: { board?: string; title: string; description?: string; status?: string; priority?: Priority; labels?: string[];
    assignee?: string | null; due?: string | null; estimate?: number | null; parent?: string; checklist?: (string | ChecklistEntry)[];
    fields?: Record<string, any> }, by?: string): Item;
  updateItem(idOrKey: string, patch: Partial<{ title: string; description: string; status: string; priority: Priority; labels: string[];
    assignee: string | null; due: string | null; estimate: number | null; parent: string | null; checklist: (string | ChecklistEntry)[];
    fields: Record<string, any>; archived: boolean }>, by?: string): Item;
  moveItem(idOrKey: string, to: { status: string; beforeId?: string; afterId?: string }, by?: string): Item;
  toggleCheck(idOrKey: string, entry: string, done?: boolean, by?: string): Item;
  deleteItem(idOrKey: string, o?: { hard?: boolean }, by?: string): void;
  comment(idOrKey: string, author: string, body: string): Comment;
  comments(idOrKey: string): Comment[];
  linkGoal(idOrKey: string, goalId: string): Item;
  itemsForGoal(goalId: string): Item[];
}

export class BoardError extends Error {
  constructor(message: string) { super(message); this.name = 'BoardError'; }
}

const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
const KINDS: ColumnKind[] = ['backlog', 'todo', 'doing', 'review', 'done'];
const FIELD_TYPES = ['text', 'number', 'select', 'date', 'checkbox', 'url'];
const DEFAULT_COLUMNS: Column[] = [
  { id: 'backlog', name: 'Backlog', kind: 'backlog' },
  { id: 'todo', name: 'To do', kind: 'todo' },
  { id: 'doing', name: 'In progress', kind: 'doing' },
  { id: 'review', name: 'Review', kind: 'review' },
  { id: 'done', name: 'Done', kind: 'done' },
];

interface ItemRow {
  id: string; boardId: string; key: string; title: string; description: string; columnId: string; rank: number;
  priority: string; labels: string; assignee: string | null; due: string | null; estimate: number | null;
  parentId: string | null; checklist: string; fields: string; goalIds: string; createdBy: string;
  createdAt: number; updatedAt: number; completedAt: number | null; archived: number;
}

const J = (v: any) => JSON.stringify(v);
const toId = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function openBoard(store: Store): Board {
  const cached = CACHE.get(store);
  if (cached) return cached;
  const board = build(store);
  CACHE.set(store, board);
  return board;
}

const CACHE = new WeakMap<Store, Board>();

function build(store: Store): Board {
  const db = store.raw();
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      columns TEXT NOT NULL, fields TEXT NOT NULL, nextNum INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS board_items (
      id TEXT PRIMARY KEY, boardId TEXT NOT NULL, key TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, columnId TEXT NOT NULL, rank REAL NOT NULL, priority TEXT NOT NULL,
      labels TEXT NOT NULL, assignee TEXT, due TEXT, estimate REAL, parentId TEXT, checklist TEXT NOT NULL,
      fields TEXT NOT NULL, goalIds TEXT NOT NULL, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, completedAt INTEGER, archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_board_items_board ON board_items(boardId);
    CREATE TABLE IF NOT EXISTS board_comments (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
  `);

  const ev = (kind: string, data: any) => store.appendEvent('', null, kind, data);
  const now = () => Date.now();

  // ---- boards ----
  function rowToDef(r: any): BoardDef {
    return { id: r.id, key: r.key, name: r.name, columns: JSON.parse(r.columns), fields: JSON.parse(r.fields), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }
  function listBoards(): BoardDef[] {
    return db.prepare('SELECT * FROM boards ORDER BY createdAt ASC').all().map(rowToDef);
  }
  function getBoard(idOrKey: string): BoardDef | undefined {
    if (!idOrKey) return undefined;
    return rowToDef(db.prepare('SELECT * FROM boards WHERE id = ?').get(idOrKey) ?? db.prepare('SELECT * FROM boards WHERE key = ? COLLATE NOCASE').get(String(idOrKey)) ?? undefined as any);
  }
  function needBoard(idOrKey: string): BoardDef {
    const b = getBoard(idOrKey);
    if (!b) throw new BoardError(`no such board: ${idOrKey}`);
    return b;
  }
  function defaultBoard(): BoardDef {
    const all = listBoards();
    return all.find((b) => b.key === 'ALF') ?? all[0] ?? createBoard({ key: 'ALF', name: 'Alfred' });
  }
  function validateColumns(cols: any): Column[] {
    if (!Array.isArray(cols) || cols.length === 0) throw new BoardError('a board needs at least one column');
    return cols.map((c: any) => {
      if (!c || typeof c !== 'object' || !c.id || !c.name || !KINDS.includes(c.kind)) {
        throw new BoardError(`invalid column: ${J(c)}`);
      }
      return { id: String(c.id), name: String(c.name), kind: c.kind, wip: c.wip ?? null, color: c.color ?? null };
    });
  }
  function validateFields(fields: any): FieldDef[] {
    if (fields == null) return [];
    if (!Array.isArray(fields)) throw new BoardError('fields must be an array');
    return fields.map((f: any) => {
      if (!f || !f.id || !f.name || !FIELD_TYPES.includes(f.type)) throw new BoardError(`invalid field: ${J(f)}`);
      const out: FieldDef = { id: String(f.id), name: String(f.name), type: f.type };
      if (Array.isArray(f.options)) out.options = f.options.map(String);
      return out;
    });
  }
  function createBoard(i: { name: string; key: string; columns?: Column[]; fields?: FieldDef[] }): BoardDef {
    const key = String(i.key ?? '').trim();
    if (!/^[A-Z]{2,6}$/.test(key)) throw new BoardError('board key must be 2-6 uppercase letters');
    if (getBoard(key)) throw new BoardError(`board key already in use: ${key}`);
    const name = String(i.name ?? '').trim();
    if (!name) throw new BoardError('board name is required');
    const columns = validateColumns(i.columns ?? DEFAULT_COLUMNS);
    const fields = validateFields(i.fields);
    const t = now();
    const def = { id: randomUUID(), key, name, columns, fields, createdAt: t, updatedAt: t };
    db.prepare('INSERT INTO boards (id,key,name,columns,fields,nextNum,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(def.id, def.key, def.name, J(def.columns), J(def.fields), 1, t, t);
    return def;
  }
  function updateBoard(idOrKey: string, patch: { name?: string; columns?: Column[]; fields?: FieldDef[]; moveTo?: string }): BoardDef {
    const def = needBoard(idOrKey);
    let { columns, fields, name } = { columns: def.columns, fields: def.fields, name: def.name };
    if (patch.name !== undefined) {
      name = String(patch.name).trim();
      if (!name) throw new BoardError('board name is required');
    }
    if (patch.columns !== undefined) {
      columns = validateColumns(patch.columns);
      const keep = new Set(columns.map((c) => c.id));
      const removed = def.columns.filter((c) => !keep.has(c.id)).map((c) => c.id);
      if (removed.length) {
        const held = db.prepare(
          `SELECT columnId, COUNT(*) AS n FROM board_items WHERE boardId = ? AND archived = 0 AND columnId IN (${removed.map(() => '?').join(',')}) GROUP BY columnId`,
        ).all(def.id, ...removed) as { columnId: string; n: number }[];
        if (held.length) {
          if (!patch.moveTo || !keep.has(patch.moveTo)) {
            throw new BoardError(`column ${held[0]!.columnId} still has items; pass moveTo (a column id of the new set)`);
          }
          db.prepare('UPDATE board_items SET columnId = ?, updatedAt = ? WHERE boardId = ? AND columnId IN (?)'
            .replace('IN (?)', `IN (${removed.map(() => '?').join(',')})`))
            .run(patch.moveTo, now(), def.id, ...removed);
        }
      }
    }
    if (patch.fields !== undefined) fields = validateFields(patch.fields);
    const t = now();
    db.prepare('UPDATE boards SET name = ?, columns = ?, fields = ?, updatedAt = ? WHERE id = ?').run(name, J(columns), J(fields), t, def.id);
    ev('board_updated', { boardId: def.id });
    return { ...def, name, columns, fields, updatedAt: t };
  }

  // ---- items ----
  function colOf(def: BoardDef, columnId: string): Column | undefined {
    return def.columns.find((c) => c.id === columnId);
  }
  function resolveColumn(def: BoardDef, s: string): Column {
    const byId = def.columns.find((c) => c.id === s);
    if (byId) return byId;
    const lower = String(s).toLowerCase();
    const byName = def.columns.find((c) => c.name.toLowerCase() === lower);
    if (byName) return byName;
    const byKind = def.columns.find((c) => c.kind === lower);
    if (byKind) return byKind;
    throw new BoardError(`unknown status: ${s}`);
  }
  function toLite(def: BoardDef, r: ItemRow): Item {
    const col = colOf(def, r.columnId);
    return {
      id: r.id, boardId: r.boardId, key: r.key, title: r.title, description: r.description,
      columnId: r.columnId, status: col ? col.name : r.columnId, kind: col ? col.kind : 'backlog', rank: r.rank,
      priority: r.priority as Priority, labels: JSON.parse(r.labels), assignee: r.assignee, due: r.due,
      estimate: r.estimate, parentId: r.parentId, checklist: JSON.parse(r.checklist), fields: JSON.parse(r.fields),
      goalIds: JSON.parse(r.goalIds), createdBy: r.createdBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
      completedAt: r.completedAt, archived: !!r.archived,
    };
  }
  const defOfItemRow = (r: ItemRow): BoardDef => needBoard(r.boardId);
  function getItem(idOrKey: string): Item | undefined {
    if (!idOrKey) return undefined;
    const row = (db.prepare('SELECT * FROM board_items WHERE id = ?').get(idOrKey)
      ?? db.prepare('SELECT * FROM board_items WHERE key = ? COLLATE NOCASE').get(String(idOrKey))) as ItemRow | undefined;
    return row ? toLite(defOfItemRow(row), row) : undefined;
  }
  function needItem(idOrKey: string): Item {
    const it = getItem(idOrKey);
    if (!it) throw new BoardError(`no such item: ${idOrKey}`);
    return it;
  }
  function normalizeChecklist(list: (string | ChecklistEntry)[] | undefined): ChecklistEntry[] {
    return (list ?? []).map((e) => typeof e === 'string'
      ? { id: randomUUID(), text: e, done: false }
      : { id: e.id || randomUUID(), text: String(e.text ?? ''), done: !!e.done });
  }
  function validateFieldValues(def: BoardDef, values: Record<string, any>): void {
    for (const k of Object.keys(values ?? {})) {
      if (!def.fields.some((f) => f.id === k)) throw new BoardError(`unknown field: ${k}`);
    }
  }
  const maxRank = (boardId: string, columnId: string): number => {
    const r = db.prepare('SELECT MAX(rank) AS m FROM board_items WHERE boardId = ? AND columnId = ?').get(boardId, columnId) as { m: number | null };
    return (r?.m ?? 0) + 1;
  };
  function createItem(i: any, by = 'quinn'): Item {
    const def = i.board ? needBoard(i.board) : defaultBoard();
    const title = String(i.title ?? '').trim();
    if (!title) throw new BoardError('title is required');
    const col = i.status ? resolveColumn(def, i.status) : def.columns[0]!;
    const priority = i.priority ?? 'none';
    if (!PRIORITIES.includes(priority)) throw new BoardError(`unknown priority: ${priority}`);
    let parentId: string | null = null;
    if (i.parent) parentId = needItem(String(i.parent)).id;
    if (i.fields) validateFieldValues(def, i.fields);
    const t = now();
    const num = (db.prepare('SELECT nextNum FROM boards WHERE id = ?').get(def.id) as { nextNum: number }).nextNum;
    db.prepare('UPDATE boards SET nextNum = nextNum + 1, updatedAt = ? WHERE id = ?').run(t, def.id);
    const row: ItemRow = {
      id: randomUUID(), boardId: def.id, key: `${def.key}-${num}`, title,
      description: String(i.description ?? ''), columnId: col.id, rank: maxRank(def.id, col.id),
      priority, labels: J(i.labels ?? []), assignee: i.assignee ?? null, due: i.due ?? null,
      estimate: i.estimate ?? null, parentId, checklist: J(normalizeChecklist(i.checklist)),
      fields: J(i.fields ?? {}), goalIds: J([]), createdBy: by, createdAt: t, updatedAt: t,
      completedAt: col.kind === 'done' ? t : null, archived: 0,
    };
    db.prepare(`INSERT INTO board_items (id,boardId,key,title,description,columnId,rank,priority,labels,assignee,due,estimate,parentId,checklist,fields,goalIds,createdBy,createdAt,updatedAt,completedAt,archived)
      VALUES (@id,@boardId,@key,@title,@description,@columnId,@rank,@priority,@labels,@assignee,@due,@estimate,@parentId,@checklist,@fields,@goalIds,@createdBy,@createdAt,@updatedAt,@completedAt,@archived)`).run(row);
    ev('item_created', { boardId: def.id, key: row.key, by });
    return toLite(def, row);
  }
  // helpers shared by update/move/toggle
  function asRow(lite: Item): ItemRow {
    return {
      ...lite, labels: J(lite.labels), checklist: J(lite.checklist), fields: J(lite.fields),
      goalIds: J(lite.goalIds), archived: lite.archived ? 1 : 0,
    } as ItemRow;
  }

  function listItems(q: ListQuery = {}): Item[] {
    const def = q.board ? needBoard(q.board) : undefined;
    let rows = (q.board
      ? db.prepare('SELECT * FROM board_items WHERE boardId = ?').all(def!.id)
      : db.prepare('SELECT * FROM board_items').all()) as ItemRow[];
    if (!q.includeArchived) rows = rows.filter((r) => !r.archived);
    if (q.status && def) {
      const col = resolveColumn(def, q.status);
      rows = rows.filter((r) => r.columnId === col.id);
    } else if (q.status) {
      const s = String(q.status);
      rows = rows.filter((r) => {
        try { return resolveColumn(defOfItemRow(r), s).id === r.columnId; } catch { return false; }
      });
    }
    if (q.assignee !== undefined) rows = rows.filter((r) => r.assignee === q.assignee);
    if (q.label) rows = rows.filter((r) => (JSON.parse(r.labels) as string[]).includes(q.label!));
    if (q.parentId !== undefined) rows = rows.filter((r) => (q.parentId == null ? r.parentId == null : r.parentId === q.parentId));
    if (q.q) {
      const needle = String(q.q).toLowerCase();
      rows = rows.filter((r) => `${r.title}\n${r.description}`.toLowerCase().includes(needle));
    }
    const colIndex = (r: ItemRow) => {
      const d = def ?? defOfItemRow(r);
      const idx = d.columns.findIndex((c) => c.id === r.columnId);
      return idx < 0 ? 1e6 : idx;
    };
    const boardIndex = (r: ItemRow) => listBoards().findIndex((b) => b.id === r.boardId);
    rows.sort((a, b) => (boardIndex(a) - boardIndex(b)) || (colIndex(a) - colIndex(b)) || (a.rank - b.rank));
    if (q.limit != null) rows = rows.slice(0, Math.max(0, Number(q.limit)));
    return rows.map((r) => toLite(defOfItemRow(r), r));
  }

  function moveItem(idOrKey: string, to: { status: string; beforeId?: string; afterId?: string }, by = 'quinn'): Item {
    const it = needItem(idOrKey);
    const def = needBoard(it.boardId);
    const col = resolveColumn(def, to.status);
    const from = it.columnId;
    const inCol = listItems({ board: def.key }).filter((x) => x.columnId === col.id && x.id !== it.id && x.archived === false);
    let rank: number;
    const before = to.beforeId ? needItem(to.beforeId) : undefined;
    const after = to.afterId ? needItem(to.afterId) : undefined;
    if (before && after) rank = (before.rank + after.rank) / 2;
    else if (before) {
      const prev = inCol.filter((x) => x.rank < before.rank).pop();
      rank = prev ? (prev.rank + before.rank) / 2 : before.rank - 1;
    } else if (after) {
      const next = inCol.find((x) => x.rank > after.rank);
      rank = next ? (after.rank + next.rank) / 2 : after.rank + 1;
    } else rank = maxRank(def.id, col.id);
    const t = now();
    const completedAt = col.kind === 'done' ? (it.completedAt ?? t) : null;
    db.prepare('UPDATE board_items SET columnId = ?, rank = ?, completedAt = ?, updatedAt = ? WHERE id = ?').run(col.id, rank, completedAt, t, it.id);
    ev('item_moved', { boardId: def.id, key: it.key, from, to: col.id, by });
    return { ...it, columnId: col.id, status: col.name, kind: col.kind, rank, completedAt, updatedAt: t };
  }

  function toggleCheck(idOrKey: string, entry: string, done?: boolean, by = 'quinn'): Item {
    const it = needItem(idOrKey);
    const list = it.checklist.slice();
    const idx = list.findIndex((c) => c.id === entry || c.text === entry);
    if (idx < 0) throw new BoardError(`no such checklist entry: ${entry}`);
    list[idx] = { ...list[idx]!, done: done === undefined ? !list[idx]!.done : !!done };
    const t = now();
    db.prepare('UPDATE board_items SET checklist = ?, updatedAt = ? WHERE id = ?').run(J(list), t, it.id);
    ev('item_updated', { boardId: it.boardId, key: it.key, changes: ['checklist'], by });
    return { ...it, checklist: list, updatedAt: t };
  }

  function deleteItem(idOrKey: string, o?: { hard?: boolean }, by = 'quinn'): void {
    const it = needItem(idOrKey);
    const hard = !!o?.hard;
    if (hard) {
      db.prepare('DELETE FROM board_comments WHERE itemId = ?').run(it.id);
      db.prepare('DELETE FROM board_items WHERE id = ?').run(it.id);
    } else {
      db.prepare('UPDATE board_items SET archived = 1, updatedAt = ? WHERE id = ?').run(now(), it.id);
    }
    ev('item_deleted', { boardId: it.boardId, key: it.key, hard, by });
  }

  function comment(idOrKey: string, author: string, body: string): Comment {
    const it = needItem(idOrKey);
    const text = String(body ?? '');
    if (!text.trim()) throw new BoardError('comment body is required');
    const c: Comment = { id: randomUUID(), itemId: it.id, author: author || 'quinn', body: text, createdAt: now() };
    db.prepare('INSERT INTO board_comments (id,itemId,author,body,createdAt) VALUES (?,?,?,?,?)').run(c.id, c.itemId, c.author, c.body, c.createdAt);
    ev('item_comment', { boardId: it.boardId, key: it.key, commentId: c.id, author: c.author });
    return c;
  }
  function comments(idOrKey: string): Comment[] {
    const it = needItem(idOrKey);
    return db.prepare('SELECT * FROM board_comments WHERE itemId = ? ORDER BY createdAt ASC, id ASC').all(it.id) as Comment[];
  }

  function linkGoal(idOrKey: string, goalId: string): Item {
    const it = needItem(idOrKey);
    if (it.goalIds.includes(goalId)) return it;
    const goalIds = [...it.goalIds, goalId];
    const t = now();
    db.prepare('UPDATE board_items SET goalIds = ?, updatedAt = ? WHERE id = ?').run(J(goalIds), t, it.id);
    ev('item_updated', { boardId: it.boardId, key: it.key, changes: ['goalIds'], by: 'alfred' });
    return { ...it, goalIds, updatedAt: t };
  }
  function itemsForGoal(goalId: string): Item[] {
    const rows = db.prepare('SELECT * FROM board_items').all().filter((r: any) => (JSON.parse(r.goalIds) as string[]).includes(goalId)) as ItemRow[];
    return rows.map((r) => toLite(defOfItemRow(r), r));
  }

  const api: Board = {
    listBoards, getBoard, defaultBoard, createBoard, updateBoard, listItems, getItem, createItem,
    updateItem: (idOrKey, patch, by) => {
      const it = needItem(idOrKey);
      const def = needBoard(it.boardId);
      const row: any = { ...it };
      const changes: string[] = [];
      const movedFrom = it.columnId;
      if (patch.title !== undefined) {
        const v = String(patch.title).trim();
        if (!v) throw new BoardError('title is required');
        row.title = v; changes.push('title');
      }
      if (patch.description !== undefined) { row.description = String(patch.description); changes.push('description'); }
      if (patch.status !== undefined) {
        const col = resolveColumn(def, patch.status);
        if (col.id !== row.columnId) {
          row.columnId = col.id; row.rank = maxRank(it.boardId, col.id);
          row.completedAt = col.kind === 'done' ? now() : null;
        }
        changes.push('status');
      }
      if (patch.priority !== undefined) {
        if (!PRIORITIES.includes(patch.priority)) throw new BoardError(`unknown priority: ${patch.priority}`);
        row.priority = patch.priority; changes.push('priority');
      }
      if (patch.labels !== undefined) { row.labels = Array.isArray(patch.labels) ? patch.labels.map(String) : []; changes.push('labels'); }
      if (patch.assignee !== undefined) { row.assignee = patch.assignee == null ? null : String(patch.assignee); changes.push('assignee'); }
      if (patch.due !== undefined) { row.due = patch.due == null ? null : String(patch.due); changes.push('due'); }
      if (patch.estimate !== undefined) { row.estimate = patch.estimate == null ? null : Number(patch.estimate); changes.push('estimate'); }
      if (patch.parent !== undefined) { row.parentId = patch.parent == null ? null : needItem(String(patch.parent)).id; changes.push('parent'); }
      if (patch.checklist !== undefined) { row.checklist = normalizeChecklist(patch.checklist); changes.push('checklist'); }
      if (patch.fields !== undefined) {
        validateFieldValues(def, patch.fields);
        row.fields = { ...(row.fields ?? {}), ...patch.fields }; changes.push('fields');
      }
      if (patch.archived !== undefined) { row.archived = !!patch.archived; changes.push('archived'); }
      if (!changes.length) return it;
      row.updatedAt = now();
      db.prepare(`UPDATE board_items SET title=?, description=?, columnId=?, rank=?, priority=?, labels=?, assignee=?, due=?, estimate=?,
        parentId=?, checklist=?, fields=?, goalIds=?, updatedAt=?, completedAt=?, archived=? WHERE id=?`)
        .run(row.title, row.description, row.columnId, row.rank, row.priority, J(row.labels), row.assignee, row.due, row.estimate,
          row.parentId, J(row.checklist), J(row.fields), J(row.goalIds), row.updatedAt, row.completedAt, row.archived ? 1 : 0, it.id);
      ev('item_updated', { boardId: it.boardId, key: it.key, changes, by });
      if (row.columnId !== movedFrom) ev('item_moved', { boardId: it.boardId, key: it.key, from: movedFrom, to: row.columnId, by });
      return toLite(def, { ...asRow(row) });
    },
    moveItem, toggleCheck, deleteItem, comment, comments, linkGoal, itemsForGoal,
  };
  // ensure default board exists on first open
  api.defaultBoard();
  return api;
}
