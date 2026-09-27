// Pure logic for the Goals views (no React) — unit-tested in test/unit/p17c-goals.test.ts.

/** Segments of the goals list filter. */
export const GOAL_SEGS = [
  ['active', 'Active'],
  ['attention', 'Needs attention'],
  ['done', 'Done'],
  ['failed', 'Failed'],
  ['all', 'All'],
];

/** A goal summary ({...goal, counts}) needs attention: failed, or a failed/blocked/needs_claude task. */
export function needsAttention(g) {
  if (!g) return false;
  if (g.status === 'failed') return true;
  const c = g.counts || {};
  return (c.failed || 0) + (c.blocked || 0) + (c.needs_claude || 0) > 0;
}

/** Filter goal summaries by segment + free text (title, slug, id — case-insensitive). */
export function filterGoals(goals, seg = 'active', text = '') {
  const list = goals ?? [];
  const q = text.trim().toLowerCase();
  return list.filter((g) => {
    if (seg === 'attention') {
      if (!needsAttention(g)) return false;
    } else if (seg !== 'all' && g.status !== seg) return false;
    if (q && !`${g.title} ${g.slug} ${g.id}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Total of a task-count map. */
export function countTasks(counts = {}) {
  return Object.values(counts || {}).reduce((a, b) => a + (b || 0), 0);
}

/** Tasks → tree: roots first (each node gets a `children` array, sorted by createdAt). */
export function buildTaskTree(tasks = []) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const t of byId.values()) {
    if (t.parentTaskId && byId.has(t.parentTaskId)) byId.get(t.parentTaskId).children.push(t);
    else roots.push(t);
  }
  const sortRec = (list) => {
    list.sort((a, b) => a.createdAt - b.createdAt);
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export const STOPPABLE = ['queued', 'running', 'verifying', 'blocked', 'needs_claude'];
export const RETRYABLE = ['failed', 'stopped', 'blocked'];
export const FAILEDISH = ['failed', 'stopped', 'blocked'];

export const stoppable = (t) => !!t && STOPPABLE.includes(t.status);
export const retryable = (t) => !!t && RETRYABLE.includes(t.status);
export const isFailure = (t) => !!t && FAILEDISH.includes(t.status);

/** The goal's root task: first task without a parent (creation order), else the first. */
export function rootTask(tasks = []) {
  return tasks.find((t) => !t.parentTaskId) ?? tasks[0] ?? null;
}

/** Flatten a task tree (pre-order, depth-first) with depths, for pickers. */
export function flattenTree(nodes, depth = 0) {
  const out = [];
  for (const n of nodes) {
    out.push({ task: n, depth });
    out.push(...flattenTree(n.children ?? [], depth + 1));
  }
  return out;
}

const truncate = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

/** Compact `name(args…)` chip text for a tool call of a turn. */
export function callLabel(call) {
  const name = call?.name ?? 'tool';
  let args = call?.args;
  if (args == null) return `${name}()`;
  if (typeof args !== 'string') {
    try {
      args = JSON.stringify(args);
    } catch {
      args = String(args);
    }
  }
  return `${name}(${truncate(args.replace(/^\{|\}$/g, ''), 60)})`;
}

/** The first line of a tool output (for a collapsed <summary>). */
export const firstLine = (s) => String(s ?? '').split('\n', 1)[0];

/** Split a unified diff into renderable lines: { cls: 'add'|'del'|'hunk'|'meta'|'ctx', text }. */
export function diffLines(diff) {
  return String(diff ?? '').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).map((text) => {
    let cls = 'ctx';
    if (text.startsWith('@@')) cls = 'hunk';
    else if (text.startsWith('++') || text.startsWith('--') || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('similarity') || text.startsWith('rename ')) cls = 'meta';
    else if (text.startsWith('+')) cls = 'add';
    else if (text.startsWith('-')) cls = 'del';
    return { cls, text };
  });
}

/** A one-line summary for a timeline event. */
export function eventSummary(ev) {
  const d = ev?.data ?? {};
  switch (ev?.kind) {
    case 'transition': return `${d.from ?? '?'} → ${d.to ?? '?'}${d.reason ? ` — ${d.reason}` : ''}`;
    case 'tool': return `${d.name ?? ''}${d.ok === false ? ' ✗' : ''}`;
    case 'turn': return `${d.usage?.promptTokens ?? d.promptTokens ?? 0}p/${d.usage?.completionTokens ?? d.completionTokens ?? 0}c`;
    case 'goal_status': return String(d.status ?? '');
    case 'goal_created': return d.title ?? '';
    case 'task_created': return d.title ?? '';
    case 'verify': return `${d.name ?? ''} ${d.ok === true ? 'ok' : d.ok === false ? 'failed' : ''}`.trim();
    case 'pushed': return `${d.branch ?? ''} ${truncate(d.sha, 8)}`.trim();
    case 'push_failed': return String(d.error ?? 'push failed');
    case 'workspace': return String(d.path ?? '');
    case 'compacted': return 'context compacted';
    case 'progress': return truncate(d.message ?? d.text ?? '', 80);
    default: return '';
  }
}

/** Pip tone for a timeline event. */
export function eventTone(ev) {
  const k = ev?.kind;
  const d = ev?.data ?? {};
  if (k === 'goal_status') return d.status === 'failed' ? 'bad' : d.status === 'done' ? 'ok' : 'info';
  if (k === 'transition') {
    if (d.to === 'failed' || d.to === 'stopped') return 'bad';
    if (d.to === 'done') return 'ok';
    if (d.to === 'blocked' || d.to === 'needs_claude') return 'warn';
    return 'info';
  }
  if (k === 'tool') return d.ok === false ? 'bad' : 'ok';
  if (k === 'verify') return d.ok === false ? 'bad' : 'ok';
  if (k === 'push_failed') return 'bad';
  if (k === 'pushed' || k === 'turn' || k === 'compacted') return 'accent';
  return '';
}

/** The `claude mcp add …` command a human runs to unlock a needs_claude task. */
export function claudeCommand(origin, token) {
  const base = String(origin ?? '').replace(/\/$/, '');
  return `claude mcp add --transport http alfred ${base}/mcp --header "Authorization: Bearer ${token || '<token>'}"`;
}

/** The "where" of a goal summary row: node name or Spark. */
export const whereOf = (goal) => (goal?.meta?.node ? String(goal.meta.node) : goal?.meta?.repo ? 'Spark' : 'Spark');

/** Per-task context economy from goal events: { taskId: { peak, compactions } }. */
export function perTaskEconomy(events = []) {
  const m = new Map();
  for (const ev of events) {
    if (!ev.taskId) continue;
    const e = m.get(ev.taskId) ?? { peak: 0, compactions: 0 };
    if (ev.kind === 'turn') e.peak = Math.max(e.peak, ev.data?.usage?.promptTokens ?? ev.data?.promptTokens ?? 0);
    if (ev.kind === 'compacted') e.compactions += 1;
    m.set(ev.taskId, e);
  }
  return m;
}
