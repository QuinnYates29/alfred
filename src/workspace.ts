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
