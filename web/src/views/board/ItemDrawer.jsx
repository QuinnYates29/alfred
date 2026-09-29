// Item drawer: opened by clicking a card/row or via #/board/<KEY>. Edits save immediately (PATCH).
import { useCallback, useEffect, useState } from 'react';
import { api, post, del } from '../../api.js';
import { useResource } from '../../lib/live.jsx';
import { timeAgo } from '../../lib/format.js';
import { Avatar, Button, Drawer, Icon, Markdown, Menu, Spinner, StatusChip, useToast } from '../../ui/index.jsx';
import { PRIORITIES, appendChecklist, assigneeSuggestions, parseLabels, removeChecklist, toggleChecklist } from './model.js';
import Dispatch from './Dispatch.jsx';
import JiraLink from './JiraLink.jsx';

/** O1 — outputs a linked goal published, listed as links to the goal page. */
function GoalOutputs({ goalId }) {
  const { data } = useResource(`/api/goals/${goalId}/outputs`, { on: ['output'] });
  if (!data?.length) return null;
  return (
    <div className="row wrap" style={{ gap: 10, paddingLeft: 22 }}>
      {data.map((o) => (
        <a key={o.id} className="row xs" style={{ gap: 4 }} href={`#/goal/${goalId}`} title={`${o.kind} · ${o.bytes} bytes`}>
          <Icon name="file" size={11} /> {o.name}
        </a>
      ))}
    </div>
  );
}

const draftFrom = (it) => ({
  title: it.title ?? '',
  status: it.columnId ?? '',
  priority: it.priority ?? 'none',
  assignee: it.assignee ?? '',
  due: it.due ?? '',
  labels: (it.labels ?? []).join(', '),
  estimate: it.estimate == null ? '' : String(it.estimate),
  fields: { ...(it.fields ?? {}) },
});

