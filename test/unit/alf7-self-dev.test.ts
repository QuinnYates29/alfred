// ALF-7 — alfred working on itself, safely: a run that dies in setup fails (no reclaim loop), repos are
// checked when a goal is made or edited, goals on `alfred` get the dev gate and an isolated clone,
// pushes from them always reach Quinn, and a landed merge can be rolled back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { hungLLM } from '../../src/runtime/testing.js';
import { createApp } from '../../src/server/app.js';
import { RepoHub } from '../../src/git/hub.js';
import { createReviewModule } from '../../src/review/index.js';
import { resolveWorkspace } from '../../src/workspace.js';
import { makeApprovalTriage } from '../../src/jev/triage.js';
import { DEFAULT_JEV_POLICY, loadJevPolicy } from '../../src/jev/policy.js';
import { createGoalWithRoot, retryTask, SELF_REPO } from '../../src/ops.js';
import type { ModuleDeps } from '../../src/modules.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

async function listen(app: any): Promise<{ url: string; close: () => void }> {
  const srv: any = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  return { url: `http://127.0.0.1:${srv.address().port}/api/v1`, close: () => srv.close() };
}

async function call(url: string, method: string, path: string, body?: any) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('scheduler', () => {
  it('fails a task whose run throws during setup instead of leaving it running to be reclaimed', async () => {
    const store = openStore(':memory:');
    const reg = new ToolRegistry();
    for (const t of allTools()) reg.register(t);
    const personas = loadPersonas('personas', reg);
    const ws = mkdtempSync(join(tmpdir(), 'alf7-sched-'));
    const g = store.createGoal({ title: 'bad setup' });
    const task = store.createTask({ goalId: g.id, persona: 'ghost', title: 'T', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const sched = new Scheduler({ store, llm: hungLLM(), personas, registry: reg, maxWorkers: 1, pollMs: 20, leaseMs: 60_000, workspaceFor: () => ws } as any);
    sched.start();
    const end = Date.now() + 5000;
    while (store.getTask(task.id)!.status !== 'failed' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await sched.stop();
    const t = store.getTask(task.id)!;
    expect(t.status).toBe('failed');
    expect(t.reason).toMatch(/run error: no such persona: ghost/);
    expect(t.attempt).toBe(1);
    expect(store.events(g.id).some((e) => e.kind === 'reclaimed')).toBe(false);
  });
});

describe('goals on repos', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });

  it('rejects an unknown repo at creation; accepts registered names, registered paths and absolute paths', () => {
    expect(() => createGoalWithRoot(store, { title: 'x', repo: 'nope' })).toThrow(/unknown repo: nope/);
    store.upsertRepo({ name: 'proj', paths: { local: '/srv/proj' } });
    expect(() => createGoalWithRoot(store, { title: 'a', repo: 'proj', acceptance: [{ name: 'a', cmd: 'true' }] })).not.toThrow();
    expect(() => createGoalWithRoot(store, { title: 'b', repo: '/srv/proj', acceptance: [{ name: 'a', cmd: 'true' }] })).not.toThrow();
    expect(() => createGoalWithRoot(store, { title: 'c', repo: '/elsewhere/x', acceptance: [{ name: 'a', cmd: 'true' }] })).not.toThrow();
  });

  it('a goal on alfred without checks gets the dev gate, and so does a retry of a check-less task', () => {
    store.upsertRepo({ name: SELF_REPO, paths: { local: '/srv/alfred' } });
    const { goal, task } = createGoalWithRoot(store, { title: 'ALF-9: thing', repo: SELF_REPO });
    expect(task.acceptance.map((a) => a.name)).toEqual(['tests', 'typecheck']);
    expect(goal.acceptance.map((a) => a.name)).toEqual(['tests', 'typecheck']);
    expect(goal.meta.mode).toBe('sandbox');
    // made before the default (ALF-7 itself): no checks; its retry picks the gate up
    const old = store.createTask({ goalId: goal.id, persona: 'alfred', title: 'old', spec: 's', acceptance: [] });
    store.transition(old.id, 'stopped', { reason: 'x' });
    expect(retryTask(store, old.id).acceptance.map((a) => a.name)).toEqual(['tests', 'typecheck']);
    // other repos keep what they had
    const other = createGoalWithRoot(store, { title: 'o', repo: '/elsewhere/x' });
    expect(other.task.acceptance).toEqual([]);
  });

  it('PATCH /goals/:id changes where a goal works, validated, and only while nothing runs', async () => {
    store.upsertRepo({ name: SELF_REPO, paths: { local: '/srv/alfred' } });
    const g = store.createGoal({ title: 'from an item', meta: { item: 'ALF-7' } });
    const t = store.createTask({ goalId: g.id, persona: 'alfred', title: 'T', spec: 's' });
    const { url, close } = await listen(createApp({ store }));
    try {
      expect((await call(url, 'PATCH', `/goals/${g.id}`, { repo: 'nope' })).status).toBe(400);
      expect((await call(url, 'PATCH', `/goals/${g.id}`, { repo: SELF_REPO, inPlace: true })).body.error).toMatch(/sandbox clone only/);
      expect((await call(url, 'PATCH', `/goals/${g.id}`, { repo: SELF_REPO, mode: 'repo' })).status).toBe(400);
      expect((await call(url, 'PATCH', `/goals/${g.id}`, {})).status).toBe(400);
      const ok = await call(url, 'PATCH', `/goals/${g.slug}`, { repo: SELF_REPO, node: 'local' });
      expect(ok.status).toBe(200);
      expect(ok.body.goal.meta).toEqual({ item: 'ALF-7', repo: SELF_REPO });
      expect((await call(url, 'PATCH', `/goals/${g.id}`, { repo: null })).body.goal.meta).toEqual({ item: 'ALF-7' });
      expect(store.claim(t.id, 'w', 60_000)).toBe(true);
      expect((await call(url, 'PATCH', `/goals/${g.id}`, { repo: SELF_REPO })).status).toBe(409);
      expect((await call(url, 'PATCH', '/goals/nope', { repo: SELF_REPO })).status).toBe(404);
    } finally {
      close();
    }
  });
});

