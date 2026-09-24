import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openStore } from '../../src/store.js';

describe('goal meta', () => {
  it('defaults to {} and is settable at creation', () => {
    const s = openStore(':memory:');
    const a = s.createGoal({ title: 'A' });
    expect(a.meta).toEqual({});
    const b = s.createGoal({ title: 'B', meta: { repo: '/x/y', n: 1 } });
    expect(b.meta).toEqual({ repo: '/x/y', n: 1 });
    expect(s.getGoal(b.id)!.meta).toEqual({ repo: '/x/y', n: 1 });
  });

  it('setGoalMeta shallow-merges and returns the updated goal', () => {
    const s = openStore(':memory:');
    const g = s.createGoal({ title: 'G', meta: { repo: '/r', keep: true } });
    const out = s.setGoalMeta(g.id, { repo: '/new', extra: 'e' });
    expect(out.meta).toEqual({ repo: '/new', keep: true, extra: 'e' });
    expect(s.getGoal(g.id)!.meta).toEqual({ repo: '/new', keep: true, extra: 'e' });
    expect(s.getGoal(g.id)!.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
    expect(() => s.setGoalMeta('nope', { a: 1 })).toThrow(/no such goal/);
  });

  it('migrates old DBs that lack the meta column', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'alfred-db-')), 'db.sqlite');
    const s = openStore(file);
    s.createGoal({ title: 'Old', meta: { a: 1 } });
    s.close();
    // Simulate a pre-meta database.
    const raw = new Database(file);
    raw.exec(`ALTER TABLE goals DROP COLUMN meta`);
    raw.close();

    const reopened = openStore(file);
    const g = reopened.listGoals()[0];
    expect(g.meta).toEqual({});
    reopened.setGoalMeta(g.id, { b: 2 });
    expect(reopened.getGoal(g.id)!.meta).toEqual({ b: 2 });
    reopened.close();
  });
});
