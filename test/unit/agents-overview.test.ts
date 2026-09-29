// GET /api/v1/agents: active goals' task trees, the latest activity per task, pending approvals.
import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store.js';
import { agentsOverview } from '../../src/server/agents.js';

describe('agentsOverview', () => {
  it('lists active goals first with task trees, live "now" lines, approvals linked to their tasks, and counts', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'morning check' });
    const root = store.createTask({ goalId: g.id, persona: 'alfred', title: 'root', spec: 's' });
    store.claim(root.id, 'w', 60_000);
    store.appendEvent(g.id, root.id, 'progress', { msg: 'waiting on 1 subtask(s)' });
    const kid = store.createTask({ goalId: g.id, parentTaskId: root.id, persona: 'coder', title: 'forensics', spec: 's' });
    store.claim(kid.id, 'w2', 60_000);
    store.appendEvent(g.id, kid.id, 'tool', { name: 'run_shell', ok: true, output: 'x' });
    store.transition(kid.id, 'blocked', { reason: 'approval needed: sudo: x', by: 'w2' });
    const ap = store.requestApproval(kid.id, 'sudo', 'sudo ls');

    const o = agentsOverview(store);
    const view = o.goals.find((x) => x.id === g.id)!;
    const r = view.tasks.find((t) => t.id === root.id)!;
    const k = view.tasks.find((t) => t.id === kid.id)!;
    expect(r.now).toBe('waiting on 1 subtask(s)');
    expect(k.parentTaskId).toBe(root.id);
    expect(k.approvalId).toBe(ap.id);
    expect(o.approvals[0]).toMatchObject({ id: ap.id, taskTitle: 'forensics' });
    expect(o.counts).toMatchObject({ running: 1, blocked: 1, waitingOnYou: 1 });
  });
});
