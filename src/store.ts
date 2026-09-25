// P0 core store. SQLite-backed, WAL mode, BEGIN IMMEDIATE for claims.
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { registerApprovalStore, unregisterApprovalStore } from './approvals.js';
import {
  type Budget,
  DEFAULT_BUDGET,
  type Goal,
  type GoalStatus,
  type Task,
  type TaskStatus,
  type EventRow,
  type AcceptanceCheck,
  TERMINAL,
  NEEDS_REASON,
  IllegalTransitionError,
  DoneGateError,
  BudgetError,
  ReasonRequiredError,
} from './types.js';

export interface CreateGoalInput {
  title: string;
  body?: string;
  acceptance?: AcceptanceCheck[];
  budget?: Partial<Budget>;
  meta?: Record<string, any>;
}

export interface CreateTaskInput {
  goalId: string;
  parentTaskId?: string | null;
  persona: string;
  title: string;
  spec?: string;
  acceptance?: AcceptanceCheck[];
  budget?: Partial<Budget>;
  /** P7: model name or role from config/models.yaml for this task (additive). */
  model?: string | null;
}

export interface ClaimNextOpts {
  leaseMs: number;
  persona?: string;
}

export interface TransitionOpts {
  reason?: string;
  by?: string;
}

export interface EventsOpts {
  sinceId?: number;
}

export interface AllEventsOpts extends EventsOpts {
  /** Default 500. */
  limit?: number;
}

/** P8: token accounting derived from a task's `turn` / `compacted` events. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  peakPromptTokens: number;
  turns: number;
  compactions: number;
}

export interface GoalUsage extends Usage {
  byPersona: Record<string, { promptTokens: number; completionTokens: number }>;
}

/** Raw row of the automations table (P4). Templates ride as JSON text. */
export interface AutomationRow {
  id: string;
  name: string;
  cron: string;
  enabled: number;
  template: string;
  lastRunAt: number | null;
  lastGoalId: string | null;
  lastStatus: string | null;
  lastNote: string | null;
  createdAt: number;
  updatedAt: number;
}

/** P3 §3 — one requested action awaiting a decision. */
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  id: string;
  taskId: string;
  goalId: string;
  /** The guard that tripped, e.g. 'git push'. */
  action: string;
  /** The exact thing requested (the command); consumeApproval matches on it. */
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

export interface Store {
  createGoal(input: CreateGoalInput): Goal;
  getGoal(id: string): Goal | undefined;
  listGoals(): Goal[];
  /** Shallow-merge patch into the goal's meta; returns the updated goal. */
  setGoalMeta(goalId: string, patch: Record<string, any>): Goal;
  createTask(input: CreateTaskInput): Task;
  getTask(id: string): Task | undefined;
  /** P7: the per-task model name/role set at creation (spawn_subagent `model`), if any. */
  getTaskModel(taskId: string): string | null;
  listTasks(goalId: string): Task[];
  children(taskId: string): Task[];
  claim(taskId: string, workerId: string, leaseMs: number): boolean;
  claimNext(workerId: string, opts: ClaimNextOpts): Task | null;
  heartbeat(taskId: string, workerId: string, leaseMs: number): boolean;
  reclaimExpired(): string[];
  transition(taskId: string, to: TaskStatus, opts?: TransitionOpts): Task;
  appendNote(taskId: string, text: string): void;
  /** P8: store the finish summary (what a parent sees instead of the child's transcript). */
  setResult(taskId: string, text: string): void;
  /** P8: token accounting for one task, from its `turn` / `compacted` events. */
  taskUsage(taskId: string): Usage;
  /** P8: usage summed over every task of the goal, split by persona. */
  goalUsage(goalId: string): GoalUsage;
  appendEvent(goalId: string, taskId: string | null, kind: string, data: any): EventRow;
  events(goalId: string, opts?: EventsOpts): EventRow[];
  /** Ascending across all goals, for SSE replay. limit defaults to 500. */
  allEvents(opts?: AllEventsOpts): EventRow[];
  listAutomationRows(): AutomationRow[];
  putAutomationRow(row: AutomationRow): void;
  deleteAutomationRow(id: string): boolean;
  /** P3: record a requested action and park-ready notify the decider (event `approval_requested`). */
  requestApproval(taskId: string, action: string, detail: string): Approval;
  /** P3: approve/deny; a `blocked` task goes back to `queued` with the outcome in its notes. */
  decideApproval(id: string, decision: 'approved' | 'denied', by: string): Approval;
  approvals(opts?: { status?: ApprovalStatus; taskId?: string }): Approval[];
  /** P3: true once for an approved match, then the approval is spent. */
  consumeApproval(taskId: string, detail: string): boolean;
  onEvent(cb: (e: EventRow) => void): () => void;
  close(): void;
  /** Internal: only the done-gate may call this. */
  _markDone(taskId: string, by?: string): Task;
}

