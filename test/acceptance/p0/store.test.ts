// P0 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach } from 'vitest';
import { openStore } from '../../../src/store.js';
import {
  IllegalTransitionError, DoneGateError, BudgetError, ReasonRequiredError, DEFAULT_BUDGET,
} from '../../../src/types.js';

let clock = 1_000_000;
const now = () => clock;
let store: ReturnType<typeof openStore>;

beforeEach(() => {
  clock = 1_000_000;
  store = openStore(':memory:', { now });
});

function goalWithTask(budget = {}) {
  const g = store.createGoal({ title: 'Ship The Thing', budget });
  const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'root' });
  return { g, t };
}

describe('goals', () => {
  it('creates an active goal with a unique kebab slug and default budget', () => {
    const a = store.createGoal({ title: 'Ship The Thing!' });
    const b = store.createGoal({ title: 'Ship the thing' });
    expect(a.status).toBe('active');
    expect(a.slug).toBe('ship-the-thing');
    expect(b.slug).toBe('ship-the-thing-2');
    expect(a.budget).toEqual(DEFAULT_BUDGET);
    expect(store.getGoal(a.id)?.title).toBe('Ship The Thing!');
    expect(store.getGoal('nope')).toBeUndefined();
    expect(store.listGoals()).toHaveLength(2);
  });
});

describe('state machine', () => {
  it('walks the happy path up to verifying', () => {
    const { t } = goalWithTask();
    expect(t.status).toBe('queued');
    expect(store.claim(t.id, 'w1', 60_000)).toBe(true);
    const r = store.getTask(t.id)!;
    expect(r.status).toBe('running');
    expect(r.attempt).toBe(1);
    expect(r.leaseOwner).toBe('w1');
    const v = store.transition(t.id, 'verifying');
    expect(v.status).toBe('verifying');
    expect(v.leaseOwner).toBeNull();
  });

  it('refuses illegal edges', () => {
    const { t } = goalWithTask();
    expect(() => store.transition(t.id, 'verifying')).toThrow(IllegalTransitionError);
    store.transition(t.id, 'stopped', { reason: 'user cancelled' });
    expect(() => store.transition(t.id, 'queued')).toThrow(IllegalTransitionError);
  });

  it('never lets transition() mark done, even from verifying', () => {
    const { t } = goalWithTask();
    store.claim(t.id, 'w1', 1000);
    store.transition(t.id, 'verifying');
    expect(() => store.transition(t.id, 'done')).toThrow(DoneGateError);
    expect(store.getTask(t.id)!.status).toBe('verifying');
  });

  it('requires a reason to fail, block, park or stop', () => {
    const { t } = goalWithTask();
    store.claim(t.id, 'w1', 1000);
    for (const to of ['failed', 'blocked', 'needs_claude', 'stopped'] as const) {
      expect(() => store.transition(t.id, to)).toThrow(ReasonRequiredError);
      expect(() => store.transition(t.id, to, { reason: '   ' })).toThrow(ReasonRequiredError);
    }
    const f = store.transition(t.id, 'failed', { reason: 'tests red 3x' });
    expect(f.reason).toBe('tests red 3x');
  });

  it('records every transition as an event', () => {
    const { g, t } = goalWithTask();
    store.claim(t.id, 'w1', 1000);
    store.transition(t.id, 'blocked', { reason: 'need api key', by: 'coder' });
    const tr = store.events(g.id).filter(e => e.kind === 'transition');
    expect(tr.at(-1)!.data).toMatchObject({ from: 'running', to: 'blocked', reason: 'need api key', by: 'coder' });
  });
});

