// P0 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { verifyAndComplete, defaultRunner } from '../../../src/gate.js';
import { Notifier, wireLoudFailures } from '../../../src/notify.js';
import { writeMirror } from '../../../src/mirror.js';
import { IllegalTransitionError, type Notice, type Sink } from '../../../src/types.js';

let store: ReturnType<typeof openStore>;
beforeEach(() => { store = openStore(':memory:'); });

function verifyingTask(acceptance: { name: string; cmd: string; timeoutMs?: number }[]) {
  const g = store.createGoal({ title: 'gate goal' });
  const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'build it', acceptance });
  store.claim(t.id, 'w', 60_000);
  store.transition(t.id, 'verifying');
  return { g, t };
}

describe('done gate', () => {
  it('marks done only when every check passes, using the real runner', async () => {
    const { g, t } = verifyingTask([{ name: 'true', cmd: 'true' }, { name: 'echo', cmd: 'echo hi' }]);
    const r = await verifyAndComplete(store, t.id);
    expect(r.ok).toBe(true);
    expect(r.results.map(x => x.ok)).toEqual([true, true]);
    expect(r.results[1].output).toContain('hi');
    expect(store.getTask(t.id)!.status).toBe('done');
    expect(store.getGoal(g.id)!.status).toBe('done');
  });

  it('sends a task with a failing check back to running with the output in notes', async () => {
    const { t } = verifyingTask([
      { name: 'ok', cmd: 'true' },
      { name: 'unit-tests', cmd: 'echo "3 failed" >&2; exit 1' },
    ]);
    const r = await verifyAndComplete(store, t.id);
    expect(r.ok).toBe(false);
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('running');
    expect(after.reason).toContain('unit-tests');
    expect(after.notes).toContain('3 failed');
  });

  it('refuses to complete a task that has no acceptance checks', async () => {
    const { t } = verifyingTask([]);
    const r = await verifyAndComplete(store, t.id);
    expect(r.ok).toBe(false);
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('failed');
    expect(after.reason).toMatch(/no acceptance checks/);
  });

  it('only verifies tasks in verifying', async () => {
    const g = store.createGoal({ title: 'x' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    await expect(verifyAndComplete(store, t.id)).rejects.toThrow(IllegalTransitionError);
  });

  it('default runner times out and kills a hung check', async () => {
    const started = Date.now();
    const res = await defaultRunner({ name: 'hang', cmd: 'sleep 30', timeoutMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('default runner honours cwd and truncates output to 4000 chars', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-'));
    const a = await defaultRunner({ name: 'pwd', cmd: 'pwd', cwd: dir });
    expect(a.output.trim()).toBe(dir);
    const b = await defaultRunner({ name: 'big', cmd: 'head -c 20000 /dev/zero | tr "\\0" x; echo END' });
    expect(b.output.length).toBeLessThanOrEqual(4000);
    expect(b.output).toContain('END');
  });
});

describe('notifier', () => {
  const rec = (name: string, into: Notice[]): Sink => ({ name, send: async n => { into.push(n); } });

  it('isolates a throwing sink and a hanging sink from the healthy ones', async () => {
    const got: Notice[] = [];
    const n = new Notifier([
      { name: 'boom', send: async () => { throw new Error('slack down'); } },
      { name: 'hang', send: () => new Promise<void>(() => {}) },
      rec('desktop', got),
    ], { timeoutMs: 200 });
    const res = await n.notify({ level: 'failure', goalId: 'g', title: 't', body: 'b' });
    expect(got).toHaveLength(1);
    const by = Object.fromEntries(res.map(r => [r.sink, r]));
    expect(by.desktop.ok).toBe(true);
    expect(by.boom.ok).toBe(false);
    expect(by.boom.error).toContain('slack down');
    expect(by.hang.ok).toBe(false);
  });

  it('wireLoudFailures announces failures, stops, blocks and Claude hand-offs with the reason', async () => {
    const got: Notice[] = [];
    const off = wireLoudFailures(store, new Notifier([rec('mem', got)]));
    const g = store.createGoal({ title: 'loud goal' });
    const a = store.createTask({ goalId: g.id, persona: 'coder', title: 'task A' });
    const b = store.createTask({ goalId: g.id, persona: 'coder', title: 'task B' });
    store.claim(a.id, 'w', 1000);
    store.transition(a.id, 'needs_claude', { reason: 'deadlock in merger' });
    store.claim(b.id, 'w', 1000);
    store.transition(b.id, 'failed', { reason: 'wall clock exceeded' });
    await new Promise(r => setTimeout(r, 50));
    off();
    const warn = got.find(n => n.level === 'warn')!;
    expect(warn.title).toContain('task A');
    expect(warn.body).toContain('deadlock in merger');
    const fail = got.find(n => n.level === 'failure' && n.taskId === b.id)!;
    expect(fail.title).toContain('task B');
    expect(fail.body).toContain('wall clock exceeded');
  });
});

describe('markdown mirror', () => {
  it('writes a deterministic GOAL.md with a failure callout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mirror-'));
    const g = store.createGoal({ title: 'Mirror Me', body: 'Do the thing.', acceptance: [{ name: 'tests', cmd: 'npm test' }] });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'impl' });
    store.claim(t.id, 'w', 1000);
    store.transition(t.id, 'failed', { reason: 'typecheck red after 3 attempts' });

    const p = writeMirror(store, g.id, dir);
    expect(p).toBe(join(dir, 'mirror-me', 'GOAL.md'));
    const md = readFileSync(p, 'utf8');
    expect(md).toContain('# Mirror Me');
    expect(md).toContain('Status: **FAILED**');
    expect(md).toContain('Do the thing.');
    expect(md).toContain('npm test');
    expect(md).toMatch(/\|\s*impl\s*\|\s*coder\s*\|\s*failed\s*\|/);
    expect(md).toContain('> [!failure] impl');
    expect(md).toContain('typecheck red after 3 attempts');
    expect(md).toContain('## Recent events');

    const m1 = statSync(p).mtimeMs;
    const again = readFileSync(writeMirror(store, g.id, dir), 'utf8');
    expect(again).toBe(md);
    expect(m1).toBeGreaterThan(0);
  });
});
