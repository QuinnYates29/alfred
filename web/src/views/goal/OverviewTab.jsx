// Overview: failure cards, the task tree (with per-task actions), a live timeline, usage.
import { useMemo, useState } from 'react';
import { post, getToken } from '../../api.js';
import { clock, compact, dateTime, duration } from '../../lib/format.js';
import { Button, Empty, Icon, StatusChip, useAction } from '../../ui/index.jsx';
import ReviewBadge from '../../components/ReviewBadge.jsx';
import ApprovalCard from '../../components/ApprovalCard.jsx';
import { useResource } from '../../lib/live.jsx';
import {
  buildTaskTree, claudeCommand, eventSummary, eventTone, flattenTree, isFailure,
  perTaskEconomy, retryable, stoppable,
} from './model.js';

function NoteForm({ onSave, onCancel }) {
  const [text, setText] = useState('');
  return (
    <div className="stack tight" style={{ marginTop: 6 }}>
      <textarea
        className="textarea"
        style={{ minHeight: 64 }}
        autoFocus
        placeholder="Add a note for the agent…"
        aria-label="Note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="btn-row">
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={() => text.trim() && onSave(text.trim())}>Save</Button>
        <Button size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function TaskNode({ node, depth, onNote, reviews }) {
  const t = node;
  const [noting, setNoting] = useState(false);
  const act = useAction();

  return (
    <div className="task-node" style={{ paddingLeft: Math.min(depth, 6) * 18 }}>
      <div className="task-main">
        <StatusChip status={t.status} />
        <ReviewBadge data={reviews?.[t.id]} />
        <span className="task-title ellipsis">{t.title}</span>
        <span className="chip violet" title="persona">{t.persona}</span>
        {(t.attempt ?? 0) > 1 && <span className="chip" title="attempt">#{t.attempt}</span>}
        {depth > 0 && <span className="chip" title="sub-task">sub</span>}
        <span className="task-actions">
          {stoppable(t) && (
            <Button size="sm" icon="stop" title="Stop this task"
              onClick={() => act(() => post(`/api/tasks/${t.id}/stop`, { reason: 'stopped from the dashboard' }), 'Stop requested')}>
              Stop
            </Button>
          )}
          {retryable(t) && (
            <Button size="sm" icon="retry" title="Retry this task"
              onClick={() => act(() => post(`/api/tasks/${t.id}/retry`, {}), 'Retry queued')}>
              Retry
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="comment" onClick={() => setNoting((v) => !v)}>Add note</Button>
        </span>
      </div>

      {(t.reason || t.result || t.notes || noting) && (
        <div className="task-detail">
          {t.reason && <div className="task-reason">{t.reason}</div>}
          {t.result && <div className="task-result">{t.result}</div>}
          {t.notes ? (
            <details>
              <summary>notes ({String(t.notes).split('\n').filter(Boolean).length})</summary>
              <pre>{String(t.notes)}</pre>
            </details>
          ) : null}
          {noting && (
            <NoteForm
              onCancel={() => setNoting(false)}
              onSave={(text) => act(async () => { await post(`/api/tasks/${t.id}/note`, { text }); }, 'Note added').then(() => setNoting(false))}
            />
          )}
        </div>
      )}

      {(node.children ?? []).map((c) => <TaskNode key={c.id} node={c} depth={depth + 1} onNote={onNote} reviews={reviews} />)}
    </div>
  );
}

/** Red card for a failed/stopped/blocked task (or the goal itself): title + reason. */
export function FailureCard({ title, reason, taskId, persona }) {
  return (
    <div className="card pad alert failure-card" data-testid="failure-card" role="alert">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="alert" size={16} />
        <strong className="ellipsis">{title}</strong>
        {persona ? <span className="chip violet">{persona}</span> : null}
        {taskId ? <span className="key" title={taskId}>{String(taskId).slice(0, 8)}</span> : null}
      </div>
      <div className="reason">{reason || 'No reason recorded.'}</div>
    </div>
  );
}

/** Amber card for a task parked on Claude, with the command to unlock it. */
export function ClaudeCard({ task, origin }) {
  const cmd = claudeCommand(origin, getToken());
  return (
    <div className="card pad amber claude-card" data-testid="claude-card">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="bot" size={16} />
        <strong className="ellipsis">{task.title}</strong>
        <span className="chip needs_claude"><span className="dot" />Waiting for Claude</span>
      </div>
      <div className="reason">{task.reason || 'The task is waiting for a Claude session to take over.'}</div>
      <code className="cmd">{cmd}</code>
    </div>
  );
}

function Timeline({ events }) {
  const rows = useMemo(() => (events ?? []).slice(-80).reverse(), [events]);
  if (!rows.length) return <Empty icon="activity" title="No events yet" />;
  return (
    <div className="timeline">
      {rows.map((ev) => (
        <div className="tl" key={ev.id}>
          <span className="t" title={dateTime(ev.ts)}>{clock(ev.ts)}</span>
          <span className={`pip ${eventTone(ev)}`} />
          <span className="row wrap" style={{ gap: 6, alignItems: 'baseline' }}>
            <span className="xs faint" style={{ minWidth: 92 }}>{ev.kind.replace(/_/g, ' ')}</span>
            <span className="ellipsis" style={{ maxWidth: '100%' }}>{eventSummary(ev)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function Usage({ usage, events, tasks }) {
  const econ = useMemo(() => perTaskEconomy(events), [events]);
  const byPersona = usage?.byPersona ?? {};
  const rows = Object.entries(byPersona);
  const total = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 14 }}>
        <span className="stat" style={{ padding: 0 }}><span className="k">prompt</span><span className="v" style={{ fontSize: 'var(--t-lg)' }}>{compact(usage?.promptTokens ?? 0)}</span></span>
        <span className="stat" style={{ padding: 0 }}><span className="k">completion</span><span className="v" style={{ fontSize: 'var(--t-lg)' }}>{compact(usage?.completionTokens ?? 0)}</span></span>
        <span className="stat" style={{ padding: 0 }}><span className="k">total</span><span className="v" style={{ fontSize: 'var(--t-lg)' }}>{compact(total)}</span></span>
        <span className="stat" style={{ padding: 0 }}><span className="k">turns</span><span className="v" style={{ fontSize: 'var(--t-lg)' }}>{usage?.turns ?? 0}</span></span>
      </div>
      {rows.length > 0 && (
        <table className="table">
          <thead><tr><th>persona</th><th style={{ textAlign: 'right' }}>prompt</th><th style={{ textAlign: 'right' }}>completion</th></tr></thead>
          <tbody>
            {rows.map(([p, u]) => (
              <tr key={p}><td>{p}</td><td style={{ textAlign: 'right' }}>{compact(u?.promptTokens ?? 0)}</td><td style={{ textAlign: 'right' }}>{compact(u?.completionTokens ?? 0)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {tasks.length > 0 && (
        <div className="xs faint">
          peak context:{' '}
          {tasks.slice(0, 6).map((t) => `${t.persona} ${compact(econ.get(t.id)?.peak ?? 0)}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

export default function OverviewTab({ goal, tasks, events, usage }) {
  const tree = useMemo(() => buildTaskTree(tasks), [tasks]);
  const flat = useMemo(() => flattenTree(tree), [tree]);
  // Pending approvals for this goal: shown as "waiting for your OK" cards with Approve/Deny,
  // and their blocked tasks are not listed again as red failure cards.
  const pendingAll = useResource('/api/approvals?status=pending', { on: ['approval_'] });
  const pending = (pendingAll.data ?? []).filter((a) => a.goalId === goal.id);
  const waitingIds = new Set(pending.map((a) => a.taskId));
  const failing = tasks.filter((t) => isFailure(t) && !(t.status === 'blocked' && waitingIds.has(t.id)));
  const claude = tasks.filter((t) => t.status === 'needs_claude');
  const goalFailed = goal.status === 'failed';
  // J2 §6 — each task's latest `review` event data, for the verdict badge next to its status.
  const reviews = useMemo(() => {
    const m = {};
    for (const e of events ?? []) if (e.kind === 'review' && e.taskId) m[e.taskId] = e.data;
    return m;
  }, [events]);

  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} taskTitle={tasks.find((t) => t.id === a.taskId)?.title} onDecided={() => pendingAll.reload?.()} />
      ))}

      {(goalFailed || failing.length > 0) && (
        <div className="stack tight">
          {failing.map((t) => (
            <FailureCard key={t.id} title={t.title} reason={t.reason} taskId={t.id} persona={t.persona} />
          ))}
          {goalFailed && failing.length === 0 && (
            <FailureCard
              title={goal.title}
              reason={goal.meta?.reason ?? 'The goal failed.'}
            />
          )}
        </div>
      )}

      {claude.map((t) => <ClaudeCard key={t.id} task={t} origin={location.origin} />)}

      <div className="grid goal-main">
        <div className="card">
          <div className="card-head"><h3>Tasks</h3><span className="chip">{tasks.length}</span></div>
          {flat.length === 0
            ? <Empty icon="list" title="No tasks yet" />
            : <div className="task-tree">{tree.map((n) => <TaskNode key={n.id} node={n} depth={0} reviews={reviews} />)}</div>}
        </div>

        <div className="stack" style={{ gap: 'var(--s-4)' }}>
          <div className="card">
            <div className="card-head"><h3>Activity</h3></div>
            <div className="card-body" style={{ paddingTop: 'var(--s-2)' }}><Timeline events={events} /></div>
          </div>
          <div className="card">
            <div className="card-head"><h3>Usage</h3></div>
            <div className="card-body"><Usage usage={usage} events={events} tasks={tasks} /></div>
          </div>
          {goal.budget?.maxRuntimeMs ? (
            <div className="xs faint">
              budget: {duration(goal.budget.maxRuntimeMs)} runtime
              {goal.budget.maxTurns ? `, ${goal.budget.maxTurns} turns` : ''}
              {goal.budget.maxChildren ? `, ${goal.budget.maxChildren} children` : ''}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
