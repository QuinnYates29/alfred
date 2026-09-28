// Qwen server: presets + the llama-server flags card (shared with the Models tab) + env file view.
// Every apply restarts the model server: confirm first; 409 (tasks running) → Force.
import { useEffect, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { joinRows, parseExtra, rowError } from '../../lib/qwenFlags.js';
import { Button, Empty, StatusChip, useToast } from '../../ui/index.jsx';

/** send({slots:2}, 'Set slots to 2') → confirm, POST /api/ops/qwen, 409 → Force prompt. Resolves true on success. */
export function useQwenApply(reload) {
  const { toast, confirm } = useToast();
  const [busy, setBusy] = useState(false);
  const send = async (body, label) => {
    if (!(await confirm({ title: `${label}?`, body: 'This restarts the Qwen server.', ok: 'Apply', danger: false }))) return false;
    setBusy(true);
    const go = (force) => post('/api/ops/qwen', { confirm: true, ...body, ...(force ? { force: true } : {}) });
    try {
      try {
        await go(false);
      } catch (e) {
        if (e.status === 409) {
          const n = (e.data?.running ?? []).length;
          if (!(await confirm({ title: `${n} task${n === 1 ? '' : 's'} running on the model`, body: 'Applying this kills them. Force?', ok: 'Force', danger: true }))) return false;
          await go(true);
        } else throw e;
      }
      toast(`${label} applied`, 'ok');
      reload();
      return true;
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

function initialRows(data) {
  if (data.extraRows) return data.extraRows;
  try {
    return parseExtra(data.env?.QWEN_EXTRA ?? '');
  } catch {
    return null;
  }
}

/** QWEN_EXTRA as editable flag/value rows, with a raw-text fallback. */
function ExtraEditor({ data, busy, send }) {
  const current = data.env?.QWEN_EXTRA ?? '';
  const [rows, setRows] = useState(() => initialRows(data) ?? []);
  const [raw, setRaw] = useState(current);
  const [rawMode, setRawMode] = useState(() => initialRows(data) === null);
  // Server-side changes (another tab, a preset) reset the editor.
  useEffect(() => {
    const r = initialRows(data);
    setRows(r ?? []);
    setRaw(current);
    if (r === null) setRawMode(true);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  let text = '';
  let problem = '';
  if (rawMode) {
    try {
      text = joinRows(parseExtra(raw));
    } catch (e) {
      problem = e.message;
    }
  } else {
    const errs = rows.map(rowError);
    const i = errs.findIndex(Boolean);
    if (i >= 0) problem = `row ${i + 1}: ${errs[i]}`;
    text = joinRows(rows);
  }
  const dirty = !problem && text !== current.trim().split(/\s+/).filter(Boolean).join(' ');

  const setRow = (i, k, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const toggle = () => {
    if (rawMode) {
      try {
        setRows(parseExtra(raw));
        setRawMode(false);
      } catch {
        /* stay raw: the text doesn't parse into rows */
      }
    } else {
      setRaw(joinRows(rows));
      setRawMode(true);
    }
  };

  return (
    <div className="stack" data-testid="qwen-extra">
      <div className="row between">
        <span className="faint small">Extra flags (QWEN_EXTRA)</span>
        <Button size="sm" variant="ghost" onClick={toggle} disabled={rawMode && !!problem}>{rawMode ? 'Edit as rows' : 'Raw text'}</Button>
      </div>
      {rawMode ? (
        <input className="input mono" aria-label="Extra flags" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="--flag value …" />
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {rows.map((r, i) => (
            <div className="row" key={i} style={{ gap: 6 }}>
              <input className="input mono" style={{ maxWidth: 220 }} aria-label={`Flag ${i + 1}`} value={r.flag}
                placeholder="--flag" onChange={(e) => setRow(i, 'flag', e.target.value)} />
              <input className="input mono" aria-label={`Value ${i + 1}`} value={r.value}
                placeholder="(no value)" onChange={(e) => setRow(i, 'value', e.target.value)} />
              <Button size="sm" variant="ghost" icon="x" aria-label={`Remove ${r.flag || 'row'}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))} />
            </div>
          ))}
          {!rows.length && <span className="faint xs">no extra flags</span>}
          <span><Button size="sm" icon="plus" onClick={() => setRows([...rows, { flag: '', value: '' }])}>Add flag</Button></span>
        </div>
      )}
      <div className="row between">
        <span className={problem ? 'sys-bad xs' : 'faint xs mono'}>{problem || (dirty ? `→ ${text || '(none)'}` : '')}</span>
        <span className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" disabled={busy || (!dirty && !problem)}
            onClick={() => { const r = initialRows(data); setRows(r ?? []); setRaw(current); setRawMode(r === null); }}>Reset</Button>
          <Button size="sm" variant="primary" disabled={busy || !dirty}
            onClick={() => send({ extra: text }, text ? 'Set extra flags' : 'Clear extra flags')}>Apply</Button>
        </span>
      </div>
    </div>
  );
}

/** The llama-server flags: what is running, what the env file configures, and editors for -np / -c / -ncmoe / extra. */
export function QwenFlagsCard({ data, reload, title = 'llama-server flags' }) {
  const { busy, send } = useQwenApply(reload);
  const [vals, setVals] = useState({ slots: '', ctx: '', offload: '' });
  const env = data.env ?? {};
  const lim = data.limits ?? {};
  const num = (k) => (vals[k] !== '' ? Number(vals[k]) : undefined);
  // [field, label, flag, limits, env key in qwen-server.env]
  const fields = [
    ['slots', 'Slots', '-np', lim.slots ?? [1, 8], 'QWEN_NP'],
    ['ctx', 'Context per slot', '-c ÷ np', lim.ctx ?? [1024, 262144], 'QWEN_CTX'],
    ['offload', 'MoE offload blocks', '-ncmoe', lim.offload ?? [0, 48], 'QWEN_NCMOE'],
  ];
  const total = env.QWEN_CTX_TOTAL ?? (env.QWEN_CTX && env.QWEN_NP ? String(Number(env.QWEN_CTX) * Number(env.QWEN_NP)) : '?');
  const configured = [
    `-np ${env.QWEN_NP ?? '?'}`,
    `-c ${total}`,
    `-ncmoe ${env.QWEN_NCMOE ?? '?'}`,
    env.QWEN_EXTRA ?? '',
  ].filter(Boolean).join(' ');

  return (
    <div className="card" data-testid="qwen-flags">
      <div className="card-head">
        <h3>{title}</h3>
        <span className="actions"><StatusChip status={data.health ? 'ok' : 'bad'}>{data.health ? 'healthy' : 'down'}</StatusChip></span>
      </div>
      <div className="card-body stack">
        <dl className="sys-kv">
          <dt>running</dt><dd>{data.running ?? <span className="faint">unknown (server not running?)</span>}</dd>
          <dt>configured</dt><dd>{configured}</dd>
        </dl>
        <div className="form-row">
          {fields.map(([k, label, flag, [min, max], envKey]) => (
            <div className="field" key={k}>
              <label htmlFor={`qwen-${k}`}>{label} <span className="mono faint xs">{flag}</span> <span className="faint xs">[{min}…{max}]</span></label>
              <div className="row">
                <input id={`qwen-${k}`} className="input" type="number" min={min} max={max}
                  value={vals[k]} placeholder={env[envKey] ?? '—'}
                  onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
                <Button size="sm" disabled={busy || num(k) === undefined}
                  onClick={() => { send({ [k]: num(k) }, `Set ${label.toLowerCase()} to ${num(k)}`); setVals({ ...vals, [k]: '' }); }}>
                  Apply
                </Button>
              </div>
            </div>
          ))}
        </div>
        <ExtraEditor data={data} busy={busy} send={send} />
        <span className="faint xs">Each apply restarts the model server through qwenctl; running tasks are killed.</span>
      </div>
    </div>
  );
}

export default function QwenTab() {
  const { data, error, reload } = useResource('/api/ops/qwen', { interval: 15000 });
  const { busy, send } = useQwenApply(reload);

  if (error) return <Empty icon="alert" title="Qwen info unavailable">{error.message}</Empty>;
  if (!data) return <div className="card pad muted">Loading…</div>;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3>Presets</h3></div>
        <div className="card-body">
          <div className="row wrap">
            {(data.presets ?? []).map((p) => (
              <Button key={p} size="sm" disabled={busy} onClick={() => send({ preset: p }, `Apply preset “${p}”`)}>{p}</Button>
            ))}
          </div>
        </div>
      </div>

      <QwenFlagsCard data={data} reload={reload} title="Server" />

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
