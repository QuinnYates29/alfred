// Jira: Quinn's work site — configured state, what agents may do (config/jira.yaml), usage today,
// and the board import. Sync now pulls Jira issues onto the board (read-only toward Jira).
import { useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { api } from '../../api.js';
import { Button, Empty, Spinner, StatusChip, useToast } from '../../ui/index.jsx';

const Row = ({ k, children }) => (
  <div className="kv-row">
    <span className="kv-k muted xs">{k}</span>
    <span className="kv-v">{children}</span>
  </div>
);

export default function JiraTab() {
  const { data: s, error, loading, reload } = useResource('/api/jira/status', { on: ['jira'] });
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      const r = await api('/api/jira/sync', { method: 'POST' });
      toast(`jira sync: ${r.created.length} new, ${r.updated.length} updated, ${r.closed.length} closed${r.errors.length ? `, ${r.errors.length} errors` : ''}`, r.errors.length ? 'bad' : 'ok');
      reload();
    } catch (err) {
      toast(err?.message ?? String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <Empty icon="alert" title="Jira unavailable">{error.message}</Empty>;
  if (!s) return <div className="card pad muted"><Spinner /> loading jira…</div>;

  const pol = s.policy ?? {};
  const l = pol.limits ?? {};
  const u = s.usage ?? {};
  const imp = pol.import ?? {};
  const ls = s.lastSync;

  if (!s.configured) {
    return (
      <div className="stack">
        <div className="card pad">
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <h3>Jira</h3>
            <StatusChip tone="warn">not configured</StatusChip>
          </div>
          <p className="muted">
            Set <code>JIRA_SITE</code>, <code>JIRA_EMAIL</code> and <code>JIRA_API_TOKEN</code> in
            {' '}<code>~/.config/alfred.env</code> (the site must be <code>https://&lt;name&gt;.atlassian.net</code>),
            then restart alfred. What agents may do lives in <code>config/jira.yaml</code> — edit it in System → Config.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3>Jira</h3>
          <span className="actions btn-row">
            <Button size="sm" variant="primary" disabled={busy} onClick={sync}>{busy ? 'Syncing…' : 'Sync now'}</Button>
          </span>
        </div>
        <div className="card-body faint">
          <Row k="site">{s.site}{s.user ? ` · signed in as ${s.user}` : ''}{s.error ? ` · ${s.error}` : ''}</Row>
          <Row k="projects">
            {(pol.projects ?? []).length
              ? (pol.projects ?? []).map((p) => <StatusChip key={p} tone="ok">{p}</StatusChip>)
              : <StatusChip tone="warn">none — agents cannot create or comment</StatusChip>}
            {' '}{(pol.issueTypes ?? []).map((t) => <span key={t} className="chip xs">{t}</span>)}
          </Row>
          <Row k="limits">
            tickets {u.createsToday ?? 0}/{l.createsPerDay ?? '—'} today · comments {u.commentsToday ?? 0}/{l.commentsPerDay ?? '—'} · searches {u.searchesHour ?? 0}/{l.searchesPerHour ?? '—'} this hour
          </Row>
          <Row k="import">
            {imp.enabled ? <>every {imp.everyMinutes} min · max {imp.max} · board {imp.board || 'default'}</> : 'off (set import.enabled in config/jira.yaml)'}
          </Row>
          {ls && (
            <Row k="last sync">
              {`created ${ls.created?.length ?? 0}, updated ${ls.updated?.length ?? 0}, closed ${ls.closed?.length ?? 0}`
                + (ls.errors?.length ? `, errors: ${ls.errors.join('; ')}` : '')}
            </Row>
          )}
        </div>
        <div className="card-body faint xs">
          Agents may only search, read, and (with your OK) create or comment in the projects above — small daily caps,
          every ticket labelled <code>alfred</code>. Sync is one-way: Jira → board. Policy file: <code>{s.policyPath ?? 'config/jira.yaml'}</code>.
        </div>
      </div>
    </div>
  );
}
