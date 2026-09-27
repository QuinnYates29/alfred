// Services: alfred, qwen-server, deck. Start/Stop/Restart with confirm; 409 offers Force.
import { useState } from 'react';
import { useResource, useLiveState } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { dateTime } from '../../lib/format.js';
import { Button, Empty, Spinner, useToast } from '../../ui/index.jsx';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default function Services() {
  const { data, error, loading, reload } = useResource('/api/ops/services', { interval: 10000, on: ['ops'] });
  const live = useLiveState();
  const { toast, confirm } = useToast();
  const [busy, setBusy] = useState(null); // `${name}:${action}`
  const [restartingAlfred, setRestartingAlfred] = useState(false);

  if (restartingAlfred && live === 'open') setRestartingAlfred(false); // the stream is back — the restart landed

  const act = async (svc, action) => {
    const label = cap(action);
    if (!(await confirm({ title: `${label} ${svc.name}?`, body: `${svc.unit ?? svc.name} will go down while it restarts.`, ok: label, danger: action !== 'start' }))) return;
    setBusy(`${svc.name}:${action}`);
    const go = (force) => post(`/api/ops/services/${svc.name}/${action}`, { confirm: true, ...(force ? { force: true } : {}) });
    try {
      try {
        await go(false);
      } catch (e) {
        if (e.status === 409) {
          const ids = Array.isArray(e.data?.running) ? e.data.running : [];
          const names = ids.map((t) => t?.title ?? (typeof t === 'string' ? t : String(t))).slice(0, 6).join(', ');
          if (!(await confirm({ title: `${ids.length} task${ids.length === 1 ? '' : 's'} running on the model`, body: `${names}. ${label} will kill them. Force?`, ok: 'Force', danger: true }))) return;
          await go(true);
        } else throw e;
      }
      if (svc.name === 'alfred') setRestartingAlfred(true);
      toast(`${label} ${svc.name}`, 'ok');
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <div className="card list">
      <div className="card-head">
        <h3>Services</h3>
        <span className="actions"><Button size="sm" variant="ghost" icon="retry" onClick={reload}>Refresh</Button></span>
      </div>
      {error && <div className="card-body"><Empty icon="alert" title="Services unavailable">{error.message}</Empty></div>}
      {loading && !data && <div className="card-body row"><Spinner /> loading…</div>}
      {(data ?? []).map((svc) => (
        <div className="list-item" key={svc.name}>
          <span className={`chip ${svc.active === 'active' ? 'active-ok' : 'stopped'}`}>
            <span className="dot" />{svc.active === 'active' ? 'running' : svc.active}
          </span>
          <span className="grow">
            <strong>{svc.name}</strong>
            <span className="key" style={{ marginLeft: 8 }}>{svc.unit ?? (svc.name === 'deck' ? 'supervised by alfred' : '')}</span>
          </span>
          <span className="faint small hide-mobile">{svc.pid ? `pid ${svc.pid}` : ''}</span>
          <span className="faint small hide-mobile">{svc.memMb != null ? `${svc.memMb} MB` : ''}</span>
          <span className="faint small">{svc.since ? `since ${dateTime(svc.since)}` : ''}</span>
          {svc.url && <a className="small" href={svc.url} target="_blank" rel="noreferrer">open</a>}
          {(svc.controllable ?? []).map((action) => (
            <Button key={action} size="sm" variant={action === 'stop' ? 'danger' : undefined}
              disabled={busy !== null} onClick={() => act(svc, action)}>
              {restartingAlfred && svc.name === 'alfred' && action === 'restart' && live !== 'open' ? 'reconnecting…' : cap(action)}
            </Button>
          ))}
          {svc.name === 'alfred' && restartingAlfred && live !== 'open' && <span className="muted small">reconnecting…</span>}
        </div>
      ))}
      {data && !data.length && !error && <Empty title="No services found" />}
    </div>
  );
}
