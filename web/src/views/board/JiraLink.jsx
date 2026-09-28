// Item ↔ Jira: "Open in Jira" when the item is linked (fields.jira), else "Create Jira ticket"
// (Quinn's own action: no approval, but only in config/jira.yaml's projects and under the daily cap).
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Button, Icon, useToast } from '../../ui/index.jsx';

export default function JiraLink({ item, onDone }) {
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [busy, setBusy] = useState(false);
  const url = item?.fields?.jira;

  useEffect(() => {
    if (url) return;
    api('/api/jira/status').then((s) => {
      setStatus(s);
      setProject(s?.policy?.projects?.[0] ?? '');
      setType(s?.policy?.issueTypes?.[0] ?? '');
    }).catch(() => setStatus(null));
  }, [url, item?.key]);

  if (url) {
    return (
      <div className="drawer-section">
        <a className="small" href={url} target="_blank" rel="noreferrer noopener"><Icon name="external" size={13} /> Open in Jira</a>
      </div>
    );
  }
  // Nothing to offer until Jira is configured and at least one project is allowed.
  if (!status?.configured || !status?.policy?.projects?.length) return null;

  const create = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/jira/items/${encodeURIComponent(item.key)}/ticket`, { method: 'POST', body: { project, type } });
      toast(`Created ${r.key}`, 'ok');
      setOpen(false);
      onDone?.();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-section">
      {!open ? (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen(true)}>Create Jira ticket</Button>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="select" aria-label="Jira project" value={project} onChange={(e) => setProject(e.target.value)}>
            {status.policy.projects.map((p) => <option key={p}>{p}</option>)}
          </select>
          <select className="select" aria-label="Issue type" value={type} onChange={(e) => setType(e.target.value)}>
            {status.policy.issueTypes.map((t) => <option key={t}>{t}</option>)}
          </select>
          <Button size="sm" variant="primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create'}</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      )}
    </div>
  );
}
