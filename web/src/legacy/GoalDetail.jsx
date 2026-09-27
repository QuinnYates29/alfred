import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Chip, elapsed, fmtTime } from '../shared.jsx';

function TaskNode({ task, children, goalId }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const act = async (fn) => {
    try {
      await fn();
    } catch {
      /* view refreshes on the next event */
    }
  };
  const stoppable = ['queued', 'running', 'blocked', 'needs_claude'].includes(task.status);
  const retryable = ['failed', 'stopped', 'blocked'].includes(task.status);
  return (
    <li className="task" data-testid={`task-${task.id}`}>
      <div className="task-head">
        <Chip status={task.status} />
        <strong>{task.title}</strong>
        <span className="muted">
          {task.persona} · attempt {task.attempt}
        </span>
        {task.reason && <span className="reason">{task.reason}</span>}
        <span className="task-actions">
          {stoppable && (
            <button className="btn danger" onClick={() => act(() => post(`/api/tasks/${task.id}/stop`, { reason: 'stopped from dashboard' }))}>
              Stop
            </button>
          )}
          {retryable && (
            <button className="btn" onClick={() => act(() => post(`/api/tasks/${task.id}/retry`, {}))}>
              Retry
            </button>
          )}
          <button
            className="btn ghost"
            onClick={() => act(async () => {
              const text = window.prompt('Note for this task?');
              if (text) await post(`/api/tasks/${task.id}/note`, { text });
            })}
          >
            Add note
          </button>
        </span>
      </div>
      {task.notes ? (
        <details open={notesOpen} onToggle={(e) => setNotesOpen(e.target.open)}>
          <summary>notes</summary>
          <pre>{task.notes}</pre>
        </details>
      ) : null}

      {(task.status === 'failed' || task.status === 'stopped' || task.status === 'blocked') && (
        <div className="failure-card" data-testid="failure-card">
          <div className="title">{task.title} — {task.status}</div>
          <div className="reason">{task.reason || 'no reason recorded'}</div>
        </div>
      )}
      {task.status === 'needs_claude' && (
        <div className="claude-card" data-testid="claude-card">
          <div className="title">{task.title} — Waiting for Claude</div>
          <div className="reason">{task.reason || ''}</div>
          <code>claude mcp add alfred http://localhost:8790/api/mcp --transport http</code>
        </div>
      )}

      {children?.length > 0 && (
        <ul>
          {children.map((c) => (
            <TaskNode key={c.id} task={c} children={c.children} goalId={goalId} />
          ))}
        </ul>
      )}
    </li>
  );
}

function buildTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const t of byId.values()) {
    if (t.parentTaskId && byId.has(t.parentTaskId)) byId.get(t.parentTaskId).children.push(t);
    else roots.push(t);
  }
  return roots;
}

export default function GoalDetail({ id, tick }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    api(`/api/goals/${id}`)
      .then((d) => live && (setData(d), setErr(null)))
      .catch((e) => live && setErr(e));
    return () => {
      live = false;
    };
  }, [id, tick]);

  if (err) return <div className="panel err">Goal not found: {err.message}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const { goal, tasks = [], events = [], usage } = data;
  const tree = buildTree(tasks);

  const perTask = new Map();
  for (const ev of events) {
    if (!ev.taskId) continue;
    const m = perTask.get(ev.taskId) || { peak: 0, compactions: 0 };
    if (ev.kind === 'turn') m.peak = Math.max(m.peak, ev.data?.promptTokens ?? 0);
    if (ev.kind === 'compacted') m.compactions += 1;
    perTask.set(ev.taskId, m);
  }

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>
        {goal.title} <Chip status={goal.status} />
      </h2>
      {goal.status === 'failed' && (
        <div className="failure-card" data-testid="failure-card">
          <div className="title">{goal.title} — goal failed</div>
          <div className="reason">
            {goal.meta?.reason || tasks.find((t) => ['failed', 'blocked', 'stopped'].includes(t.status))?.reason || 'the goal reported failure'}
          </div>
        </div>
      )}
      <p className="muted">
        {goal.slug} · created {fmtTime(goal.createdAt)} · {elapsed(goal.createdAt, goal.status === 'active' ? undefined : goal.updatedAt)}
        {goal.meta?.repo ? <> · repo <span className="mono">{goal.meta.repo}</span></> : null}
      </p>
      {goal.body && <p style={{ marginTop: 8 }}>{goal.body}</p>}

      <div className="group-title">Tasks</div>
      <ul className="tasks">
        {tree.map((t) => (
          <TaskNode key={t.id} task={t} children={t.children} goalId={goal.id} />
        ))}
      </ul>

      {usage && (
        <>
          <div className="group-title">Context economy</div>
          <div className="panel">
            <div className="sub" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <span>prompt <strong className="mono">{usage.promptTokens ?? 0}</strong></span>
              <span>completion <strong className="mono">{usage.completionTokens ?? 0}</strong></span>
            </div>
            {Object.entries(usage.byPersona || {}).map(([p, u]) => (
              <div key={p} className="muted">
                {p}: <span className="mono">{u.promptTokens}p / {u.completionTokens}c</span>
              </div>
            ))}
            {tasks.map((t) => {
              const u = perTask.get(t.id);
              return u ? (
                <div key={t.id} className="muted">
                  {t.title}: peak <span className="mono">{u.peak}</span> tokens, {u.compactions} compaction{u.compactions === 1 ? '' : 's'}
                </div>
              ) : null;
            })}
          </div>
        </>
      )}

      <div className="group-title">Timeline</div>
      <div className="panel timeline" aria-label="Event timeline">
        {events
          .slice(-60)
          .reverse()
          .map((ev) => (
            <div key={ev.id}>
              {fmtTime(ev.ts)} <strong>{ev.kind}</strong>{' '}
              <span className="muted">{summarize(ev)}</span>
            </div>
          ))}
        {!events.length && <div className="muted">no events yet</div>}
      </div>
    </section>
  );
}

function summarize(ev) {
  const d = ev.data || {};
  if (ev.kind === 'transition') return `${d.from} → ${d.to}${d.reason ? ` — ${d.reason}` : ''}`;
  if (ev.kind === 'tool') return `${d.name}${d.ok === false ? ' ✗' : ''}`;
  if (ev.kind === 'turn') return `${d.promptTokens ?? 0}p/${d.completionTokens ?? 0}c`;
  if (ev.kind === 'goal_status') return d.status;
  return '';
}
