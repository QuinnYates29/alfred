// ALF-7 — a merge can't be lost and can't silently fail to go live. The hub sync only fast-forwards (it
// once wound the hub's master back and erased a merge); Merge first brings the hub's base up to the live
// checkout, keeps a copy of the goal branch in the checkout's repo (and the merge itself when the checkout
// can't take it), and says why; "Merge & update" runs the whole way to live.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../src/store.js';
import { RepoHub } from '../../src/git/hub.js';
import { mergeGoal } from '../../src/review/land.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string, store: Store, hub: RepoHub, live: string;

/** A goal whose task pushed `files` to its own branch in the hub (branched from the hub's main). */
function goalWithBranch(slug: string, files: Record<string, string>) {
  const g = store.createGoal({ title: slug, meta: { repo: 'proj' } } as any);
  const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T' });
  const wt = join(root, `wt-${slug}`);
  git(root, 'clone', '-q', hub.barePath('proj'), wt);
  const br = `alfred/${slug}/${g.id.slice(0, 8)}`;
  git(wt, 'checkout', '-q', '-b', br);
  for (const [p, c] of Object.entries(files)) writeFileSync(join(wt, p), c);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', `work on ${slug}`);
  git(wt, 'push', '-q', 'origin', br);
  store.appendEvent(g.id, t.id, 'pushed', { branch: br, sha: git(wt, 'rev-parse', 'HEAD') });
  return { g: store.getGoal(g.id)!, br };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'alf7-live-'));
  live = join(root, 'live'); // the Spark checkout the server runs from
  mkdirSync(live);
  git(live, 'init', '-q');
  writeFileSync(join(live, 'app.js'), 'v1\n');
  git(live, 'add', '-A');
  git(live, 'commit', '-qm', 'init');
  hub = new RepoHub({ root: join(root, 'hub') });
  await hub.ensure('proj', live);
  store = openStore(':memory:');
  store.upsertRepo({ name: 'proj', paths: { local: live }, defaultBranch: 'main' });
});

describe('the hub never loses a merge', () => {
  it('the checkout → hub sync only fast-forwards: a merge only the hub has survives it', async () => {
    const { g } = goalWithBranch('a', { 'a.txt': 'a\n' });
    writeFileSync(join(live, 'dirty.txt'), 'x'); // the live checkout can't take the merge
    const m = await mergeGoal(store, hub, g, {});
    expect(m.localUpdated).toBe(false);
    await hub.ensure('proj', live); // what a workspace setup does — this used to force the hub back
    expect(git(root, '--git-dir', hub.barePath('proj'), 'rev-parse', 'main')).toBe(m.sha);
  });

  it('Merge builds on what is running, keeps a copy of the branch on the Spark, and reports why the checkout did not move', async () => {
    // the live checkout moved on by itself (a deploy) — the hub's main is behind it
    writeFileSync(join(live, 'b.txt'), 'deployed\n');
    git(live, 'add', '-A');
    git(live, 'commit', '-qm', 'deployed directly');
    const liveHead = git(live, 'rev-parse', 'HEAD');
    const { g, br } = goalWithBranch('b', { 'c.txt': 'c\n' });

    const m = await mergeGoal(store, hub, g, {});
    expect(m.localUpdated).toBe(true); // built on the running main, so the checkout fast-forwards
    expect(git(live, 'rev-parse', 'HEAD')).toBe(m.sha);
    expect(git(live, 'merge-base', '--is-ancestor', liveHead, 'HEAD') === '').toBe(true);
    expect(readFileSync(join(live, 'c.txt'), 'utf8')).toBe('c\n');
    expect(git(live, 'rev-parse', '--verify', br)).not.toBe(''); // the goal branch, kept on the Spark

    // a dirty checkout: the merge lands, is kept on the Spark as merged/<slug>, and the reason is given
    const d = goalWithBranch('d', { 'd.txt': 'd\n' });
    writeFileSync(join(live, 'scratch.txt'), 'uncommitted');
    const m2 = await mergeGoal(store, hub, d.g, {});
    expect(m2.localUpdated).toBe(false);
    expect(m2.localNote).toMatch(/uncommitted changes — the merge is kept in the Spark checkout as branch merged\/d/);
    expect(git(live, 'rev-parse', 'merged/d')).toBe(m2.sha);
    expect(store.events(d.g.id).find((e) => e.kind === 'goal_merged')!.data).toMatchObject({ localUpdated: false });
  });
});
