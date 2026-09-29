// platform({op:'runs'}): the read-only goal/task ledger agents use (their sandbox can't read the DB/API).
import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store.js';
import { platformTool } from '../../src/powers/platform.js';

describe('platform runs', () => {
  it('lists goals in the window with each task: persona, status, turns/tokens and why it ended', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'overnight check' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'forensics', spec: 's' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'stopped', { reason: 'stall: no event for this task in 900000ms', by: 'w' });
    const tool = platformTool({ store, extra: {} } as any);
    const r = await tool.run({ op: 'runs', since: 24 }, { taskId: 'x', goalId: '', workspace: '/tmp', persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} } as any);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('## overnight-check [failed] overnight check');
    expect(r.output).toMatch(/coder \[stopped\] forensics · 0 turns, 0 tok — stall: no event/);
    expect(r.output.split('\n')[0]).toMatch(/window: last 24 h · goals: 1 failed · tasks: 1 stopped/);
    const one = await tool.run({ op: 'runs', goal: 'nope' }, {} as any);
    expect(one.output).toBe('no goal nope');
  });
});
