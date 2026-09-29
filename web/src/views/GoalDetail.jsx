// #/goal/<id>[/<tab>] — goal header (status, meta, actions) + Overview / Transcript / Changes / Files.
import { useCallback, useMemo, useState } from 'react';
import { useResource } from '../lib/live.jsx';
import { go, href } from '../lib/router.js';
import { dateTime, duration } from '../lib/format.js';
import { del, post, apiText } from '../api.js';
import { Button, Icon, StatusChip, Tabs, Empty, Spinner, Field, Modal, useToast, useAction, Markdown } from '../ui/index.jsx';
import { rootTask, stoppable } from './goal/model.js';
import OverviewTab from './goal/OverviewTab.jsx';
import TranscriptTab from './goal/TranscriptTab.jsx';
import ChangesTab from './goal/ChangesTab.jsx';
import FilesTab from './goal/FilesTab.jsx';
import './GoalDetail.css';

const TABS = [['', 'Overview'], ['transcript', 'Transcript'], ['changes', 'Changes'], ['files', 'Files']];

const OUTPUT_EXT = { markdown: 'md', text: 'txt', json: 'json', csv: 'csv', 'html-code': 'html' };

/** Minimal CSV parse (quoted cells + "" escapes); capped at 200 data rows. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(0, 201);
}

function renderOutput(kind, content) {
  if (kind === 'markdown') return <Markdown text={content} />;
  if (kind === 'json') {
    let pretty = content;
    try { pretty = JSON.stringify(JSON.parse(content), null, 2); } catch { /* not valid JSON — show raw */ }
    return <pre className="output-pre">{pretty}</pre>;
  }
  if (kind === 'csv') {
    const rows = csvRows(content);
    return (
      <div className="output-table-wrap">
        <table className="output-table">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
            ))}
          </tbody>
        </table>
        {rows.length >= 201 ? <div className="xs faint">first 200 rows shown</div> : null}
      </div>
    );
  }
  return <pre className="output-pre">{content}</pre>;
}

