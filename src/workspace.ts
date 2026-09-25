// Workspace resolution for tasks (P2 §0).
// Every task runs in a directory derived from its goal and its root ancestor task:
// - plain goals: <root>/<goal.slug>/
// - repo goals (goal.meta.repo set): a git worktree at <root>/<goal.slug>/<rootTaskId[0..8]>
//   on branch alfred/<goal.slug>/<rootTaskId[0..8]>, created from the repo's current HEAD.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Task } from './types.js';
import type { WorkspaceBackend } from './runtime/contract.js';
import { NodeOfflineError } from './runtime/contract.js';
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
    if (!parent) throw new Error(`task ${cur.id} references missing parent ${cur.parentTaskId}`);
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
  });
  return ws;
}

// ---- P9: workspaces that may live on an alfred-node ----

export interface ResolvedWorkspace {
  backend: WorkspaceBackend;
  path: string;
}

export interface ResolveWorkspaceOpts extends WorkspaceOpts {
  /** P9 node hub. Absent = no nodes configured; a goal with meta.node set is treated as offline. */
  nodes?: import('./node/hub.js').NodeHub;
}

/**
 * Resolve where a task runs. `meta.node` (default 'local') selects the
 * machine; on a node the worktree is created there via exec when the node has
 * the `git` cap and the repo really is a git repo — otherwise `repo` itself is
 * the workspace. Without `nodes`, local goals behave exactly like workspaceFor.
 */
export async function resolveWorkspace(
  store: Store,
  task: Task,
  o?: ResolveWorkspaceOpts,
): Promise<ResolvedWorkspace> {
  const goal = store.getGoal(task.goalId);
  if (!goal) throw new Error(`no such goal: ${task.goalId}`);
  const nodeName = typeof goal.meta?.node === 'string' && goal.meta.node ? goal.meta.node : 'local';

  if (nodeName === 'local') {
    const { LocalBackend } = await import('./node/hub.js');
    return { backend: new LocalBackend(), path: workspaceFor(store, task, o) };
  }

  // hub.backend() throws NodeOfflineError for an absent node; no hub = every node absent.
  if (!o?.nodes) throw new NodeOfflineError(nodeName);
  const backend = o.nodes.backend(nodeName);

  const repo = typeof goal.meta?.repo === 'string' && goal.meta.repo ? goal.meta.repo : null;
  if (!repo) throw new Error(`goal ${goal.slug} runs on node ${nodeName} but has no meta.repo`);

  const root = rootAncestor(store, task);
  const id8 = root.id.slice(0, 8);
  const caps = o?.nodes?.info(nodeName)?.caps ?? [];
  if (caps.includes('git')) {
    try {
      const probe = await backend.exec('git rev-parse --git-dir', { cwd: repo, timeoutMs: 15_000 });
      if (probe.exitCode === 0) {
        const ws = `${repo.replace(/\/+$/, '')}/.alfred-worktrees/${id8}`;
        const exists = await backend.exec(`test -d ${JSON.stringify(ws)}`, { cwd: repo, timeoutMs: 15_000 });
        if (exists.exitCode !== 0) {
          const add = await backend.exec(
            `git worktree add -b alfred/${goal.slug}/${id8} ${JSON.stringify(ws)} HEAD`,
            { cwd: repo, timeoutMs: 60_000 },
          );
          if (add.exitCode !== 0) throw new Error(`git worktree add failed: ${add.output.slice(-500)}`);
        }
        return { backend, path: ws };
      }
    } catch {
      /* not a repo (or git trouble on the node): fall through to using repo directly */
    }
  }
  return { backend, path: repo };
}
