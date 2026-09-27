// P15 §2 — where a goal's code is: repo, base branch, pushed branches, and the
// diff of one branch against base (three-dot) in the bare hub.
import type { Store, Repo } from '../store.js';
import type { RepoHub } from '../git/hub.js';
import { git, gitTry } from './git.js';

export const DIFF_CAP = 200_000;
export const FILE_DIFF_CAP = 1_000_000;

export interface PushedBranch {
  branch: string;
  sha: string;
  taskId: string;
}

/** The goal's repo: a registered name, or a path matching a registered repo's paths value. */
export function resolveRepo(store: Store, goal: { meta?: Record<string, any> }): Repo | null {
  const v = goal.meta?.repo;
  if (typeof v !== 'string' || !v) return null;
  const byName = store.getRepo(v);
  if (byName) return byName;
  return store.listRepos().find((r) => Object.values(r.paths ?? {}).includes(v)) ?? null;
}

/** The goal's pushed branches from `pushed` events; latest event per branch wins. */
export function pushedBranches(store: Store, goalId: string): PushedBranch[] {
  const byBranch = new Map<string, PushedBranch>();
  for (const e of store.events(goalId)) {
    if (e.kind !== 'pushed' || !e.data?.branch) continue;
    byBranch.set(String(e.data.branch), {
      branch: String(e.data.branch),
      sha: String(e.data.sha ?? ''),
      taskId: String(e.taskId ?? ''),
    });
  }
  return [...byBranch.values()];
}

/** repo.defaultBranch, else the hub's HEAD branch (if it exists), else main, else master. */
export async function resolveBase(repoHub: RepoHub, repoName: string, repo: Repo | null): Promise<string | null> {
  if (repo?.defaultBranch) return repo.defaultBranch;
  const bare = repoHub.barePath(repoName);
  const head = await gitTry(['--git-dir', bare, 'symbolic-ref', '--short', 'HEAD']);
  const candidates: string[] = [];
  if (head.ok) candidates.push(head.stdout.trim());
  candidates.push('main', 'master');
  const branches = await repoHub.branches(repoName);
  for (const c of candidates) if (branches.includes(c)) return c;
  return null;
}

function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const m = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [a, d, path] = [parts[0], parts[1], parts.slice(2).join('\t')];
    m.set(path, {
      additions: a === '-' ? 0 : Number(a) || 0,
      deletions: d === '-' ? 0 : Number(d) || 0,
    });
  }
  return m;
}

export interface ChangesResult {
  repo: string | null;
  base: string | null;
  branches: PushedBranch[];
  commits: { sha: string; subject: string; author: string; date: string }[];
  files: { path: string; status: string; additions: number; deletions: number }[];
  diff: string;
  truncated: boolean;
}

export async function getChanges(
  store: Store,
  repoHub: RepoHub,
  goal: { id: string; meta?: Record<string, any> },
  branchQ?: string,
): Promise<ChangesResult> {
  const repo = resolveRepo(store, goal);
  const branches = pushedBranches(store, goal.id);
  const out: ChangesResult = {
    repo: repo?.name ?? null,
    base: null,
    branches,
    commits: [],
    files: [],
    diff: '',
    truncated: false,
  };
  if (!repo || branches.length === 0) return out;

  const base = await resolveBase(repoHub, repo.name, repo);
  const branch = branchQ ? branches.find((b) => b.branch === branchQ)?.branch ?? branchQ : branches[0].branch;
  out.base = base;
  if (!base) return out;

  const bare = repoHub.barePath(repo.name);
  const range = `${base}...${branch}`;
  const [logRes, namesRes, numRes, diffRes] = await Promise.all([
    gitTry(['--git-dir', bare, 'log', '--reverse', '--format=%H\x1f%an <%ae>\x1f%cI\x1f%s', range]),
    gitTry(['--git-dir', bare, 'diff', '--name-status', range]),
    gitTry(['--git-dir', bare, 'diff', '--numstat', range]),
    gitTry(['--git-dir', bare, 'diff', range]),
  ]);
  if (!logRes.ok || !namesRes.ok) return out; // unknown base/branch → nothing to show

  for (const line of logRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, author, date, ...rest] = line.split('\x1f');
    out.commits.push({ sha, subject: rest.join('\x1f'), author, date });
  }
  const stats = parseNumstat(numRes.ok ? numRes.stdout : '');
  for (const line of namesRes.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    const path = parts[parts.length - 1];
    const s = stats.get(path) ?? { additions: 0, deletions: 0 };
    out.files.push({ path, status, additions: s.additions, deletions: s.deletions });
  }
  const raw = diffRes.ok ? diffRes.stdout : '';
  out.truncated = raw.length > DIFF_CAP;
  out.diff = raw.slice(0, DIFF_CAP);
  return out;
}

export async function getFileDiff(
  store: Store,
  repoHub: RepoHub,
  goal: { id: string; meta?: Record<string, any> },
  file: string,
  branchQ?: string,
): Promise<{ file: string; diff: string } | { error: string }> {
  const repo = resolveRepo(store, goal);
  const branches = pushedBranches(store, goal.id);
  if (!repo || branches.length === 0) return { file, diff: '' };
  const base = await resolveBase(repoHub, repo.name, repo);
  if (!base) return { file, diff: '' };
  const branch = branchQ ? branches.find((b) => b.branch === branchQ)?.branch ?? branchQ : branches[0].branch;
  const res = await gitTry([
    '--git-dir', repoHub.barePath(repo.name), 'diff', `${base}...${branch}`, '--', file,
  ]);
  return { file, diff: (res.ok ? res.stdout : '').slice(0, FILE_DIFF_CAP) };
}
