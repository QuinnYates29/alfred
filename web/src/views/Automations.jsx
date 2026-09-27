// Automations: cron-scheduled goals. Table + create/edit modal (Name, Cron, Title, Persona,
// Spec, acceptance rows) + enable toggle + delete. Invalid cron → API 400 shown inline.
import { useState } from 'react';
import { useResource } from '../lib/live.jsx';
import { api, del, post } from '../api.js';
import { timeAgo } from '../lib/format.js';
import { Button, Empty, Menu, Modal, Spinner, StatusChip, useToast } from '../ui/index.jsx';
import './Automations.css';

const PRESETS = [['hourly', '* * * * *'], ['daily 8am', '0 8 * * *'], ['weekdays 9am', '0 9 * * 1-5'], ['weekly Mon', '0 8 * * 1']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A human phrase for common crons; null when it is not easy. */
export function cronWords(cron) {
  const p = String(cron).trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [min, hour, dom, mon, dow] = p;
  const at = /^\d+$/.test(hour) && /^\d+$/.test(min) ? `${+hour}:${String(min).padStart(2, '0')}` : null;
  if (cron === '* * * * *') return 'every minute';
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `every ${min.slice(3)} minutes`;
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'hourly';
  if (at && dom === '*' && mon === '*' && dow === '1-5') return `weekdays at ${at}`;
  if (at && dom === '*' && mon === '*' && dow === '*') return `daily at ${at}`;
  if (at && dom === '*' && mon === '*' && /^\d$/.test(dow) && DAYS[+dow]) return `weekly on ${DAYS[+dow]} at ${at}`;
  return null;
}

const blank = { id: null, name: '', cron: '0 8 * * *', title: '', persona: '', spec: '', acceptance: [] };

function EditModal({ initial, onClose, onSaved }) {
  const [f, setF] = useState(() => ({ ...blank, ...initial }));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: personas } = useResource('/api/personas');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const setAcc = (i, k, v) => setF({ ...f, acceptance: f.acceptance.map((a, j) => (j === i ? { ...a, [k]: v } : a)) });

  const save = async () => {
    setBusy(true);
    setErr(null);
    const body = {
      name: f.name.trim(),
      cron: f.cron.trim(),
      enabled: f.enabled !== false,
      template: {
        title: f.title.trim(),
        ...(f.persona ? { persona: f.persona } : {}),
        ...(f.spec.trim() ? { spec: f.spec } : {}),
        acceptance: f.acceptance.filter((a) => a.name && a.cmd),
      },
    };
    if (f.id) body.id = f.id;
    try {
      await api('/api/automations', { method: 'POST', body });
      onSaved();
      onClose();
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal testId="automation-dialog" title={f.id ? 'Edit automation' : 'New automation'} onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <span className="grow" />
        <Button variant="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
      </>}>
      <div className="stack">
        <div className="grid cols-2">
          <label className="field">
            <span className="label">Name</span>
            <input className="input" id="auto-name" value={f.name} placeholder="Morning check" onChange={set('name')} />
          </label>
          <label className="field">
            <span className="label">Cron</span>
            <input className="input mono" id="auto-cron" value={f.cron} placeholder="0 8 * * *" onChange={set('cron')} />
          </label>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="faint xs">presets:</span>
          {PRESETS.map(([label, expr]) => (
            <button key={label} type="button" className={`chip ${f.cron === expr ? 'accent' : ''}`} onClick={() => setF({ ...f, cron: expr })}>{label}</button>
          ))}
          {cronWords(f.cron) && <span className="faint xs">→ {cronWords(f.cron)}</span>}
        </div>
        <label className="field">
          <span className="label">Title</span>
          <input className="input" id="auto-title" value={f.title} placeholder="Check overnight failures" onChange={set('title')} />
        </label>
        <label className="field">
          <span className="label">Persona</span>
          <select className="select" id="auto-persona" value={f.persona} onChange={set('persona')}>
            <option value="">default</option>
            {(personas ?? []).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Spec</span>
          <textarea className="textarea" id="auto-spec" rows={5} value={f.spec} placeholder="What the goal should do…" onChange={set('spec')} />
        </label>
        <div className="field">
          <span className="label">Acceptance</span>
          {f.acceptance.map((a, i) => (
            <div key={i} className="row auto-acc" style={{ gap: 6 }}>
              <input className="input grow" placeholder="checks the API" value={a.name} onChange={(e) => setAcc(i, 'name', e.target.value)} aria-label={`Acceptance ${i + 1} name`} />
              <input className="input grow mono" placeholder="curl -sf localhost:8787/health" value={a.cmd} onChange={(e) => setAcc(i, 'cmd', e.target.value)} aria-label={`Acceptance ${i + 1} command`} />
              <Button variant="ghost" icon="trash" aria-label={`Remove acceptance ${i + 1}`} onClick={() => setF({ ...f, acceptance: f.acceptance.filter((_, j) => j !== i) })} />
            </div>
          ))}
          <div>
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setF({ ...f, acceptance: [...f.acceptance, { name: '', cmd: '' }] })}>Add check</Button>
          </div>
        </div>
        {err && <div className="err" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

export default function Automations() {
  const { data, error, loading, reload } = useResource('/api/automations', { on: ['automation_'] });
  const [modal, setModal] = useState(null); // null | draft object
  const { toast, confirm } = useToast();

  const toggle = async (a, on) => {
    try {
      await post(`/api/automations/${encodeURIComponent(a.id)}/enabled`, { on });
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    }
  };

  const remove = async (a) => {
    if (!(await confirm({ title: `Delete ${a.name}?`, body: 'The automation will stop firing. Existing goals are kept.', ok: 'Delete', danger: true }))) return;
    try {
      await del(`/api/automations/${encodeURIComponent(a.id)}`);
      toast('Automation deleted', 'ok');
      reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    }
  };

  const openEdit = (a) => setModal(a ? {
    id: a.id, name: a.name, cron: a.cron, enabled: a.enabled,
    title: a.template?.title ?? '', persona: a.template?.persona ?? '', spec: a.template?.spec ?? '',
    acceptance: (a.template?.acceptance ?? []).map((c) => ({ name: c.name ?? '', cmd: c.cmd ?? '' })),
  } : { ...blank });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Automations</h1>
        <span className="sub">goals that fire on a schedule</span>
        <span className="actions"><Button variant="primary" icon="plus" onClick={() => openEdit(null)}>New automation</Button></span>
      </div>

      {loading && !data && <div className="card pad muted"><Spinner /> loading automations…</div>}
      {error && <Empty icon="alert" title="Automations unavailable">{error.message}</Empty>}

      {data && !data.length && (
        <Empty icon="clock" title="No automations" children="Schedule a goal — a morning health check, a weekly tidy-up.">
          <Button variant="primary" icon="plus" onClick={() => openEdit(null)}>New automation</Button>
        </Empty>
      )}

      {(data ?? []).length > 0 && (
        <div className="card">
          <div className="sys-table">
            <table className="table">
              <thead><tr><th>Name</th><th>Cron</th><th>Template</th><th>Enabled</th><th>Last run</th><th /></tr></thead>
              <tbody>
                {data.map((a) => {
                  const words = cronWords(a.cron);
                  const file = a.source === 'file';
                  return (
                    <tr key={a.id}>
                      <td><span className="key">{a.name}</span>{file && <span className="chip xs" style={{ marginLeft: 6 }}>file</span>}</td>
                      <td>
                        <div className="mono xs">{a.cron}</div>
                        {words && <div className="faint xs">{words}</div>}
                      </td>
                      <td className="xs">
                        <div className="ellipsis" style={{ maxWidth: 240 }}>{a.template?.title ?? '—'}</div>
                        {a.template?.persona && <span className="chip xs">{a.template.persona}</span>}
                      </td>
                      <td>
                        <input type="checkbox" checked={!!a.enabled} disabled={file} aria-label={`${a.enabled ? 'Disable' : 'Enable'} ${a.name}`}
                          onChange={(e) => toggle(a, e.target.checked)} />
                      </td>
                      <td className="xs">
                        {a.lastRunAt ? (
                          <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                            {a.lastStatus && <StatusChip status={a.lastStatus} />}
                            <span className="faint">{timeAgo(a.lastRunAt)}</span>
                            {a.lastGoalId && <a href={`#/goal/${a.lastGoalId}`}>goal</a>}
                          </span>
                        ) : <span className="faint">never</span>}
                      </td>
                      <td>
                        {!file && (
                          <Menu align="right" trigger={<Button size="sm" variant="ghost" icon="more" aria-label={`More actions for ${a.name}`} />}
                            items={[
                              { label: 'Edit', icon: 'edit', onClick: () => openEdit(a) },
                              'sep',
                              { label: 'Delete', icon: 'trash', danger: true, onClick: () => remove(a) },
                            ]} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && <EditModal initial={modal} onClose={() => setModal(null)} onSaved={() => { toast('Automation saved', 'ok'); reload(); }} />}
    </div>
  );
}
