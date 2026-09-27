// Global "New item" dialog for the board (top bar "+", palette, `c` shortcut, or useApp().newItem(prefill)).
import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Button, Field, Modal, useToast } from '../ui/index.jsx';

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

export default function NewItemDialog({ onClose, prefill = {} }) {
  const [boards, setBoards] = useState([]);
  const [board, setBoard] = useState(prefill.board ?? '');
  const [title, setTitle] = useState(prefill.title ?? '');
  const [description, setDescription] = useState(prefill.description ?? '');
  const [status, setStatus] = useState(prefill.status ?? '');
  const [priority, setPriority] = useState(prefill.priority ?? 'none');
  const [labels, setLabels] = useState((prefill.labels ?? []).join(', '));
  const [assignee, setAssignee] = useState(prefill.assignee ?? '');
  const [due, setDue] = useState(prefill.due ?? '');
  const [more, setMore] = useState(false);
  const [err, setErr] = useState(null);
  const { toast } = useToast();

  useEffect(() => {
    api('/api/boards').then((b) => {
      setBoards(b);
      if (!board && b[0]) setBoard(b[0].key);
    }).catch((e) => setErr(e.message));
  }, []);
  const def = boards.find((b) => b.key === board) ?? boards[0];

  const create = async (e, again) => {
    e?.preventDefault();
    setErr(null);
    try {
      const body = { board, title, description, priority, labels: labels.split(',').map((s) => s.trim()).filter(Boolean) };
      if (status) body.status = status;
      if (assignee) body.assignee = assignee;
      if (due) body.due = due;
      const item = await post('/api/items', body);
      toast(`Created ${item.key}`, 'ok');
      if (again) {
        setTitle('');
        setDescription('');
      } else onClose();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  return (
    <Modal title="New item" onClose={onClose} testId="new-item-dialog"
      footer={<>
        <Button onClick={(e) => create(e, true)} disabled={!title.trim()}>Create &amp; add another</Button>
        <Button variant="primary" onClick={create} disabled={!title.trim()}>Create item</Button>
      </>}>
      <form className="form" onSubmit={create}>
        <input className="input bare" style={{ fontSize: 'var(--t-xl)', fontWeight: 600 }} autoFocus aria-label="Item title" placeholder="Item title"
          value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="textarea" aria-label="Item description" placeholder="Description (markdown)" rows={3}
          value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="form-row">
          {boards.length > 1 && (
            <Field label="Board">
              <select className="select" value={board} onChange={(e) => setBoard(e.target.value)}>
                {boards.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Status">
            <select className="select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{def?.columns?.[0]?.name ?? 'Backlog'}</option>
              {(def?.columns ?? []).slice(1).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className="select" aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Due">
            <input className="input" type="date" aria-label="Due date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        {more ? (
          <div className="form-row">
            <Field label="Labels" hint="comma separated"><input className="input" aria-label="Labels" value={labels} onChange={(e) => setLabels(e.target.value)} /></Field>
            <Field label="Assignee" hint="quinn, alfred, agent:coder…"><input className="input" aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} /></Field>
          </div>
        ) : (
          <div><Button size="sm" variant="ghost" icon="plus" onClick={() => setMore(true)}>Labels &amp; assignee</Button></div>
        )}
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
