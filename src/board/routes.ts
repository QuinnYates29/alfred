// P13 §4/§5 — HTTP surface for the board. Mounted under /api/v1 and /api behind the token.
import express, { type Router, type Request, type Response } from 'express';
import type { Store } from '../store.js';
import type { Persona } from '../runtime/contract.js';
import type { AcceptanceCheck } from '../types.js';
import { createGoalWithRoot, goalSummary } from '../ops.js';
import { BoardError, type Board, type ListQuery } from './board.js';

export interface DispatchOptions {
  persona?: string;
  acceptance?: AcceptanceCheck[];
  repo?: string;
  node?: string;
  mode?: 'sandbox' | 'repo';
  model?: string;
  note?: string;
}

export function boardRouter(opts: {
  store: Store;
  board: Board;
  personas: () => Map<string, Persona>;
}): Router {
  const { store, board } = opts;
  const r = express.Router();

  const wrap = (fn: (req: Request, res: Response) => any) => (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (e: any) {
      if (e instanceof BoardError) {
        const msg = e.message || String(e);
        res.status(/no such/i.test(msg) ? 404 : 400).json({ error: msg });
        return;
      }
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  };
  const body = (req: Request): any => (req.body && typeof req.body === 'object' ? req.body : {});
  const needItem = (key: unknown) => {
    const it = board.getItem(String(key ?? ''));
    if (!it) throw new BoardError(`no such item: ${key}`);
    return it;
  };
  const needBoard = (id: unknown) => {
    const b = board.getBoard(String(id ?? ''));
    if (!b) throw new BoardError(`no such board: ${id}`);
    return b;
  };

  // ---- boards ----
  r.get('/boards', wrap((_req, res) => res.json(board.listBoards())));
  r.post('/boards', wrap((req, res) => {
    const b = body(req);
    res.status(201).json(board.createBoard({ name: b.name, key: b.key, columns: b.columns, fields: b.fields }));
  }));
  r.get('/boards/:id', wrap((req, res) => res.json(needBoard(req.params.id))));
  r.patch('/boards/:id', wrap((req, res) => {
    const b = needBoard(req.params.id);
    const p = body(req);
    res.json(board.updateBoard(b.key, { name: p.name, columns: p.columns, fields: p.fields, moveTo: p.moveTo }));
  }));

  // ---- items ----
  r.get('/items', wrap((req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const list: ListQuery = {};
    if (q.board) list.board = q.board;
    if (q.status) list.status = q.status;
    if (q.assignee !== undefined) list.assignee = q.assignee;
    if (q.label) list.label = q.label;
    if (q.q) list.q = q.q;
    if (q.parent) list.parentId = q.parent;
    if (q.archived === '1' || q.archived === 'true') list.includeArchived = true;
    if (q.limit) list.limit = Number(q.limit);
    res.json(board.listItems(list));
  }));
  r.post('/items', wrap((req, res) => {
    const b = body(req);
    res.status(201).json(board.createItem(b, typeof b.by === 'string' && b.by ? b.by : 'quinn'));
  }));
  r.get('/items/:key', wrap((req, res) => {
    const it = needItem(req.params.key);
    const children = board.listItems({ board: it.boardId, parentId: it.id });
    const goals = it.goalIds.map((g) => goalSummary(store, g)).filter(Boolean);
    res.json({ item: it, comments: board.comments(it.key), children, goals });
  }));
  r.patch('/items/:key', wrap((req, res) => {
    const it = needItem(req.params.key);
    const p = body(req);
    const by = typeof p.by === 'string' && p.by ? p.by : 'quinn';
    const { by: _by, key: _k, board: _b, ...patch } = p;
    res.json(board.updateItem(it.key, patch, by));
  }));
  r.post('/items/:key/move', wrap((req, res) => {
    const it = needItem(req.params.key);
    const p = body(req);
    const by = typeof p.by === 'string' && p.by ? p.by : 'quinn';
    res.json(board.moveItem(it.key, { status: p.status, beforeId: p.beforeId, afterId: p.afterId }, by));
  }));
  r.post('/items/:key/check', wrap((req, res) => {
    const it = needItem(req.params.key);
    const p = body(req);
    res.json(board.toggleCheck(it.key, String(p.entry ?? ''), p.done, 'quinn'));
  }));
  r.delete('/items/:key', wrap((req, res) => {
    const it = needItem(req.params.key);
    board.deleteItem(it.key, { hard: req.query.hard === '1' || req.query.hard === 'true' }, 'quinn');
    res.json({ ok: true });
  }));
  r.post('/items/:key/comments', wrap((req, res) => {
    const it = needItem(req.params.key);
    const p = body(req);
    const c = board.comment(it.key, typeof p.author === 'string' && p.author ? p.author : 'quinn', String(p.body ?? ''));
    res.status(201).json(c);
  }));

  // ---- dispatch (§5) ----
  function dispatchOne(itemKey: string, o: DispatchOptions) {
    const it = needItem(itemKey);
    const personas = opts.personas();
    const persona = o.persona && o.persona.trim() ? o.persona.trim() : 'alfred';
    if (personas.size && !personas.has(persona)) throw new BoardError(`unknown persona: ${persona}`);
    let bodyText = it.description || '';
    if (it.checklist.length) {
      bodyText += `${bodyText ? '\n\n' : ''}## Checklist\n${it.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}`;
    }
    if (o.note && String(o.note).trim()) bodyText += `${bodyText ? '\n\n' : ''}${String(o.note).trim()}`;
    const { goal, task } = createGoalWithRoot(store, {
      title: `${it.key}: ${it.title}`,
      body: bodyText,
      persona,
      acceptance: o.acceptance,
      repo: o.repo,
      model: o.model,
    });
    store.setGoalMeta(goal.id, { item: it.key, ...(o.node ? { node: o.node } : {}), ...(o.mode ? { mode: o.mode } : {}) });
    board.linkGoal(it.key, goal.id);
    board.updateItem(it.key, { assignee: `agent:${persona}` }, 'alfred');
    board.moveItem(it.key, { status: 'doing' }, 'alfred');
    board.comment(it.key, 'alfred', `Sent to ${persona} as goal ${goal.slug}`);
    return { item: board.getItem(it.key)!, goal, task };
  }

  r.post('/items/:key/dispatch', wrap((req, res) => {
    const it = needItem(req.params.key);
    res.status(201).json(dispatchOne(it.key, body(req)));
  }));
  r.post('/board/dispatch', wrap((req, res) => {
    const p = body(req);
    const keys = Array.isArray(p.keys) ? p.keys : [];
    if (!keys.length) throw new BoardError('keys is required');
    const { keys: _k, ...o } = p;
    res.status(201).json(keys.map((k: string) => dispatchOne(k, o)));
  }));

  return r;
}
