// Personas: cards with tools, canSpawn, prompt cost vs budget, and an Edit link into Config.
import { useResource } from '../../lib/live.jsx';
import { href } from '../../lib/router.js';
import { Empty, Meter, Spinner } from '../../ui/index.jsx';

function PersonaCard({ p }) {
  const budget = p.promptBudgetTokens || 0;
  const pct = budget ? Math.min(100, (p.promptCost / budget) * 100) : 0;
  const file = `personas/${p.name}.yaml`;
  return (
    <div className="card">
      <div className="card-head">
        <h3><span className="key">{p.name}</span></h3>
        <span className="actions"><a className="btn sm ghost" href={href(`/system/config?file=${encodeURIComponent(file)}`)}>Edit</a></span>
      </div>
      <div className="card-body stack">
        {p.description && <p className="muted small" style={{ margin: 0 }}>{p.description}</p>}
        {(p.tools ?? []).length > 0 && (
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {p.tools.map((t) => <span key={t} className="chip xs">{t}</span>)}
          </div>
        )}
        {(p.canSpawn ?? []).length > 0 && (
          <div className="faint xs">can spawn: {p.canSpawn.join(', ')}</div>
        )}
        {budget > 0 && (
          <div className="sys-meters">
            <div className="lbl">
              <span>prompt cost</span>
              <span>{p.promptCost} / {budget} tok</span>
            </div>
            <Meter value={pct} tone={pct > 100 ? 'bad' : undefined} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function PersonasTab() {
  const { data, error, loading, reload } = useResource('/api/personas', { on: ['config_'] });
  if (error) return <Empty icon="alert" title="Personas unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading personas…</div>;
  const list = data ?? [];
  if (!list.length) return <Empty title="No personas" children="personas/*.yaml defines the agents." />;
  return (
    <div className="stack">
      <div className="row between">
        <span className="faint xs">{list.length} personas · edit files in the Config tab</span>
        <button className="btn sm ghost" onClick={reload}>↻</button>
      </div>
      <div className="grid cols-3">
        {list.map((p) => <PersonaCard key={p.name} p={p} />)}
      </div>
    </div>
  );
}