/** O1 — deliverables the agent published for Quinn: one tab per output, newest first. */
function OutputsCard({ goalId, outputs, onDeleted }) {
  const { toast, confirm } = useToast();
  const live = useCallback((ev) => ev.goalId === goalId, [goalId]);
  const [sel, setSel] = useState(null);
  const selId = outputs.some((o) => o.id === sel) ? sel : outputs[0]?.id ?? null;
  const selOut = outputs.find((o) => o.id === selId);
  const { data: full } = useResource(selId ? `/api/goals/${goalId}/outputs/${selId}` : null, { on: live, deps: [selId] });
  const content = full?.id === selId ? full.content ?? '' : '';

  const copy = () =>
    navigator.clipboard?.writeText(content).then(
      () => toast('Copied', 'ok'),
      (e) => toast(`Copy failed: ${e?.message ?? e}`, 'bad'),
    );

  const download = async (o) => {
    try {
      const text = await apiText(`/api/goals/${goalId}/outputs/${o.id}/raw`);
      const url = URL.createObjectURL(new Blob([text]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(o.name || 'output').replace(/["\\/;\x00-\x1f]/g, '_')}.${OUTPUT_EXT[o.kind] ?? 'txt'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };

  const remove = async (o) => {
    if (!(await confirm({ title: `Delete output “${o.name}”?`, body: 'The content is removed for good.', ok: 'Delete', danger: true }))) return;
    try { await del(`/api/goals/${goalId}/outputs/${o.id}`); toast('Output deleted', 'ok'); onDeleted?.(); }
    catch (e) { toast(e?.message ?? String(e), 'bad'); }
  };

  return (
    <div className="card outputs-card" data-testid="outputs-card">
      <div className="outputs-head">
        <h3><Icon name="file" size={14} /> Outputs</h3>
        {selOut ? (
          <div className="row" style={{ gap: 4 }}>
            <Button size="sm" variant="ghost" icon="copy" title="Copy to clipboard" onClick={copy}>Copy</Button>
            <Button size="sm" variant="ghost" icon="download" title="Download" onClick={() => download(selOut)}>Download</Button>
            <Button size="sm" variant="ghost" icon="trash" title="Delete this output" onClick={() => remove(selOut)}>Delete</Button>
          </div>
        ) : null}
      </div>
      <div className="output-tabs" role="tablist">
        {outputs.map((o) => (
          <button
            key={o.id}
            role="tab"
            aria-selected={o.id === selId}
            className={`output-tab${o.id === selId ? ' on' : ''}`}
            title={`${o.kind} · updated ${new Date(o.updatedAt).toISOString()}`}
            onClick={() => setSel(o.id)}
          >
            {o.name} <span className="xs faint">{o.kind}</span>
          </button>
        ))}
      </div>
      <div className="output-body">
        {!selOut || content === '' && !full ? <div className="row" style={{ padding: 12 }}><Spinner /></div> : renderOutput(selOut.kind, content)}
      </div>
    </div>
  );
}

export default function GoalDetail({ id, tab = '' }) {
  const live = useCallback((ev) => ev.goalId === id, [id]);
  const { data, error, loading, reload } = useResource(id ? `/api/goals/${id}` : null, { on: live });
  const { toast, confirm } = useToast();
  const act = useAction();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  const goal = data?.goal;
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const root = useMemo(() => rootTask(tasks), [tasks]);

  if (error) {
    return (
      <div className="page">
        <Empty icon="alert" title={error.status === 404 ? 'Goal not found' : `Could not load the goal: ${error.message}`} />
      </div>
    );
  }
  if (!goal) {
    return (
      <div className="page">
        <div className="row"><Spinner /> <span className="muted">Loading goal…</span></div>
      </div>
    );
  }

  const stoppableTasks = tasks.filter(stoppable);
  const retryRoot = root && ['failed', 'stopped'].includes(root.status);
  const itemKey = typeof goal.meta?.item === 'string' ? goal.meta.item : null;

  const stopAll = () =>
    act(async () => {
      await Promise.all(stoppableTasks.map((t) => post(`/api/tasks/${t.id}/stop`, { reason: 'stopped from the dashboard' })));
      toast('Stop requested', 'ok');
    }, null);

  const retryRootTask = () =>
    act(async () => {
      await post(`/api/tasks/${root.id}/retry`, {});
      toast('Retry queued', 'ok');
    }, null);

  const saveNote = () =>
    act(async () => {
      if (!root) throw new Error('no task to note');
      await post(`/api/tasks/${root.id}/note`, { text: note });
      toast('Note added', 'ok');
      setNoteOpen(false);
      setNote('');
    }, null);

  return (
    <div className="page">
      <div className="page-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            <h1 style={{ lineHeight: 1.25 }}>{goal.title}</h1>
            <StatusChip status={goal.status} />
          </div>
          <div className="sub row wrap" style={{ gap: 8, marginTop: 4 }}>
            <span className="key">{goal.slug}</span>
            <span aria-hidden="true">·</span>
            <span title="created">{dateTime(goal.createdAt)}</span>
            <span aria-hidden="true">·</span>
            <span title="elapsed">{duration((goal.status === 'active' ? Date.now() : goal.updatedAt) - goal.createdAt)}</span>
            {goal.meta?.repo ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="row" style={{ gap: 4 }} title="repo"><Icon name="git" size={13} /><span className="mono ellipsis">{String(goal.meta.repo)}</span></span>
              </>
            ) : null}
            {goal.meta?.node ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="row" style={{ gap: 4 }} title="node"><Icon name="node" size={13} />{String(goal.meta.node)}</span>
              </>
            ) : null}
            {itemKey ? (
              <>
                <span aria-hidden="true">·</span>
                <a className="row" style={{ gap: 4 }} href={href(`/board/${itemKey}`)}><Icon name="board" size={13} />{itemKey}</a>
              </>
            ) : null}
          </div>
        </div>
        <div className="actions">
          {stoppableTasks.length > 0 && (
            <Button icon="stop" onClick={stopAll} title={`Stop ${stoppableTasks.length} running/queued task${stoppableTasks.length === 1 ? '' : 's'}`}>
              Stop
            </Button>
          )}
          {retryRoot && <Button icon="retry" onClick={retryRootTask}>Retry</Button>}
          {root && (
            <Button icon="comment" variant="ghost" onClick={() => setNoteOpen(true)}>Add note</Button>
          )}
          <Button icon="trash" variant="ghost" data-testid="goal-delete" title="Delete this goal"
            disabled={tasks.some((t) => t.status === 'running' || t.status === 'verifying')}
            onClick={async () => {
              if (!(await confirm({ title: `Delete “${goal.title}”?`, body: 'The goal, its tasks, transcript and approvals are removed for good. Branches and workspaces on disk are kept.', ok: 'Delete', danger: true }))) return;
              try { await del(`/api/goals/${goal.id}`); toast('Goal deleted', 'ok'); go('/goals'); }
              catch (e) { toast(e?.message ?? String(e), 'bad'); }
            }}>
            Delete
          </Button>
        </div>
      </div>

      {(data?.outputs ?? []).length > 0 && (
        <OutputsCard goalId={goal.id} outputs={data.outputs} onDeleted={reload} />
      )}

      <Tabs tabs={TABS} value={tab ?? ''} hrefFor={(t) => `#/goal/${id}${t ? `/${t}` : ''}`} />

      {tab === 'transcript' ? (
        <TranscriptTab goal={goal} tasks={tasks} />
      ) : tab === 'changes' ? (
        <ChangesTab id={id} />
      ) : tab === 'files' ? (
        <FilesTab id={id} tasks={tasks} />
      ) : (
        <OverviewTab goal={goal} tasks={tasks} events={data.events ?? []} usage={data.usage} />
      )}

      {noteOpen && (
        <Modal
          title="Add note"
          onClose={() => setNoteOpen(false)}
          footer={<><Button onClick={() => setNoteOpen(false)}>Cancel</Button><Button variant="primary" onClick={saveNote}>Save</Button></>}
        >
          <Field label="Note" htmlFor="goal-note">
            <textarea id="goal-note" className="textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the agent know?" />
          </Field>
        </Modal>
      )}
    </div>
  );
}
