// Global "New goal" dialog (opened from the top bar, the palette, or a view via useApp().newGoal(prefill)).
// Labels "Title" / "Spec" and the "Create" button are part of the P5 acceptance contract.
import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { go } from '../lib/router.js';
import { Button, Field, Modal, Seg } from '../ui/index.jsx';

export default function NewGoalDialog({ onClose, prefill = {} }) {
  const [title, setTitle] = useState(prefill.title ?? '');
  const [spec, setSpec] = useState(prefill.spec ?? '');
  const [persona, setPersona] = useState(prefill.persona ?? 'alfred');
  const [where, setWhere] = useState(prefill.node ?? 'local');
  const [repo, setRepo] = useState(prefill.repo ?? '');
  const [mode, setMode] = useState(prefill.mode ?? 'auto');
  const [model, setModel] = useState('');
  const [checks, setChecks] = useState(prefill.acceptance ?? [{ name: '', cmd: '' }]);
  const [personas, setPersonas] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [repos, setRepos] = useState([]);
  const [models, setModels] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/personas').then((p) => setPersonas(p.map((x) => x.name))).catch(() => {});
    api('/api/nodes').then(setNodes).catch(() => {});
    api('/api/ops/repos').then(setRepos).catch(() => {});
    api('/api/models').then((m) => setModels([...Object.keys(m.roles ?? {}), ...(m.models ?? []).map((x) => x.name)])).catch(() => {});
  }, []);

  const setCheck = (i, k, v) => setChecks(checks.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const create = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = { title, spec, persona, acceptance: checks.filter((c) => c.cmd.trim()).map((c, i) => ({ name: c.name.trim() || `check-${i + 1}`, cmd: c.cmd })) };
      if (repo.trim()) body.repo = repo.trim();
      if (where !== 'local') body.node = where;
      if (mode !== 'auto') body.mode = mode;
      if (model) body.model = model;
      const out = await post('/api/goals', body);
      onClose();
      go(`/goal/${out.goal.id}`);
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New goal" onClose={onClose} wide testId="new-goal-dialog"
      footer={<>
        <span className="faint small grow">Runs on the Spark's Qwen. It finishes only when the checks pass.</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={create} disabled={busy || !title.trim()}>{busy ? 'Creating…' : 'Create'}</Button>
      </>}>
      <form className="form" onSubmit={create}>
        <Field label="Title" htmlFor="ng-title">
          <input id="ng-title" className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should get done?" />
        </Field>
        <Field label="Spec" htmlFor="ng-spec" hint="Details, constraints, definition of done. Markdown is fine.">
          <textarea id="ng-spec" className="textarea" rows={5} value={spec} onChange={(e) => setSpec(e.target.value)} />
        </Field>
        <div className="form-row">
          <Field label="Persona" htmlFor="ng-persona">
            <select id="ng-persona" className="select" value={persona} onChange={(e) => setPersona(e.target.value)}>
              {(personas.length ? personas : ['alfred', 'coder', 'researcher', 'coder-lg']).map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="Where" htmlFor="ng-where" hint="The Spark, or a connected node (your Mac)">
            <select id="ng-where" className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="local">Spark</option>
              {nodes.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
            </select>
          </Field>
          <Field label="Model" htmlFor="ng-model">
            <select id="ng-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">persona default</option>
              {models.map((m) => <option key={m}>{m}</option>)}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Repo" htmlFor="ng-repo" hint="Registered name or absolute path; empty = scratch sandbox">
            <input id="ng-repo" className="input" list="ng-repos" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="e.g. alfred or /Users/quinn/code/app" />
            <datalist id="ng-repos">{repos.map((r) => <option key={r.name} value={r.name} />)}</datalist>
          </Field>
          <Field label="Workspace">
            <Seg value={mode} onChange={setMode} options={[['auto', 'Auto'], ['sandbox', 'Sandbox clone'], ['repo', 'Worktree']]} />
          </Field>
        </div>
        <div className="field">
          <div className="label">Acceptance checks</div>
          {checks.map((c, i) => (
            <div className="row" key={i}>
              <input className="input" style={{ maxWidth: 160 }} aria-label={`check ${i + 1} name`} placeholder="name" value={c.name} onChange={(e) => setCheck(i, 'name', e.target.value)} />
              <input className="input mono" aria-label={`check ${i + 1} command`} placeholder="command, e.g. npm test" value={c.cmd} onChange={(e) => setCheck(i, 'cmd', e.target.value)} />
              <Button variant="ghost" icon="x" aria-label="remove check" onClick={() => setChecks(checks.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button size="sm" variant="ghost" icon="plus" onClick={() => setChecks([...checks, { name: '', cmd: '' }])}>Add check</Button></div>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
