// Contacts: who the agents may text or call (config/contacts.yaml) — edit in place, save (validated, backed up).
// Also shows how texts/calls would go out right now (a Mac node with --messages, else Twilio).
import { useEffect, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { api } from '../../api.js';
import { Button, Empty, Spinner, StatusChip, useToast } from '../../ui/index.jsx';

const FIELDS = [
  ['name', 'Name', 'Mom'],
  ['phone', 'Phone', '+15551234567'],
  ['imessage', 'iMessage', 'phone or email'],
  ['email', 'Email', ''],
  ['notes', 'Notes', ''],
];
const blank = () => ({ name: '', phone: '', imessage: '', email: '', notes: '' });

export default function Contacts() {
  const { data, error, loading, reload } = useResource('/api/contacts', { on: ['ops'] });
  const { data: nodes } = useResource('/api/nodes', { interval: 20000 });
  const { toast } = useToast();
  const [rows, setRows] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  // Take the server's list unless there are unsaved edits.
  useEffect(() => {
    if (data && !dirty) setRows(data.map((c) => ({ ...blank(), ...c })));
  }, [data, dirty]);

  const edit = (i, k) => (e) => {
    const next = rows.slice();
    next[i] = { ...next[i], [k]: e.target.value };
    setRows(next);
    setDirty(true);
  };
  const add = () => { setRows([...(rows ?? []), blank()]); setDirty(true); setQ(''); };
  const remove = (i) => {
    const c = rows[i];
    if (c.name && !window.confirm(`Remove ${c.name}?`)) return;
    setRows(rows.filter((_, j) => j !== i));
    setDirty(true);
  };
  const discard = () => { setDirty(false); reload(); };

  const save = async () => {
    const contacts = rows
      .map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v)))
      .filter((c) => Object.keys(c).length);
    setBusy(true);
    try {
      const out = await api('/api/contacts', { method: 'PUT', body: { contacts, confirm: true } });
      setRows(out.contacts.map((c) => ({ ...blank(), ...c })));
      setDirty(false);
      toast(`Saved ${out.contacts.length} contact${out.contacts.length === 1 ? '' : 's'}`, 'ok');
      reload();
    } catch (err) {
      toast(err?.message ?? String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Empty icon="alert" title="Contacts unavailable">{error.message}</Empty>;
  if (!rows) return <div className="card pad muted"><Spinner /> loading contacts…</div>;

  const mac = (nodes ?? []).find((n) => (n.caps ?? []).includes('messages'));
  const needle = q.trim().toLowerCase();
  const shown = rows.map((c, i) => [c, i]).filter(([c]) => !needle || Object.values(c).some((v) => String(v).toLowerCase().includes(needle)));

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Contacts</h3>
          <span className="actions btn-row">
            <input className="input" style={{ width: 180 }} placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button size="sm" icon="plus" onClick={add}>Add</Button>
          </span>
        </div>
        <div className="card-body faint xs">
          Texting: {mac
            ? <StatusChip tone="ok">via {mac.name} (Messages)</StatusChip>
            : <StatusChip tone="warn">no Mac with --messages online</StatusChip>}
          {' '}— otherwise Twilio when TWILIO_* is set. Every text and call waits for your approval unless config/powers.yaml pre-approves the contact.
        </div>
        <div className="sys-table">
          <table className="table">
            <thead><tr>{FIELDS.map(([k, label]) => <th key={k}>{label}</th>)}<th /></tr></thead>
            <tbody>
              {shown.map(([c, i]) => (
                <tr key={i}>
                  {FIELDS.map(([k, label, ph]) => (
                    <td key={k}>
                      <input className={`input${k === 'phone' || k === 'imessage' ? ' mono' : ''}`} value={c[k] ?? ''} placeholder={ph} aria-label={label} onChange={edit(i, k)} />
                    </td>
                  ))}
                  <td><Button size="sm" variant="danger" onClick={() => remove(i)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <Empty icon="user" title="No contacts" children="Add the people alfred may text or call." />}
        </div>
        <div className="card-body btn-row">
          <Button variant="primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
          {dirty && <Button disabled={busy} onClick={discard}>Discard changes</Button>}
          <span className="faint xs">Writes config/contacts.yaml (backed up). Numbers: +country code and digits.</span>
        </div>
      </div>
    </div>
  );
}