describe('workspace for a goal on alfred', () => {
  it('is an isolated hub clone with the server deps linked in; a worktree or in-place is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alf7-ws-'));
    const checkout = join(root, 'alfred');
    mkdirSync(join(checkout, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(checkout, 'node_modules', 'dep', 'index.js'), '');
    writeFileSync(join(checkout, '.gitignore'), 'node_modules\n');
    writeFileSync(join(checkout, 'a.txt'), '1\n');
    git(root, 'init', '-q', checkout);
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-qm', 'init');
    const store = openStore(':memory:');
    store.upsertRepo({ name: SELF_REPO, paths: { local: checkout } });
    const hub = new RepoHub({ root: join(root, 'hub') });
    const goal = store.createGoal({ title: 'self', meta: { repo: SELF_REPO } });
    const task = store.createTask({ goalId: goal.id, persona: 'coder', title: 'T', spec: 's' });
    const ws = await resolveWorkspace(store, task, { root: join(root, 'work'), hub });
    expect(ws.path.startsWith(join(root, 'work'))).toBe(true);
    expect(ws.remote).toBe('spark');
    expect(git(ws.path, 'rev-parse', '--git-common-dir')).toBe('.git'); // its own repo, not the live checkout's
    expect(lstatSync(join(ws.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ws.path, 'node_modules'))).toBe(join(checkout, 'node_modules'));
    expect(git(ws.path, 'status', '--porcelain')).toBe('');
    expect(git(checkout, 'branch', '--list', 'alfred/*')).toBe(''); // nothing created in the live checkout

    for (const bad of [{ inPlace: true }, { mode: 'repo' }]) {
      store.setGoalMeta(goal.id, { inPlace: undefined, mode: undefined, ...bad });
      await expect(resolveWorkspace(store, task, { root: join(root, 'work'), hub })).rejects.toThrow(/sandbox clone only/);
    }
  });
});

