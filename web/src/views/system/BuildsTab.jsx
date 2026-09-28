// Builds: dispatch jobs from the Qwen build harness + detail drawer + a "New build" form.
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { timeAgo } from '../../lib/format.js';
import { Button, Drawer, Empty, Modal, Spinner, StatusChip, useToast } from '../../ui/index.jsx';

function JobDrawer({ name, onClose }) {
  const { data, loading } = useResource(name ? `/api/ops/dispatch/${encodeURIComponent(name)}` : null, { deps: [name], interval: 5000 });
  return (
    <Drawer testId="build-drawer" onClose={onClose} head={<strong className="key">{name}</strong>}>
      {loading && !data && <div className="row"><Spinner /> loading…</div>}
      {data && (
        <div className="stack">
          {data.status && (
            <div className="row" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <StatusChip status={data.status.state} />
              <span className="faint xs">attempt {data.status.attempt}{data.status.ts ? ` · ${timeAgo(Date.parse(data.status.ts))}` : ''}</span>
              {data.status.branch && <span className="chip xs">{data.status.branch}</span>}
            </div>
          )}
          <div>
            <div className="faint xs" style={{ marginBottom: 4 }}>run log (last 100 lines)</div>
            <pre className="codeblock sys-diff-tail sys-log-tail">{(data.log ?? []).join('\n') || 'no log yet'}</pre>
          </div>
          {data.check && (
            <div>
              <div className="faint xs" style={{ marginBottom: 4 }}>last check output</div>
              <pre className="codeblock sys-diff-tail">{data.check}</pre>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** U1 — the Mac app: last packed build (app/dist/latest.json) and a rebuild button. The app updates itself from it. */
function MacAppCard() {
  const { data, reload } = useResource('/api/ops/app/build', { interval: 10000, on: ['ops'] });
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const { toast } = useToast();
  const latest = data?.latest;
  const running = Boolean(data?.running);

  const build = async () => {
    setBusy(true);
    try {
      await post('/api/ops/app/build', { confirm: true, by: 'dashboard' });
      toast('Mac app build started', 'ok');
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card pad" data-testid="mac-app-build">
      <div className="row between" style={{ gap: 'var(--s-3)', flexWrap: 'wrap' }}>
        <div className="stack" style={{ gap: 2 }}>
          <strong>Mac app</strong>
          <span className="faint xs">
            {latest
              ? <>v{latest.version} · build <span className="mono">{latest.build}</span> · <span className="mono">{latest.commit}</span>{latest.builtAt ? ` · ${timeAgo(Date.parse(latest.builtAt))}` : ''}</>
              : 'no build yet'}
            {running && ' · building…'}
            {!running && data?.ok === false && ' · last build failed'}
          </span>
          <span className="faint xs">The app picks new builds up under Settings → Updates.</span>
        </div>
        <div className="row" style={{ gap: 'var(--s-2)' }}>
          {data?.output && <Button size="sm" variant="ghost" onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide log' : 'Log'}</Button>}
          <Button size="sm" variant="primary" disabled={busy || running} onClick={build}>
            {running ? <><Spinner /> Building…</> : 'Build Mac app'}
          </Button>
        </div>
      </div>
      {showLog && data?.output && <pre className="codeblock sys-diff-tail sys-log-tail" style={{ marginTop: 'var(--s-3)' }}>{data.output}</pre>}
    </div>
  );
}

const EMPTY_FORM = { name: '', branch: '', promptFile: '', check: '', attempts: 4, timeoutMin: 60 };

function NewBuildModal({ onClose, onDone }) {
  const [f, setF] = useState(EMPTY_FORM);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post('/api/ops/dispatch', {
        confirm: true,
        name: f.name.trim(),
        branch: f.branch.trim(),
        promptFile: f.promptFile.trim(),
        check: f.check.trim(),
        attempts: Number(f.attempts) || 4,
        timeoutMin: Number(f.timeoutMin) || 60,
      });
      toast(`Build ${f.name} started`, 'ok');
      onDone();
      onClose();
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal testId="build-dialog" title="New build" onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <span className="grow" />
        <Button variant="primary" disabled={busy || !f.name || !f.branch || !f.promptFile || !f.check} onClick={start}>
          {busy ? 'Starting…' : 'Start build'}
        </Button>
      </>}>
      <div className="stack">
        <div className="grid cols-2">
          <label className="field"><span className="label">Name</span><input className="input" value={f.name} placeholder="fix-login" onChange={set('name')} /></label>
          <label className="field"><span className="label">Branch</span><input className="input" value={f.branch} placeholder="main" onChange={set('branch')} /></label>
        </div>
        <label className="field"><span className="label">Prompt file (path in the alfred repo)</span><input className="input mono" value={f.promptFile} placeholder="prompts/fix-login.md" onChange={set('promptFile')} /></label>
        <label className="field"><span className="label">Check command</span><input className="input mono" value={f.check} placeholder="npx vitest run test/unit/" onChange={set('check')} /></label>
        <div className="grid cols-2">
          <label className="field"><span className="label">Attempts</span><input className="input" type="number" min="1" max="20" value={f.attempts} onChange={set('attempts')} /></label>
          <label className="field"><span className="label">Timeout (minutes)</span><input className="input" type="number" min="1" value={f.timeoutMin} onChange={set('timeoutMin')} /></label>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

export default function BuildsTab() {
  const { data, error, loading, reload } = useResource('/api/ops/dispatch', { interval: 10000, on: ['ops'] });
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);

  if (error) return <Empty icon="alert" title="Builds unavailable">{error.message}</Empty>;
  if (loading && !data) return <div className="card pad muted"><Spinner /> loading builds…</div>;

  const jobs = data ?? [];
  return (
    <div className="stack">
      <MacAppCard />
      <div className="row between">
        <span className="faint xs">dispatch jobs run qwen-task.sh against a branch until the check passes</span>
        <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>New build</Button>
      </div>
      <div className="card">
        <div className="sys-table">
          <table className="table">
            <thead><tr><th>Name</th><th>State</th><th>Attempt</th><th>Branch</th><th>Updated</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.name} className="link" onClick={() => setOpen(j.name)} role="button" tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(j.name)}>
                  <td><span className="key">{j.name}</span></td>
                  <td><StatusChip status={j.state} /></td>
                  <td className="faint xs">{j.attempt}</td>
                  <td className="mono xs">{j.branch}</td>
                  <td className="faint xs">{j.ts ? timeAgo(Date.parse(j.ts)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!jobs.length && <Empty icon="terminal" title="No build jobs" children="Kick one off with “New build”." />}
        </div>
      </div>
      {open && <JobDrawer name={open} onClose={() => setOpen(null)} />}
      {creating && <NewBuildModal onClose={() => setCreating(false)} onDone={reload} />}
    </div>
  );
}
