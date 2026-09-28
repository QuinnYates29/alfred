// My own unit tests for P4a: ops.ts, cron validation, Automations extras.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../../src/store.js';
import { createGoalWithRoot, retryTask, goalSummary, REPORT_CHECK, REPORT_SPEC_NOTE } from '../../src/ops.js';
import { Automations, validCron, cronMatches } from '../../src/automations.js';

describe('ops.createGoalWithRoot', () => {
  it('creates goal + root task with defaults', () => {
    const store = openStore(':memory:');
    const { goal, task } = createGoalWithRoot(store, { title: 'Do the thing', body: 'because' });
    expect(goal.status).toBe('active');
    expect(task.persona).toBe('alfred');
    // no checks + no repo = a report goal: the default report check and the deliverable note
    expect(task.spec).toBe(`because\n\n${REPORT_SPEC_NOTE}`); // spec defaults to body
    expect(task.acceptance).toEqual([REPORT_CHECK]);
    expect(task.goalId).toBe(goal.id);
    expect(task.depth).toBe(0);
    const withRepo = createGoalWithRoot(store, { title: 'Repo thing', repo: '/tmp/x' });
    expect(withRepo.goal.meta.repo).toBe('/tmp/x');
    expect(withRepo.task.acceptance).toEqual([]); // code goals keep needing real checks
    const withChecks = createGoalWithRoot(store, { title: 'Checked', acceptance: [{ name: 't', cmd: 'true' }] });
    expect(withChecks.task.acceptance).toEqual([{ name: 't', cmd: 'true' }]);
    expect(() => createGoalWithRoot(store, { title: '  ' })).toThrow(/title/);
  });
});

describe('ops.retryTask', () => {
  it('clones a failed task with notes carried over', () => {
    const store = openStore(':memory:');
    const { task } = createGoalWithRoot(store, { title: 'Flaky', spec: 'do it' });
    store.claim(task.id, 'w1', 1000);
    store.transition(task.id, 'failed', { reason: 'boom' });
    store.appendNote(task.id, 'halfway done');
    const fresh = retryTask(store, task.id, 'try again');
    expect(fresh.id).not.toBe(task.id);
    expect(fresh.status).toBe('queued');
    expect(fresh.goalId).toBe(task.goalId);
    expect(fresh.persona).toBe(task.persona);
    expect(fresh.spec).toBe(`do it\n\n${REPORT_SPEC_NOTE}`);
    expect(fresh.notes).toContain('halfway done');
    expect(fresh.notes).toContain('try again');
    expect(fresh.notes).toContain('boom');
  });

  it('refuses non-failed tasks and unknown ids', () => {
    const store = openStore(':memory:');
    const { task } = createGoalWithRoot(store, { title: 'Queued' });
    expect(() => retryTask(store, task.id)).toThrow(/failed or stopped/);
    expect(() => retryTask(store, 'nope')).toThrow(/no such task/);
  });
});

describe('ops.goalSummary', () => {
  it('counts tasks by status; undefined for unknown goal', () => {
    const store = openStore(':memory:');
    const { goal, task } = createGoalWithRoot(store, { title: 'Counted' });
    store.createTask({ goalId: goal.id, parentTaskId: task.id, persona: 'coder', title: 'kid' });
    const s = goalSummary(store, goal.id)!;
    expect(s.title).toBe('Counted');
    expect(s.counts.queued).toBe(2);
    expect(s.counts.done).toBeUndefined();
    expect(goalSummary(store, 'nope')).toBeUndefined();
  });
});

