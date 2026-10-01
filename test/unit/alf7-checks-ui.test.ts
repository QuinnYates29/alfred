// ALF-7 — checks you don't have to design up front (Auto, grown from the diff), check editing that
// carries into retries, UI-test screenshots as goal outputs, and transcripts for every task.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { createApp } from '../../src/server/app.js';
import { verifyAndComplete } from '../../src/gate.js';
import { transcriptFor } from '../../src/review/transcript.js';
import { publishUiRun, uiTestTool } from '../../src/uitest.js';
import { registerApprovalStore } from '../../src/approvals.js';
import { autoChecks, usesAutoChecks, parseChecks, devAcceptance, retryTask, createGoalWithRoot, SELF_REPO } from '../../src/ops.js';

async function listen(app: any) {
  const srv: any = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, close: () => srv.close() };
}

describe('Auto checks', () => {
  it('start from the dev gate and add the web build + UI smoke test only when web/ changed', () => {
    const base = devAcceptance();
    expect(autoChecks(base, ['src/ops.ts'])).toEqual(base);
    expect(autoChecks(base, ['src/ops.ts', 'web/src/views/Agents.jsx']).map((c) => c.name)).toEqual(['build-web', 'tests', 'typecheck', 'ui-smoke']);
    expect(autoChecks(devAcceptance('web'), ['web/x.css']).map((c) => c.name)).toEqual(['build-web', 'tests', 'typecheck', 'ui-smoke']); // no doubles
    expect(devAcceptance()[0].cmd).toContain("--exclude 'test/acceptance/p18/**'");
  });

  it('apply to goals on alfred unless Quinn set custom checks', () => {
    const store = openStore(':memory:');
    store.upsertRepo({ name: SELF_REPO, paths: { local: '/srv/alfred' } });
    expect(usesAutoChecks(store, createGoalWithRoot(store, { title: 'a', repo: SELF_REPO }).goal)).toBe(true);
    const custom = createGoalWithRoot(store, { title: 'b', repo: SELF_REPO, acceptance: [{ name: 'x', cmd: 'true' }] }).goal;
    expect(custom.meta.checks).toBe('custom');
    expect(usesAutoChecks(store, custom)).toBe(false);
    expect(usesAutoChecks(store, createGoalWithRoot(store, { title: 'c', repo: '/elsewhere', acceptance: [{ name: 'x', cmd: 'true' }] }).goal)).toBe(false);
  });

  it('the gate runs the checks it is given instead of the stored ones', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [{ name: 'stored', cmd: 'false' }] });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'verifying', { by: 'w' });
    const ran: string[] = [];
    const v = await verifyAndComplete(store, t.id, {
      by: 'w',
      checks: [{ name: 'grown', cmd: 'true' }],
      runner: async (c) => { ran.push(c.name); return { name: c.name, ok: true, exitCode: 0, output: '', durationMs: 0, timedOut: false }; },
    });
    expect(v.ok).toBe(true);
    expect(ran).toEqual(['grown']);
  });
});

