// GET /api/v1/agents — one live picture of what every agent is doing: active (and recently
// finished) goals with their task trees, what each running task is doing right now, and
// everything waiting on Quinn (approvals, Claude hand-offs). Feeds the dashboard's Agents view.
import type { Store } from '../store.js';
import type { Task } from '../types.js';

const RECENT_MS = 12 * 60 * 60_000;
const MAX_GOALS = 20;
const LIVE_KINDS = ['turn', 'tool', 'progress', 'transition', 'compacted', 'review'];

export interface AgentTaskView {
  id: string;
  parentTaskId: string | null;
  depth: number;
  persona: string;
  title: string;
  status: Task['status'];
  reason: string | null;
  attempt: number;
  turns: number;
  turnBudget: number;
  tokens: number;
  createdAt: number;
  updatedAt: number;
  /** The latest activity: "run_shell", "waiting on 2 subtask(s)", "turn 12" … */
  now: string | null;
  lastActivityAt: number | null;
  approvalId: string | null;
}

function oneLine(s: unknown, n = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** What a task's latest live event says it is doing. */
function describe(kind: string, data: any): string {
  if (kind === 'tool') return `${data?.name ?? 'tool'}${data?.ok === false ? ' (failed)' : ''}`;
  if (kind === 'turn') {
    const tools: string[] = Array.isArray(data?.tools) ? data.tools : [];
    return tools.length ? `calling ${tools.join(', ')}` : `turn ${data?.turn ?? ''} (thinking)`.trim();
  }
  if (kind === 'progress') return oneLine(data?.msg, 120);
  if (kind === 'transition') return `${data?.from ?? '?'} → ${data?.to ?? '?'}`;
  if (kind === 'compacted') return 'compacting context';
  if (kind === 'review') return `reviewed: ${data?.verdict ?? '?'}`;
  return kind;
}

export function agentsOverview(store: Store, now = Date.now()) {
  const goals = store
    .listGoals()
    .filter((g) => g.status === 'active' || now - g.updatedAt < RECENT_MS)
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_GOALS);

  const pending = store.approvals({ status: 'pending' });
  const approvalByTask = new Map(pending.map((a) => [a.taskId, a.id]));

  // The latest live event of every task shown, in one query.
  const taskIds: string[] = [];
  const tasksByGoal = new Map<string, Task[]>();
  for (const g of goals) {
    const ts = store.listTasks(g.id);
    tasksByGoal.set(g.id, ts);
    for (const t of ts) taskIds.push(t.id);
  }
  const last = new Map<string, { kind: string; ts: number; data: any }>();
  if (taskIds.length) {
    const qs = taskIds.map(() => '?').join(',');
    const kinds = LIVE_KINDS.map(() => '?').join(',');
    const rows = store
      .raw()
      .prepare(
        `SELECT e.taskId AS taskId, e.kind AS kind, e.ts AS ts, e.data AS data FROM events e
         JOIN (SELECT taskId, MAX(id) AS id FROM events WHERE taskId IN (${qs}) AND kind IN (${kinds}) GROUP BY taskId) m
         ON e.id = m.id`,
      )
      .all(...taskIds, ...LIVE_KINDS) as { taskId: string; kind: string; ts: number; data: string }[];
    for (const r of rows) {
      let data: any = {};
      try {
        data = JSON.parse(r.data);
      } catch {
        /* keep {} */
      }
      last.set(r.taskId, { kind: r.kind, ts: r.ts, data });
    }
  }

  const counts = { running: 0, queued: 0, blocked: 0, waitingOnYou: pending.length, needsClaude: 0 };
  const goalViews = goals.map((g) => {
    const tasks: AgentTaskView[] = (tasksByGoal.get(g.id) ?? []).map((t) => {
      const u = store.taskUsage(t.id);
      const ev = last.get(t.id);
      if (g.status === 'active') {
        if (t.status === 'running' || t.status === 'verifying') counts.running++;
        else if (t.status === 'queued') counts.queued++;
        else if (t.status === 'blocked') counts.blocked++;
        else if (t.status === 'needs_claude') counts.needsClaude++;
      }
      return {
        id: t.id,
        parentTaskId: t.parentTaskId,
        depth: t.depth,
        persona: t.persona,
        title: t.title,
        status: t.status,
        reason: t.reason ? oneLine(t.reason, 400) : null,
        attempt: t.attempt,
        turns: u.turns,
        turnBudget: t.budget?.turns ?? 0,
        tokens: u.promptTokens + u.completionTokens,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        now: ev ? describe(ev.kind, ev.data) : null,
        lastActivityAt: ev?.ts ?? null,
        approvalId: approvalByTask.get(t.id) ?? null,
      };
    });
    return {
      id: g.id,
      slug: g.slug,
      title: g.title,
      status: g.status,
      source: (g.meta as any)?.source ?? (g.meta as any)?.automation ?? null,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      tasks,
    };
  });

  const titleOf = (taskId: string) => {
    for (const ts of tasksByGoal.values()) {
      const t = ts.find((x) => x.id === taskId);
      if (t) return t.title;
    }
    return store.getTask(taskId)?.title ?? null;
  };
  return {
    at: now,
    counts,
    approvals: pending.map((a) => ({ ...a, taskTitle: String(a.taskId).startsWith('chat:') ? 'asked in chat' : titleOf(a.taskId) })),
    goals: goalViews,
  };
}
