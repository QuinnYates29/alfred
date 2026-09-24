// P0 contract. Written by the orchestrator; implementers build to it and may
// extend it, but must not change the meaning of anything below.

/** Every task ends in one of TERMINAL, or waits in PARKED for a human/Claude. */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'needs_claude'
  | 'stopped';

export const TERMINAL: readonly TaskStatus[] = ['done', 'failed', 'stopped'];
export const PARKED: readonly TaskStatus[] = ['blocked', 'needs_claude'];
/** Transitions into these must carry a non-empty reason: failing loudly. */
export const NEEDS_REASON: readonly TaskStatus[] = ['failed', 'blocked', 'needs_claude', 'stopped'];

export type GoalStatus = 'active' | 'done' | 'failed';

export interface Budget {
  turns: number;
  tokens: number;
  wallClockMs: number;
  /** Max direct children a task may spawn. */
  maxSubtasks: number;
  /** Max depth below the goal's root tasks (root tasks are depth 0). */
  maxDepth: number;
}

export const DEFAULT_BUDGET: Budget = {
  turns: 60,
  tokens: 2_000_000,
  wallClockMs: 4 * 60 * 60 * 1000,
  maxSubtasks: 4,
  maxDepth: 2,
};

export interface AcceptanceCheck {
  name: string;
  /** Run with `bash -c`. Exit 0 = pass. */
  cmd: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface Goal {
  id: string;
  slug: string;
  title: string;
  body: string;
  acceptance: AcceptanceCheck[];
  budget: Budget;
  status: GoalStatus;
  /** Free-form goal metadata; `repo` = absolute path of the git repo the goal works on. */
  meta: Record<string, any>;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  goalId: string;
  parentTaskId: string | null;
  depth: number;
  persona: string;
  title: string;
  spec: string;
  acceptance: AcceptanceCheck[];
  budget: Budget;
  status: TaskStatus;
  /** Incremented on every claim. */
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  /** Reason of the latest transition that carried one. */
  reason: string | null;
  /** Accumulated notes; survive reclaim/retry so a retry is never from scratch. */
  notes: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventRow {
  id: number;
  goalId: string;
  taskId: string | null;
  ts: number;
  kind: string;
  data: any;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  /** Tail of combined stdout+stderr, at most 4000 chars. */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export type CheckRunner = (check: AcceptanceCheck) => Promise<CheckResult>;

export interface Notice {
  level: 'info' | 'warn' | 'failure';
  goalId: string;
  taskId?: string;
  title: string;
  body: string;
}

export interface Sink {
  name: string;
  send(n: Notice): Promise<void>;
}

export class IllegalTransitionError extends Error {}
export class DoneGateError extends Error {}
export class BudgetError extends Error {}
export class ReasonRequiredError extends Error {}
