// Board settings: rename, column editor (order, kind, WIP, add/delete with moveTo),
// custom-field editor, and create-a-new-board. Layout note: the columns section renders
// LAST so a freshly added column's name input is the last text input in the dialog.
import { useMemo, useState } from 'react';
import { api, post } from '../../api.js';
import { Button, Field, Modal, useToast } from '../../ui/index.jsx';

const KINDS = ['backlog', 'todo', 'doing', 'review', 'done'];
const FIELD_TYPES = ['text', 'number', 'select', 'date', 'checkbox', 'url'];

const newId = (prefix) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Trim to what PATCH /api/boards accepts; returns an error string or null. */
export function validateBoard({ name, columns, fields }) {
  if (!name.trim()) return 'The board needs a name.';
  if (!columns.length) return 'A board needs at least one column.';
  if (columns.some((c) => !c.name.trim())) return 'Every column needs a name.';
  const ids = new Set(columns.map((c) => c.id));
  if (ids.size !== columns.length) return 'Column ids must be unique.';
  if (fields.some((f) => !f.name.trim())) return 'Every field needs a name.';
  return null;
}

export function boardPatch({ name, columns, fields, removedIds, moveTo }) {
  const body = {
    name: name.trim(),
    columns: columns.map((c) => ({
      id: c.id, name: c.name.trim(), kind: c.kind,
      wip: c.wip === '' || c.wip == null ? null : Number(c.wip),
    })),
    fields: fields.map((f) => ({
      id: f.id, name: f.name.trim(), type: f.type,
      ...(f.type === 'select' ? { options: f.options ?? [] } : {}),
    })),
  };
  if (removedIds.length && moveTo) body.moveTo = moveTo;
  return body;
}

export default function Settings({ board, onClose, onCreated }) {
  const { toast } = useToast();
  const [name, setName] = useState(board.name ?? '');
  const [columns, setColumns] = useState(() => (board.columns ?? []).map((c) => ({ wip: '', ...c })));
  const [fields, setFields] = useState(() => (board.fields ?? []).map((f) => ({ options: [], ...f })));
  const [moveTo, setMoveTo] = useState('');
  const [nbName, setNbName] = useState('');
  const [nbKey, setNbKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const initialIds = useMemo(() => new Set((board.columns ?? []).map((c) => c.id)), [board]);
  const removedIds = useMemo(
    () => [...initialIds].filter((id) => !columns.some((c) => c.id === id)),
    [initialIds, columns],
  );

  const setCol = (i, patch) => setColumns((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setFld = (i, patch) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const shift = (arr, i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= arr.length) return arr;
    const out = [...arr];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };

  const addColumn = () => setColumns((cs) => [...cs, { id: newId('col-'), name: '', kind: 'todo', wip: '' }]);
  const addField = () => setFields((fs) => [...fs, { id: newId('fld-'), name: '', type: 'text', options: [] }]);

  const save = async () => {
    const v = validateBoard({ name, columns, fields });
    if (v) { setErr(v); return; }
    if (removedIds.length && !moveTo) { setErr('Pick a column to move items from removed columns into.'); return; }
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/boards/${encodeURIComponent(board.key)}`, {
        method: 'PATCH',
        body: boardPatch({ name, columns, fields, removedIds, moveTo }),
      });
      toast('Board saved', 'ok');
      onClose?.();
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const createBoard = async () => {
    if (!nbName.trim() || !nbKey.trim()) { setErr('A new board needs a name and a key.'); return; }
    setErr(null);
    setBusy(true);
    try {
      const b = await post('/api/boards', { name: nbName.trim(), key: nbKey.trim().toUpperCase() });
      toast(`Board ${b.key} created`, 'ok');
      onCreated?.(b);
      onClose?.();
    } catch (e) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Board settings — ${board.name}`}
      onClose={onClose}
      testId="settings-dialog"
      wide
      footer={<>
        {err && <span className="small bad grow" role="alert">{err}</span>}
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
      </>}
    >
      <Field label="Board name">
        <input className="input" type="text" value={name} aria-label="Board name" onChange={(e) => setName(e.target.value)} />
      </Field>

      <div className="set-row">
        <input className="input" type="text" placeholder="New board name" aria-label="New board name"
          value={nbName} onChange={(e) => setNbName(e.target.value)} />
        <input className="input" type="text" placeholder="KEY" aria-label="New board key"
          value={nbKey} onChange={(e) => setNbKey(e.target.value)} style={{ maxWidth: 90 }} />
        <Button onClick={createBoard} disabled={busy}>New board</Button>
      </div>

      <div className="set-section">
        <div className="set-head">
          <h3>Custom fields</h3>
          <Button variant="ghost" size="sm" onClick={addField}>Add field</Button>
        </div>
        {!fields.length && <div className="faint small">No custom fields.</div>}
        {fields.map((f, i) => (
          <div className="set-row" key={f.id}>
            <input className="input" type="text" placeholder="Field name" aria-label={`Field ${i + 1} name`}
              value={f.name} onChange={(e) => setFld(i, { name: e.target.value })} />
            <select className="select" aria-label={`Field ${i + 1} type`} value={f.type}
              onChange={(e) => setFld(i, { type: e.target.value })}>
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {f.type === 'select' && (
              <input className="input" type="text" placeholder="options, comma-separated" aria-label={`Field ${i + 1} options`}
                value={(f.options ?? []).join(', ')}
                onChange={(e) => setFld(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
            )}
            <Button variant="ghost" icon="trash" aria-label={`Remove field ${f.name || i + 1}`}
              onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} />
          </div>
        ))}
      </div>

      <div className="set-section">
        <div className="set-head">
          <h3>Columns</h3>
          <Button variant="ghost" size="sm" data-testid="add-column" onClick={addColumn}>Add column</Button>
        </div>
        {columns.map((c, i) => (
          <div className="set-row" key={c.id}>
            <input className="input" type="text" placeholder="Column name" aria-label={`Column ${i + 1} name`}
              value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} />
            <select className="select" aria-label={`Column ${i + 1} kind`} value={c.kind}
              onChange={(e) => setCol(i, { kind: e.target.value })}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input className="input" type="number" min="0" placeholder="WIP" aria-label={`Column ${i + 1} WIP limit`}
              value={c.wip ?? ''} style={{ maxWidth: 70 }}
              onChange={(e) => setCol(i, { wip: e.target.value })} />
            <Button variant="ghost" aria-label={`Move ${c.name || 'column'} up`} title="Move up"
              onClick={() => setColumns((cs) => shift(cs, i, -1))}>↑</Button>
            <Button variant="ghost" aria-label={`Move ${c.name || 'column'} down`} title="Move down"
              onClick={() => setColumns((cs) => shift(cs, i, 1))}>↓</Button>
            <Button variant="ghost" icon="trash" aria-label={`Remove ${c.name || 'column'}`}
              onClick={() => setColumns((cs) => cs.filter((_, j) => j !== i))} />
          </div>
        ))}
        {removedIds.length > 0 && (
          <Field label="Move items from removed columns to" error={!moveTo ? 'Required while a column is removed.' : undefined}>
            <select className="select" aria-label="Move removed column items to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">Choose a column…</option>
              {columns.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}
