// Focused unit coverage for store.ts behaviour the acceptance suite doesn't pin down.
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore, type Store } from '../../src/store.js';
import { IllegalTransitionError } from '../../src/types.js';

let clock = 1_000_000;
const now = () => clock;
let store: Store;

beforeEach(() => {
  clock = 1_000_000;
  store = openStore(':memory:', { now });
});

describe('reason retention', () => {
  it('keeps the last-given reason across a reason-less transition', () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'root' });
    store.claim(t.id, 'w', 1000);
    const blocked = store.transition(t.id, 'blocked', { reason: 'need api key' });
    expect(blocked.reason).toBe('need api key');
    // blocked -> queued carries no reason; the last real reason should survive.
    const queued = store.transition(t.id, 'queued');
    expect(queued.reason).toBe('need api key');
  });
});

describe('_markDone guard', () => {
  it('refuses to mark a non-verifying task done', () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'root' });
    // task is still 'queued'
    expect(() => store._markDone(t.id, 'gate')).toThrow(IllegalTransitionError);
  });
});

describe('slug collisions beyond the second', () => {
  it('keeps incrementing the numeric suffix', () => {
    const a = store.createGoal({ title: 'Same Name' });
    const b = store.createGoal({ title: 'Same Name' });
    const c = store.createGoal({ title: 'Same Name' });
    expect([a.slug, b.slug, c.slug]).toEqual(['same-name', 'same-name-2', 'same-name-3']);
  });
});

describe('leaving running always clears the lease', () => {
  it('clears leaseOwner/leaseExpiresAt on running -> queued (manual retry)', () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'root' });
    store.claim(t.id, 'w1', 1000);
    const back = store.transition(t.id, 'queued');
    expect(back.leaseOwner).toBeNull();
    expect(back.leaseExpiresAt).toBeNull();
    // and it can be claimed by someone else immediately
    expect(store.claim(t.id, 'w2', 1000)).toBe(true);
  });
});

describe('claimNext respects an empty queue and persona filters with no match', () => {
  it('returns null rather than throwing', () => {
    const g = store.createGoal({ title: 'g' });
    store.createTask({ goalId: g.id, persona: 'researcher', title: 'a' });
    expect(store.claimNext('w', { leaseMs: 1000, persona: 'coder' })).toBeNull();
  });
});
