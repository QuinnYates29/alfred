import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { fmtTime } from '../shared.jsx';

export default function ApprovalsView({ tick }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState({});

  useEffect(() => {
    let live = true;
    api('/api/approvals?status=pending').then((d) => live && setRows(Array.isArray(d) ? d : [])).catch(() => {});
    return () => {
      live = false;
    };
  }, [tick]);

  const decide = async (id, decision) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setErr(null);
    try {
      await post(`/api/approvals/${id}`, { decision, by: 'dashboard' });
      setRows((rs) => rs.filter((r) => r.id !== id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>Approvals</h2>
      {err && <div className="err">{err}</div>}
      {!rows.length && <div className="panel muted">Nothing is waiting for you.</div>}
      {rows.map((a) => (
        <div className="panel" key={a.id}>
          <div className="task-head">
            <strong>{a.action}</strong>
            <span className="muted">{fmtTime(a.createdAt)}</span>
            <span className="task-actions">
              <button
                className="btn"
                data-testid={`approve-${a.id}`}
                disabled={busy[a.id]}
                onClick={() => decide(a.id, 'approved')}
              >
                Approve
              </button>
              <button
                className="btn danger"
                data-testid={`deny-${a.id}`}
                disabled={busy[a.id]}
                onClick={() => decide(a.id, 'denied')}
              >
                Deny
              </button>
            </span>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 8 }} className="mono muted">{a.detail}</pre>
          <div className="muted">
            task <a href={`#/goal/${a.goalId}`} className="mono">{a.taskId}</a>
          </div>
        </div>
      ))}
    </section>
  );
}
