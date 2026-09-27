// Repos: the repo registry (name, paths per machine, branch counts) + a register form.
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { Button, Empty, Spinner, useToast } from '../../ui/index.jsx';

export default function ReposTab() {
  const { data, error, loading, reload } = useResource('/api/ops/repos');
  const { toast } = useToast();
  const [form, setForm] = useState({ name: '', machine: 'local', path: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault();
    const { name, machine, path } = form;
    if (!name.trim() || !path.trim()) { toast('Name and path are required', 'bad'); return; }
    setBusy(true);
    try {
      await post('/api/ops/repos', { name: name.trim(), paths: { [machine.trim() || 'local']: path.trim() }, confirm: true });
      toast(`Registered ${name.trim()}`, 'ok');
      setForm({ name: '', machine, path: '' });
      reload();
    } catch (err) {
      toast(err?.message ?? String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Empty icon="alert" title="Repos unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading repos…</div>;

  const repos = data ?? [];
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Registry</h3><span className="actions faint xs">{repos.length} repos</span></div>
        <div className="sys-table">
          <table className="table">
            <thead><tr><th>Name</th><th>Paths</th><th>Branches</th></tr></thead>
            <tbody>
              {repos.map((r) => (
                <tr key={r.name}>
                  <td><span className="key">{r.name}</span>{r.defaultBranch && <span className="faint xs"> · {r.defaultBranch}</span>}</td>
                  <td className="mono xs">
                    {Object.entries(r.paths ?? {}).map(([m, p]) => (
                      <div key={m}><span className="faint">{m}:</span> {p}</div>
                    ))}
                  </td>
                  <td>{(r.branches ?? []).length ? <span className="chip xs">{(r.branches ?? []).length}</span> : <span className="faint xs">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!repos.length && <Empty icon="git" title="No repos registered" children="Register a repo so goals can point at it." />}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Register a repo</h3></div>
        <form className="card-body grid cols-3" onSubmit={submit}>
          <label className="field">
            <span className="label">Name</span>
            <input className="input" value={form.name} placeholder="my-app" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Machine</span>
            <input className="input" value={form.machine} placeholder="local" onChange={(e) => setForm({ ...form, machine: e.target.value })} />
          </label>
          <label className="field">
            <span className="label">Path on that machine</span>
            <input className="input" value={form.path} placeholder="/Users/me/code/my-app" onChange={(e) => setForm({ ...form, path: e.target.value })} />
          </label>
          <div className="btn-row" style={{ gridColumn: '1 / -1' }}>
            <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Add repo'}</Button>
            <span className="faint xs">Machines: local = the Spark; node names = a connected machine.</span>
          </div>
        </form>
      </div>
    </div>
  );
}
