// P15 §4/§5 — landing a goal's branch in the hub, and discarding it.
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../store.js';
import type { RepoHub } from '../git/hub.js';
import { git, gitTry } from './git.js';
import { resolveRepo, resolveBase, pushedBranches } from './changes.js';
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

export async function mergeGoal(
  store: Store,
  repoHub: RepoHub,
  goal: { id: string; title: string; meta?: Record<string, any> },
  input: MergeInput,
): Promise<{ ok: true; into: string; sha: string; localUpdated: boolean }> {
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

    sha = (await git(['rev-parse', 'HEAD'], tmp)).trim();
    // Not a push (the hub's pre-receive hook refuses pushes to base branches): bring the objects
    // into the hub and move the base ref with a compare-and-swap against the reviewed base head.
    await git(['--git-dir', bare, 'fetch', '-q', '--no-tags', '--', tmp, `+refs/heads/${into}:refs/alfred/landing`]);
    const upd = await gitTry(['--git-dir', bare, 'update-ref', '-m', `alfred merge ${branch}`, `refs/heads/${into}`, sha, baseHead]);
    await gitTry(['--git-dir', bare, 'update-ref', '-d', 'refs/alfred/landing']);
    if (!upd.ok) throw new HttpError(409, `base ${into} moved during the merge; try again`);
    if (deleteBranch) {
      // Only if nobody pushed more to it meanwhile (expected old value = what we merged from).
      await gitTry(['--git-dir', bare, 'update-ref', '-d', `refs/heads/${branch}`, branchHead]);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  const localUpdated = await fastForwardLocal(repo?.paths?.local, bare, into);

  store.appendEvent(goal.id, null, 'goal_merged', { branch, into, sha, strategy });
  return { ok: true, into, sha, localUpdated };
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
async function fastForwardLocal(local: string | undefined, bare: string, into: string): Promise<boolean> {
  if (!local || !existsSync(local)) return false;
  try {
    const status = await git(['status', '--porcelain'], local);
    if (status.trim()) return false;
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], local);
    if (head.trim() !== into) return false;
    await git(['fetch', '--', bare, into], local);
    await git(['merge', '--ff-only', 'FETCH_HEAD'], local);
    return true;
  } catch {
    return false;
  }
}
