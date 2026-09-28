// Goal deletion (store.deleteGoal) and the notify tool (powers).
import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store.js';
import { notifyTool } from '../../src/powers/notify.js';

describe('store.deleteGoal', () => {
  it('removes the goal with its tasks, events and approvals, and emits goal_deleted', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'old soak' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'blocked', { reason: 'approval needed', by: 'w' });
    store.requestApproval(t.id, 'git push', 'git push origin main');
    store.deleteGoal(g.id);
    expect(store.getGoal(g.id)).toBeUndefined();
    expect(store.getTask(t.id)).toBeUndefined();
    expect(store.events(g.id)).toEqual([]);
    expect(store.approvals().some((a) => a.goalId === g.id)).toBe(false);
    expect(store.events('').some((e) => e.kind === 'goal_deleted' && e.data.goalId === g.id)).toBe(true);
  });

  it('refuses while a task is running', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'busy' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'w', 60_000);
    expect(() => store.deleteGoal(g.id)).toThrow(/running/);
    expect(store.getGoal(g.id)).toBeDefined();
  });
});

describe('notify tool', () => {
  const setup = (sinks: { sink: string; ok: boolean; error?: string }[], nodes: any[] = []) => {
    const store = openStore(':memory:');
    const sent: any[] = [];
    const deps: any = {
      store,
      nodes: { list: () => nodes },
      notifier: { notify: async (n: any) => { sent.push(n); return sinks; } },
    };
    return { store, sent, tool: notifyTool(deps) };
  };
  const ctx: any = { taskId: 'chat:t1' };

  it('reports only channels Quinn sees, emits a notice event, and names the Mac only when one is online', async () => {
    const { store, sent, tool } = setup([{ sink: 'slack', ok: true }, { sink: 'node-notify', ok: true }, { sink: 'markdown', ok: true }]);
    const r = await tool.run({ title: 'Build done', body: 'all green' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('slack');
    expect(r.output).not.toContain('Mac (');
    expect(r.output).not.toContain('markdown');
    expect(sent[0]).toMatchObject({ level: 'info', title: 'Build done', body: 'all green', goalId: '' });
    expect(store.events('').some((e) => e.kind === 'notice' && e.data.title === 'Build done')).toBe(true);

    const withMac = setup([{ sink: 'node-notify', ok: true }], [{ name: 'macbook', caps: ['fs', 'notify'] }]);
    expect((await withMac.tool.run({ title: 'hi' }, ctx)).output).toContain('Mac (macbook)');
  });

  it('fails honestly when nothing but the mirror got it, and rate-limits', async () => {
    const { tool } = setup([{ sink: 'markdown', ok: true }]);
    const r = await tool.run({ title: 'x' }, ctx);
    expect(r.ok).toBe(false);
    for (let i = 1; i < 10; i++) await tool.run({ title: 'x' }, ctx);
    expect((await tool.run({ title: 'x' }, ctx)).output).toContain('rate limit');
    expect((await tool.run({ title: '' }, ctx)).output).toContain('title is required');
  });
});
