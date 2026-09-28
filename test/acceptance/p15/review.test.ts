// P15 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { RepoHub } from '../../../src/git/hub.js';
import { NodeOfflineError } from '../../../src/runtime/contract.js';
import type { ModuleDeps } from '../../../src/modules.js';
import { createReviewModule } from '../../../src/review/index.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string, store: Store, hub: RepoHub, src: string, srv: any, url: string, workRoot: string;
let offline = false;

async function call(method: string, path: string, body?: any) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** A goal on repo `proj` whose task pushed branch `br` with `files` changed on top of main. */
function goalWithBranch(title: string, br: string, files: Record<string, string>) {
  const g = store.createGoal({ title, meta: { repo: 'proj' } });
  const t = store.createTask({ goalId: g.id, persona: 'coder', title });
  const wt = join(root, 'wt-' + br.replace(/\W/g, '_'));
  git(root, 'clone', '-q', hub.barePath('proj'), wt);
  git(wt, 'checkout', '-q', '-b', br);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(wt, p), c);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', `work on ${title}`);
  git(wt, 'push', '-q', 'origin', br);
  const sha = git(wt, 'rev-parse', 'HEAD');
  store.appendEvent(g.id, t.id, 'workspace', { path: wt, node: 'local', branch: br });
  store.appendEvent(g.id, t.id, 'pushed', { branch: br, sha });
  return { g, t, wt, sha };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'alfred-rev-'));
  workRoot = join(root, 'work');
  mkdirSync(workRoot);
  src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(join(src, 'README.md'), 'hello\n');
  writeFileSync(join(src, 'app.js'), 'console.log(1)\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  hub = new RepoHub({ root: join(root, 'hub') });
  await hub.ensure('proj', src);
  store = openStore(':memory:');
  store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
  offline = false;
  const nodes = {
    backend: (name: string) => ({
      node: name,
      readFile: async (p: string) => { if (offline) throw new NodeOfflineError(name); return `remote:${p}`; },
      writeFile: async () => {},
      listDir: async () => { if (offline) throw new NodeOfflineError(name); return [{ name: 'b.txt', dir: false }, { name: 'adir', dir: true }]; },
      exec: async () => ({ exitCode: 0, output: '', timedOut: false }),
    }),
  };
  const deps: ModuleDeps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot,
    nodes: nodes as any, repoHub: hub, deckState: { url: null }, extra: {}, modules: {}, personas: new Map(),
  };
  const mod = await createReviewModule(deps);
  const app = createApp({ store, routers: [mod.router!] });
  srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  url = `http://127.0.0.1:${srv.address().port}/api/v1`;
});
afterEach(() => srv?.close());

describe('changes', () => {
  it('shows commits, files and the diff of a goal branch against base', async () => {
    const { g, t, sha } = goalWithBranch('Add feature', 'alfred/add-feature/abcd1234', { 'app.js': 'console.log(2)\n', 'new.txt': 'n\n' });
    const c = await call('GET', `/goals/${g.slug}/changes`);
    expect(c.status).toBe(200);
    expect(c.body.repo).toBe('proj');
    expect(c.body.base).toBe('main');
    expect(c.body.branches).toEqual([{ branch: 'alfred/add-feature/abcd1234', sha, taskId: t.id }]);
    expect(c.body.commits).toHaveLength(1);
    expect(c.body.commits[0].subject).toBe('work on Add feature');
    const files = Object.fromEntries(c.body.files.map((f: any) => [f.path, f]));
    expect(files['app.js']).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
    expect(files['new.txt']).toMatchObject({ status: 'A', additions: 1, deletions: 0 });
    expect(c.body.diff).toContain('+console.log(2)');
    expect(c.body.truncated).toBe(false);
    const one = await call('GET', `/goals/${g.id}/changes?file=new.txt`);
    expect(one.body.file).toBe('new.txt');
    expect(one.body.diff).toContain('+n');
    expect(one.body.diff).not.toContain('console.log');
  });

  it('is empty for goals without a repo or push, and 404 for unknown goals', async () => {
    const g = store.createGoal({ title: 'sandbox' });
    const c = await call('GET', `/goals/${g.id}/changes`);
    expect(c.body).toMatchObject({ repo: null, branches: [], commits: [], files: [], diff: '' });
    expect((await call('GET', '/goals/nope/changes')).status).toBe(404);
  });
});

