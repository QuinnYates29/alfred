// "Send to agent" dialog: creates a goal for the item on the Spark or a node.
import { useEffect, useState } from 'react';
import { api, post } from '../../api.js';
import { Button, Field, Modal, useToast } from '../../ui/index.jsx';

export default function Dispatch({ item, onClose, onDone }) {
  const { toast } = useToast();
  const [personas, setPersonas] = useState(['alfred']);
  const [persona, setPersona] = useState('alfred');
  const [nodes, setNodes] = useState([]);
  const [where, setWhere] = useState('local');
  const [repos, setRepos] = useState([]);
  const [repo, setRepo] = useState('');
  const [checks, setChecks] = useState([]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/personas')
      .then((p) => {
        const names = (p ?? []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean);
        if (names.length) setPersonas(names);
        if (!names.includes(persona) && names.includes('alfred')) setPersona('alfred');
      })
      .catch(() => {});
    api('/api/nodes').then(setNodes).catch(() => {});
    api('/api/ops/repos').then(setRepos).catch(() => {});
  }, []);

  const setCheck = (i, k, v) => setChecks(checks.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { persona, acceptance: checks.filter((c) => c.cmd.trim()).map((c, i) => ({ name: c.name.trim() || `check-${i + 1}`, cmd: c.cmd })) };
      if (repo.trim()) body.repo = repo.trim();
      if (where !== 'local') body.node = where;
      if (note.trim()) body.note = note.trim();
      const out = await post(`/api/items/${encodeURIComponent(item.key)}/dispatch`, body);
      toast(`Sent to ${persona}${out?.goal?.slug ? ` as ${out.goal.slug}` : ''}`, 'ok');
      onDone?.(out);
    } catch (e) {
      setErr(e.message ?? String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Send ${item.key} to an agent`}
      onClose={onClose}
      testId="dispatch-dialog"
      footer={<>
        <span className="faint small grow">Creates a goal; the item moves to In progress and follows the run.</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" data-testid="dispatch-submit" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : 'Start'}
        </Button>
      </>}
    >
      <div className="form">
        <div className="form-row">
          <Field label="Persona">
            <select className="select" data-testid="dispatch-persona" value={persona} onChange={(e) => setPersona(e.target.value)}>
              {personas.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Where" hint="The Spark, or a connected node">
            <select className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="local">Spark</option>
              {(nodes ?? []).map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
            </select>
          </Field>
          <Field label="Repo" hint="empty = scratch sandbox">
            <input className="input" list="dispatch-repos" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="e.g. alfred" />
            <datalist id="dispatch-repos">{(repos ?? []).map((r) => <option key={r.name} value={r.name} />)}</datalist>
          </Field>
        </div>
        <div className="field">
          <div className="label">Acceptance checks</div>
          {checks.map((c, i) => (
            <div className="row" key={i}>
              <input className="input" style={{ maxWidth: 150 }} aria-label={`check ${i + 1} name`} placeholder="name" value={c.name} onChange={(e) => setCheck(i, 'name', e.target.value)} />
              <input className="input mono" aria-label={`check ${i + 1} command`} placeholder="command, e.g. npm test" value={c.cmd} onChange={(e) => setCheck(i, 'cmd', e.target.value)} />
              <Button variant="ghost" icon="x" aria-label="remove check" onClick={() => setChecks(checks.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button size="sm" variant="ghost" icon="plus" onClick={() => setChecks([...checks, { name: '', cmd: '' }])}>Add check</Button></div>
        </div>
        <Field label="Note" hint="appended to the goal spec">
          <textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && <div className="err" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}
