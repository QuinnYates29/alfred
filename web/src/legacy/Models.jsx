import { useEffect, useState } from 'react';
import { api, post } from '../api.js';

export default function ModelsView({ tick }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    api('/api/models')
      .then((d) => live && (setData(d), setErr(null)))
      .catch((e) => live && setErr(e));
    return () => {
      live = false;
    };
  }, [tick]);

  if (err) return <div className="panel err">Models unavailable: {err.message}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const models = data.models || [];
  const roles = data.roles || {};
  const byName = new Map(models.map((m) => [m.name, m]));

  const setRole = async (role, model) => {
    try {
      const out = await post('/api/models/roles', { role, model });
      setData((d) => ({ ...d, roles: out.roles }));
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>Models</h2>
      {err && <div className="err">{err.message}</div>}

      <div className="group-title">Endpoints</div>
      <div className="panel">
        {models.map((m) => (
          <div className="task-head" key={m.name}>
            <strong>{m.name}</strong>
            <span className="muted mono">{m.baseUrl} · {m.model}</span>
            <span className="muted">
              {m.slots ? `${m.slots} slots` : ''}
              {m.contextWindow ? ` · ctx ${m.contextWindow}` : ''}
            </span>
            <span className="muted">{(m.roles || []).join(', ')}</span>
          </div>
        ))}
        {!models.length && <div className="muted">No models configured.</div>}
      </div>

      <div className="group-title">Roles</div>
      <div className="panel">
        {Object.entries(roles).map(([role, model]) => {
          const spec = byName.get(model);
          return (
            <div className="row" key={role} style={{ alignItems: 'center' }}>
              <label style={{ minWidth: 120 }}>
                {role}
                <select value={model} onChange={(e) => setRole(role, e.target.value)}>
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="muted mono">
                {spec ? `${spec.baseUrl} · ${spec.model}` : '—'}
              </span>
            </div>
          );
        })}
        {!Object.keys(roles).length && <div className="muted">No roles configured.</div>}
      </div>
    </section>
  );
}