describe('cron validation edges', () => {
  it('rejects garbage and out-of-range values', () => {
    expect(validCron('60 * * * *')).toBe(false);
    expect(validCron('* 24 * * *')).toBe(false);
    expect(validCron('* * 0 * *')).toBe(false);
    expect(validCron('* * * * 7')).toBe(false);
    expect(validCron('*/0 * * * *')).toBe(false);
    expect(validCron('5-1 * * * *')).toBe(false);
    expect(validCron('a * * * *')).toBe(false);
    expect(validCron('')).toBe(false);
    expect(validCron('* * * * 0')).toBe(true);
    expect(validCron('5,10 22 * * 6,0')).toBe(true);
  });

  it('dom/dow OR when both restricted (standard cron)', () => {
    // 13th of the month OR any Friday.
    expect(cronMatches('0 0 13 * 5', new Date(2026, 8, 25, 0, 0))).toBe(true); // Friday
    expect(cronMatches('0 0 13 * 5', new Date(2026, 8, 13, 0, 0))).toBe(true); // Sunday the 13th
    expect(cronMatches('0 0 13 * 5', new Date(2026, 8, 14, 0, 0))).toBe(false);
    // dow only restricted: must be that day.
    expect(cronMatches('0 0 * * 5', new Date(2026, 8, 13, 0, 0))).toBe(false);
  });

  it('steps on ranges', () => {
    expect(cronMatches('0-30/10 * * * *', new Date(2026, 8, 24, 1, 20))).toBe(true);
    expect(cronMatches('0-30/10 * * * *', new Date(2026, 8, 24, 1, 31))).toBe(false);
  });
});

describe('Automations extras', () => {
  it('rejects invalid cron and missing template title on upsert', () => {
    const store = openStore(':memory:');
    const auto = new Automations(store);
    expect(() => auto.upsert({ name: 'x', cron: 'nope', template: { title: 't' } })).toThrow(/cron/);
    expect(() => auto.upsert({ name: 'x', cron: '* * * * *', template: {} as any })).toThrow(/title/);
  });

  it('db automations survive a new Automations instance', () => {
    const store = openStore(':memory:');
    const a1 = new Automations(store).upsert({ name: 'Persist', cron: '*/5 * * * *', template: { title: 'P', spec: 's' } });
    const a2 = new Automations(store);
    const loaded = a2.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(a1.id);
    expect(loaded[0].source).toBe('db');
    expect(loaded[0].template.spec).toBe('s');
  });

  it('reloadFiles replaces state and skips broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-auto-u-'));
    writeFileSync(join(dir, 'good.md'), '---\nname: Good\ncron: "* * * * *"\n---\nbody here\n');
    writeFileSync(join(dir, 'broken.md'), '---\nname: [broken\n---\nnope\n');
    writeFileSync(join(dir, 'nocron.md'), 'no frontmatter at all\n');
    const store = openStore(':memory:');
    const auto = new Automations(store, { dir });
    auto.reloadFiles();
    expect(auto.list().map((a) => a.name)).toEqual(['Good']);
    auto.reloadFiles();
    expect(auto.list()).toHaveLength(1);
    expect(auto.setEnabled('file:good.md', false).enabled).toBe(false);
    expect(auto.tick()).toEqual([]);
    expect(auto.remove('file:good.md')).toBe(true);
    expect(auto.list()).toEqual([]);
    expect(auto.remove('file:good.md')).toBe(false);
  });

  it('file automation firing uses name + local date as title', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-auto-t-'));
    writeFileSync(join(dir, 'daily.md'), '---\nname: Daily\ncron: "0 7 * * *"\nrepo: /repo/x\n---\nDo it.\n');
    let now = new Date(2026, 0, 5, 7, 0, 0).getTime();
    const store = openStore(':memory:', { now: () => now });
    const auto = new Automations(store, { dir, now: () => now });
    auto.reloadFiles();
    const fired = auto.tick();
    expect(fired).toHaveLength(1);
    const goal = store.getGoal(fired[0].lastGoalId!)!;
    expect(goal.title).toBe('Daily — 2026-01-05');
    expect(goal.meta.repo).toBe('/repo/x');
    const task = store.listTasks(goal.id)[0];
    expect(task.spec).toBe('Do it.');
    expect(task.persona).toBe('alfred');
  });
});
