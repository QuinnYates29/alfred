import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function PersonasView({ tick }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    api('/api/personas').then((d) => live && setRows(Array.isArray(d) ? d : [])).catch((e) => live && setErr(e));
    return () => {
      live = false;
    };
  }, [tick]);

  if (err) return <div className="panel err">personas unavailable: {err.message}</div>;

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>Personas</h2>
      {rows.map((p) => {
        const budget = p.promptBudgetTokens || 0;
        const pct = budget ? Math.min(100, Math.round(((p.promptCost || 0) / budget) * 100)) : 0;
        return (
          <div className="panel" key={p.name}>
            <div className="task-head">
              <strong>{p.name}</strong>
              {p.canSpawn ? <span className="chip active">can spawn</span> : null}
            </div>
            <p className="muted">{p.description}</p>
            <div className="muted mono" style={{ marginTop: 6 }}>
              {(p.tools || []).join(', ') || 'no tools'}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ marginBottom: 4 }}>
                prompt cost <span className="mono">{p.promptCost ?? 0}</span> / budget{' '}
                <span className="mono">{budget || '∞'}</span>
              </div>
              {budget > 0 && (
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div style={{ width: `${pct}%`, background: pct > 85 ? 'var(--coral)' : 'var(--acc)' }} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!rows.length && <div className="muted">No personas loaded.</div>}
    </section>
  );
}
