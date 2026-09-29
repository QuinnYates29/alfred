// #/agents — live control room: what every agent is doing right now, and everything waiting on Quinn.
// One refetch of /api/agents on task/approval events (and every 5 s for the "N s ago" clocks).
import { useEffect, useMemo, useState } from 'react';
import { post } from '../api.js';
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { timeAgo, compact } from '../lib/format.js';
import { Button, Empty, Icon, StatusChip, useAction, useToast } from '../ui/index.jsx';
import ApprovalCard from '../components/ApprovalCard.jsx';
import './Agents.css';

const ACTIVE = new Set(['running', 'verifying', 'queued', 'blocked', 'needs_claude']);

function useTick(ms) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Parent → children order with depth, from the flat task list. */
function ordered(tasks) {
  const kids = new Map();
  for (const t of tasks) {
    const k = t.parentTaskId ?? '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(t);
  }
  const out = [];
  const walk = (id, depth) => {
    for (const t of (kids.get(id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) {
      out.push({ ...t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk('', 0);
  // orphans (parent not in this list)
  for (const t of tasks) if (!out.some((x) => x.id === t.id)) out.push({ ...t, depth: 0 });
  return out;
}

function TaskRow({ t, approval, onChanged }) {
  const act = useAction();
  const { confirm } = useToast();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const live = t.status === 'running' || t.status === 'verifying';
  const stale = live && t.lastActivityAt && Date.now() - t.lastActivityAt > 5 * 60_000;
  const doing = approval
    ? 'waiting for your OK'
    : t.status === 'needs_claude'
      ? 'waiting for Claude'
      : live
        ? t.now ?? 'starting…'
        : t.reason ?? t.now ?? '';
  const stop = async () => {
    if (!(await confirm({ title: `Stop "${t.title}"?`, body: 'The agent stops after its current step.', ok: 'Stop', danger: true }))) return;
    act(() => post(`/api/tasks/${t.id}/stop`, { reason: 'stopped from the Agents view' }), 'Stop requested').then(onChanged);
  };
  return (
    <div className={`agent-row ${t.status}`} style={{ paddingLeft: 12 + t.depth * 22 }} data-testid={`agent-task-${t.id}`}>
      <div className="agent-line">
        {t.depth > 0 && <span className="agent-branch" aria-hidden="true">└</span>}
        <StatusChip status={t.status} />
        <span className="chip violet">{t.persona}</span>
        <span className="agent-title ellipsis" title={t.title}>{t.title}</span>
        <span className="agent-meta xs faint">
          {t.turns}/{t.turnBudget || '∞'} turns · {compact(t.tokens)} tok
          {t.lastActivityAt ? ` · ${timeAgo(t.lastActivityAt)}` : ''}
        </span>
        <span className="agent-actions">
          {(live || t.status === 'queued' || t.status === 'blocked') && (
            <Button size="sm" variant="ghost" icon="stop" onClick={stop}>Stop</Button>
          )}
          {(t.status === 'failed' || t.status === 'stopped') && (
            <Button size="sm" variant="ghost" icon="retry" onClick={() => act(() => post(`/api/tasks/${t.id}/retry`, {}), 'Retry queued').then(onChanged)}>Retry</Button>
          )}
          <Button size="sm" variant="ghost" icon="comment" onClick={() => setNoting((n) => !n)} title="Send the agent a note (read on its next step or retry)">Note</Button>
        </span>
      </div>
      {doing && (
        <div className={`agent-doing xs ${approval ? 'warn' : stale ? 'warn' : 'faint'}`}>
          {approval ? <Icon name="alert" size={12} /> : live ? <span className="dot pulse" /> : null}
          <span className="ellipsis">{stale ? `no activity for ${timeAgo(t.lastActivityAt)} — ${doing}` : doing}</span>
        </div>
      )}
      {approval && <div className="agent-approval"><ApprovalCard approval={approval} onDecided={onChanged} /></div>}
      {noting && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <input className="input grow" autoFocus value={note} placeholder="Note for the agent…" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) { act(() => post(`/api/tasks/${t.id}/note`, { text: note.trim() }), 'Note added').then(() => { setNote(''); setNoting(false); onChanged(); }); } }} />
          <Button size="sm" variant="primary" disabled={!note.trim()}
            onClick={() => act(() => post(`/api/tasks/${t.id}/note`, { text: note.trim() }), 'Note added').then(() => { setNote(''); setNoting(false); onChanged(); })}>Send</Button>
        </div>
      )}
    </div>
  );
}

function GoalCard({ g, approvals, onChanged }) {
  const act = useAction();
  const { confirm } = useToast();
  const rows = useMemo(() => ordered(g.tasks), [g.tasks]);
  const active = g.tasks.filter((t) => ACTIVE.has(t.status)).length;
  const stopAll = async () => {
    const live = g.tasks.filter((t) => ACTIVE.has(t.status));
    if (!(await confirm({ title: `Stop all ${live.length} tasks of "${g.title}"?`, ok: 'Stop all', danger: true }))) return;
    act(async () => { for (const t of live) await post(`/api/tasks/${t.id}/stop`, { reason: 'stopped from the Agents view' }); }, 'Stop requested').then(onChanged);
  };
  return (
    <div className={`card agent-goal ${g.status}`} data-testid={`agent-goal-${g.id}`}>
      <div className="card-head">
        <StatusChip status={g.status} />
        <a className="agent-goal-title ellipsis" href={href(`/goal/${g.id}`)}>{g.title}</a>
        {g.source ? <span className="chip">{g.source}</span> : null}
        <span className="xs faint" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>started {timeAgo(g.createdAt)}</span>
        {active > 0 && <Button size="sm" variant="ghost" icon="stop" onClick={stopAll}>Stop all</Button>}
      </div>
      <div className="agent-tree">
        {rows.map((t) => (
          <TaskRow key={t.id} t={t} approval={t.approvalId ? approvals.find((a) => a.id === t.approvalId) : null} onChanged={onChanged} />
        ))}
        {!rows.length && <div className="small faint" style={{ padding: 12 }}>No tasks yet.</div>}
      </div>
    </div>
  );
}

export default function Agents() {
  useTick(5000);
  const res = useResource('/api/agents', { on: ['transition', 'task_created', 'approval_', 'goal_', 'turn', 'progress'] });
  // a slow poll as well: "N s ago" and live "now" lines stay fresh even between events
  useEffect(() => {
    const t = setInterval(() => res.reload?.(), 10_000);
    return () => clearInterval(t);
  }, [res.reload]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = res.data;
  if (!d) return <div className="page"><div className="page-head"><h1>Agents</h1></div>{res.error ? <Empty icon="alert" title="Could not load">{res.error.message}</Empty> : null}</div>;
  const active = d.goals.filter((g) => g.status === 'active');
  const recent = d.goals.filter((g) => g.status !== 'active');
  const inTree = new Set(d.goals.flatMap((g) => g.tasks.map((t) => t.approvalId)).filter(Boolean));
  const loose = d.approvals.filter((a) => !inTree.has(a.id)); // chat asks, older goals
  const c = d.counts;
  return (
    <div className="page agents-page">
      <div className="page-head">
        <h1>Agents</h1>
        <span className="row" style={{ gap: 8 }}>
          <span className="chip running"><span className="dot" />{c.running} running</span>
          {c.waitingOnYou > 0 && <span className="chip warn"><Icon name="alert" size={12} />{c.waitingOnYou} waiting for you</span>}
          {c.queued > 0 && <span className="chip">{c.queued} queued</span>}
          {c.blocked > c.waitingOnYou && <span className="chip warn">{c.blocked} blocked</span>}
          {c.needsClaude > 0 && <span className="chip needs_claude">{c.needsClaude} need Claude</span>}
        </span>
      </div>

      {loose.length > 0 && (
        <div className="stack tight">
          {loose.map((a) => <ApprovalCard key={a.id} approval={a} taskTitle={a.taskTitle} onDecided={() => res.reload?.()} />)}
        </div>
      )}

      {active.length === 0 && !loose.length && (
        <div className="card" style={{ padding: 'var(--s-6)' }}>
          <Empty icon="check" title="No agents running">Start one with <b>!coder …</b> in ⌘K, the chat box or Slack.</Empty>
        </div>
      )}
      {active.map((g) => <GoalCard key={g.id} g={g} approvals={d.approvals} onChanged={() => res.reload?.()} />)}

      {recent.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Finished in the last 12 h</h2><span className="chip">{recent.length}</span></div>
          <div className="list">
            {recent.map((g) => (
              <a className="list-item" key={g.id} href={href(`/goal/${g.id}`)}>
                <StatusChip status={g.status} />
                <span className="grow ellipsis">{g.title}</span>
                <span className="xs faint">{g.tasks.length} task{g.tasks.length === 1 ? '' : 's'} · {timeAgo(g.updatedAt)}</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
