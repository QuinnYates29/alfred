import { useFetch } from '../shared.jsx';

export default function NodesView({ tick }) {
  const { data, error } = useFetch('/api/nodes', tick);
  const nodes = Array.isArray(data) ? data : data?.nodes ?? [];

  return (
    <section>
      <h2 style={{ margin: '18px 0' }}>Nodes</h2>
      {error && <div className="err">{error.message}</div>}
      {!nodes.length && <div className="panel muted">No nodes connected — only local work.</div>}
      {nodes.map((n) => (
        <div className="panel task-head" key={n.id ?? n.name}>
          <span className={`dot ${n.connected ? 'on' : 'off'}`} aria-label={n.connected ? 'connected' : 'disconnected'} />
          <strong>{n.name ?? n.id}</strong>
          <span className="muted">{n.connected ? 'connected' : 'disconnected'}</span>
          {typeof n.tools === 'number' && <span className="muted">{n.tools} tools</span>}
          {n.error && <span className="reason mono">{n.error}</span>}
          {(n.roots || []).map((r) => (
            <span className="mono muted" key={r}>{r}</span>
          ))}
        </div>
      ))}
    </section>
  );
}
