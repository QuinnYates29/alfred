// P4 §1 — operations shared by the HTTP API, the CLI and the Claude door.
// One place that knows how a goal, a root task and a retry are shaped, so the
// front ends cannot drift apart.
import type { Store } from './store.js';
import {
  TERMINAL,
  type AcceptanceCheck,
  type Budget,
  type Goal,
  type Task,
  type TaskStatus,
} from './types.js';

const ALL_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'verifying',
  'done',
  'failed',
  'blocked',
  'needs_claude',
  'stopped',
];

export interface GoalWithRootInput {
  title: string;
  body?: string;
  /** Default 'alfred' — the orchestrating persona. */
  persona?: string;
  /** Default: the body. */
  spec?: string;
  acceptance?: AcceptanceCheck[];
  /** goal.meta.repo: a git repo to work in (worktrees per root task). */
  repo?: string;
  budget?: Partial<Budget>;
}

export interface GoalSummary {
  goal: Goal;
  counts: Record<TaskStatus, number>;
}

export function createGoalWithRoot(
  store: Store,
  input: GoalWithRootInput,
): { goal: Goal; task: Task } {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('goal title is required');
  const body = input.body ?? '';
  const spec = input.spec ?? body;
  const acceptance = input.acceptance ?? [];
  const goal = store.createGoal({
    title,
    body,
    acceptance,
    budget: input.budget,
    meta: input.repo ? { repo: input.repo } : {},
  });
  const task = store.createTask({
    goalId: goal.id,
    persona: input.persona ?? 'alfred',
    title: `${title} — root`,
    spec,
    acceptance,
    budget: input.budget,
  });
  store.appendEvent(goal.id, task.id, 'goal_root_task', { taskId: task.id, persona: task.persona });
  return { goal, task };
}

/**
 * A fresh queued clone of a terminal task: same goal, parent, persona, spec,
 * acceptance and budget; the old notes carry over, plus `note`.
 */
export function retryTask(store: Store, taskId: string, note?: string): Task {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  if (!(TERMINAL as readonly string[]).includes(task.status)) {
    throw new Error(`task ${taskId} is ${task.status}; retry only works on done/failed/stopped tasks`);
  }
  const clone = store.createTask({
    goalId: task.goalId,
    parentTaskId: task.parentTaskId ?? undefined,
    persona: task.persona,
    title: task.title,
    spec: task.spec,
    acceptance: task.acceptance,
    budget: task.budget,
  });
  const notes = [task.notes.trimEnd(), note?.trim() ?? ''].filter((s) => s).join('\n\n');
  if (notes) store.appendNote(clone.id, notes);
  store.appendEvent(task.goalId, clone.id, 'task_retried', { from: taskId });
  return store.getTask(clone.id)!;
}

export function goalSummary(store: Store, goalId: string): GoalSummary {
  const goal = store.getGoal(goalId);
  if (!goal) throw new Error(`no such goal: ${goalId}`);
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  for (const t of store.listTasks(goal.id)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { goal, counts };
}

/** A goal by id or slug; undefined when neither matches. */
export function resolveGoal(store: Store, ref: string): Goal | undefined {
  return store.getGoal(ref) ?? store.listGoals().find((g) => g.slug === ref);
}
