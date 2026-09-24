// Focused unit coverage for gate.ts behaviour the acceptance suite doesn't pin down:
// a custom CheckRunner is honoured (not just the real bash runner), checks run
// sequentially in acceptance order, and a task can be re-verified after a fix.
import { describe, it, expect } from 'vitest';
import { openStore } from '../../src/store.js';
import { verifyAndComplete } from '../../src/gate.js';
import type { CheckRunner } from '../../src/types.js';

describe('verifyAndComplete with a custom runner', () => {
  it('uses opts.runner instead of the real bash runner, in declared order', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({
      goalId: g.id,
      persona: 'coder',
      title: 'x',
      acceptance: [
        { name: 'first', cmd: 'unused' },
        { name: 'second', cmd: 'unused' },
      ],
    });
    store.claim(t.id, 'w', 1000);
    store.transition(t.id, 'verifying');

    const seen: string[] = [];
    const runner: CheckRunner = async (check) => {
      seen.push(check.name);
      return {
        name: check.name,
        ok: true,
        exitCode: 0,
        output: `ran ${check.name}`,
        durationMs: 1,
        timedOut: false,
      };
    };

    const r = await verifyAndComplete(store, t.id, { runner });
    expect(r.ok).toBe(true);
    expect(seen).toEqual(['first', 'second']); // sequential, in order, not parallel
    expect(store.getTask(t.id)!.status).toBe('done');
  });

  it('allows re-verification after the failure is fixed', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({
      goalId: g.id,
      persona: 'coder',
      title: 'x',
      acceptance: [{ name: 'flaky', cmd: 'unused' }],
    });
    store.claim(t.id, 'w', 1000);
    store.transition(t.id, 'verifying');

    let pass = false;
    const runner: CheckRunner = async (check) => ({
      name: check.name,
      ok: pass,
      exitCode: pass ? 0 : 1,
      output: pass ? 'good' : 'bad',
      durationMs: 1,
      timedOut: false,
    });

    const first = await verifyAndComplete(store, t.id, { runner });
    expect(first.ok).toBe(false);
    expect(store.getTask(t.id)!.status).toBe('running');

    pass = true;
    store.transition(t.id, 'verifying');
    const second = await verifyAndComplete(store, t.id, { runner });
    expect(second.ok).toBe(true);
    expect(store.getTask(t.id)!.status).toBe('done');
  });
});
