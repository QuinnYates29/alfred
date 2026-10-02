// P15 §4/§5 — landing a goal's branch in the hub, and discarding it.
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../store.js';
import type { RepoHub } from '../git/hub.js';
import { git, gitTry } from './git.js';
import { resolveRepo, resolveBase, pushedBranches, syncBaseFromLocal } from './changes.js';
import { assertBranch, SHA_RE } from '../git/refs.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, any> = {}) {
    super(message);
  }
}

const IDENTITY = ['-c', 'user.name=alfred', '-c', 'user.email=alfred@localhost'];

export interface MergeInput {
  branch?: string;
  into?: string;
  strategy?: 'merge' | 'squash';
  message?: string;
  deleteBranch?: boolean;
  /** Merge exactly this commit of the branch (what was reviewed/approved), not whatever the branch is now. */
  sha?: string;
  /** The base head the change was reviewed against: refuse (409) if the base has moved since. */
  baseSha?: string;
}

export interface MergeResult {
  ok: true;
  into: string;
  sha: string;
  /** The live checkout (the Spark's copy of the repo) now holds the merge. */
  localUpdated: boolean;
  /** Why it doesn't, when it doesn't — and where the merge was kept instead. */
  localNote?: string;
}

export async function mergeGoal(
  store: Store,
  repoHub: RepoHub,
  goal: { id: string; title: string; slug?: string; meta?: Record<string, any> },
  input: MergeInput,
): Promise<MergeResult> {
  for (const [k, v] of [['branch', input.branch], ['into', input.into]] as const) {
    try {
      assertBranch(v, k);
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
  }
  for (const [k, v] of [['sha', input.sha], ['baseSha', input.baseSha]] as const) {
    if (v !== undefined && !SHA_RE.test(String(v))) throw new HttpError(400, `invalid ${k}: must be a full commit sha`);
  }
  const repo = resolveRepo(store, goal);
  const branches = pushedBranches(store, goal.id);
  const branch = input.branch ?? branches[0]?.branch;
  if (!repo || !branch) throw new HttpError(409, 'nothing to merge');

  const base = await resolveBase(repoHub, repo.name, repo);
  const into = input.into ?? base;
  if (!into) throw new HttpError(409, 'no base branch in the hub');
  repoHub.protect(repo.name, [into]);
  await syncBaseFromLocal(repoHub, repo, into);

  // What gets merged is a commit, read from the hub — never a name that could move under us.
  const branchHead = await repoHub.headSha(repo.name, branch);
  if (!branchHead) throw new HttpError(409, `branch ${branch} is not in the hub`);
  const baseHead = await repoHub.headSha(repo.name, into);
  if (!baseHead) throw new HttpError(409, `base ${into} is not in the hub`);
  if (input.baseSha && input.baseSha !== baseHead) {
    throw new HttpError(409, `base ${into} moved since review (${input.baseSha.slice(0, 8)} → ${baseHead.slice(0, 8)}); review and approve again`, { baseSha: baseHead });
  }
  const mergeSha = input.sha ?? branchHead;

  const strategy = input.strategy === 'squash' ? 'squash' : 'merge';
  const deleteBranch = input.deleteBranch !== false;
  const message = input.message || `Merge ${branch}: ${goal.title}`;
  const bare = repoHub.barePath(repo.name);
  if (input.sha && input.sha !== branchHead) {
    // Only a commit the branch still contains (so the clone has it); a rewritten branch is re-reviewed.
    const anc = await gitTry(['--git-dir', bare, 'merge-base', '--is-ancestor', input.sha, branchHead]);
    if (!anc.ok) throw new HttpError(409, `commit ${input.sha.slice(0, 8)} is no longer on ${branch}; review and approve again`);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'alfred-land-'));
  let sha = '';
  try {
    await git(['clone', '-q', '--', bare, tmp]);
    await git(['checkout', '-q', '-B', into, baseHead], tmp);

    if (strategy === 'merge') {
      const m = await gitTry([...IDENTITY, 'merge', '--no-ff', '-m', message, mergeSha], tmp);
      if (!m.ok) {
        const conflicts = await conflictPaths(tmp);
        await gitTry(['merge', '--abort'], tmp);
        throw new HttpError(409, 'merge conflict', { conflicts });
      }
    } else {
      const m = await gitTry(['merge', '--squash', mergeSha], tmp);
      if (!m.ok) {
        const conflicts = await conflictPaths(tmp);
        await gitTry(['reset', '--hard'], tmp);
        throw new HttpError(409, 'merge conflict', { conflicts });
      }
      const c = await gitTry([...IDENTITY, 'commit', '-m', message], tmp);
      if (!c.ok) throw new Error(`squash commit failed: ${c.tail}`);
    }

    sha = await landInHub(bare, tmp, into, baseHead, `alfred merge ${branch}`);
    // Before the hub branch may be deleted: the Spark checkout's repo keeps a copy of the goal branch.
    const local = repo.paths?.local;
    if (local && existsSync(local)) await gitTry(['fetch', '-q', '--', bare, `+refs/heads/${branch}:refs/heads/${branch}`], local);
    if (deleteBranch) {
      // Only if nobody pushed more to it meanwhile (expected old value = what we merged from).
      await gitTry(['--git-dir', bare, 'update-ref', '-d', `refs/heads/${branch}`, branchHead]);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  const ff = await fastForwardLocal(repo?.paths?.local, bare, into);
  // A merge must never live only in the hub (a later sync could lose it): the live checkout's repo keeps a
  // copy of the goal branch, and of the merge itself whenever the checkout couldn't take it.
  let localNote = ff.ok ? undefined : ff.why;
  const local = repo?.paths?.local;
  if (local && existsSync(local)) {
    if (!ff.ok) {
      const keep = `merged/${goal.slug ?? goal.id.slice(0, 8)}`;
      const k = await gitTry(['fetch', '-q', '--', bare, `+refs/heads/${into}:refs/heads/${keep}`], local);
      localNote = `${ff.why}${k.ok ? ` — the merge is kept in the Spark checkout as branch ${keep}` : ''}`;
    }
  }

  store.appendEvent(goal.id, null, 'goal_merged', { branch, into, sha, strategy, localUpdated: ff.ok, ...(localNote ? { localNote } : {}) });
  return { ok: true, into, sha, localUpdated: ff.ok, ...(localNote ? { localNote } : {}) };
}

/**
 * Not a push (the hub's pre-receive hook refuses pushes to base branches): bring the clone's `into`
 * into the hub and move the base ref with a compare-and-swap against the head it was built on.
 */
async function landInHub(bare: string, tmp: string, into: string, baseHead: string, why: string): Promise<string> {
  const sha = (await git(['rev-parse', 'HEAD'], tmp)).trim();
  await git(['--git-dir', bare, 'fetch', '-q', '--no-tags', '--', tmp, `+refs/heads/${into}:refs/alfred/landing`]);
  const upd = await gitTry(['--git-dir', bare, 'update-ref', '-m', why, `refs/heads/${into}`, sha, baseHead]);
  await gitTry(['--git-dir', bare, 'update-ref', '-d', 'refs/alfred/landing']);
  if (!upd.ok) throw new HttpError(409, `base ${into} moved meanwhile; try again`);
  return sha;
}

/** The goal's merges that are landed and not reverted yet, oldest first (from goal_merged / goal_reverted). */
export function landedMerges(store: Pick<Store, 'events'>, goalId: string): { sha: string; into: string }[] {
  const reverted = new Set<string>();
  const merges: { sha: string; into: string }[] = [];
  for (const e of store.events(goalId)) {
    if (e.kind === 'goal_reverted' && typeof e.data?.reverted === 'string') reverted.add(e.data.reverted);
    if (e.kind === 'goal_merged' && typeof e.data?.sha === 'string') merges.push({ sha: e.data.sha, into: String(e.data.into) });
  }
  return merges.filter((m) => !reverted.has(m.sha));
}

/**
 * ALF-7 — undo a landed goal: `git revert` its merge (`sha`, default: the latest goal_merged not yet
 * reverted) on the branch it landed on, as a new commit. Nothing is rewritten, so the rollback can
 * itself be reverted. Conflicts (later work touched the same lines) → 409, nothing changes.
 */
export async function revertGoal(
  store: Store,
  repoHub: RepoHub,
  goal: { id: string; title: string; meta?: Record<string, any> },
  input: { sha?: string },
): Promise<{ ok: true; into: string; sha: string; reverted: string; files: string[]; localUpdated: boolean }> {
  if (input.sha !== undefined && !SHA_RE.test(String(input.sha))) throw new HttpError(400, 'invalid sha: must be a full commit sha');
  const repo = resolveRepo(store, goal);
  const open = landedMerges(store, goal.id);
  const target = input.sha ? open.find((m) => m.sha === input.sha) : open[open.length - 1];
  if (!repo || !target) throw new HttpError(409, input.sha ? `merge ${input.sha.slice(0, 8)} is not a landed, unreverted merge of this goal` : 'nothing to revert');
  const into = target.into;
  try {
    assertBranch(into, 'into');
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  repoHub.protect(repo.name, [into]);
  await syncBaseFromLocal(repoHub, repo, into);
  const bare = repoHub.barePath(repo.name);
  const baseHead = await repoHub.headSha(repo.name, into);
  if (!baseHead) throw new HttpError(409, `base ${into} is not in the hub`);
  const onBase = await gitTry(['--git-dir', bare, 'merge-base', '--is-ancestor', target.sha, baseHead]);
  if (!onBase.ok) throw new HttpError(409, `merge ${target.sha.slice(0, 8)} is not on ${into}`);

  const tmp = await mkdtemp(join(tmpdir(), 'alfred-revert-'));
  let sha = '';
  let files: string[] = [];
  try {
    await git(['clone', '-q', '--', bare, tmp]);
    await git(['checkout', '-q', '-B', into, baseHead], tmp);
    const parents = (await git(['rev-list', '--parents', '-n', '1', target.sha], tmp)).trim().split(/\s+/).length - 1;
    const r = await gitTry([...IDENTITY, 'revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), target.sha], tmp);
    if (!r.ok) {
      const conflicts = await conflictPaths(tmp);
      await gitTry(['revert', '--abort'], tmp);
      throw new HttpError(409, 'revert conflict', { conflicts });
    }
    files = (await git(['diff', '--name-only', baseHead, 'HEAD'], tmp)).split('\n').map((f) => f.trim()).filter(Boolean);
    sha = await landInHub(bare, tmp, into, baseHead, `alfred revert ${target.sha.slice(0, 8)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  const localUpdated = (await fastForwardLocal(repo.paths?.local, bare, into)).ok;
  store.appendEvent(goal.id, null, 'goal_reverted', { into, sha, reverted: target.sha });
  return { ok: true, into, sha, reverted: target.sha, files, localUpdated };
}

async function conflictPaths(cwd: string): Promise<string[]> {
  const r = await gitTry(['diff', '--name-only', '--diff-filter=U'], cwd);
  return (r.ok ? r.stdout : '').split('\n').map((s) => s.trim()).filter(Boolean);
}

const WT = '/.alfred-worktrees/';

const pathInside = (p: string, root: string): boolean =>
  p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/** P15 §5 — delete the goal's hub branch(es) and clean up local workspaces. */
export async function discardGoal(
  store: Store,
  repoHub: RepoHub,
  workRoot: string,
  goal: { id: string; meta?: Record<string, any> },
  branchQ?: string,
): Promise<{ ok: true; branches: string[]; removed: string[]; kept: string[] }> {
  try {
    assertBranch(branchQ, 'branch');
  } catch (e: any) {
    throw new HttpError(400, e.message);
  }
  const repo = resolveRepo(store, goal);
  const all = pushedBranches(store, goal.id).map((b) => b.branch);
  const branches = branchQ ? all.filter((b) => b === branchQ) : all;

  if (repo && branches.length) {
    const bare = repoHub.barePath(repo.name);
    for (const b of branches) await gitTry(['--git-dir', bare, 'branch', '-D', '--', b]);
  }

  const removed: string[] = [];
  const kept: string[] = [];
  // Latest workspace event per task.
  const latest = new Map<string, { path: string; node: string }>();
  for (const e of store.events(goal.id)) {
    if (e.kind !== 'workspace' || !e.taskId || typeof e.data?.path !== 'string') continue;
    latest.set(e.taskId, { path: e.data.path, node: String(e.data.node ?? 'local') });
  }
  const seen = new Set<string>();
  for (const t of store.listTasks(goal.id)) {
    const ws = latest.get(t.id);
    if (!ws || seen.has(ws.path)) continue;
    seen.add(ws.path);
    if (ws.node !== 'local' || pathInside(ws.path, repoHub.root)) {
      kept.push(ws.path); // node workspaces and hub clones are left alone
      continue;
    }
    if (ws.path.includes(WT)) {
      const checkout = ws.path.slice(0, ws.path.indexOf(WT));
      const r = await gitTry(['-C', checkout, 'worktree', 'remove', '--force', ws.path]);
      (r.ok ? removed : kept).push(ws.path);
      continue;
    }
    if (pathInside(ws.path, workRoot)) {
      await rm(ws.path, { recursive: true, force: true }).catch(() => {});
      removed.push(ws.path);
    } else {
      kept.push(ws.path);
    }
  }

  store.appendEvent(goal.id, null, 'goal_discarded', { branches });
  return { ok: true, branches, removed, kept };
}

/** Fast-forward a clean local checkout sitting on `into`; failures are reported, not fatal. */
async function fastForwardLocal(local: string | undefined, bare: string, into: string): Promise<{ ok: boolean; why: string }> {
  if (!local || !existsSync(local)) return { ok: false, why: 'no checkout of this repo on the Spark' };
  try {
    const status = await git(['status', '--porcelain'], local);
    if (status.trim()) return { ok: false, why: `the Spark checkout (${local}) has uncommitted changes` };
    const head = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], local)).trim();
    if (head !== into) return { ok: false, why: `the Spark checkout is on ${head}, not ${into}` };
    await git(['fetch', '-q', '--', bare, into], local);
    const ff = await gitTry(['merge', '-q', '--ff-only', 'FETCH_HEAD'], local);
    if (!ff.ok) return { ok: false, why: `the Spark checkout's ${into} has commits the hub's doesn't (they diverged)` };
    return { ok: true, why: '' };
  } catch (e: any) {
    return { ok: false, why: `could not update the Spark checkout: ${String(e?.message ?? e).slice(0, 200)}` };
  }
}