export default function ItemDrawer({ itemKey, board, item, goalStatus, onClose, onChanged, onPatch }) {
  const { toast, confirm } = useToast();
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [personas, setPersonas] = useState([]);
  const [descEdit, setDescEdit] = useState(false);
  const [descText, setDescText] = useState('');
  const [ckNew, setCkNew] = useState('');
  const [subNew, setSubNew] = useState('');
  const [comment, setComment] = useState('');
  const [dispatch, setDispatch] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(
    () => api(`/api/items/${encodeURIComponent(itemKey)}`).then(setDetail).catch((e) => setErr(e?.message ?? String(e))),
    [itemKey],
  );
  useEffect(() => { setDetail(null); setDescEdit(false); load(); }, [load]);
  useEffect(() => { api('/api/personas').then(setPersonas).catch(() => {}); }, []);

  const it = detail?.item ?? item;
  // Seed the editable draft when the drawer switches to another item (not on refetches).
  useEffect(() => { if (it?.id) setDraft(draftFrom(it)); }, [it?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = (k, v) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const patch = (p) => onPatch?.(itemKey, p);

  const saveField = async (body) => {
    const cur = Object.keys(body).length ? body : null;
    if (!cur || !it) return;
    try {
      const updated = await api(`/api/items/${encodeURIComponent(itemKey)}`, { method: 'PATCH', body });
      setDetail((d) => (d ? { ...d, item: updated } : d));
      patch(body);
      onChanged?.();
    } catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };

  // Save a single property only when it actually changed (blur/Enter/change handlers).
  const saveOne = (key, val) => {
    if (!it || !draft) return;
    if (String(it[key] ?? '') === String(val ?? '')) return;
    saveField({ [key]: val === '' && key !== 'priority' && key !== 'title' ? null : val });
  };

  const toggleCheck = async (entry) => {
    try {
      await post(`/api/items/${encodeURIComponent(itemKey)}/check`, { entry: entry.id, done: !entry.done });
      load(); onChanged?.();
    } catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };
  const patchChecklist = async (list) => saveField({ checklist: list });

  const sendComment = async () => {
    const body = comment.trim();
    if (!body) return;
    setComment('');
    try {
      await post(`/api/items/${encodeURIComponent(itemKey)}/comments`, { body });
      load(); onChanged?.();
    } catch (e) { toast(e?.message ?? String(e), 'bad'); setComment(body); }
  };

  const addSub = async () => {
    const t = subNew.trim();
    if (!t) return;
    setSubNew('');
    try { await post('/api/items', { board: board.key, title: t, parent: it.id }); load(); onChanged?.(); }
    catch (e) { toast(e?.message ?? String(e), 'bad'); setSubNew(t); }
  };

  const copyLink = () => {
    const url = `${location.origin}${location.pathname}#/board/${it?.key ?? itemKey}`;
    navigator.clipboard?.writeText(url).then(() => toast('Link copied', 'ok')).catch(() => toast(url));
  };
  const archiveItem = async () => {
    if (!(await confirm({ title: `Archive ${it?.key}?`, body: 'It disappears from the board; agents can still see it.', ok: 'Archive' }))) return;
    try { await del(`/api/items/${encodeURIComponent(itemKey)}`); toast('Archived', 'ok'); onClose(); }
    catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };
  const deleteItem = async () => {
    if (!(await confirm({ title: `Delete ${it?.key} permanently?`, body: 'The item and its comments are gone for good.', danger: true, ok: 'Delete' }))) return;
    try { await del(`/api/items/${encodeURIComponent(itemKey)}?hard=1`); toast('Deleted', 'ok'); onClose(); }
    catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };

  if (!it || !draft) {
    return (
      <Drawer testId="item-drawer" onClose={onClose} head={<div className="item-head"><span className="key">{itemKey}</span></div>}>
        {err ? <div className="err" role="alert">{err}</div> : <div className="row" style={{ padding: 'var(--s-5)' }}><Spinner size={20} /></div>}
      </Drawer>
    );
  }

  const goals = detail?.goals ?? [];
  const checklists = it.checklist ?? [];
  const headMenu = [
    { label: 'Copy link', icon: 'link', onClick: copyLink },
    'sep',
    { label: 'Archive', icon: 'trash', onClick: archiveItem },
    { label: 'Delete permanently', danger: true, onClick: deleteItem },
  ];

  return (
    <>
      <Drawer
        testId="item-drawer"
        onClose={onClose}
        head={
          <div className="item-head">
            <div className="row" style={{ gap: 'var(--s-2)' }}>
              <span className="key">{it.key}</span>
              {it.archived && <span className="chip">archived</span>}
              <Button variant="ghost" size="sm" icon="trash" aria-label="Delete item" title="Delete item" onClick={deleteItem} />
              <Menu align="right" trigger={<Button variant="ghost" size="sm" icon="more" aria-label="Item actions" title="More (archive, delete…)" />} items={headMenu} />
            </div>
          </div>
        }
      >
        {err && <div className="err" role="alert">{err}</div>}
        <input
          className="input bare item-title-input"
          data-testid="item-title"
          aria-label="Title"
          value={draft.title}
          onChange={(e) => setF('title', e.target.value)}
          onBlur={() => saveOne('title', draft.title.trim())}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />

        <div className="item-props drawer-section">
          <label className="field">Status
            <select className="select" data-testid="item-status" value={draft.status} onChange={(e) => { setF('status', e.target.value); saveField({ status: e.target.value }); }}>
              {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field">Priority
            <select className="select" data-testid="item-priority" value={draft.priority} onChange={(e) => { setF('priority', e.target.value); saveField({ priority: e.target.value }); }}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="field">Assignee
            <input className="input" data-testid="item-assignee" list="item-assignees" value={draft.assignee}
              onChange={(e) => setF('assignee', e.target.value)} onBlur={() => saveOne('assignee', draft.assignee.trim())} />
            <datalist id="item-assignees">{assigneeSuggestions(personas).map((a) => <option key={a} value={a} />)}</datalist>
          </label>
          <label className="field">Due
            <input className="input" type="date" data-testid="item-due" value={draft.due}
              onChange={(e) => { setF('due', e.target.value); saveField({ due: e.target.value || null }); }} />
          </label>
          <label className="field">Labels
            <input className="input" data-testid="item-labels" placeholder="comma, separated" value={draft.labels}
              onChange={(e) => setF('labels', e.target.value)} onBlur={() => saveField({ labels: parseLabels(draft.labels) })} />
          </label>
          <label className="field">Estimate
            <input className="input" type="number" min="0" value={draft.estimate} placeholder="–"
              onChange={(e) => setF('estimate', e.target.value)} onBlur={() => saveOne('estimate', draft.estimate === '' ? null : Number(draft.estimate))} />
          </label>
          {(board.fields ?? []).map((f) => (
            <label className="field" key={f.id}>{f.name}
              {f.type === 'select' ? (
                <select className="select" value={draft.fields[f.id] ?? ''} onChange={(e) => { setDraft((d) => ({ ...d, fields: { ...d.fields, [f.id]: e.target.value } })); saveField({ fields: { [f.id]: e.target.value } }); }}>
                  <option value="">–</option>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === 'checkbox' ? (
                <input type="checkbox" checked={!!draft.fields[f.id]}
                  onChange={(e) => { setDraft((d) => ({ ...d, fields: { ...d.fields, [f.id]: e.target.checked } })); saveField({ fields: { [f.id]: e.target.checked } }); }} />
              ) : (
                <input className="input" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
                  value={draft.fields[f.id] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, fields: { ...d.fields, [f.id]: e.target.value } }))}
                  onBlur={() => saveField({ fields: { [f.id]: draft.fields[f.id] === '' ? null : f.type === 'number' && draft.fields[f.id] !== '' ? Number(draft.fields[f.id]) : draft.fields[f.id] } })} />
              )}
            </label>
          ))}
        </div>

        <JiraLink item={it} onDone={() => { load(); onChanged?.(); }} />

        <div className="drawer-section">
          <div className="row between">
            <h3>Description</h3>
            {!descEdit && (
              <Button size="sm" variant="ghost" icon="edit" data-testid="edit-description"
                onClick={() => { setDescText(it.description ?? ''); setDescEdit(true); }}>Edit</Button>
            )}
          </div>
          {descEdit ? (
            <>
              <textarea className="textarea" data-testid="item-description" rows={5} value={descText} onChange={(e) => setDescText(e.target.value)} />
              <div className="row" style={{ gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
                <Button onClick={() => setDescEdit(false)}>Cancel</Button>
                <Button variant="primary" onClick={async () => { await saveField({ description: descText }); setDescEdit(false); }}>Save</Button>
              </div>
            </>
          ) : it.description
            ? <Markdown text={it.description} />
            : <div className="faint small">No description.</div>}
        </div>

        <div className="drawer-section">
          <h3>Checklist</h3>
          {checklists.map((c) => (
            <div key={c.id} className={`ck-row ${c.done ? 'done' : ''}`}>
              <input type="checkbox" checked={!!c.done} aria-label={c.text} onChange={() => toggleCheck(c)} />
              <span className="ck-text">{c.text}</span>
              <Button size="sm" variant="ghost" icon="x" aria-label={`Remove ${c.text}`} onClick={() => patchChecklist(removeChecklist(checklists, c.id))} />
            </div>
          ))}
          <input className="input" data-testid="checklist-add" placeholder="Add a checklist item…" value={ckNew}
            onChange={(e) => setCkNew(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ckNew.trim()) { const t = ckNew.trim(); setCkNew(''); patchChecklist(appendChecklist(checklists, t)); }
            }} />
        </div>

        <div className="drawer-section">
          <h3>Sub-items</h3>
          {(detail?.children ?? []).map((c) => (
            <div key={c.id} className="sub-row">
              <span className="key">{c.key}</span>
              <span className="ellipsis grow">{c.title}</span>
              <span className="chip">{c.kind}</span>
            </div>
          ))}
          <input className="input" placeholder="Add sub-item…" aria-label="Add sub-item" value={subNew}
            onChange={(e) => setSubNew(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSub()} />
        </div>

        {(goals.length || (it.goalIds ?? []).length) > 0 && (
          <div className="drawer-section">
            <h3>Linked goals</h3>
            {goals.length ? goals.map((g) => (
              <div key={g.id}>
                <div className="row" style={{ gap: 'var(--s-2)', padding: '3px 0' }}>
                  <StatusChip status={g.status} />
                  <a href={`#/goal/${g.id}`}>{g.title ?? g.slug ?? g.id}</a>
                </div>
                {(g.outputs ?? 0) > 0 && <GoalOutputs goalId={g.id} />}
              </div>
            )) : (it.goalIds ?? []).map((gid) => (
              <div key={gid} className="row" style={{ gap: 'var(--s-2)', padding: '3px 0' }}>
                <StatusChip status={goalStatus?.(gid) ?? 'unknown'} />
                <a href={`#/goal/${gid}`}>goal {String(gid).slice(0, 8)}</a>
              </div>
            ))}
          </div>
        )}

        <div className="drawer-section">
          <div className="row between">
            <h3>Send to agent</h3>
            <Button icon="send" data-testid="send-to-agent" onClick={() => setDispatch(true)}>Send to agent</Button>
          </div>
        </div>

        <div className="drawer-section comment-form">
          <h3>Comments</h3>
          {(detail?.comments ?? []).map((c) => (
            <div key={c.id} className="comment">
              <Avatar who={c.author} />
              <div style={{ minWidth: 0 }}>
                <div className="meta">{c.author} · {timeAgo(c.createdAt)}</div>
                <Markdown text={c.body} />
              </div>
            </div>
          ))}
          <textarea
            className="textarea"
            data-testid="comment-input"
            placeholder="Comment… (⌘/Ctrl+Enter sends)"
            aria-label="New comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendComment(); }}
          />
          <div className="row" style={{ marginTop: 'var(--s-2)' }}>
            <span className="grow" />
            <Button icon="send" data-testid="comment-send" onClick={sendComment} disabled={!comment.trim()}>Send</Button>
          </div>
        </div>
      </Drawer>
      {dispatch && (
        <Dispatch
          item={it}
          onClose={() => setDispatch(false)}
          onDone={() => { setDispatch(false); load(); onChanged?.(); }}
        />
      )}
    </>
  );
}
