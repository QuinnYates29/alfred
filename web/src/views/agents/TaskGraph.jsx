// Graph view of the Agents tab: one tidy node-link tree of tasks per goal.
// Data comes straight from the overview the page already loads (GET /api/v1/agents) —
// no extra fetching. Layout is hand-rolled: depth → y, leaf order → x, parents centered
// over their children. Plain SVG, no dependencies.
import { useMemo } from 'react';
import { href } from '../../lib/router.js';
import { timeAgo, compact } from '../../lib/format.js';
import { Icon, StatusChip } from '../../ui/index.jsx';

const NODE_W = 196;
const NODE_H = 54;
const GAP_X = 18; // between sibling subtrees
const GAP_Y = 46; // between depth levels
const PAD = 14;
const TITLE_CHARS = 26; // ~ fits NODE_W at 12px
const PERSONA_CHARS = 22;

const byCreated = (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id));
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};

/** A node waits on Quinn: pending approval, blocked, or handed off to Claude. */
const waitsOnQuinn = (t) => !!t.approvalId || t.status === 'blocked' || t.status === 'needs_claude';

/** The "what it is doing now" line, same wording as the list view. */
function doingLine(t, approval) {
  if (approval) return 'waiting for your OK';
  if (t.status === 'needs_claude') return 'waiting for Claude';
  const live = t.status === 'running' || t.status === 'verifying';
  if (live) return t.now ?? 'starting…';
  return t.reason ?? t.now ?? '';
}

/**
 * Tidy tree: leaves get the next free x slot, a parent is centered over its children.
 * Returns { nodes, width, height }.
 */
export function layoutTree(tasks) {
  const list = (tasks ?? []).slice();
  const ids = new Set(list.map((t) => t.id));
  const kids = new Map();
  for (const t of list) {
    const p = t.parentTaskId && ids.has(t.parentTaskId) ? t.parentTaskId : '';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(t);
  }
  for (const arr of kids.values()) arr.sort(byCreated);

  const nodes = [];
  let slot = 0; // next free leaf slot
  const place = (t, depth) => {
    const children = kids.get(t.id) ?? [];
    if (!children.length) {
      const x = PAD + slot * (NODE_W + GAP_X);
      slot += 1;
      nodes.push({ task: t, depth, x });
      return nodes[nodes.length - 1];
    }
    const placed = children.map((c) => place(c, depth + 1));
    const mid = placed.reduce((s, n) => s + n.x + NODE_W / 2, 0) / placed.length;
    const node = { task: t, depth, x: Math.max(PAD, mid - NODE_W / 2) };
    nodes.push(node);
    return node;
  };
  for (const r of kids.get('') ?? []) place(r, 0);

  const at = new Map(nodes.map((n) => [n.task.id, n]));
  const edges = [];
  for (const n of nodes) {
    const p = n.task.parentTaskId && ids.has(n.task.parentTaskId) ? at.get(n.task.parentTaskId) : null;
    if (p) edges.push({ from: p, to: n, key: `${p.task.id}->${n.task.id}` });
  }
  const depth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  return {
    nodes,
    edges,
    width: Math.max(1, PAD * 2 + (slot > 0 ? slot * (NODE_W + GAP_X) - GAP_X : NODE_W)),
    height: PAD * 2 + (depth + 1) * NODE_H + depth * GAP_Y,
  };
}

/** Elbow from the bottom of the parent to the top of the child. */
function elbow(from, to) {
  const x1 = from.x + NODE_W / 2;
  const y1 = PAD + from.depth * (NODE_H + GAP_Y) + NODE_H;
  const x2 = to.x + NODE_W / 2;
  const y2 = PAD + to.depth * (NODE_H + GAP_Y);
  const my = y1 + GAP_Y / 2;
  return `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`;
}

function GraphNode({ node, approval, goalId }) {
  const t = node.task;
  const x = node.x;
  const y = PAD + node.depth * (NODE_H + GAP_Y);
  const live = t.status === 'running' || t.status === 'verifying';
  const waits = waitsOnQuinn(t);
  const doing = doingLine(t, approval);
  const tip = [
    t.title,
    `${t.persona} · ${String(t.status).replace('_', ' ')}${t.attempt > 1 ? ` · attempt ${t.attempt}` : ''}`,
    doing ? `now: ${doing}${t.lastActivityAt ? ` (${timeAgo(t.lastActivityAt)})` : ''}` : null,
    `${t.turns}/${t.turnBudget || '∞'} turns · ${compact(t.tokens)} tok`,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <a href={href(`/goal/${goalId}`)} className="ag-link">
      <g
        className={`ag-node ${t.status}${live ? ' live' : ''}${waits ? ' waits' : ''}`}
        transform={`translate(${x},${y})`}
        data-testid={`ag-node-${t.id}`}
      >
        <title>{tip}</title>
        {live && <rect className="ag-pulse" x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={11} />}
        <rect className="ag-box" width={NODE_W} height={NODE_H} rx={9} />
        <rect className="ag-bar" width={4} height={NODE_H} rx={2} />
        <text className="ag-persona" x={13} y={19}>
          {clip(t.persona, PERSONA_CHARS)}
        </text>
        <text className="ag-title" x={13} y={37}>
          {clip(t.title, TITLE_CHARS)}
        </text>
        {waits && (
          <g className="ag-alert" transform={`translate(${NODE_W - 15},14)`}>
            <circle r={9} />
            <text textAnchor="middle" y={3.5}>
              !
            </text>
          </g>
        )}
      </g>
    </a>
  );
}

/** One goal's task tree as an SVG graph, in a card that scrolls sideways on phones. */
export default function TaskGraph({ goal, approvals = [] }) {
  const { nodes, edges, width, height } = useMemo(() => layoutTree(goal.tasks), [goal.tasks]);
  const approvalById = useMemo(() => new Map((approvals ?? []).map((a) => [a.id, a])), [approvals]);
  const waiting = nodes.filter((n) => waitsOnQuinn(n.task)).length;
  return (
    <div className={`card agent-graph ${goal.status}`} data-testid={`agent-graph-${goal.id}`}>
      <div className="card-head">
        <StatusChip status={goal.status} />
        <a className="agent-graph-title ellipsis" href={href(`/goal/${goal.id}`)}>{goal.title}</a>
        {goal.source ? <span className="chip">{goal.source}</span> : null}
        {waiting > 0 && <span className="chip warn"><Icon name="alert" size={12} />{waiting}</span>}
        <span className="xs faint" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          {nodes.length} task{nodes.length === 1 ? '' : 's'} · {timeAgo(goal.updatedAt ?? goal.createdAt)}
        </span>
      </div>
      {nodes.length ? (
        <div className="ag-scroll">
          <svg className="ag-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
            aria-label={`Task graph for ${goal.title}`}>
            <g className="ag-edges">
              {edges.map((e) => (
                <path key={e.key} className={`ag-edge ${e.to.task.status}`} d={elbow(e.from, e.to)} />
              ))}
            </g>
            {nodes.map((n) => (
              <GraphNode key={n.task.id} node={n} goalId={goal.id}
                approval={n.task.approvalId ? approvalById.get(n.task.approvalId) : null} />
            ))}
          </svg>
        </div>
      ) : (
        <div className="small faint" style={{ padding: 12 }}>No tasks yet.</div>
      )}
    </div>
  );
}
