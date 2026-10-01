// P15 unit tests — review helpers (repo/base resolution, pushed branches, transcript, path safety).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../src/store.js';
import { RepoHub } from '../../src/git/hub.js';
import { resolveRepo, resolveBase, pushedBranches } from '../../src/review/changes.js';
import { transcriptFor } from '../../src/review/transcript.js';
import { safeJoin, resolveWorkspace } from '../../src/review/files.js';
import { HttpError } from '../../src/review/land.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

let root: string, store: Store, hub: RepoHub, src: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'alfred-rev-unit-'));
  src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(join(src, 'README.md'), 'hi\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  hub = new RepoHub({ root: join(root, 'hub') });
});

beforeEach(async () => {
  await hub.ensure('proj', src);
  store = openStore(':memory:');
  store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
});

describe('resolveRepo', () => {
  it('resolves by name and by a registered path value', () => {
    expect(resolveRepo(store, { meta: { repo: 'proj' } })?.name).toBe('proj');
    expect(resolveRepo(store, { meta: { repo: src } })?.name).toBe('proj');
    expect(resolveRepo(store, { meta: { repo: 'nope' } })).toBeNull();
    expect(resolveRepo(store, {})).toBeNull();
    expect(resolveRepo(store, { meta: { repo: 42 } })).toBeNull();
  });
});

describe('pushedBranches', () => {
  it('keeps the latest event per branch, most recently pushed first', () => {
    const g = store.createGoal({ title: 'g' });
    const t1 = store.createTask({ goalId: g.id, persona: 'coder', title: 'a' });
    const t2 = store.createTask({ goalId: g.id, persona: 'coder', title: 'b' });
    store.appendEvent(g.id, t1.id, 'pushed', { branch: 'b1', sha: 'aaa' });
    store.appendEvent(g.id, t2.id, 'pushed', { branch: 'b2', sha: 'bbb' });
    store.appendEvent(g.id, t2.id, 'pushed', { branch: 'b1', sha: 'ccc' });
    store.appendEvent(g.id, t2.id, 'push_failed', { branch: 'b3', sha: 'ddd' });
    expect(pushedBranches(store, g.id)).toEqual([
      { branch: 'b1', sha: 'ccc', taskId: t2.id },
      { branch: 'b2', sha: 'bbb', taskId: t2.id },
    ]);
  });
});

describe('resolveBase', () => {
  it('prefers defaultBranch, else hub HEAD, else main/master', async () => {
    const repo = (defaultBranch: string | null) =>
      ({ name: 'proj', paths: {}, defaultBranch, createdAt: 0, updatedAt: 0 });
    expect(await resolveBase(hub, 'proj', repo('trunk'))).toBe('trunk');
    expect(await resolveBase(hub, 'proj', repo(null))).toBe('main');
    expect(await resolveBase(hub, 'ghost', null)).toBeNull();
  });
});

describe('transcriptFor', () => {
  it('keeps only transcript kinds for one task, ascending', () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'a' });
    const other = store.createTask({ goalId: g.id, persona: 'coder', title: 'b' });
    store.appendEvent(g.id, t.id, 'turn', { turn: 1 });
    store.appendEvent(g.id, t.id, 'goal_status', {});
    store.appendEvent(g.id, t.id, 'tool', { name: 'x', ok: true });
    store.appendEvent(g.id, other.id, 'tool', { name: 'not mine' });
    const tr = transcriptFor(store, t.id);
    expect(tr.map((e) => e.kind)).toEqual(['turn', 'tool']);
    expect(tr[0].id).toBeLessThan(tr[1].id);
    expect((tr[1] as any).name).toBe('x');
  });
});

describe('workspace paths', () => {
  const ws = { workspace: '/home/q/work/w1', node: 'local' };

  it('accepts relative paths inside the workspace, rejects escapes', () => {
    expect(safeJoin(ws.workspace, '.')).toBe('/home/q/work/w1');
    expect(safeJoin(ws.workspace, 'a/b.txt')).toBe('/home/q/work/w1/a/b.txt');
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '']) {
      if (bad === '') continue; // empty means cwd
      expect(() => safeJoin(ws.workspace, bad), bad).toThrow(HttpError);
    }
    expect(() => safeJoin(ws.workspace, '../w1x')).toThrow(HttpError);
  });

  it('resolves the root task workspace and 404s without one', () => {
    const g = store.createGoal({ title: 'g' });
    expect(() => resolveWorkspace(store, g.id)).toThrow(/no workspace yet/);
    const parent = store.createTask({ goalId: g.id, persona: 'planner', title: 'root' });
    const child = store.createTask({ goalId: g.id, parentTaskId: parent.id, persona: 'coder', title: 'child' });
    store.appendEvent(g.id, parent.id, 'workspace', { path: '/w/root', node: 'local' });
    store.appendEvent(g.id, parent.id, 'workspace', { path: '/w/root2', node: 'local' });
    store.appendEvent(g.id, child.id, 'workspace', { path: '/w/child', node: 'mac' });
    expect(resolveWorkspace(store, g.id)).toEqual({ workspace: '/w/root2', node: 'local' });
    expect(resolveWorkspace(store, g.id, child.id)).toEqual({ workspace: '/w/child', node: 'mac' });
    expect(() => resolveWorkspace(store, g.id, 'nope')).toThrow(/no workspace yet/);
  });

  it('HttpError carries status and extra fields', () => {
    const e = new HttpError(409, 'merge conflict', { conflicts: ['a.txt'] });
    expect(e.status).toBe(409);
    expect(e.extra.conflicts).toEqual(['a.txt']);
  });
});
