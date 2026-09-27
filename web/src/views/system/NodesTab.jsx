// Nodes: connected alfred-nodes + a short "connect your Mac" help.
import { useResource } from '../../lib/live.jsx';
import { dateTime } from '../../lib/format.js';
import { Empty, Spinner } from '../../ui/index.jsx';

export default function NodesTab() {
  const { data, error, loading } = useResource('/api/nodes', { on: ['node_'] });
  if (error) return <Empty icon="alert" title="Nodes unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading nodes…</div>;

  const nodes = data ?? [];
  const host = typeof location !== 'undefined' ? location.hostname : 'spark';

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Connected nodes</h3><span className="actions faint xs">{nodes.length} connected</span></div>
        <div className="sys-table">
          <table className="table">
            <thead><tr><th>Name</th><th>Roots</th><th>Caps</th><th>Connected</th></tr></thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.name}>
                  <td><span className="key">{n.name}</span></td>
                  <td className="mono xs">{(n.roots ?? []).join(', ') || '—'}</td>
                  <td>
                    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {(n.caps ?? []).map((c) => <span key={c} className="chip xs">{c}</span>)}
                    </span>
                  </td>
                  <td className="faint xs">{n.connectedAt ? dateTime(n.connectedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!nodes.length && <Empty icon="node" title="No nodes connected" children="Only local work runs until a machine connects." />}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Connect your Mac</h3></div>
        <div className="card-body stack">
          <p className="muted small" style={{ margin: 0 }}>
            Run an alfred-node on the Mac; it dials back over the tailnet and stays up via LaunchAgent.
          </p>
          <pre className="codeblock">
{`alfred-node --server wss://${host}:8443 \\\n  --token $ALFRED_TOKEN --name macbook --root ~/code\n\n# or install it as a LaunchAgent:\nbash deploy/node-install-macos.sh`}
          </pre>
        </div>
      </div>
    </div>
  );
}