describe('land', () => {
  it('merges into base in the hub, deletes the branch, fast-forwards the clean Spark checkout', async () => {
    const { g } = goalWithBranch('Merge me', 'alfred/merge-me/11111111', { 'app.js': 'console.log(3)\n' });
    expect((await call('POST', `/goals/${g.id}/merge`, {})).status).toBe(400);
    const m = await call('POST', `/goals/${g.id}/merge`, { confirm: true });
    expect(m.status).toBe(200);
    expect(m.body.ok).toBe(true);
    expect(m.body.into).toBe('main');
    expect(m.body.localUpdated).toBe(true);
    const tip = git(root, '--git-dir', hub.barePath('proj'), 'rev-parse', 'main');
    expect(m.body.sha).toBe(tip);
    expect(git(root, '--git-dir', hub.barePath('proj'), 'show', 'main:app.js')).toBe('console.log(3)');
    expect(await hub.branches('proj')).not.toContain('alfred/merge-me/11111111');
    expect(readFileSync(join(src, 'app.js'), 'utf8')).toBe('console.log(3)\n');
    expect(store.events(g.id).some(e => e.kind === 'goal_merged')).toBe(true);
  });

  it('squashes on request, keeps the branch when asked, and reports conflicts without pushing', async () => {
    const a = goalWithBranch('Squash', 'alfred/squash/22222222', { 'a.txt': '1\n' });
    const s = await call('POST', `/goals/${a.g.id}/merge`, { confirm: true, strategy: 'squash', deleteBranch: false, message: 'squashed it' });
    expect(s.status).toBe(200);
    expect(git(root, '--git-dir', hub.barePath('proj'), 'log', '-1', '--format=%s', 'main')).toBe('squashed it');
    expect(git(root, '--git-dir', hub.barePath('proj'), 'rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(2); // not a merge commit
    expect(await hub.branches('proj')).toContain('alfred/squash/22222222');

    const b = goalWithBranch('Conflict', 'alfred/conflict/33333333', { 'README.md': 'theirs\n' });
    // move main so the README edit conflicts
    const other = join(root, 'other');
    git(root, 'clone', '-q', hub.barePath('proj'), other);
    writeFileSync(join(other, 'README.md'), 'ours\n');
    git(other, 'commit', '-qam', 'ours');
    // (a push to the hub's main is refused by its pre-receive hook — agents must not move base branches;
    //  the hub takes base-branch updates by fetch, like alfred's own merge does)
    git(root, '--git-dir', hub.barePath('proj'), 'fetch', '-q', other, '+main:main');
    const before = git(root, '--git-dir', hub.barePath('proj'), 'rev-parse', 'main');
    const c = await call('POST', `/goals/${b.g.id}/merge`, { confirm: true });
    expect(c.status).toBe(409);
    expect(c.body.conflicts).toEqual(['README.md']);
    expect(git(root, '--git-dir', hub.barePath('proj'), 'rev-parse', 'main')).toBe(before);
    const none = store.createGoal({ title: 'nothing' });
    expect((await call('POST', `/goals/${none.id}/merge`, { confirm: true })).status).toBe(409);
  });

  it('discards a goal: hub branch deleted, local sandbox removed, node workspace kept', async () => {
    const { g, t } = goalWithBranch('Throw away', 'alfred/throw/44444444', { 'x.txt': 'x\n' });
    const sandbox = join(workRoot, 'throw-away');
    mkdirSync(sandbox);
    writeFileSync(join(sandbox, 'f'), '1');
    const t2 = store.createTask({ goalId: g.id, persona: 'coder', title: 'second' });
    store.appendEvent(g.id, t2.id, 'workspace', { path: sandbox, node: 'local' });
    const t3 = store.createTask({ goalId: g.id, persona: 'coder', title: 'third' });
    store.appendEvent(g.id, t3.id, 'workspace', { path: '/Users/q/code/x', node: 'macbook' });
    const d = await call('POST', `/goals/${g.id}/discard`, { confirm: true });
    expect(d.status).toBe(200);
    expect(d.body.branches).toEqual(['alfred/throw/44444444']);
    expect(d.body.removed).toContain(sandbox);
    expect(d.body.kept).toContain('/Users/q/code/x');
    expect(existsSync(sandbox)).toBe(false);
    expect(await hub.branches('proj')).not.toContain('alfred/throw/44444444');
    expect(store.events(g.id).some(e => e.kind === 'goal_discarded')).toBe(true);
    expect(t).toBeTruthy();
  });
});

describe('transcripts and files', () => {
  it('returns a task transcript from its events', async () => {
    const g = store.createGoal({ title: 'talk' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'talk' });
    store.appendEvent(g.id, t.id, 'workspace', { path: '/w', node: 'local' });
    store.appendEvent(g.id, t.id, 'turn', { turn: 1, text: 'I will list files', calls: [{ name: 'list_dir', args: '{}' }], usage: { promptTokens: 5, completionTokens: 2 } });
    store.appendEvent(g.id, t.id, 'tool', { name: 'list_dir', ok: true, output: 'a.txt' });
    store.appendEvent(g.id, t.id, 'something_else', {});
    const other = store.createTask({ goalId: g.id, persona: 'coder', title: 'other' });
    store.appendEvent(g.id, other.id, 'turn', { turn: 1, text: 'not me' });
    const tr = await call('GET', `/tasks/${t.id}/transcript`);
    expect(tr.body.map((e: any) => e.kind)).toEqual(['workspace', 'turn', 'tool']);
    expect(tr.body[1]).toMatchObject({ kind: 'turn', text: 'I will list files', turn: 1 });
    expect(tr.body[2]).toMatchObject({ kind: 'tool', name: 'list_dir', output: 'a.txt' });
    expect(typeof tr.body[0].id).toBe('number');
    expect((await call('GET', '/tasks/nope/transcript')).status).toBe(404);
  });

  it('browses local and node workspaces safely', async () => {
    const g = store.createGoal({ title: 'files' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'files' });
    expect((await call('GET', `/goals/${g.id}/files`)).status).toBe(404);
    const ws = join(root, 'ws');
    mkdirSync(join(ws, 'sub'), { recursive: true });
    writeFileSync(join(ws, 'z.txt'), 'zzz');
    writeFileSync(join(ws, 'a.txt'), 'aaa');
    store.appendEvent(g.id, t.id, 'workspace', { path: ws, node: 'local' });
    const l = await call('GET', `/goals/${g.id}/files`);
    expect(l.body.entries).toEqual([{ name: 'sub', dir: true }, { name: 'a.txt', dir: false }, { name: 'z.txt', dir: false }]);
    expect((await call('GET', `/goals/${g.id}/file?path=z.txt`)).body).toMatchObject({ content: 'zzz', size: 3, truncated: false, node: 'local' });
    expect((await call('GET', `/goals/${g.id}/file?path=../../etc/passwd`)).status).toBe(400);

    const g2 = store.createGoal({ title: 'remote' });
    const t2 = store.createTask({ goalId: g2.id, persona: 'coder', title: 'remote' });
    store.appendEvent(g2.id, t2.id, 'workspace', { path: '/Users/q/w', node: 'macbook' });
    const rl = await call('GET', `/goals/${g2.id}/files`);
    expect(rl.body.node).toBe('macbook');
    expect(rl.body.entries[0]).toEqual({ name: 'adir', dir: true });
    expect((await call('GET', `/goals/${g2.id}/file?path=b.txt`)).body.content).toBe('remote:/Users/q/w/b.txt');
    offline = true;
    const off = await call('GET', `/goals/${g2.id}/files`);
    expect(off.status).toBe(503);
    expect(off.body.error).toContain('offline');
  });
});