describe('leases', () => {
  it('rejects a second claim and a foreign heartbeat', () => {
    const { t } = goalWithTask();
    expect(store.claim(t.id, 'w1', 1000)).toBe(true);
    expect(store.claim(t.id, 'w2', 1000)).toBe(false);
    expect(store.heartbeat(t.id, 'w2', 1000)).toBe(false);
    expect(store.heartbeat(t.id, 'w1', 1000)).toBe(true);
  });

  it('reclaims expired leases, keeps notes, and bumps attempt on re-claim', () => {
    const { t } = goalWithTask();
    store.claim(t.id, 'w1', 1000);
    store.appendNote(t.id, 'tried approach A; tests 4/5');
    clock += 500;
    expect(store.reclaimExpired()).toEqual([]);
    clock += 600;
    expect(store.heartbeat(t.id, 'w1', 1000)).toBe(false);
    expect(store.reclaimExpired()).toEqual([t.id]);
    const q = store.getTask(t.id)!;
    expect(q.status).toBe('queued');
    expect(q.leaseOwner).toBeNull();
    expect(q.notes).toContain('tried approach A');
    const again = store.claimNext('w2', { leaseMs: 1000 })!;
    expect(again.id).toBe(t.id);
    expect(again.attempt).toBe(2);
  });

  it('claimNext takes the oldest queued task and filters by persona', () => {
    const g = store.createGoal({ title: 'g' });
    const a = store.createTask({ goalId: g.id, persona: 'researcher', title: 'a' });
    clock += 1;
    const b = store.createTask({ goalId: g.id, persona: 'coder', title: 'b' });
    expect(store.claimNext('w', { leaseMs: 1000, persona: 'coder' })!.id).toBe(b.id);
    expect(store.claimNext('w', { leaseMs: 1000 })!.id).toBe(a.id);
    expect(store.claimNext('w', { leaseMs: 1000 })).toBeNull();
  });
});

describe('subtask budgets', () => {
  it('enforces depth, fan-out and budget shrink-only', () => {
    const { g, t } = goalWithTask({ maxDepth: 1, maxSubtasks: 2 });
    const c1 = store.createTask({ goalId: g.id, parentTaskId: t.id, persona: 'coder', title: 'c1' });
    expect(c1.depth).toBe(1);
    expect(c1.budget.turns).toBe(t.budget.turns);
    store.createTask({ goalId: g.id, parentTaskId: t.id, persona: 'coder', title: 'c2' });
    expect(() => store.createTask({ goalId: g.id, parentTaskId: t.id, persona: 'coder', title: 'c3' })).toThrow(BudgetError);
    expect(() => store.createTask({ goalId: g.id, parentTaskId: c1.id, persona: 'coder', title: 'deep' })).toThrow(BudgetError);
    expect(store.children(t.id)).toHaveLength(2);
  });

  it('refuses a child budget larger than its parent', () => {
    const { g, t } = goalWithTask();
    expect(() => store.createTask({
      goalId: g.id, parentTaskId: t.id, persona: 'coder', title: 'greedy',
      budget: { tokens: t.budget.tokens + 1 },
    })).toThrow(BudgetError);
  });
});

describe('goal rollup', () => {
  it('stays active while a task is parked, fails when a task fails', () => {
    const { g, t } = goalWithTask();
    const t2 = store.createTask({ goalId: g.id, persona: 'coder', title: 'two' });
    store.claim(t.id, 'w', 1000);
    store.transition(t.id, 'needs_claude', { reason: 'stuck on race condition' });
    store.claim(t2.id, 'w', 1000);
    store.transition(t2.id, 'stopped', { reason: 'budget' });
    expect(store.getGoal(g.id)!.status).toBe('active');
    store.transition(t.id, 'failed', { reason: 'claude could not fix' });
    expect(store.getGoal(g.id)!.status).toBe('failed');
    expect(store.events(g.id).some(e => e.kind === 'goal_status' && e.data.status === 'failed')).toBe(true);
  });
});

describe('events', () => {
  it('supports sinceId and synchronous subscribers with unsubscribe', () => {
    const g = store.createGoal({ title: 'g' });
    const seen: string[] = [];
    const off = store.onEvent(e => seen.push(e.kind));
    const e1 = store.appendEvent(g.id, null, 'ping', { n: 1 });
    store.appendEvent(g.id, null, 'pong', { n: 2 });
    off();
    store.appendEvent(g.id, null, 'unseen', {});
    expect(seen).toEqual(['ping', 'pong']);
    expect(store.events(g.id, { sinceId: e1.id }).map(e => e.kind)).toEqual(['pong', 'unseen']);
  });
});
