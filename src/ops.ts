// P4 §1 — operations shared by the API, the CLI and the Claude door.
import { DEFAULT_BUDGET, type Budget, type Task } from './types.js';
import type { AcceptanceCheck } from './types.js';
import type { Store } from './store.js';

export interface CreateGoalOpts {
  title: string;
  body?: string;
  persona?: string;
  spec?: string;
  acceptance?: AcceptanceCheck[];
  repo?: string;
  budget?: Partial<Budget>;
  model?: string;
}

export function createGoalWithRoot(
  store: Store,
  o: CreateGoalOpts,
): { goal: ReturnType<Store['createGoal']>; task: Task } {
  const acceptance = o.acceptance ?? [];
  const goal = store.createGoal({
    title: o.title,
    body: o.body ?? o.title,
    acceptance,
    budget: o.budget,
    meta: { ...(o.repo ? { repo: o.repo } : {}), ...(o.model ? { model: o.model } : {}) },
  });
  const task = store.createTask({
    goalId: goal.id,
    persona: o.persona ?? 'alfred',
    title: o.title,
    spec: o.spec ?? o.body ?? o.title,
    acceptance,
    budget: o.budget,
  });
  return { goal, task };
}

/** Clone of a failed/stopped/blocked task, re-queued; the original keeps its history. */
export function retryTask(store: Store, taskId: string, note?: string): Task {
  const t = store.getTask(taskId);
  if (!t) throw new Error(`no such task: ${taskId}`);
  if (!['failed', 'stopped', 'blocked'].includes(t.status)) {
    throw new Error(`task ${taskId} is ${t.status}; only failed/stopped/blocked tasks can be retried`);
  }
  if (note?.trim()) store.appendNote(taskId, note);
  const clone = store.createTask({
    goalId: t.goalId,
    parentTaskId: t.parentTaskId,
    persona: t.persona,
    title: t.title,
    spec: t.spec,
    acceptance: t.acceptance,
    budget: { ...DEFAULT_BUDGET, ...t.budget },
  });
  if (t.notes.trim()) store.appendNote(clone.id, t.notes);
  if (note?.trim()) store.appendNote(clone.id, note);
  // A goal that had failed goes back to active when work reappears.
  const goal = store.getGoal(t.goalId);
  if (goal && goal.status !== 'active') {
    store.setGoalMeta(t.goalId, { retriedAt: Date.now() });
  }
  return store.getTask(clone.id)!;
}

export function goalSummary(store: Store, goalId: string) {
  const goal = store.getGoal(goalId);
  if (!goal) return null;
  const tasks = store.listTasks(goalId);
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { goal, counts };
}
