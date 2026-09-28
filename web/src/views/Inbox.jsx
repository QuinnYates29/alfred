// #/inbox (alias #/approvals) — everything that needs Quinn: approvals (with the exact
// command), tasks waiting on Claude, blocked tasks, failed goals (with Retry) and flagged board items.
import { api, post } from '../api.js';
import { useResource } from '../lib/live.jsx';
import { href } from '../lib/router.js';
import { timeAgo } from '../lib/format.js';
import { Button, Empty, Icon, StatusChip, useAction, useToast } from '../ui/index.jsx';
import { attentionRows, failedRootTask, needsDetail, useGoalDetails } from './home/model.js';
import './Home.css';

const group = (rows, kind) => rows.filter((r) => r.kind === kind);

function Section({ icon, title, count, children }) {
  return (
    <div className="card" data-testid={`inbox-${kindSlug(title)}`}>
      <div className="card-head">
        <Icon name={icon} size={14} className="faint" />
        <h2>{title}</h2>
        {count > 0 && <span className="chip warn">{count}</span>}
      </div>
      <div className="list">{children}</div>
    </div>
  );
}
const kindSlug = (title) => title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/(^-|-$)/g, '');

function TaskRow({ row }) {
  return (
    <div className="list-item">
      <StatusChip status={row.task.status} />
      <span className="grow" style={{ minWidth: 0 }}>
        <a className="ellipsis" style={{ display: 'block' }} href={href(row.href)}>{row.title}</a>
        {row.sub && <div className="xs faint ellipsis">{row.sub}</div>}
      </span>
      <a className="small faint" style={{ whiteSpace: 'nowrap' }} href={href(`/goal/${row.goalId}`)} title="Open goal">goal</a>
    </div>
  );
}

function Approvals({ rows, onDecide }) {
  return (
    <Section icon="check" title="Approvals" count={rows.length}>
      {rows.map((r) => (
        <div className="list-item" key={r.key} style={{ flexWrap: 'wrap' }}>
          <span className="chip accent"><Icon name="check" size={12} /></span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="ellipsis" style={{ display: 'block', fontWeight: 600 }}>{r.approval.action}</span>
            {String(r.approval.taskId ?? '').startsWith('chat:') && (
              <span className="xs faint" style={{ display: 'block' }}>asked in chat</span>
            )}
            {r.taskTitle && (
              <a className="xs faint" style={{ display: 'block' }} href={href(`/goal/${r.approval.goalId}`)}>
                {r.taskTitle}
              </a>
            )}
          </span>
          <span className="xs faint">{timeAgo(r.approval.createdAt)}</span>
          <span className="row" style={{ gap: 'var(--s-2)', width: '100%' }}>
            <code className="codeblock wrap grow" style={{ margin: 0 }}>{r.approval.detail}</code>
          </span>
          {r.approval.info && (
            <pre className="codeblock wrap" data-testid={`approval-info-${r.approval.id}`}
              style={{ margin: 0, width: '100%', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{r.approval.info}</pre>
          )}
          <span className="row" style={{ gap: 'var(--s-2)', marginLeft: 'auto' }}>
            <Button size="sm" variant="primary" data-testid={`approve-${r.approval.id}`} onClick={() => onDecide(r.approval, 'approved')}>
              Approve
            </Button>
            <Button size="sm" variant="danger" data-testid={`deny-${r.approval.id}`} onClick={() => onDecide(r.approval, 'denied')}>
              Deny
            </Button>
          </span>
        </div>
      ))}
      {!rows.length && <div className="small faint" style={{ padding: 'var(--s-3) var(--s-4)' }}>No approvals pending.</div>}
    </Section>
  );
}

export default function Inbox() {
  const act = useAction();
  const { toast } = useToast();
  const goalsRes = useResource('/api/goals', { on: ['goal_', 'transition', 'task_created'] });
  const approvals = useResource('/api/approvals?status=pending', { on: ['approval_'] });
  const items = useResource('/api/items?label=needs-attention', { on: ['item_'] });
  const goals = goalsRes.data ?? [];
  const detailIds = goals.filter(needsDetail).map((g) => g.id);
  const details = useGoalDetails(detailIds, { interval: 15_000 });

  const rows = attentionRows({ approvals: approvals.data ?? [], items: items.data ?? [], goals, details });
  // Add the task title to approval rows (sub already carries the command).
  const taskTitle = (task) => {
    for (const g of goals) {
      const t = (details[g.id]?.tasks ?? []).find((x) => x.id === task);
      if (t) return t.title;
    }
    return null;
  };
  const approvalRows = group(rows, 'approval').map((r) => ({ ...r, taskTitle: taskTitle(r.approval.taskId) }));
  const claude = group(rows, 'claude');
  const blocked = group(rows, 'blocked');
  const failed = group(rows, 'failed-goal');
  const flagged = group(rows, 'item');
  const total = rows.length;

  const decide = (approval, decision) =>
    act(() => post(`/api/approvals/${approval.id}`, { decision }),
      decision === 'approved' ? 'Approved' : 'Denied').catch(() => {});

  const retry = (goalId) =>
    act(async () => {
      const root = failedRootTask(details[goalId]);
      if (!root) throw new Error('no failed task to retry');
      return post(`/api/tasks/${root.id}/retry`, {});
    }, 'Retry queued').catch(() => {});

  const removeFlag = (it) =>
    act(() => api(`/api/items/${it.key}`, { method: 'PATCH', body: { labels: (it.labels ?? []).filter((l) => l !== 'needs-attention') } }), 'Flag cleared').catch(() => {});

  if (!total) {
    return (
      <div className="page">
        <div className="page-head"><h1>Inbox</h1></div>
        <div className="card" style={{ padding: 'var(--s-6)' }}>
          <Empty icon="check" title="Inbox zero">
            <a href={href('/board')}>Board</a> · <a href={href('/goals')}>Goals</a>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Inbox</h1>
        <span className="muted small">{total} thing{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} you</span>
      </div>
      <div className="stack" style={{ gap: 'var(--s-4)' }}>
        <Approvals rows={approvalRows} onDecide={decide} />
        {claude.length > 0 && (
          <Section icon="bot" title="Waiting for Claude" count={claude.length}>
            {claude.map((r) => <TaskRow row={r} key={r.key} />)}
          </Section>
        )}
        {blocked.length > 0 && (
          <Section icon="alert" title="Blocked" count={blocked.length}>
            {blocked.map((r) => <TaskRow row={r} key={r.key} />)}
          </Section>
        )}
        {failed.length > 0 && (
          <Section icon="alert" title="Failed goals" count={failed.length}>
            {failed.map((r) => (
              <div className="list-item" key={r.key}>
                <StatusChip status="failed" />
                <a className="grow ellipsis" href={href(r.href)}>{r.title}</a>
                <Button size="sm" icon="retry" onClick={() => void retry(r.goalId)}>Retry</Button>
              </div>
            ))}
          </Section>
        )}
        {flagged.length > 0 && (
          <Section icon="board" title="Board items needing attention" count={flagged.length}>
            {flagged.map((r) => (
              <div className="list-item" key={r.key}>
                <Icon name="board" size={14} className="faint" />
                <a className="grow ellipsis" href={href(r.href)}>{r.title}</a>
                <span className="small faint">{r.item.key}</span>
                <Button size="sm" variant="ghost" icon="check" title="Clear needs-attention" onClick={() => void removeFlag(r.item)}>
                  Done with it
                </Button>
              </div>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}
