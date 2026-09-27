// P13 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import type { ModuleDeps } from '../../../src/modules.js';
import type { Persona } from '../../../src/runtime/contract.js';
import { openBoard, BoardError } from '../../../src/board/board.js';
import { createBoardModule } from '../../../src/board/index.js';

function deps(store: Store, personas = new Map<string, Persona>()): ModuleDeps {
  return {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: '/tmp/x',
    nodes: {} as any, repoHub: {} as any, deckState: { url: null }, extra: {}, modules: {}, personas,
  };
}
const persona = (name: string): Persona => ({ name, description: '', system: '', tools: [], promptBudgetTokens: 4000, canSpawn: [] });

async function serve(store: Store, personas?: Map<string, Persona>) {
  const mod = await createBoardModule(deps(store, personas));
  await mod.start?.();
  const app = createApp({ store, routers: [mod.router!], token: 't' });
  const srv: any = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(url + path, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { mod, call, close: async () => { await mod.stop?.(); srv.close(); } };
}

/** Drive a task to done through the real gate path (claim → verifying → _markDone). */
function finish(store: Store, taskId: string, result?: string) {
  store.claim(taskId, 'w', 60_000);
  if (result) store.setResult(taskId, result);
  store.transition(taskId, 'verifying', { by: 'w' });
  store._markDone(taskId, 'gate');
}

let store: Store;
beforeEach(() => { store = openStore(':memory:'); });

describe('board data', () => {
  it('creates the default board with five columns and sequential keys', () => {
    const b = openBoard(store);
    const def = b.defaultBoard();
    expect(def.key).toBe('ALF');
    expect(def.columns.map(c => c.kind)).toEqual(['backlog', 'todo', 'doing', 'review', 'done']);
    const a = b.createItem({ title: '  First  ' });
    const c = b.createItem({ title: 'Second', status: 'doing', priority: 'high', labels: ['ops'], assignee: 'quinn', due: '2026-10-01' });
    expect(a.key).toBe('ALF-1');
    expect(a.title).toBe('First');
    expect(a.kind).toBe('backlog');
    expect(c.key).toBe('ALF-2');
    expect(c.status).toBe('In progress');
    expect(b.getItem('alf-2')!.id).toBe(c.id);
    expect(() => b.createItem({ title: '' })).toThrow(BoardError);
    expect(() => b.createItem({ title: 'x', status: 'nope' })).toThrow(/unknown status/);
    expect(() => b.createItem({ title: 'x', priority: 'huge' as any })).toThrow(BoardError);
  });

  it('resolves status by id, name and kind; ranks and moves; tracks completion', () => {
    const b = openBoard(store);
    const i1 = b.createItem({ title: 'one', status: 'To do' });
    const i2 = b.createItem({ title: 'two', status: 'todo' });
    const i3 = b.createItem({ title: 'three', status: 'todo' });
    expect(b.listItems({ status: 'todo' }).map(i => i.title)).toEqual(['one', 'two', 'three']);
    b.moveItem(i3.key, { status: 'todo', beforeId: i1.id });
    expect(b.listItems({ status: 'todo' }).map(i => i.title)).toEqual(['three', 'one', 'two']);
    b.moveItem(i2.key, { status: 'todo', afterId: i3.id });
    expect(b.listItems({ status: 'todo' }).map(i => i.title)).toEqual(['three', 'two', 'one']);
    const done = b.moveItem(i1.key, { status: 'done' });
    expect(done.completedAt).toBeTypeOf('number');
    expect(b.moveItem(i1.key, { status: 'doing' }).completedAt).toBeNull();
    const kinds = store.allEvents().map(e => e.kind);
    expect(kinds).toContain('item_created');
    expect(kinds).toContain('item_moved');
    expect(store.allEvents().filter(e => e.kind.startsWith('item_')).every(e => e.goalId === '')).toBe(true);
  });

  it('filters, checklists, comments, subtasks, archive and hard delete', () => {
    const b = openBoard(store);
    const p = b.createItem({ title: 'Parent', description: 'Renew the Passport soon', labels: ['home'], checklist: ['photo', 'form'] });
    const kid = b.createItem({ title: 'Kid', parent: p.key, assignee: 'alfred' });
    expect(kid.parentId).toBe(p.id);
    expect(b.listItems({ q: 'passport' }).map(i => i.key)).toEqual([p.key]);
    expect(b.listItems({ label: 'home' })).toHaveLength(1);
    expect(b.listItems({ assignee: 'alfred' }).map(i => i.key)).toEqual([kid.key]);
    expect(b.listItems({ parentId: p.id }).map(i => i.key)).toEqual([kid.key]);
    const t = b.toggleCheck(p.key, 'photo');
    expect(t.checklist.find(c => c.text === 'photo')!.done).toBe(true);
    b.comment(p.key, 'quinn', 'hello');
    expect(b.comments(p.key).map(c => c.body)).toEqual(['hello']);
    b.deleteItem(kid.key);
    expect(b.listItems().map(i => i.key)).toEqual([p.key]);
    expect(b.listItems({ includeArchived: true })).toHaveLength(2);
    b.deleteItem(p.key, { hard: true });
    expect(b.getItem(p.key)).toBeUndefined();
    expect(b.createItem({ title: 'next' }).key).toBe('ALF-3'); // numbers are never reused
  });

  it('adjustable columns and custom fields', () => {
    const b = openBoard(store);
    const def = b.defaultBoard();
    const item = b.createItem({ title: 'in review', status: 'review' });
    const noReview = def.columns.filter(c => c.kind !== 'review');
    expect(() => b.updateBoard(def.key, { columns: noReview })).toThrow(/moveTo|items/);
    const upd = b.updateBoard(def.key, { columns: [...noReview, { id: 'blocked', name: 'Blocked', kind: 'doing', wip: 3 }], moveTo: 'doing', fields: [{ id: 'area', name: 'Area', type: 'select', options: ['home', 'work'] }] });
    expect(upd.columns.map(c => c.id)).toContain('blocked');
    expect(b.getItem(item.key)!.columnId).toBe('doing');
    expect(b.updateItem(item.key, { fields: { area: 'home' } }).fields.area).toBe('home');
    expect(() => b.updateItem(item.key, { fields: { nope: 1 } })).toThrow(BoardError);
    expect(() => b.updateBoard(def.key, { columns: [] })).toThrow(BoardError);
    const other = b.createBoard({ name: 'Home', key: 'HOME' });
    expect(b.createItem({ board: 'HOME', title: 'lawn' }).key).toBe('HOME-1');
    expect(() => b.createBoard({ name: 'dup', key: 'HOME' })).toThrow(BoardError);
    expect(b.listBoards().map(x => x.key).sort()).toEqual(['ALF', 'HOME']);
    expect(other.columns.length).toBe(5);
  });
});

describe('board HTTP + dispatch + sync', () => {
  it('serves CRUD over the API with proper status codes', async () => {
    const { call, close } = await serve(store);
    try {
      expect((await call('GET', '/boards')).body[0].key).toBe('ALF');
      const created = await call('POST', '/items', { title: 'Buy milk', priority: 'low', labels: ['home'] });
      expect(created.status).toBe(201);
      const key = created.body.key;
      expect((await call('POST', '/items', { title: '' })).status).toBe(400);
      expect((await call('GET', '/items/NOPE-9')).status).toBe(404);
      expect((await call('PATCH', `/items/${key}`, { title: 'Buy oat milk', status: 'todo' })).body.status).toBe('To do');
      expect((await call('POST', `/items/${key}/move`, { status: 'done' })).body.kind).toBe('done');
      expect((await call('POST', `/items/${key}/comments`, { body: 'got it' })).status).toBe(201);
      const shown = await call('GET', `/items/${key.toLowerCase()}`);
      expect(shown.body.item.title).toBe('Buy oat milk');
      expect(shown.body.comments[0]).toMatchObject({ body: 'got it', author: 'quinn' });
      expect((await call('GET', '/items?label=home')).body).toHaveLength(1);
      expect((await call('GET', '/items?q=OAT')).body).toHaveLength(1);
      expect((await call('POST', '/boards', { name: 'Work', key: 'WRK' })).status).toBe(201);
      expect((await call('PATCH', '/boards/WRK', { name: 'Work stuff' })).body.name).toBe('Work stuff');
      expect((await call('DELETE', `/items/${key}`)).body).toEqual({ ok: true });
      expect((await call('GET', '/items')).body).toHaveLength(0);
    } finally { await close(); }
  });

  it('dispatches an item to an agent and follows the goal to review/done/failed', async () => {
    const personas = new Map([['alfred', persona('alfred')], ['coder', persona('coder')]]);
    const { mod, call, close } = await serve(store, personas);
    const board = (mod as any).board;
    try {
      const it1 = (await call('POST', '/items', { title: 'Write report', description: 'Summarize Q3', checklist: ['draft', 'send'] })).body;
      expect((await call('POST', `/items/${it1.key}/dispatch`, { persona: 'ghost' })).status).toBe(400);
      const d = await call('POST', `/items/${it1.key}/dispatch`, { persona: 'coder', acceptance: [{ name: 'ok', cmd: 'true' }], note: 'be brief' });
      expect(d.status).toBe(201);
      expect(d.body.goal.title).toBe(`${it1.key}: Write report`);
      expect(d.body.goal.body).toContain('Summarize Q3');
      expect(d.body.goal.body).toContain('- [ ] draft');
      expect(d.body.goal.body).toContain('be brief');
      expect(d.body.task.persona).toBe('coder');
      expect(store.getGoal(d.body.goal.id)!.meta.item).toBe(it1.key);
      let item = board.getItem(it1.key);
      expect(item.kind).toBe('doing');
      expect(item.assignee).toBe('agent:coder');
      expect(item.goalIds).toEqual([d.body.goal.id]);

      // done without pushed code → Done column, with the summary as a comment
      finish(store, d.body.task.id, 'Report written to report.md');
      item = board.getItem(it1.key);
      expect(item.kind).toBe('done');
      expect(board.comments(it1.key).map((c: any) => c.body).join('\n')).toContain('Report written to report.md');

      // done WITH pushed code → Review column
      const it2 = board.createItem({ title: 'Fix bug' });
      const d2 = (await call('POST', `/items/${it2.key}/dispatch`, {})).body;
      expect(d2.task.persona).toBe('alfred');
      store.appendEvent(d2.goal.id, d2.task.id, 'pushed', { branch: 'alfred/x/1', sha: 'abc' });
      finish(store, d2.task.id);
      expect(board.getItem(it2.key).kind).toBe('review');

      // failed → comment + needs-attention label; retry clears the label
      const it3 = board.createItem({ title: 'Impossible' });
      const d3 = (await call('POST', `/items/${it3.key}/dispatch`, {})).body;
      store.claim(d3.task.id, 'w', 60_000);
      store.transition(d3.task.id, 'failed', { reason: 'cannot be done', by: 'w' });
      const failed = board.getItem(it3.key);
      expect(failed.kind).toBe('doing');
      expect(failed.labels).toContain('needs-attention');
      expect(board.comments(it3.key).map((c: any) => c.body).join('\n')).toContain('cannot be done');
      store.createTask({ goalId: d3.goal.id, persona: 'alfred', title: 'retry' });
      expect(board.getItem(it3.key).labels).not.toContain('needs-attention');

      // bulk
      const a = board.createItem({ title: 'A' }); const b = board.createItem({ title: 'B' });
      const bulk = await call('POST', '/board/dispatch', { keys: [a.key, b.key], persona: 'coder' });
      expect(bulk.status).toBe(201);
      expect(bulk.body).toHaveLength(2);
      const shown = (await call('GET', `/items/${a.key}`)).body;
      expect(shown.goals[0].counts).toEqual({ queued: 1 });
    } finally { await close(); }
  });
});

describe('agent tool', () => {
  it('lists, creates, updates, comments and completes items, lean schema', async () => {
    const mod = await createBoardModule(deps(store));
    const tool = mod.tools!.find(t => t.schema.name === 'board')!;
    expect(tool).toBeTruthy();
    expect(estimateTokens(JSON.stringify(tool.schema))).toBeLessThanOrEqual(350);
    const ctx: any = { taskId: 't', goalId: 'g', workspace: '/tmp', persona: 'researcher', signal: new AbortController().signal, acceptance: [], progress: () => {} };
    const run = (args: any) => tool.run(args, ctx);
    expect((await run({ op: 'list' })).output).toBe('no items');
    const c = await run({ op: 'create', title: 'Call the bank', priority: 'high', status: 'todo' });
    expect(c.ok).toBe(true);
    expect(c.output).toContain('ALF-1');
    const board = (mod as any).board;
    expect(board.getItem('ALF-1').createdBy).toBe('agent:researcher');
    expect((await run({ op: 'list' })).output).toMatch(/ALF-1 \[To do\] \(high\) Call the bank/);
    expect((await run({ op: 'update', key: 'ALF-1', assignee: 'quinn', due: '2026-10-02' })).ok).toBe(true);
    expect((await run({ op: 'comment', key: 'ALF-1', text: 'number is on the card' })).ok).toBe(true);
    const got = await run({ op: 'get', key: 'ALF-1' });
    expect(got.output).toContain('number is on the card');
    expect(got.output).toContain('@quinn');
    expect((await run({ op: 'done', key: 'ALF-1' })).ok).toBe(true);
    expect(board.getItem('ALF-1').kind).toBe('done');
    const bad = await run({ op: 'update', key: 'ALF-99', title: 'x' });
    expect(bad.ok).toBe(false);
    expect((await run({ op: 'frobnicate' })).ok).toBe(false);
  });
});
