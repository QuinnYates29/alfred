// Tool permissions by agent (persona `tools:`) AND by model (`deny:` in config/models.yaml).
// Effective = persona allows AND the persona's model allows. Save → POST /api/ops/permissions.
import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { post } from '../../api.js';
import { Button, Empty, Spinner, useToast } from '../../ui/index.jsx';

const GROUPS = [
  ['Files', ['read_file', 'list_dir', 'write_file']],
  ['Shell & code', ['run_shell', 'dsh_code', 'pipeline_run', 'langgraph_code']],
  ['Delegation', ['spawn_subagent', 'wait_subtasks', 'ask_claude']],
  ['Platform', ['board', 'platform', 'connectors', 'alfred_dev', 'notify']],
  ['People', ['contacts', 'message', 'call']],
];
/** Tasks need these to end; a model may not deny them (the server refuses too). */
const UNDENIABLE = ['finish', 'give_up'];

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export default function Permissions() {
  const tools = useResource('/api/tools');
  const personas = useResource('/api/personas', { on: ['config_'] });
  const models = useResource('/api/models', { on: ['config_'] });
  const { toast, confirm } = useToast();
  const [pDraft, setPDraft] = useState({}); // persona → Set(tools)
  const [mDraft, setMDraft] = useState({}); // model → Set(denied)
  const [saving, setSaving] = useState(false);

  const orig = useMemo(() => {
    const p = {};
    for (const x of personas.data ?? []) p[x.name] = new Set(x.tools ?? []);
    const m = {};
    for (const x of models.data?.models ?? []) m[x.name] = new Set(x.deny ?? []);
    return { p, m };
  }, [personas.data, models.data]);
  useEffect(() => { setPDraft(orig.p); setMDraft(orig.m); }, [orig]);

  const err = tools.error ?? personas.error ?? models.error;
  if (err) return <Empty icon="alert" title="Permissions unavailable">{err.message}</Empty>;
  if (!tools.data || !personas.data || !models.data) return <div className="card pad muted"><Spinner /> loading permissions…</div>;

  const plist = personas.data;
  const mlist = models.data.models ?? [];
  const roles = models.data.roles ?? {};
  const known = new Set(tools.data.map((t) => t.name));
  const grouped = new Set(GROUPS.flatMap(([, names]) => names));
  const groups = [
    ...GROUPS.map(([g, names]) => [g, names.filter((n) => known.has(n))]),
    ['Other', tools.data.map((t) => t.name).filter((n) => !grouped.has(n)).sort()],
  ].filter(([, names]) => names.length);
  const describe = Object.fromEntries(tools.data.map((t) => [t.name, t.description]));

  /** persona.model is a role or a model name → the model it runs on. */
  const modelOf = (ref) => roles[ref] ?? (mlist.some((m) => m.name === ref) ? ref : roles.default);
  const blockedBy = (persona, tool) => {
    const m = modelOf(persona.model ?? 'default');
    return mDraft[m]?.has(tool) ? m : null;
  };

  const flip = (setter, draft, key, tool) => {
    const next = new Set(draft[key] ?? []);
    next.has(tool) ? next.delete(tool) : next.add(tool);
    setter({ ...draft, [key]: next });
  };

  const changedP = plist.filter((p) => pDraft[p.name] && !sameSet(pDraft[p.name], orig.p[p.name] ?? new Set()));
  const changedM = mlist.filter((m) => mDraft[m.name] && !sameSet(mDraft[m.name], orig.m[m.name] ?? new Set()));
  const dirty = changedP.length + changedM.length > 0;
  const order = groups.flatMap(([, names]) => names);

  const diffText = (before, after) => {
    const add = [...after].filter((t) => !before.has(t));
    const rm = [...before].filter((t) => !after.has(t));
    return [add.length ? `+${add.join(' +')}` : '', rm.length ? `−${rm.join(' −')}` : ''].filter(Boolean).join(' ');
  };

  const save = async () => {
    const lines = [
      ...changedP.map((p) => `${p.name}: ${diffText(orig.p[p.name], pDraft[p.name])}`),
      ...changedM.map((m) => `model ${m.name} deny: ${diffText(orig.m[m.name], mDraft[m.name])}`),
    ];
    if (!(await confirm({ title: 'Change what agents can do?', body: lines.join(' · '), ok: 'Save', danger: true }))) return;
    const body = { confirm: true, personas: {}, models: {} };
    for (const p of changedP) {
      // Keep the persona's existing order; new tools go at the end in matrix order.
      const kept = (p.tools ?? []).filter((t) => pDraft[p.name].has(t));
      body.personas[p.name] = [...kept, ...order.filter((t) => pDraft[p.name].has(t) && !kept.includes(t))];
    }
    for (const m of changedM) body.models[m.name] = order.filter((t) => mDraft[m.name].has(t));
    setSaving(true);
    try {
      const out = await post('/api/ops/permissions', body);
      toast(`Saved ${out.written.join(', ')}${out.warnings?.length ? ` — ${out.warnings.join('; ')}` : ''}`, out.warnings?.length ? 'bad' : 'ok');
      personas.reload();
      models.reload();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" data-testid="permissions">
      <div className="card-head">
        <h3>Tool permissions</h3>
        <span className="actions row" style={{ gap: 6 }}>
          <Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => { setPDraft(orig.p); setMDraft(orig.m); }}>Reset</Button>
          <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
        </span>
      </div>
      <div className="card-body stack">
        <span className="faint xs">
          Agent columns are each persona's <span className="mono">tools:</span>; model columns allow a tool for every agent on that model
          (unchecked = <span className="mono">deny</span> in models.yaml). An agent gets a tool only if both allow it.
          Approvals still apply to messages, calls, deploys and config changes.
        </span>
        <div className="sys-table">
          <table className="table sys-perm">
            <thead>
              <tr>
                <th>Tool</th>
                {plist.map((p) => <th key={p.name} title={`runs on ${modelOf(p.model ?? 'default')} (${p.model ?? 'default'})`}>{p.name}</th>)}
                {mlist.map((m) => <th key={m.name} className="sys-perm-model" title="model">{m.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, names]) => [
                <tr key={`g-${g}`} className="sys-perm-group"><td colSpan={1 + plist.length + mlist.length}>{g}</td></tr>,
                ...names.map((t) => (
                  <tr key={t}>
                    <td className="mono small" title={describe[t]}>{t}</td>
                    {plist.map((p) => {
                      const on = pDraft[p.name]?.has(t) ?? false;
                      const via = on ? blockedBy(p, t) : null;
                      return (
                        <td key={p.name} className={via ? 'sys-perm-blocked' : ''} title={via ? `blocked via model ${via}` : undefined}>
                          <input type="checkbox" checked={on} aria-label={`${p.name} ${t}`} onChange={() => flip(setPDraft, pDraft, p.name, t)} />
                        </td>
                      );
                    })}
                    {mlist.map((m) => (
                      <td key={m.name} className="sys-perm-model">
                        <input type="checkbox" checked={!(mDraft[m.name]?.has(t))} disabled={UNDENIABLE.includes(t)}
                          aria-label={`model ${m.name} ${t}`} onChange={() => flip(setMDraft, mDraft, m.name, t)} />
                      </td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
        <div className="stack" style={{ gap: 4 }} data-testid="permissions-effective">
          <span className="faint small">Effective</span>
          {plist.map((p) => {
            const m = modelOf(p.model ?? 'default');
            const all = [...(pDraft[p.name] ?? [])];
            const blocked = all.filter((t) => mDraft[m]?.has(t));
            return (
              <div key={p.name} className="xs">
                <span className="key">{p.name}</span> <span className="faint">on {m}:</span> {all.length - blocked.length} tools
                {blocked.length > 0 && <span className="sys-bad"> · via model {m}: blocked {blocked.join(', ')}</span>}
              </div>
            );
          })}
          {(() => {
            const m = modelOf('planner');
            const blocked = [...(mDraft[m] ?? [])];
            return (
              <div className="xs"><span className="key">chat</span> <span className="faint">on {m} (planner):</span>
                {blocked.length ? <span className="sys-bad"> blocked {blocked.join(', ')}</span> : ' no model restrictions'}</div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
