// Connectors: the MCP servers alfred uses (config/mcp.json) — live status, tools, add / remove / reconnect.
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { api, post } from '../../api.js';
import { Button, Empty, Spinner, StatusChip, useToast } from '../../ui/index.jsx';

const EMPTY = { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' };

/** "K=V" / "K: V" lines → object (empty → undefined). */
function pairs(text, sep) {
  const out = {};
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf(sep);
    if (i <= 0) throw new Error(`expected KEY${sep}value: ${s}`);
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export default function Connectors() {
  const { data, error, loading, reload } = useResource('/api/connectors', { on: ['ops'], interval: 15000 });
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      await fn();
      toast(done, 'ok');
      reload();
      return true;
    } catch (err) {
      toast(err?.message ?? String(err), 'bad');
      return false;
    } finally {
      setBusy('');
    }
  };

  const submit = (e) => {
    e?.preventDefault();
    const name = form.name.trim();
    if (!name) { toast('Name is required', 'bad'); return; }
    let body;
    try {
      body = form.transport === 'stdio'
        ? { name, command: form.command.trim(), args: form.args.split('\n').map((s) => s.trim()).filter(Boolean), env: pairs(form.env, '=') }
        : { name, url: form.url.trim(), headers: pairs(form.headers, ':') };
    } catch (err) {
      toast(err.message, 'bad');
      return;
    }
    run('add', () => post('/api/connectors', { ...body, confirm: true }), `Saved ${name}`).then((ok) => ok && setForm({ ...EMPTY, transport: form.transport }));
  };

  const remove = (name) => {
    if (!window.confirm(`Remove connector ${name} from config/mcp.json?`)) return;
    run(`rm:${name}`, () => api(`/api/connectors/${encodeURIComponent(name)}`, { method: 'DELETE', body: { confirm: true } }), `Removed ${name}`);
  };
  const reconnect = (name) => run(`re:${name}`, () => post(`/api/connectors/${encodeURIComponent(name)}/reconnect`), `Reconnected ${name}`);

  if (error) return <Empty icon="alert" title="Connectors unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading connectors…</div>;

  const list = data ?? [];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>MCP connectors</h3><span className="actions faint xs">{list.filter((c) => c.ok).length}/{list.length} connected</span></div>
        <div className="sys-table">
          <table className="table">
            <thead><tr><th>Name</th><th>Status</th><th>Tools</th><th /></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.name}>
                  <td><span className="key">{c.name}</span> <span className="faint xs">{c.transport}</span></td>
                  <td>
                    <StatusChip tone={c.ok ? 'ok' : 'bad'}>{c.ok ? 'connected' : 'down'}</StatusChip>
                    {c.error && <div className="faint xs mono">{c.error}</div>}
                  </td>
                  <td title={(c.tools ?? []).join(', ')}><span className="chip xs">{(c.tools ?? []).length}</span></td>
                  <td className="btn-row">
                    <Button size="sm" disabled={!!busy} onClick={() => reconnect(c.name)}>{busy === `re:${c.name}` ? 'Reconnecting…' : 'Reconnect'}</Button>
                    <Button size="sm" variant="danger" disabled={!!busy} onClick={() => remove(c.name)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <Empty icon="link" title="No connectors" children="Add an MCP server so agents can use its tools." />}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Add or replace a connector</h3></div>
        <form className="card-body grid cols-2" onSubmit={submit}>
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={form.name} placeholder="weather" onChange={set('name')} />
          </label>
          <label className="field">
            <span className="label">Transport</span>
            <select className="input" value={form.transport} onChange={set('transport')}>
              <option value="stdio">stdio (a local command)</option>
              <option value="http">http (a URL)</option>
            </select>
          </label>
          {form.transport === 'stdio' ? (
            <>
              <label className="field">
                <span className="label">Command</span>
                <input className="input mono" value={form.command} placeholder="npx" onChange={set('command')} />
              </label>
              <label className="field">
                <span className="label">Args (one per line)</span>
                <textarea className="input mono" rows={3} value={form.args} placeholder={'-y\n@scope/mcp-server'} onChange={set('args')} />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="label">Env (KEY=value per line; ${'{VAR}'} reads alfred's env)</span>
                <textarea className="input mono" rows={2} value={form.env} onChange={set('env')} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span className="label">URL</span>
                <input className="input mono" value={form.url} placeholder="https://host/mcp" onChange={set('url')} />
              </label>
              <label className="field">
                <span className="label">Headers (Name: value per line)</span>
                <textarea className="input mono" rows={3} value={form.headers} placeholder="Authorization: Bearer ${TOKEN}" onChange={set('headers')} />
              </label>
            </>
          )}
          <div className="btn-row" style={{ gridColumn: '1 / -1' }}>
            <Button type="submit" variant="primary" disabled={!!busy}>{busy === 'add' ? 'Saving…' : 'Save & connect'}</Button>
            <span className="faint xs">Writes config/mcp.json (backed up) and reconnects. Same name replaces.</span>
          </div>
        </form>
      </div>
    </div>
  );
}
