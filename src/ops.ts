// P4 §1 — operations shared by the API, the CLI and the Claude door.
import type { AcceptanceCheck, Budget, Goal, Task, TaskStatus } from './types.js';
import type { Store } from './store.js';

export interface CreateGoalWithRootInput {
  title: string;
  body?: string;
  /** Default 'alfred'. */
  persona?: string;
  /** Default: the goal's body. */
  spec?: string;
  acceptance?: AcceptanceCheck[];
  /** Absolute path of the git repo the goal works on; lands in goal.meta.repo. */
  repo?: string;
  budget?: Partial<Budget>;
}

/** Create a goal plus its single root task in one call. */
export function createGoalWithRoot(
  store: Store,
  input: CreateGoalWithRootInput,
): { goal: Goal; task: Task } {
  if (!input.title || !input.title.trim()) throw new Error('title is required');
  const body = input.body ?? '';
  const acceptance = input.acceptance ?? [];
  const goal = store.createGoal({
    title: input.title,
    body,
    acceptance,
    budget: input.budget,
    meta: input.repo ? { repo: input.repo } : {},
  });
  const task = store.createTask({
    goalId: goal.id,
    persona: input.persona ?? 'alfred',
    title: input.title,
    spec: input.spec ?? body,
    acceptance,
  });
  return { goal, task };
}

/**
 * Clone a failed/stopped task as a fresh queued one (the `alfred_retry`
 * semantics): same goal/parent/persona/spec/acceptance; notes carry over,
 * plus the optional new note.
 */
export function retryTask(store: Store, taskId: string, note?: string): Task {
  const src = store.getTask(taskId);
  if (!src) throw new Error(`no such task: ${taskId}`);
  if (src.status !== 'failed' && src.status !== 'stopped') {
    throw new Error(`retry needs a failed or stopped task (this one is ${src.status})`);
  }
  const fresh = store.createTask({
    goalId: src.goalId,
    parentTaskId: src.parentTaskId,
    persona: src.persona,
    title: src.title,
    spec: src.spec,
    acceptance: src.acceptance,
    budget: src.budget,
  });
  if (src.notes && src.notes.trim()) store.appendNote(fresh.id, src.notes.trimEnd());
  const extra = [src.reason ? `retry of ${taskId} (${src.status}: ${src.reason})` : `retry of ${taskId}`, note]
    .filter((s): s is string => !!s && !!s.trim())
    .join(' — ');
  if (extra) store.appendNote(fresh.id, extra);
  return store.getTask(fresh.id)!;
}

export interface GoalSummary extends Goal {
  counts: Partial<Record<TaskStatus, number>>;
}

/** Goal plus task counts by status. */
export function goalSummary(store: Store, goalId: string): GoalSummary | undefined {
  const goal = store.getGoal(goalId);
  if (!goal) return undefined;
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of store.listTasks(goalId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { ...goal, counts };
}

/** A goal by id or slug; undefined when neither matches. (from P3b, used by the Claude door) */
export function resolveGoal(store: Store, ref: string): Goal | undefined {
  return store.getGoal(ref) ?? store.listGoals().find((g) => g.slug === ref);
}
