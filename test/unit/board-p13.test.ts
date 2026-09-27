// P13 unit tests — board data edge cases, sync label flow, tool fallbacks.
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../src/store.js';
import { openBoard, BoardError } from '../../src/board/board.js';
import { startBoardSync } from '../../src/board/sync.js';
import { boardTool } from '../../src/board/tool.js';

let store: Store;
beforeEach(() => { store = openStore(':memory:'); });

describe('board data edges', () => {
  it('getBoard returns undefined for unknown refs (no crash)', () => {
    const b = openBoard(store);
    expect(b.getBoard('nope')).toBeUndefined();
    expect(b.getBoard('')).toBeUndefined();
    expect(b.getItem('NOPE-9')).toBeUndefined();
  });

  it('openBoard is cached per store', () => {
    expect(openBoard(store)).toBe(openBoard(store));
  });

  it('updateItem moves status and clears completedAt', () => {
    const b = openBoard(store);
    const i = b.createItem({ title: 'x' });
    expect(b.updateItem(i.key, { status: 'done' }).completedAt).toBeTypeOf('number');
    expect(b.updateItem(i.key, { status: 'todo' }).completedAt).toBeNull();
    expect(() => b.updateItem(i.key, { priority: 'nope' as any })).toThrow(BoardError);
    expect(() => b.updateItem('ZZZ-1', { title: 'y' })).toThrow(/no such item/);
  });

  it('toggleCheck by id and unknown entry errors', () => {
    const b = openBoard(store);
    const i = b.createItem({ title: 'x', checklist: ['a', 'b'] });
    const entryId = b.getItem(i.key)!.checklist[0]!.id;
    expect(b.toggleCheck(i.key, entryId).checklist[0]!.done).toBe(true);
    expect(b.toggleCheck(i.key, 'a', false).checklist[0]!.done).toBe(false);
    expect(() => b.toggleCheck(i.key, 'missing')).toThrow(BoardError);
  });

  it('updateBoard keeps items when no column was removed', () => {
    const b = openBoard(store);
    const def = b.defaultBoard();
    const upd = b.updateBoard('ALF', { columns: [...def.columns, { id: 'waiting', name: 'Waiting', kind: 'todo' }] });
    expect(upd.columns).toHaveLength(6);
  });
});

describe('board sync', () => {
  it('failed goal labels the item; new task (retry) clears it', () => {
    const stop = startBoardSync(store, openBoard(store));
    const b = openBoard(store);
    const it = b.createItem({ title: 'x' });
    b.linkGoal(it.key, 'g1');
    const g = store.createGoal({ title: 'g one', body: '' });
    b.updateItem(it.key, {}, 'x'); // noop guard
    const t = store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'failed', { reason: 'boom', by: 'w' });
    expect(b.getItem(it.key)!.labels).not.toContain('needs-attention'); // not linked to g
    b.linkGoal(it.key, g.id);
    const t2 = store.createTask({ goalId: g.id, persona: 'alfred', title: 't2' });
    store.claim(t2.id, 'w', 60_000);
    store.transition(t2.id, 'failed', { reason: 'boom', by: 'w' });
    const failed = b.getItem(it.key)!;
    expect(failed.labels).toContain('needs-attention');
    store.createTask({ goalId: g.id, persona: 'alfred', title: 'retry' });
    expect(b.getItem(it.key)!.labels).not.toContain('needs-attention');
    stop();
  });
});

describe('board tool fallbacks', () => {
  it('unknown op and missing store return ok:false', async () => {
    const tool = boardTool();
    const ctx: any = { taskId: 'none-at-all', persona: 'x', signal: new AbortController().signal };
    const r = await tool.run({ op: 'frobnicate' }, ctx);
    expect(r.ok).toBe(false);
    const r2 = await tool.run({ op: 'list' }, ctx);
    expect(r2.ok).toBe(false);
    expect(String(r2.output)).toContain('board unavailable');
  });

  it('resolver-bound board works for create/list', async () => {
    const b = openBoard(store);
    const tool = boardTool(() => b);
    const ctx: any = { taskId: 't', persona: 'alfred', signal: new AbortController().signal };
    const c = await tool.run({ op: 'create', title: 'Unit thing' }, ctx);
    expect(c.ok).toBe(true);
    expect(String(c.output)).toContain('ALF-1');
    const g = await tool.run({ op: 'get', key: 'alf-1' }, ctx);
    expect(String(g.output)).toContain('Unit thing');
    expect(b.getItem('ALF-1')!.createdBy).toBe('agent:alfred');
  });
});
