import { useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Chip, elapsed, goalNeedsAttention, go } from '../shared.jsx';

function GoalCard({ summary }) {
  const g = summary; // flat: goal fields + counts
  const c = summary.counts || {};
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return (
    <div className="card">
      <a href={`#/goal/${g.id}`}>{g.title}</a> <Chip status={g.status} />
      <div className="sub">
        <span>{total} tasks{c.done ? ` · ${c.done} done` : ''}{c.running ? ` · ${c.running} running` : ''}</span>
        <span>{elapsed(g.createdAt)}</span>
        <span className="mono muted">{g.slug}</span>
      </div>
    </div>
  );
}

function NewGoalForm({ personas, nodes }) {
  const [title, setTitle] = useState('');
  const [persona, setPersona] = useState('coder');
  const [spec, setSpec] = useState('');
  const [rows, setRows] = useState([{ name: 'acceptance', cmd: 'true' }]);
  const [repo, setRepo] = useState('');
  const [where, setWhere] = useState('local');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        title,
        persona,
        spec,
        acceptance: rows.filter((r) => r.name || r.cmd),
      };
      if (repo) body.repo = repo;
      if (where && where !== 'local') body.node = where;
      const out = await post('/api/goals', body);
      go(`/goal/${out.goal.id}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="panel form">
      <div className="row">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="what should alfred do?" />
        </label>
        <label>
          Persona
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            {(personas.length ? personas : ['coder']).map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Spec
        <textarea rows={4} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="details, constraints, definition of done" />
      </label>
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <label>
            Acceptance name
            <input value={r.name} onChange={(e) => setRow(i, 'name', e.target.value)} />
          </label>
          <label>
            Acceptance command
            <input className="mono" value={r.cmd} onChange={(e) => setRow(i, 'cmd', e.target.value)} />
          </label>
        </div>
      ))}
      <div className="row">
        <label>
          Repo
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="optional — path or URL" />
        </label>
        <label>
          Where
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="local">local</option>
            {(nodes || []).map((n) => (
              <option key={n.id ?? n.name} value={n.id ?? n.name}>{n.name ?? n.id}</option>
            ))}
          </select>
        </label>
      </div>
      {err && <div className="err">{err}</div>}
      <div>
        <button className="btn" onClick={create} disabled={busy || !title}>Create</button>{' '}
        <button className="btn ghost" onClick={() => setRows([...rows, { name: '', cmd: '' }])}>+ acceptance</button>
      </div>
    </div>
  );
}

export default function GoalsView({ goals, tick }) {
  const [showForm, setShowForm] = useState(false);
  const [personas, setPersonas] = useState([]);
  const [nodes, setNodes] = useState([]);
  useEffect(() => {
    api('/api/personas').then((l) => setPersonas(l.map((p) => p.name))).catch(() => {});
    api('/api/nodes').then((l) => setNodes(Array.isArray(l) ? l : l?.nodes ?? [])).catch(() => setNodes([]));
  }, [tick]);

  const attention = goals.filter(goalNeedsAttention);
  const rest = goals.filter((g) => !goalNeedsAttention(g));
  const active = rest.filter((g) => g.status === 'active');
  const done = rest.filter((g) => g.status !== 'active');

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>
        Goals{' '}
        <button className="btn" onClick={() => setShowForm(!showForm)}>
          New goal
        </button>
      </h2>
      {showForm && <NewGoalForm personas={personas} nodes={nodes} />}

      <div className="group-title">Active ({active.length})</div>
      {active.map((s) => <GoalCard key={s.id} summary={s} />)}

      <div className="group-title">Needs attention ({attention.length})</div>
      {attention.map((s) => <GoalCard key={s.id} summary={s} />)}

      <div className="group-title">Done ({done.length})</div>
      {done.map((s) => <GoalCard key={s.id} summary={s} />)}

      {!goals.length && <p className="muted">No goals yet — create one above.</p>}
    </section>
  );
}
