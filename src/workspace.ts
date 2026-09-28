// Workspace resolution for tasks (P2 §0, P9, P10).
// Every task runs in a directory derived from its goal and its root ancestor task:
// - plain goals: <root>/<goal.slug>/
// - repo goals (goal.meta.repo set): a git worktree at <root>/<goal.slug>/<rootTaskId[0..8]>
//   on branch alfred/<goal.slug>/<rootTaskId[0..8]>, created from the repo's current HEAD.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { Store } from './store.js';
import type { Goal, Task } from './types.js';
import type { WorkspaceBackend } from './runtime/contract.js';
import { NodeOfflineError } from './runtime/contract.js';
import { registerGitHub, scrubEnv } from './sandbox.js';
import type { NodeHub } from './node/hub.js';

export interface WorkspaceOpts {
  /** Base directory for workspaces. Default ~/.alfred/work */
  root?: string;
}

/** Follow parentTaskId up to the task that has no parent. */
function rootAncestor(store: Store, task: Task): Task {
  let cur = task;
  const seen = new Set<string>([cur.id]);
  while (cur.parentTaskId) {
    const parent = store.getTask(cur.parentTaskId);
    if (!parent) throw new Error(`task ${task.id} references missing parent ${cur.parentTaskId}`);
    if (seen.has(parent.id)) throw new Error(`task parent cycle at ${parent.id}`);
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

export function workspaceFor(store: Store, task: Task, o?: WorkspaceOpts): string {
  const base = o?.root ?? join(homedir(), '.alfred', 'work');
  const goal = store.getGoal(task.goalId);
  if (!goal) throw new Error(`no such goal: ${task.goalId}`);

  const root = rootAncestor(store, task);

  const repo = typeof goal.meta?.repo === 'string' ? goal.meta.repo : null;
  if (!repo) {
    const dir = join(base, goal.slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const id8 = root.id.slice(0, 8);
  const ws = join(base, goal.slug, id8);
  if (existsSync(ws)) return ws;

  mkdirSync(join(base, goal.slug), { recursive: true });
  const branch = `alfred/${goal.slug}/${id8}`;
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', branch, ws, 'HEAD'], {
    stdio: 'pipe',
    env: scrubEnv(process.env),
  });
  return ws;
}

// ---- P9 + P10: workspaces on nodes, wired to the Spark repo hub ----

export interface ResolvedWorkspace {
  backend: WorkspaceBackend;
  path: string;
  /** P10: the task branch (git workspaces only). */
  branch?: string;
  /** P10: the hub remote a done task publishes to ('spark'). */
  remote?: string;
}

export interface ResolveWorkspaceOpts extends WorkspaceOpts {
  /** P9 node hub. Absent = no nodes configured; a goal with meta.node/where set is treated as offline. */
  nodes?: NodeHub;
  /** P10: the Spark repo hub. Absent = pre-P10 behavior (plain dir / local worktree). */
  hub?: import('./git/hub.js').RepoHub;
  /** P10: sandbox root per machine ('local' = the Spark). Defaults: root (local), node's advertised sandbox. */
  sandboxRoots?: Record<string, string>;
}

export const shq = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** backend.exec that throws on non-zero exit (workspace setup is fail-fast; publishing is not). */
export async function be(backend: WorkspaceBackend, cwd: string, cmd: string, timeoutMs = 60_000, trusted = false): Promise<string> {
  const r = await backend.exec(cmd, { cwd, timeoutMs, ...(trusted ? { trusted } : {}) });
  if (r.exitCode !== 0) throw new Error(`${cmd} failed (exit ${r.exitCode}): ${r.output.slice(-600)}`);
  return r.output;
}

/** Commit identity: repo/global config wins; otherwise Alfred signs its own commits. */
export async function identityArgs(backend: WorkspaceBackend, cwd: string): Promise<string[]> {
  try {
    const r = await backend.exec('git config user.email', { cwd, timeoutMs: 15_000 });
    if (r.exitCode === 0 && r.output.trim()) return [];
  } catch {
    /* an unreadable config counts as "no identity" */
  }
  return ['-c', 'user.name=Alfred', `-c`, `user.email=alfred@${hostname()}`];
}

const joinPosix = (base: string, ...parts: string[]): string =>
  `${base.replace(/\/+$/, '')}/${parts.join('/')}`;

/**
 * Workspace SETUP commands (clone, worktree add, remote/branch config) are Alfred's
 * own, fully quoted commands: they run unsandboxed (they must write the repo's
 * .git/config, which the sandbox keeps read-only) but still with a scrubbed env.
 */
const tbe = (b: WorkspaceBackend, cwd: string, cmd: string, timeoutMs = 60_000): Promise<string> =>
  be(b, cwd, cmd, timeoutMs, true);
const texec = (b: WorkspaceBackend, cmd: string, o: { cwd: string; timeoutMs: number }) =>
  b.exec(cmd, { ...o, trusted: true });

/** mkdir -p on any backend. `cwd` must be a dir that exists on that machine. */
async function ensureDir(backend: WorkspaceBackend, dir: string, cwd: string): Promise<void> {
  if (backend.node === 'local') mkdirSync(dir, { recursive: true });
  else await tbe(backend, cwd, `mkdir -p ${shq(dir)}`);
}

/** A root-allowed exec cwd for a node (the sandbox path may not exist yet). */
function nodeExecCwd(o: ResolveWorkspaceOpts | undefined, where: string, fallback: string): string {
  const info = o?.nodes?.info(where);
  return info?.roots?.[0] ?? info?.sandbox ?? fallback;
}

/** Clone (or reuse + repoint) a hub clone and leave it on the task branch. */
async function setupClone(
  backend: WorkspaceBackend,
  cwd: string,
  ws: string,
  url: string,
  branch: string,
): Promise<void> {
  const exists = await texec(backend, `test -d ${shq(joinPosix(ws, '.git'))}`, { cwd, timeoutMs: 15_000 });
  if (exists.exitCode === 0) {
    await tbe(backend, cwd, `git -C ${shq(ws)} remote set-url spark ${shq(url)}`);
    return;
  }
  await tbe(backend, cwd, `git clone --origin spark ${shq(url)} ${shq(ws)}`, 120_000);
  const def = (await tbe(backend, cwd, `git -C ${shq(ws)} symbolic-ref --short HEAD`, 15_000)).trim();
  // An empty hub has no commits yet: branch the unborn HEAD instead.
  const has = await texec(backend, `git -C ${shq(ws)} rev-parse --verify --quiet spark/${shq(def)}`, { cwd, timeoutMs: 15_000 });
  const from = has.exitCode === 0 ? ` spark/${shq(def)}` : '';
  await tbe(backend, cwd, `git -C ${shq(ws)} -c core.hooksPath=/dev/null checkout -B ${shq(branch)}${from}`);
  await tbe(backend, cwd, `git -C ${shq(ws)} config branch.${shq(branch)}.remote spark`);
  await tbe(backend, cwd, `git -C ${shq(ws)} config branch.${shq(branch)}.merge refs/heads/${shq(branch)}`);
}

/** The repo path registered on the Spark, used to seed the hub (null when unregistered). */
function sparkSource(store: Store, name: string): string | undefined {
  return store.getRepo(name)?.paths.local ?? undefined;
}

/**
 * Resolve where a task runs and how it reaches the hub (P10 §3). Modes (goal.meta):
 * - sandbox, no repo → empty dir <sandboxRoot>/<goal-slug>/
 * - sandbox + repo → a clone of the hub at <sandboxRoot>/<goal-slug>/<id8>
 *   on branch alfred/<slug>/<id8> with remote `spark`
 * - repo → worktree <repoPath>/.alfred-worktrees/<id8> (or the checkout itself
 *   with meta.inPlace, which refuses a dirty tree), remote `spark`
 * Without `hub` the P9 behavior is kept; a non-local machine without `nodes`
 * throws NodeOfflineError.
 */
export async function resolveWorkspace(
  store: Store,
  task: Task,
  o?: ResolveWorkspaceOpts,
): Promise<ResolvedWorkspace> {
  const goal = store.getGoal(task.goalId);
  if (!goal) throw new Error(`no such goal: ${task.goalId}`);
  const meta = goal.meta ?? {};
  const nodeName =
    typeof meta.node === 'string' && meta.node
      ? meta.node
      : typeof meta.where === 'string' && meta.where
        ? meta.where
        : 'local';

  // No hub: the pre-P10 paths, unchanged.
  if (!o?.hub) {
    if (nodeName === 'local') {
      const { LocalBackend } = await import('./node/hub.js');
      return { backend: new LocalBackend(), path: workspaceFor(store, task, o) };
    }
    return resolveOnNode(store, task, goal, o);
  }

  const hub = o.hub;
  registerGitHub(hub.root); // sandboxed `git push spark` must reach the hub
  const { LocalBackend } = await import('./node/hub.js');
  let backend: WorkspaceBackend;
  if (nodeName === 'local') backend = new LocalBackend();
  else {
    if (!o.nodes) throw new NodeOfflineError(nodeName);
    backend = o.nodes.backend(nodeName);
  }

  const root = rootAncestor(store, task);
  const id8 = root.id.slice(0, 8);
  const branch = `alfred/${goal.slug}/${id8}`;
  const base = o.root ?? join(homedir(), '.alfred', 'work');

  // --- resolve the repo: registered name, absolute path (auto-register), or none ---
  const repoRef = typeof meta.repo === 'string' && meta.repo ? meta.repo : null;
  let name: string | null = null;
  let repoPath: string | null = null;
  if (repoRef) {
    const byName = store.getRepo(repoRef);
    const byPath = byName ? undefined : store.listRepos().find((r) => Object.values(r.paths).includes(repoRef));
    const reg = byName ?? byPath;
    if (reg) {
      name = reg.name;
      repoPath = reg.paths[nodeName] ?? null;
    } else if (isAbsolute(repoRef)) {
      name = basename(repoRef).replace(/\.git$/, '') || 'repo';
      store.upsertRepo({ name, paths: { [nodeName]: repoRef } });
      repoPath = repoRef;
    } else {
      throw new Error(`unknown repo: ${repoRef} (not registered and not an absolute path)`);
    }
  }

  const mode: 'repo' | 'sandbox' =
    meta.mode === 'repo' || (meta.mode !== 'sandbox' && !!repoPath) ? 'repo' : 'sandbox';

  if (mode === 'repo' && !repoPath) {
    throw new Error(`repo ${name} has no path on ${nodeName} (use sandbox mode, or register it there)`);
  }

  const sandboxRoot =
    o.sandboxRoots?.[nodeName] ??
    (nodeName === 'local'
      ? base
      : o.nodes?.info(nodeName)?.sandbox ?? joinPosix(o.nodes?.info(nodeName)?.roots?.[0] ?? base, 'alfred-sandbox'));

  // --- sandbox mode ---
  if (mode === 'sandbox') {
    if (!name) {
      const ws = joinPosix(sandboxRoot, goal.slug);
      await ensureDir(backend, ws, backend.node === 'local' ? base : nodeExecCwd(o, nodeName, base));
      return { backend, path: ws };
    }
    await hub.ensure(name, sparkSource(store, name));
    const url = hub.urlFor(name, nodeName);
    if (backend.node === 'local') {
      const parent = joinPosix(sandboxRoot, goal.slug);
      mkdirSync(parent, { recursive: true });
      await setupClone(backend, parent, joinPosix(parent, id8), url, branch);
    } else {
      await ensureDir(backend, sandboxRoot, nodeExecCwd(o, nodeName, base));
      await setupClone(backend, nodeExecCwd(o, nodeName, base), joinPosix(sandboxRoot, goal.slug, id8), url, branch);
    }
    const wsPath = joinPosix(sandboxRoot, goal.slug, id8);
    return { backend, path: wsPath, branch, remote: 'spark' };
  }

  // --- repo mode ---
  const repoAbs = repoPath as string;
  const inPlace = meta.inPlace === true;
  if (name) await hub.ensure(name, sparkSource(store, name));

  const ensureSparkRemote = async (cwd: string): Promise<void> => {
    if (!name) return;
    const url = hub.urlFor(name, nodeName);
    const has = await texec(backend, `git -C ${shq(cwd)} remote get-url spark`, { cwd, timeoutMs: 15_000 });
    if (has.exitCode === 0) await tbe(backend, cwd, `git -C ${shq(cwd)} remote set-url spark ${shq(url)}`);
    else await tbe(backend, cwd, `git -C ${shq(cwd)} remote add spark ${shq(url)}`);
  };

  if (inPlace) {
    const dirty = await texec(backend, 'git status --porcelain', { cwd: repoAbs, timeoutMs: 20_000 });
    if (dirty.exitCode !== 0) throw new Error(`not a git repo: ${repoAbs}`);
    if (dirty.output.trim()) throw new Error(`refusing inPlace work: ${repoAbs} is dirty`);
    const cur = (await tbe(backend, repoAbs, 'git branch --show-current', 15_000)).trim();
    if (cur !== branch) {
      const has = await texec(backend, `git rev-parse --verify ${shq(branch)}`, { cwd: repoAbs, timeoutMs: 15_000 });
      if (has.exitCode === 0) await tbe(backend, repoAbs, `git -c core.hooksPath=/dev/null checkout ${shq(branch)}`);
      else await tbe(backend, repoAbs, `git -c core.hooksPath=/dev/null checkout -b ${shq(branch)}`);
    }
    await ensureSparkRemote(repoAbs);
    return { backend, path: repoAbs, branch, ...(name ? { remote: 'spark' } : {}) };
  }

  const ws = joinPosix(repoAbs, '.alfred-worktrees', id8);
  const exists = await texec(backend, `test -d ${shq(ws)}`, { cwd: repoAbs, timeoutMs: 15_000 });
  if (exists.exitCode !== 0) {
    await tbe(backend, repoAbs, `git worktree add -b ${shq(branch)} ${shq(ws)} HEAD`);
  }
  await ensureSparkRemote(repoAbs);
  return { backend, path: ws, branch, ...(name ? { remote: 'spark' } : {}) };
}

/** P9 behavior for node goals when no hub is configured: worktree on the node, else the repo dir itself. */
async function resolveOnNode(
  store: Store,
  task: Task,
  goal: Goal,
  o?: ResolveWorkspaceOpts,
): Promise<ResolvedWorkspace> {
  const nodeName = typeof goal.meta?.node === 'string' && goal.meta.node ? goal.meta.node : 'local';
  // hub.backend() throws NodeOfflineError for an absent node; no hub = every node absent.
  if (!o?.nodes) throw new NodeOfflineError(nodeName);
  const backend = o.nodes.backend(nodeName);

  const repo = typeof goal.meta?.repo === 'string' && goal.meta.repo ? goal.meta.repo : null;
  if (!repo) throw new Error(`goal ${goal.slug} runs on node ${nodeName} but has no meta.repo`);

  const root = rootAncestor(store, task);
  const id8 = root.id.slice(0, 8);
  const caps = o.nodes.info(nodeName)?.caps ?? [];
  if (caps.includes('git')) {
    try {
      const probe = await texec(backend, 'git rev-parse --git-dir', { cwd: repo, timeoutMs: 15_000 });
      if (probe.exitCode === 0) {
        const ws = `${repo.replace(/\/+$/, '')}/.alfred-worktrees/${id8}`;
        const exists = await texec(backend, `test -d ${shq(ws)}`, { cwd: repo, timeoutMs: 15_000 });
        if (exists.exitCode !== 0) {
          await tbe(backend, repo, `git worktree add -b ${shq(`alfred/${goal.slug}/${id8}`)} ${shq(ws)} HEAD`);
        }
        return { backend, path: ws };
      }
    } catch {
      /* not a repo (or git trouble on the node): fall through to using repo directly */
    }
  }
  return { backend, path: repo };
}
