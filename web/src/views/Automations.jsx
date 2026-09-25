import { useEffect, useState } from 'react';
import { api, post, del } from '../api.js';
import { fmtTime } from '../shared.jsx';

export default function AutomationsView({ tick }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState({ name: '', cron: '', persona: 'coder', spec: '', accName: 'acceptance', accCmd: 'true' });
  const [personas, setPersonas] = useState([]);

  const load = () => api('/api/automations').then((d) => setRows(Array.isArray(d) ? d : [])).catch(() => {});
  useEffect(() => {
    load();
    api('/api/personas').then((l) => setPersonas(l.map((p) => p.name))).catch(() => {});
  }, [tick]);

  const create = async () => {
    setErr(null);
    try {
      await post('/api/automations', {
        name: f.name,
        cron: f.cron,
        template: {
          title: f.name,
          persona: f.persona,
          spec: f.spec,
          acceptance: [{ name: f.accName, cmd: f.accCmd }],
        },
      });
      setShowForm(false);
      setF({ name: '', cron: '', persona: 'coder', spec: '', accName: 'acceptance', accCmd: 'true' });
      load();
    } catch (e) {
      setErr(e.message); // invalid cron comes back from the API's 400
    }
  };

  const toggle = async (a) => {
    try {
      await post(`/api/automations/${a.id}/enabled`, { on: !a.enabled });
      load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const remove = async (a) => {
    try {
      await del(`/api/automations/${a.id}`);
      load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>
        Automations{' '}
        <button className="btn" onClick={() => setShowForm(!showForm)}>New automation</button>
      </h2>
      {err && <div className="err">{err}</div>}

      {showForm && (
        <div className="panel form">
          <div className="row">
            <label>
              Name
              <input value={f.name} onChange={set('name')} />
            </label>
            <label>
              Cron
              <input className="mono" value={f.cron} onChange={set('cron')} placeholder="0 7 * * *" />
            </label>
            <label>
              Persona
              <select value={f.persona} onChange={set('persona')}>
                {(personas.length ? personas : ['coder']).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>
          <label>
            Spec
            <textarea rows={3} value={f.spec} onChange={set('spec')} />
          </label>
          <div className="row">
            <label>
              Acceptance name
              <input value={f.accName} onChange={set('accName')} />
            </label>
            <label>
              Acceptance command
              <input className="mono" value={f.accCmd} onChange={set('accCmd')} />
            </label>
          </div>
          <div>
            <button className="btn" onClick={create} disabled={!f.name || !f.cron}>Create</button>
          </div>
        </div>
      )}

      {!rows.length && !showForm && <div className="panel muted">No automations yet.</div>}
      {rows.map((a) => (
        <div className="card" key={a.id}>
          <div className="task-head">
            <strong>{a.name}</strong>
            <span className="mono muted">{a.cron}</span>
            <span className={`chip ${a.enabled ? 'done' : 'stopped'}`}>{a.enabled ? 'enabled' : 'disabled'}</span>
            <span className="task-actions">
              <button className="btn ghost" onClick={() => toggle(a)}>{a.enabled ? 'Disable' : 'Enable'}</button>
              <button className="btn danger" onClick={() => remove(a)}>Delete</button>
            </span>
          </div>
          {a.lastRunAt ? <div className="muted">last fired {fmtTime(a.lastRunAt)}</div> : null}
        </div>
      ))}
    </section>
  );
}
