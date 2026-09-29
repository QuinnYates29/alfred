// A pending approval with its exact command/detail, the Jev/info text and Approve / Deny —
// rendered wherever a blocked task shows up (goal page, Agents view), not only in the Inbox.
import { post } from '../api.js';
import { timeAgo } from '../lib/format.js';
import { Button, Icon, useAction } from '../ui/index.jsx';

export default function ApprovalCard({ approval, taskTitle, onDecided }) {
  const act = useAction();
  const decide = (decision) =>
    act(() => post(`/api/approvals/${approval.id}`, { decision }), decision === 'approved' ? 'Approved' : 'Denied')
      .then(() => onDecided?.(decision))
      .catch(() => {});
  return (
    <div className="card pad amber approval-card" data-testid={`approval-card-${approval.id}`}>
      <div className="row" style={{ gap: 8 }}>
        <Icon name="check" size={16} />
        <strong>Waiting for your OK: {approval.action}</strong>
        {taskTitle ? <span className="xs faint ellipsis">{taskTitle}</span> : null}
        <span className="xs faint" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{timeAgo(approval.createdAt)}</span>
      </div>
      <code className="codeblock wrap" style={{ display: 'block', margin: '8px 0 0' }}>{approval.detail}</code>
      {approval.info ? (
        <pre className="codeblock wrap" style={{ margin: '8px 0 0', maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{approval.info}</pre>
      ) : null}
      <div className="row" style={{ gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="primary" data-testid={`approve-${approval.id}`} onClick={() => decide('approved')}>Approve</Button>
        <Button size="sm" variant="danger" data-testid={`deny-${approval.id}`} onClick={() => decide('denied')}>Deny</Button>
      </div>
    </div>
  );
}