describe('editing checks', () => {
  it('parses 1–12 named checks', () => {
    expect(parseChecks([{ name: ' t ', cmd: ' npm test ', timeoutMs: 5000 }])).toEqual([{ name: 't', cmd: 'npm test', timeoutMs: 5000 }]);
    expect(() => parseChecks([])).toThrow();
    expect(() => parseChecks([{ name: '', cmd: 'x' }])).toThrow(/check 1/);
  });

  it('PATCH checks: custom lists and auto, applied to the goal and to what the next retry copies', async () => {
    const store = openStore(':memory:');
    store.upsertRepo({ name: SELF_REPO, paths: { local: '/srv/alfred' } });
    const { goal, task } = createGoalWithRoot(store, { title: 'self', repo: SELF_REPO, acceptance: [{ name: 'old', cmd: 'npx vitest run' }] });
    store.transition(task.id, 'stopped', { reason: 'turn budget exhausted (60)' });
    const plain = createGoalWithRoot(store, { title: 'plain', repo: '/elsewhere', acceptance: [{ name: 'x', cmd: 'true' }] }).goal;
    const { call, close } = await listen(createApp({ store }));
    try {
      expect((await call('PATCH', `/goals/${goal.id}`, { checks: [] })).status).toBe(400);
      expect((await call('PATCH', `/goals/${plain.id}`, { checks: 'auto' })).body.error).toMatch(/alfred only/);

      const c = await call('PATCH', `/goals/${goal.id}`, { checks: [{ name: 'unit', cmd: 'npx vitest run test/unit/' }] });
      expect(c.status).toBe(200);
      expect(c.body.goal.meta.checks).toBe('custom');
      expect(store.getGoal(goal.id)!.acceptance.map((x) => x.name)).toEqual(['unit']);
      expect(retryTask(store, task.id).acceptance.map((x) => x.name)).toEqual(['unit']); // the retry gates on the edit

      const a = await call('PATCH', `/goals/${goal.slug}`, { checks: 'auto' });
      expect(a.body.goal.meta.checks).toBeUndefined();
      expect(store.getGoal(goal.id)!.acceptance.map((x) => x.name)).toEqual(['tests', 'typecheck']);
      expect(store.events(goal.id).filter((e) => e.kind === 'goal_checks')).toHaveLength(2);
    } finally {
      close();
    }
  });
});

describe('UI test screenshots', () => {
  it('a run folder becomes an images output + event, and the folder is removed', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const ws = mkdtempSync(join(tmpdir(), 'alf7-ui-'));
    mkdirSync(join(ws, '.ui-test'));
    writeFileSync(join(ws, '.ui-test', '01-agents-desktop.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    writeFileSync(join(ws, '.ui-test', 'result.json'), JSON.stringify({
      ok: false, mode: 'smoke', errors: ['page error: boom'], steps: [],
      shots: [{ name: 'agents-desktop', file: '01-agents-desktop.jpg' }, { name: 'sneaky', file: '../../etc/passwd' }],
    }));
    const r = publishUiRun(store, g.id, null, ws, 'UI smoke');
    expect(r?.ok).toBe(false);
    const out = store.outputs(g.id).find((o) => o.name === 'UI smoke')!;
    expect(out.kind).toBe('images');
    const shots = JSON.parse(store.getOutput(out.id)!.content);
    expect(shots).toEqual([{ name: 'agents-desktop', src: 'data:image/jpeg;base64,/9j/2Q==' }]); // the path-escaping shot is ignored
    expect(store.events(g.id).find((e) => e.kind === 'ui_test')?.data).toMatchObject({ ok: false, mode: 'smoke', shots: 1 });
    expect(existsSync(join(ws, '.ui-test'))).toBe(false);
    expect(publishUiRun(store, g.id, null, ws, 'UI smoke')).toBeNull(); // nothing stale to republish
  });

  it('ui_test only runs for goals on alfred', async () => {
    const store = openStore(':memory:');
    registerApprovalStore(store);
    const g = store.createGoal({ title: 'g', meta: { repo: '/elsewhere' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's' });
    const tool = uiTestTool({ runShell: async () => ({ ok: true, output: '' }) });
    const r = await tool.run({ steps: [{ do: 'goto', path: '/#/' }] }, { taskId: t.id, goalId: g.id, workspace: tmpdir(), persona: 'coder', signal: new AbortController().signal, acceptance: [], progress: () => {} });
    expect(r.output).toMatch(/only for goals on repo alfred/);
  });
});

describe('transcripts', () => {
  it('show every task, not just tasks inside the first 500 events ever recorded', () => {
    const store = openStore(':memory:');
    const old = store.createGoal({ title: 'old' });
    for (let i = 0; i < 520; i++) store.appendEvent(old.id, null, 'progress', { msg: `filler ${i}` });
    const g = store.createGoal({ title: 'new' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's' });
    store.appendEvent(g.id, t.id, 'turn', { turn: 1, text: 'hello', calls: [] });
    store.appendEvent(g.id, t.id, 'tool', { name: 'run_shell', ok: true, output: 'ok' });
    expect(transcriptFor(store, t.id).map((e) => e.kind)).toEqual(['turn', 'tool']);
  });
});
