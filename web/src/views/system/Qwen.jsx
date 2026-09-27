// Qwen server: env file view, presets, slots/ctx/offload with Apply (confirm; 409 → Force).
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { Button, Empty, StatusChip, useToast } from '../../ui/index.jsx';

export default function QwenTab() {
  const { data, error, reload } = useResource('/api/ops/qwen', { interval: 15000 });
  const { toast, confirm } = useToast();
  const [busy, setBusy] = useState(false);
  const [vals, setVals] = useState({ slots: '', ctx: '', offload: '' });

  const send = async (body, label) => {
    if (!(await confirm({ title: `${label}?`, body: 'This restarts the Qwen server.', ok: 'Apply', danger: false }))) return;
    setBusy(true);
    const go = (force) => post('/api/ops/qwen', { confirm: true, ...body, ...(force ? { force: true } : {}) });
    try {
      try {
        await go(false);
      } catch (e) {
        if (e.status === 409) {
          const n = (e.data?.running ?? []).length;
          if (!(await confirm({ title: `${n} task${n === 1 ? '' : 's'} running on the model`, body: 'Applying this kills them. Force?', ok: 'Force', danger: true }))) return;
          await go(true);
        } else throw e;
      }
      toast(`${label} applied`, 'ok');
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Empty icon="alert" title="Qwen info unavailable">{error.message}</Empty>;
  if (!data) return <div className="card pad muted">Loading…</div>;

  const lim = data.limits ?? {};
  const num = (k) => (vals[k] !== '' ? Number(vals[k]) : undefined);
  const fields = [
    ['slots', 'Slots', lim.slots],
    ['ctx', 'Context per slot', lim.ctx],
    ['offload', 'Offload layers', lim.offload],
  ];

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Server</h3>
          <span className="actions"><StatusChip status={data.health ? 'ok' : 'bad'}>{data.health ? 'healthy' : 'down'}</StatusChip></span>
        </div>
        <div className="card-body stack">
          <div className="row wrap">
            <span className="faint small">Presets</span>
            {(data.presets ?? []).map((p) => (
              <Button key={p} size="sm" disabled={busy} onClick={() => send({ preset: p }, `Apply preset “${p}”`)}>{p}</Button>
            ))}
          </div>
          <div className="form-row">
            {fields.map(([k, label, [min, max]]) => (
              <div className="field" key={k}>
                <label htmlFor={`qwen-${k}`}>{label} <span className="faint xs">[{min}…{max}]</span></label>
                <div className="row">
                  <input id={`qwen-${k}`} className="input" type="number" min={min} max={max}
                    value={vals[k]} placeholder={data.env?.[`QWEN_${k.toUpperCase()}`] ?? '—'}
                    onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
                  <Button size="sm" disabled={busy || num(k) === undefined}
                    onClick={() => { send({ [k]: num(k) }, `Set ${label.toLowerCase()} to ${num(k)}`); setVals({ ...vals, [k]: '' }); }}>
                    Apply
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Environment (qwen-server.env)</h3></div>
        <div className="card-body">
          {Object.keys(data.env ?? {}).length ? (
            <dl className="sys-kv">
              {Object.entries(data.env).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          ) : <span className="faint small">no QWEN_* settings set</span>}
        </div>
      </div>
    </div>
  );
}