describe('Jev never waves a push from alfred through', () => {
  it('a git push on a goal on alfred goes to Quinn without asking Jev; elsewhere Jev is asked', async () => {
    const store = openStore(':memory:');
    store.upsertRepo({ name: SELF_REPO, paths: { local: '/srv/alfred' } });
    const asked: string[] = [];
    const client: any = {
      ask: async (state: string) => {
        asked.push(state);
        return { answers: { safe: { probability: 1 }, as_asked: { probability: 1 }, injection: { probability: 0 } } };
      },
    };
    const policy = { ...DEFAULT_JEV_POLICY, approvals: { ...DEFAULT_JEV_POLICY.approvals, mode: 'auto' as const } };
    const triage = makeApprovalTriage({ client: () => client, policy: () => policy, store } as any);
    const mk = (repo: string) => {
      const g = store.createGoal({ title: repo, meta: { repo } });
      return store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 'push it' });
    };
    const self = await triage({ taskId: mk('/srv/alfred').id, action: 'git push', detail: 'git push origin master' } as any);
    expect(self).toMatchObject({ approve: false });
    expect(asked).toHaveLength(0);
    await triage({ taskId: mk('/elsewhere').id, action: 'git push', detail: 'git push origin main' } as any);
    expect(asked).toHaveLength(1);
  });

  it('deploy stays in alwaysAsk even when config/jev.yaml leaves it out', () => {
    const root = mkdtempSync(join(tmpdir(), 'alf7-jev-'));
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'jev.yaml'), 'approvals:\n  alwaysAsk: [connectors]\n');
    const pol = loadJevPolicy({ repoRoot: root, extra: {} } as unknown as ModuleDeps);
    expect(pol.approvals.alwaysAsk).toEqual(expect.arrayContaining(['deploy', 'connectors', 'shutdown']));
  });
});

describe('rollback', () => {
  let root: string, store: Store, hub: RepoHub, src: string, url: string, close: () => void;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'alf7-rev-'));
    src = join(root, 'src');
    mkdirSync(src);
    git(src, 'init', '-q');
    writeFileSync(join(src, 'app.js'), 'v1\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'init');
    hub = new RepoHub({ root: join(root, 'hub') });
    await hub.ensure('proj', src);
    store = openStore(':memory:');
    store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
    const deps = {
      store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: join(root, 'work'),
      nodes: {} as any, repoHub: hub, deckState: { url: null }, extra: {}, modules: {}, personas: new Map(),
    } as ModuleDeps;
    ({ url, close } = await listen(createApp({ store, routers: [(await createReviewModule(deps)).router!] })));
  });
  afterEach(() => close());

  it('reverts a landed merge with a new commit (local checkout follows), and only once', async () => {
    const g = store.createGoal({ title: 'Change app', meta: { repo: 'proj' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T' });
    const wt = join(root, 'wt');
    git(root, 'clone', '-q', hub.barePath('proj'), wt);
    git(wt, 'checkout', '-q', '-b', 'alfred/change/1');
    writeFileSync(join(wt, 'app.js'), 'v2\n');
    git(wt, 'commit', '-qam', 'v2');
    git(wt, 'push', '-q', 'origin', 'alfred/change/1');
    store.appendEvent(g.id, t.id, 'pushed', { branch: 'alfred/change/1', sha: git(wt, 'rev-parse', 'HEAD') });

    expect((await call(url, 'POST', `/goals/${g.id}/revert`, { confirm: true })).status).toBe(409); // nothing landed yet
    const m = await call(url, 'POST', `/goals/${g.id}/merge`, { confirm: true });
    expect(m.status).toBe(200);
    expect(readFileSync(join(src, 'app.js'), 'utf8')).toBe('v2\n');
    expect((await call(url, 'GET', `/goals/${g.id}/changes`)).body.landed).toEqual({ sha: m.body.sha, into: 'main' });

    expect((await call(url, 'POST', `/goals/${g.id}/revert`, {})).status).toBe(400);
    const r = await call(url, 'POST', `/goals/${g.id}/revert`, { confirm: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, into: 'main', reverted: m.body.sha, files: ['app.js'], localUpdated: true });
    expect(git(root, '--git-dir', hub.barePath('proj'), 'show', 'main:app.js')).toBe('v1');
    expect(git(root, '--git-dir', hub.barePath('proj'), 'rev-parse', `${r.body.sha}~1`)).toBe(m.body.sha); // history kept
    expect(readFileSync(join(src, 'app.js'), 'utf8')).toBe('v1\n');
    expect(store.events(g.id).some((e) => e.kind === 'goal_reverted')).toBe(true);
    expect((await call(url, 'GET', `/goals/${g.id}/changes`)).body.landed).toBeNull();
    expect((await call(url, 'POST', `/goals/${g.id}/revert`, { confirm: true })).status).toBe(409);
  });
});