// Legal edges for transition(). 'done' is deliberately absent everywhere:
// only _markDone (the gate) may set it.
const EDGES: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'blocked', 'stopped'],
  running: ['verifying', 'failed', 'blocked', 'needs_claude', 'stopped', 'queued'],
  verifying: ['running', 'failed'],
  blocked: ['queued', 'failed', 'stopped'],
  needs_claude: ['queued', 'running', 'failed', 'stopped'],
  done: [],
  failed: [],
  stopped: [],
};

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'goal';
}

function mergeBudget(base: Budget, partial?: Partial<Budget>): Budget {
  return { ...base, ...(partial ?? {}) };
}

interface GoalRow {
  seq: number;
  id: string;
  slug: string;
  title: string;
  body: string;
  acceptance: string;
  budget: string;
  status: GoalStatus;
  meta: string;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  seq: number;
  id: string;
  goalId: string;
  parentTaskId: string | null;
  depth: number;
  persona: string;
  title: string;
  spec: string;
  acceptance: string;
  budget: string;
  status: TaskStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  reason: string | null;
  notes: string;
  model: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EventRowRaw {
  id: number;
  goalId: string;
  taskId: string | null;
  ts: number;
  kind: string;
  data: string;
}

interface ApprovalRow {
  seq: number;
  id: string;
  taskId: string;
  goalId: string;
  action: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
}

function approvalFromRow(r: ApprovalRow): Approval {
  return {
    id: r.id,
    taskId: r.taskId,
    goalId: r.goalId,
    action: r.action,
    detail: r.detail,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
  };
}

function goalFromRow(r: GoalRow): Goal {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    body: r.body,
    acceptance: JSON.parse(r.acceptance),
    budget: JSON.parse(r.budget),
    status: r.status,
    meta: JSON.parse(r.meta || '{}'),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    goalId: r.goalId,
    parentTaskId: r.parentTaskId,
    depth: r.depth,
    persona: r.persona,
    title: r.title,
    spec: r.spec,
    acceptance: JSON.parse(r.acceptance),
    budget: JSON.parse(r.budget),
    status: r.status,
    attempt: r.attempt,
    leaseOwner: r.leaseOwner,
    leaseExpiresAt: r.leaseExpiresAt,
    reason: r.reason,
    notes: r.notes,
    result: r.result ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function eventFromRow(r: EventRowRaw): EventRow {
  return {
    id: r.id,
    goalId: r.goalId,
    taskId: r.taskId,
    ts: r.ts,
    kind: r.kind,
    data: JSON.parse(r.data),
  };
}

export function openStore(path: string, opts?: { now?: () => number }): Store {
  const db = new Database(path);
  const now = opts?.now ?? (() => Date.now());

  // WAL mode where the filesystem supports it; in-memory DBs ignore this.
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    // :memory: databases can't use WAL; that's fine.
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      budget TEXT NOT NULL,
      status TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      goalId TEXT NOT NULL,
      parentTaskId TEXT,
      depth INTEGER NOT NULL,
      persona TEXT NOT NULL,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      acceptance TEXT NOT NULL,
      budget TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      leaseOwner TEXT,
      leaseExpiresAt INTEGER,
      reason TEXT,
      notes TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goalId TEXT NOT NULL,
      taskId TEXT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goalId);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parentTaskId);
    CREATE INDEX IF NOT EXISTS idx_events_goal ON events(goalId, id);

    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      template TEXT NOT NULL,
      lastRunAt INTEGER,
      lastGoalId TEXT,
      lastStatus TEXT,
      lastNote TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      taskId TEXT NOT NULL,
      goalId TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      decidedAt INTEGER,
      decidedBy TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(taskId);
  `);

  // Migration-safe: older DBs may predate the goals.meta column.
  const goalCols = db.prepare(`PRAGMA table_info(goals)`).all() as { name: string }[];
  if (!goalCols.some((c) => c.name === 'meta')) {
    db.exec(`ALTER TABLE goals ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'`);
  }
  // P7: tasks.model — optional model name/role for the task (additive).
  const taskCols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  if (!taskCols.some((c) => c.name === 'model')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN model TEXT`);
  }
  // P8: tasks.result — the finish summary a parent sees (additive).
  if (!taskCols.some((c) => c.name === 'result')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN result TEXT`);
  }

  const subscribers = new Set<(e: EventRow) => void>();

  const stmts = {
    insertGoal: db.prepare(
      `INSERT INTO goals (id, slug, title, body, acceptance, budget, status, meta, createdAt, updatedAt)
       VALUES (@id, @slug, @title, @body, @acceptance, @budget, @status, @meta, @createdAt, @updatedAt)`,
    ),
    getGoalById: db.prepare(`SELECT * FROM goals WHERE id = ?`),
    countGoalSlug: db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE slug = ?`),
    listGoals: db.prepare(`SELECT * FROM goals ORDER BY seq ASC`),
    updateGoalStatus: db.prepare(`UPDATE goals SET status = ?, updatedAt = ? WHERE id = ?`),
    updateGoalMeta: db.prepare(`UPDATE goals SET meta = ?, updatedAt = ? WHERE id = ?`),

    insertTask: db.prepare(
      `INSERT INTO tasks (id, goalId, parentTaskId, depth, persona, title, spec, acceptance, budget, status, attempt, leaseOwner, leaseExpiresAt, reason, notes, model, result, createdAt, updatedAt)
       VALUES (@id, @goalId, @parentTaskId, @depth, @persona, @title, @spec, @acceptance, @budget, @status, @attempt, @leaseOwner, @leaseExpiresAt, @reason, @notes, @model, @result, @createdAt, @updatedAt)`,
    ),
    getTaskById: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    listTasksByGoal: db.prepare(`SELECT * FROM tasks WHERE goalId = ? ORDER BY seq ASC`),
    listChildren: db.prepare(`SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY seq ASC`),
    countChildren: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE parentTaskId = ?`),

    claimById: db.prepare(
      `UPDATE tasks SET status = 'running', attempt = attempt + 1, leaseOwner = ?, leaseExpiresAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'queued'`,
    ),
    claimNextQueued: db.prepare(
      `SELECT * FROM tasks WHERE status = 'queued' ORDER BY seq ASC LIMIT 1`,
    ),
    claimNextQueuedPersona: db.prepare(
      `SELECT * FROM tasks WHERE status = 'queued' AND persona = ? ORDER BY seq ASC LIMIT 1`,
    ),

    setRunningLease: db.prepare(
      `UPDATE tasks SET leaseExpiresAt = ?, updatedAt = ? WHERE id = ?`,
    ),

    expiredRunning: db.prepare(
      `SELECT * FROM tasks WHERE status = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?`,
    ),
    reclaimOne: db.prepare(
      `UPDATE tasks SET status = 'queued', leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = ? WHERE id = ?`,
    ),

    transitionUpdate: db.prepare(
      `UPDATE tasks SET status = ?, leaseOwner = ?, leaseExpiresAt = ?, reason = ?, updatedAt = ? WHERE id = ?`,
    ),

    appendNoteStmt: db.prepare(
      `UPDATE tasks SET notes = notes || ? || char(10), updatedAt = ? WHERE id = ?`,
    ),

    setResultStmt: db.prepare(`UPDATE tasks SET result = ?, updatedAt = ? WHERE id = ?`),
    usageEventsByTask: db.prepare(`SELECT kind, data FROM events WHERE taskId = ? ORDER BY id ASC`),
    usageEventsByGoal: db.prepare(
      `SELECT e.kind AS kind, e.data AS data, t.persona AS persona
       FROM events e JOIN tasks t ON t.id = e.taskId WHERE e.goalId = ? ORDER BY e.id ASC`,
    ),

    insertEvent: db.prepare(
      `INSERT INTO events (goalId, taskId, ts, kind, data) VALUES (?, ?, ?, ?, ?)`,
    ),
    eventsByGoal: db.prepare(`SELECT * FROM events WHERE goalId = ? ORDER BY id ASC`),
    eventsByGoalSince: db.prepare(
      `SELECT * FROM events WHERE goalId = ? AND id > ? ORDER BY id ASC`,
    ),
    allEventsSince: db.prepare(
      `SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ),
    allEventsAll: db.prepare(`SELECT * FROM events ORDER BY id ASC LIMIT ?`),

    listAutomations: db.prepare(`SELECT * FROM automations ORDER BY createdAt ASC, id ASC`),
    putAutomation: db.prepare(
      `INSERT INTO automations (id, name, cron, enabled, template, lastRunAt, lastGoalId, lastStatus, lastNote, createdAt, updatedAt)
       VALUES (@id, @name, @cron, @enabled, @template, @lastRunAt, @lastGoalId, @lastStatus, @lastNote, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET name=@name, cron=@cron, enabled=@enabled, template=@template,
         lastRunAt=@lastRunAt, lastGoalId=@lastGoalId, lastStatus=@lastStatus, lastNote=@lastNote, updatedAt=@updatedAt`,
    ),
    deleteAutomation: db.prepare(`DELETE FROM automations WHERE id = ?`),

    insertApproval: db.prepare(
      `INSERT INTO approvals (id, taskId, goalId, action, detail, status, createdAt, decidedAt, decidedBy)
       VALUES (@id, @taskId, @goalId, @action, @detail, @status, @createdAt, @decidedAt, @decidedBy)`,
    ),
    getApproval: db.prepare(`SELECT * FROM approvals WHERE id = ?`),
    approvedForTask: db.prepare(
      `SELECT * FROM approvals WHERE taskId = ? AND detail = ? AND status = 'approved' ORDER BY seq ASC LIMIT 1`,
    ),
    decidedBy: db.prepare(`UPDATE approvals SET status = ?, decidedAt = ?, decidedBy = ? WHERE id = ?`),
    deleteApproval: db.prepare(`DELETE FROM approvals WHERE id = ?`),
  };

  /** Every approvals query, filtered in SQL by status and/or task. */
  function approvalRows(opts?: { status?: ApprovalStatus; taskId?: string }): ApprovalRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts?.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts?.taskId) {
      where.push('taskId = ?');
      args.push(opts.taskId);
    }
    const sql = `SELECT * FROM approvals${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC`;
    return db.prepare(sql).all(...args) as ApprovalRow[];
  }

  function emit(goalId: string, taskId: string | null, kind: string, data: any): EventRow {
    const ts = now();
    const info = stmts.insertEvent.run(goalId, taskId, ts, kind, JSON.stringify(data ?? null));
    const row = eventFromRow({
      id: Number(info.lastInsertRowid),
      goalId,
      taskId,
      ts,
      kind,
      data: JSON.stringify(data ?? null),
    });
    for (const cb of subscribers) cb(row);
    return row;
  }

  function getTaskRow(id: string): TaskRow | undefined {
    return stmts.getTaskById.get(id) as TaskRow | undefined;
  }

  function getGoalRow(id: string): GoalRow | undefined {
    return stmts.getGoalById.get(id) as GoalRow | undefined;
  }

  function rollupGoal(goalId: string) {
    const rows = stmts.listTasksByGoal.all(goalId) as TaskRow[];
    if (rows.length === 0) return;
    const allTerminal = rows.every((r) => (TERMINAL as readonly string[]).includes(r.status));
    if (!allTerminal) return;
    const newStatus: GoalStatus = rows.every((r) => r.status === 'done') ? 'done' : 'failed';
    const g = getGoalRow(goalId);
    if (!g || g.status === newStatus) return;
    const t = now();
    stmts.updateGoalStatus.run(newStatus, t, goalId);
    emit(goalId, null, 'goal_status', { status: newStatus });
  }

  function createGoal(input: CreateGoalInput): Goal {
    const t = now();
    const base = slugify(input.title);
    let slug = base;
    let n = 2;
    while ((stmts.countGoalSlug.get(slug) as { n: number }).n > 0) {
      slug = `${base}-${n}`;
      n += 1;
    }
    const row: GoalRow = {
      seq: 0,
      id: randomUUID(),
      slug,
      title: input.title,
      body: input.body ?? '',
      acceptance: JSON.stringify(input.acceptance ?? []),
      budget: JSON.stringify(mergeBudget(DEFAULT_BUDGET, input.budget)),
      status: 'active',
      meta: JSON.stringify(input.meta ?? {}),
      createdAt: t,
      updatedAt: t,
    };
    stmts.insertGoal.run(row);
    const goal = goalFromRow(row);
    emit(goal.id, null, 'goal_created', { title: goal.title, slug: goal.slug });
    return goal;
  }

  function getGoal(id: string): Goal | undefined {
    const r = getGoalRow(id);
    return r ? goalFromRow(r) : undefined;
  }

  function listGoals(): Goal[] {
    return (stmts.listGoals.all() as GoalRow[]).map(goalFromRow);
  }

  function setGoalMeta(goalId: string, patch: Record<string, any>): Goal {
    const row = getGoalRow(goalId);
    if (!row) throw new Error(`no such goal: ${goalId}`);
    const prev = goalFromRow(row).meta;
    const next = { ...prev, ...patch };
    stmts.updateGoalMeta.run(JSON.stringify(next), now(), goalId);
    const updated = getGoalRow(goalId)!;
    emit(goalId, null, 'goal_meta', { meta: next });
    return goalFromRow(updated);
  }

  function createTask(input: CreateTaskInput): Task {
    const goal = getGoalRow(input.goalId);
    if (!goal) throw new Error(`no such goal: ${input.goalId}`);
    const goalBudget = JSON.parse(goal.budget) as Budget;

    let depth = 0;
    let budget: Budget;
    let parentRow: TaskRow | undefined;

    if (input.parentTaskId) {
      parentRow = getTaskRow(input.parentTaskId);
      if (!parentRow) throw new Error(`no such parent task: ${input.parentTaskId}`);
      depth = parentRow.depth + 1;
      const parentBudget = JSON.parse(parentRow.budget) as Budget;
      budget = mergeBudget(parentBudget, input.budget);
      for (const key of Object.keys(parentBudget) as (keyof Budget)[]) {
        if (budget[key] > parentBudget[key]) {
          throw new BudgetError(
            `child budget field '${key}' (${budget[key]}) exceeds parent's (${parentBudget[key]})`,
          );
        }
      }
    } else {
      budget = mergeBudget(goalBudget, input.budget);
    }

    if (depth > goalBudget.maxDepth) {
      throw new BudgetError(`depth ${depth} exceeds goal.budget.maxDepth ${goalBudget.maxDepth}`);
    }

    if (parentRow) {
      const childCount = (stmts.countChildren.get(parentRow.id) as { n: number }).n;
      const parentBudget = JSON.parse(parentRow.budget) as Budget;
      if (childCount >= parentBudget.maxSubtasks) {
        throw new BudgetError(
          `parent task already has ${childCount} children (max ${parentBudget.maxSubtasks})`,
        );
      }
    }

    const t = now();
    const row: TaskRow = {
      seq: 0,
      id: randomUUID(),
      goalId: input.goalId,
      parentTaskId: input.parentTaskId ?? null,
      depth,
      persona: input.persona,
      title: input.title,
      spec: input.spec ?? '',
      acceptance: JSON.stringify(input.acceptance ?? []),
      budget: JSON.stringify(budget),
      status: 'queued',
      attempt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      reason: null,
      notes: '',
      model: input.model ?? null,
      result: null,
      createdAt: t,
      updatedAt: t,
    };
    stmts.insertTask.run(row);
    const task = taskFromRow(row);
    emit(task.goalId, task.id, 'task_created', { title: task.title, persona: task.persona, depth: task.depth });
    // New work on a settled goal wakes it up: a retry, or a follow-up Quinn added.
    if (goal.status !== 'active') {
      stmts.updateGoalStatus.run('active', now(), goal.id);
      emit(goal.id, null, 'goal_status', { status: 'active', reason: 'new task' });
    }
    return task;
  }

  function getTask(id: string): Task | undefined {
    const r = getTaskRow(id);
    return r ? taskFromRow(r) : undefined;
  }

  function getTaskModel(taskId: string): string | null {
    const r = getTaskRow(taskId) as (TaskRow & { model?: string | null }) | undefined;
    return r?.model ?? null;
  }

  function listTasks(goalId: string): Task[] {
    return (stmts.listTasksByGoal.all(goalId) as TaskRow[]).map(taskFromRow);
  }

  function children(taskId: string): Task[] {
    return (stmts.listChildren.all(taskId) as TaskRow[]).map(taskFromRow);
  }

  const claimTxn = db.transaction((taskId: string, workerId: string, leaseMs: number) => {
    const t = now();
    const info = stmts.claimById.run(workerId, t + leaseMs, t, taskId);
    return info.changes > 0;
  });

  function claim(taskId: string, workerId: string, leaseMs: number): boolean {
    return claimTxn.immediate(taskId, workerId, leaseMs);
  }

  const claimNextTxn = db.transaction((workerId: string, opts: ClaimNextOpts) => {
    const row = (
      opts.persona
        ? stmts.claimNextQueuedPersona.get(opts.persona)
        : stmts.claimNextQueued.get()
    ) as TaskRow | undefined;
    if (!row) return null;
    const t = now();
    stmts.claimById.run(workerId, t + opts.leaseMs, t, row.id);
    const fresh = getTaskRow(row.id)!;
    return taskFromRow(fresh);
  });

  function claimNext(workerId: string, opts: ClaimNextOpts): Task | null {
    return claimNextTxn.immediate(workerId, opts);
  }

  const heartbeatTxn = db.transaction((taskId: string, workerId: string, leaseMs: number) => {
    const row = getTaskRow(taskId);
    if (!row) return false;
    const t = now();
    if (row.status !== 'running') return false;
    if (row.leaseOwner !== workerId) return false;
    if (row.leaseExpiresAt == null || row.leaseExpiresAt <= t) return false;
    stmts.setRunningLease.run(t + leaseMs, t, taskId);
    return true;
  });

  function heartbeat(taskId: string, workerId: string, leaseMs: number): boolean {
    return heartbeatTxn.immediate(taskId, workerId, leaseMs);
  }

  const reclaimTxn = db.transaction(() => {
    const t = now();
    const rows = stmts.expiredRunning.all(t) as TaskRow[];
    const ids: string[] = [];
    for (const r of rows) {
      stmts.reclaimOne.run(t, r.id);
      emit(r.goalId, r.id, 'reclaimed', { workerId: r.leaseOwner });
      ids.push(r.id);
    }
    return ids;
  });

  function reclaimExpired(): string[] {
    return reclaimTxn.immediate();
  }

  const transitionTxn = db.transaction((taskId: string, to: TaskStatus, opts?: TransitionOpts) => {
    const row = getTaskRow(taskId);
    if (!row) throw new Error(`no such task: ${taskId}`);
    const from = row.status;

    if (to === 'done') {
      throw new DoneGateError('transition() cannot mark a task done; only the gate may');
    }

    const legal = EDGES[from] ?? [];
    if (!legal.includes(to)) {
      throw new IllegalTransitionError(`illegal transition ${from} -> ${to}`);
    }

    if ((NEEDS_REASON as readonly TaskStatus[]).includes(to)) {
      if (!opts?.reason || !opts.reason.trim()) {
        throw new ReasonRequiredError(`transition ${from} -> ${to} requires a non-empty reason`);
      }
    }

    const t = now();
    const clearLease = from === 'running';
    const nextReason = opts?.reason !== undefined ? opts.reason : row.reason;
    stmts.transitionUpdate.run(
      to,
      clearLease ? null : row.leaseOwner,
      clearLease ? null : row.leaseExpiresAt,
      nextReason,
      t,
      taskId,
    );

    emit(row.goalId, taskId, 'transition', {
      from,
      to,
      reason: opts?.reason ?? null,
      by: opts?.by ?? null,
    });

    rollupGoal(row.goalId);

    return taskFromRow(getTaskRow(taskId)!);
  });

  function transition(taskId: string, to: TaskStatus, opts?: TransitionOpts): Task {
    return transitionTxn.immediate(taskId, to, opts);
  }

  function appendNote(taskId: string, text: string): void {
    const t = now();
    stmts.appendNoteStmt.run(text, t, taskId);
  }

  function setResult(taskId: string, text: string): void {
    stmts.setResultStmt.run(text, now(), taskId);
  }

  interface UsageAccum extends Usage {
    personas: Map<string, { promptTokens: number; completionTokens: number }>;
  }

  function newAccum(): UsageAccum {
    return {
      promptTokens: 0,
      completionTokens: 0,
      peakPromptTokens: 0,
      turns: 0,
      compactions: 0,
      personas: new Map(),
    };
  }

  function feed(a: UsageAccum, kind: string, dataRaw: string, persona: string | null): void {
    if (kind !== 'turn' && kind !== 'compacted') return;
    let d: any;
    try {
      d = JSON.parse(dataRaw);
    } catch {
      return;
    }
    if (kind === 'compacted') {
      a.compactions += 1;
      return;
    }
    a.turns += 1;
    const p = Number(d?.usage?.promptTokens) || 0;
    const c = Number(d?.usage?.completionTokens) || 0;
    a.promptTokens += p;
    a.completionTokens += c;
    if (p > a.peakPromptTokens) a.peakPromptTokens = p;
    if (persona) {
      const bp = a.personas.get(persona) ?? { promptTokens: 0, completionTokens: 0 };
      bp.promptTokens += p;
      bp.completionTokens += c;
      a.personas.set(persona, bp);
    }
  }

  function taskUsage(taskId: string): Usage {
    const a = newAccum();
    for (const r of stmts.usageEventsByTask.all(taskId) as { kind: string; data: string }[]) {
      feed(a, r.kind, r.data, null);
    }
    const { personas: _drop, ...usage } = a;
    return usage;
  }

  function goalUsage(goalId: string): GoalUsage {
    const a = newAccum();
    for (const r of stmts.usageEventsByGoal.all(goalId) as { kind: string; data: string; persona: string }[]) {
      feed(a, r.kind, r.data, r.persona);
    }
    const { personas, ...usage } = a;
    return { ...usage, byPersona: Object.fromEntries(personas) };
  }

  function appendEvent(goalId: string, taskId: string | null, kind: string, data: any): EventRow {
    return emit(goalId, taskId, kind, data);
  }

  function events(goalId: string, opts?: EventsOpts): EventRow[] {
    const rows = (
      opts?.sinceId != null
        ? stmts.eventsByGoalSince.all(goalId, opts.sinceId)
        : stmts.eventsByGoal.all(goalId)
    ) as EventRowRaw[];
    return rows.map(eventFromRow);
  }

  function allEvents(opts?: AllEventsOpts): EventRow[] {
    const limit = opts?.limit ?? 500;
    const rows = (
      opts?.sinceId != null
        ? stmts.allEventsSince.all(opts.sinceId, limit)
        : stmts.allEventsAll.all(limit)
    ) as EventRowRaw[];
    return rows.map(eventFromRow);
  }

  function listAutomationRows(): AutomationRow[] {
    return stmts.listAutomations.all() as AutomationRow[];
  }

  function putAutomationRow(row: AutomationRow): void {
    stmts.putAutomation.run(row);
  }

  function deleteAutomationRow(id: string): boolean {
    return stmts.deleteAutomation.run(id).changes > 0;
  }

  function onEvent(cb: (e: EventRow) => void): () => void {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  const requestApprovalTxn = db.transaction((taskId: string, action: string, detail: string) => {
    const row = getTaskRow(taskId);
    if (!row) throw new Error(`no such task: ${taskId}`);
    const t = now();
    const aRow: ApprovalRow = {
      seq: 0,
      id: randomUUID(),
      taskId,
      goalId: row.goalId,
      action: String(action ?? ''),
      detail: String(detail ?? ''),
      status: 'pending',
      createdAt: t,
      decidedAt: null,
      decidedBy: null,
    };
    stmts.insertApproval.run(aRow);
    emit(row.goalId, taskId, 'approval_requested', {
      approvalId: aRow.id,
      action: aRow.action,
      detail: aRow.detail,
    });
    return approvalFromRow(aRow);
  });

  function requestApproval(taskId: string, action: string, detail: string): Approval {
    return requestApprovalTxn.immediate(taskId, action, detail);
  }

  const decideApprovalTxn = db.transaction(
    (id: string, decision: 'approved' | 'denied', by: string) => {
      const a = stmts.getApproval.get(id) as ApprovalRow | undefined;
      if (!a) throw new Error(`no such approval: ${id}`);
      const t = now();
      stmts.decidedBy.run(decision, t, by ?? null, id);
      const task = getTaskRow(a.taskId);
      if (task && task.status === 'blocked') {
        stmts.transitionUpdate.run('queued', null, null, task.reason, t, a.taskId);
        emit(
          a.goalId,
          a.taskId,
          'transition',
          { from: 'blocked', to: 'queued', reason: decision, by: by ?? null },
        );
      }
      const note =
        decision === 'approved'
          ? `approved: ${a.detail}`
          : `denied: ${a.detail} — find another way`;
      stmts.appendNoteStmt.run(note, t, a.taskId);
      emit(a.goalId, a.taskId, 'approval_decided', {
        approvalId: id,
        action: a.action,
        detail: a.detail,
        decision,
        by: by ?? null,
      });
      return approvalFromRow(stmts.getApproval.get(id) as ApprovalRow);
    },
  );

  function decideApproval(id: string, decision: 'approved' | 'denied', by: string): Approval {
    if (decision !== 'approved' && decision !== 'denied') {
      throw new Error(`unknown approval decision: ${decision}`);
    }
    return decideApprovalTxn.immediate(id, decision, by);
  }

  function approvals(opts?: { status?: ApprovalStatus; taskId?: string }): Approval[] {
    return approvalRows(opts).map(approvalFromRow);
  }

  const consumeApprovalTxn = db.transaction((taskId: string, detail: string) => {
    const a = stmts.approvedForTask.get(taskId, String(detail ?? '')) as ApprovalRow | undefined;
    if (!a) return false;
    stmts.deleteApproval.run(a.id);
    emit(a.goalId, taskId, 'approval_consumed', {
      approvalId: a.id,
      action: a.action,
      detail: a.detail,
    });
    return true;
  });

  function consumeApproval(taskId: string, detail: string): boolean {
    return consumeApprovalTxn.immediate(taskId, detail);
  }

  function close(): void {
    unregisterApprovalStore(api);
    db.close();
  }

  const markDoneTxn = db.transaction((taskId: string, by?: string) => {
    const row = getTaskRow(taskId);
    if (!row) throw new Error(`no such task: ${taskId}`);
    if (row.status !== 'verifying') {
      throw new IllegalTransitionError(`illegal transition ${row.status} -> done`);
    }
    const t = now();
    stmts.transitionUpdate.run('done', null, null, row.reason, t, taskId);
    emit(row.goalId, taskId, 'transition', { from: 'verifying', to: 'done', reason: null, by: by ?? null });
    rollupGoal(row.goalId);
    return taskFromRow(getTaskRow(taskId)!);
  });

  function _markDone(taskId: string, by?: string): Task {
    return markDoneTxn.immediate(taskId, by);
  }

  const api: Store = {
    createGoal,
    getGoal,
    listGoals,
    setGoalMeta,
    createTask,
    getTask,
    getTaskModel,
    listTasks,
    children,
    claim,
    claimNext,
    heartbeat,
    reclaimExpired,
    transition,
    appendNote,
    setResult,
    taskUsage,
    goalUsage,
    appendEvent,
    events,
    allEvents,
    listAutomationRows,
    putAutomationRow,
    deleteAutomationRow,
    requestApproval,
    decideApproval,
    approvals,
    consumeApproval,
    onEvent,
    close,
    _markDone,
  };
  // So run_shell can raise/spend approvals without ToolContext carrying a store.
  registerApprovalStore(api);
  return api;
}
