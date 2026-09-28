// Models: the model table + role → model selects (POST /api/models/roles) + Reload,
// the local llama.cpp server's flags, and the tool permissions matrix (agents × models).
import { useState } from 'react';
import { QwenFlagsCard } from './Qwen.jsx';
import Permissions from './Permissions.jsx';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { Button, Empty, Spinner, useToast } from '../../ui/index.jsx';

export default function ModelsTab() {
  const { data, error, loading, reload } = useResource('/api/models', { on: ['config_'] });
  const qwen = useResource('/api/ops/qwen');
  const { toast } = useToast();
  const [busyRole, setBusyRole] = useState('');
  const [reloading, setReloading] = useState(false);

  if (error) return <Empty icon="alert" title="Models unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading models…</div>;

  const models = data?.models ?? [];
  const roles = data?.roles ?? {};

  const setRole = async (role, model) => {
    setBusyRole(role);
    try {
      await post('/api/models/roles', { role, model });
      toast(`${role} → ${model}`, 'ok');
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusyRole('');
    }
  };

  const reloadModels = async () => {
    setReloading(true);
    try {
      await post('/api/models/reload');
      toast('Models reloaded', 'ok');
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setReloading(false);
    }
  };

  // The model served by the local llama.cpp server (the ops qwen URL), else one named qwen-local.
  const trim = (u) => String(u ?? '').replace(/\/+(v1)?\/*$/, '');
  const local = models.find((m) => qwen.data && trim(m.baseUrl) === trim(qwen.data.url)) ?? models.find((m) => m.name === 'qwen-local');

  const optionsFor = (current) => {
    const names = models.map((m) => m.name);
    if (current && !names.includes(current)) names.unshift(current);
    return names;
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Models</h3>
          <span className="actions">
            <Button size="sm" icon="retry" onClick={reloadModels} disabled={reloading}>{reloading ? 'Reloading…' : 'Reload'}</Button>
          </span>
        </div>
        <div className="sys-table">
          <table className="table">
            <thead><tr><th>Name</th><th>Model id</th><th>Base URL</th><th>Roles</th></tr></thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.name}>
                  <td><span className="key">{m.name}</span></td>
                  <td className="mono faint">{m.model}</td>
                  <td className="mono faint xs">{m.baseUrl}</td>
                  <td>
                    <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {(m.roles ?? []).map((r) => <span key={r} className="chip">{r}</span>)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!models.length && <Empty title="No models" children="config/models.yaml defines what the server can run." />}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Roles</h3><span className="actions faint xs">what each kind of work runs on — changes apply immediately</span></div>
        <div className="card-body stack">
          {Object.entries(roles).map(([role, model]) => (
            <label key={role} className="row" style={{ gap: 'var(--s-3)' }}>
              <span className="key sys-role">{role}</span>
              <select
                className="select"
                style={{ width: 'auto', maxWidth: 280 }}
                value={model}
                disabled={busyRole === role}
                onChange={(e) => setRole(role, e.target.value)}
                aria-label={`Model for ${role}`}
              >
                {optionsFor(model).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {busyRole === role && <Spinner size={14} />}
            </label>
          ))}
          {!Object.keys(roles).length && <Empty title="No roles configured" />}
        </div>
      </div>

      {local && qwen.data && <QwenFlagsCard data={qwen.data} reload={qwen.reload} title={`${local.name} — llama.cpp server flags`} />}

      <Permissions />
    </div>
  );
}
