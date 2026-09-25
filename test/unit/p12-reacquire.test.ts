// P12 unit tests: store.reacquire — re-establishing a lease for the run that still owns the task.
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore } from '../../src/store.js';

let store: ReturnType<typeof openStore>;
beforeEach(() => {
  store = openStore(':memory:');
});
const task = () => {
  const g = store.createGoal({ title: `rcq-${Math.random()}` });
  return store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [] });
};

describe('store.reacquire', () => {
  it('renews a lease that expired while the same attempt still holds it', () => {
    const t = task();
    expect(store.claim(t.id, 'A', 10)).toBe(true);
    const attempt = store.getTask(t.id)!.attempt;
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(store.getTask(t.id)!.leaseExpiresAt!).toBeLessThanOrEqual(Date.now());
        expect(store.reacquire(t.id, 'A', attempt, 5000)).toBe(true);
        expect(store.getTask(t.id)!.leaseOwner).toBe('A');
        expect(store.getTask(t.id)!.leaseExpiresAt!).toBeGreaterThan(Date.now());
        resolve();
      }, 20),
    );
  });

  it('re-establishes a lease cleared by the gate (running, no lease owner)', () => {
    const t = task();
    store.claim(t.id, 'A', 60_000);
    const attempt = store.getTask(t.id)!.attempt;
    store.transition(t.id, 'verifying', { by: 'A' }); // clears the lease by design
    store.transition(t.id, 'running', { reason: 'gate failed', by: 'A' });
    expect(store.getTask(t.id)!.leaseOwner).toBeNull();
    expect(store.reacquire(t.id, 'A', attempt, 60_000)).toBe(true);
    expect(store.getTask(t.id)!.leaseOwner).toBe('A');
  });

  it('refuses when another worker holds a live lease', () => {
    const t = task();
    store.claim(t.id, 'A', 60_000);
    const attemptA = store.getTask(t.id)!.attempt;
    store.transition(t.id, 'queued', { reason: 'test' });
    expect(store.claim(t.id, 'B', 60_000)).toBe(true);
    // Stale attempt from A: refused.
    expect(store.reacquire(t.id, 'A', attemptA, 60_000)).toBe(false);
    // Even B's fresh attempt cannot clobber B's live lease by another id.
    const attemptB = store.getTask(t.id)!.attempt;
    expect(store.reacquire(t.id, 'C', attemptB, 60_000)).toBe(false);
    expect(store.getTask(t.id)!.leaseOwner).toBe('B');
  });

  it('refuses when the task is not running', () => {
    const t = task();
    expect(store.reacquire(t.id, 'A', 0, 60_000)).toBe(false); // queued
    store.claim(t.id, 'A', 60_000);
    const attempt = store.getTask(t.id)!.attempt;
    store.transition(t.id, 'needs_claude', { reason: 'parked', by: 'A' });
    expect(store.reacquire(t.id, 'A', attempt, 60_000)).toBe(false);
  });
});
