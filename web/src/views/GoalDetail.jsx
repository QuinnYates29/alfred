// #/goal/<id>[/<tab>] — goal header (status, meta, actions) + Overview / Transcript / Changes / Files.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useResource } from '../lib/live.jsx';
import { go, href } from '../lib/router.js';
import { dateTime, duration } from '../lib/format.js';
import { api, del, patch, post, apiText } from '../api.js';
import { Button, Icon, StatusChip, Tabs, Empty, Spinner, Field, Modal, Seg, useToast, useAction, Markdown } from '../ui/index.jsx';
import { rootTask, stoppable } from './goal/model.js';
import OverviewTab from './goal/OverviewTab.jsx';
import TranscriptTab from './goal/TranscriptTab.jsx';
import ChangesTab from './goal/ChangesTab.jsx';
import FilesTab from './goal/FilesTab.jsx';
import './GoalDetail.css';

const TABS = [['', 'Overview'], ['transcript', 'Transcript'], ['changes', 'Changes'], ['files', 'Files']];

const OUTPUT_EXT = { markdown: 'md', text: 'txt', json: 'json', csv: 'csv', 'html-code': 'html', images: 'json' };

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

/** ALF-7: screenshots from a UI test — a grid of thumbnails; click one to see it full size. */
function ImageGallery({ content }) {
  const [open, setOpen] = useState(null);
  let shots = [];
  try { shots = JSON.parse(content); } catch { /* not a gallery */ }
  shots = Array.isArray(shots) ? shots.filter((s) => typeof s?.src === 'string' && s.src.startsWith('data:image/')) : [];
  if (!shots.length) return <Empty icon="file" title="No screenshots" />;
  return (
    <>
      <div className="output-gallery">
        {shots.map((s, i) => (
          <button key={i} className="output-shot" onClick={() => setOpen(s)} title={s.name}>
            <img src={s.src} alt={s.name} loading="lazy" />
            <span className="xs ellipsis">{s.name}</span>
          </button>
        ))}
      </div>
      {open && (
        <Modal title={open.name} onClose={() => setOpen(null)} footer={<Button onClick={() => setOpen(null)}>Close</Button>}>
          <img src={open.src} alt={open.name} style={{ width: '100%', height: 'auto', display: 'block' }} />
        </Modal>
      )}
    </>
  );
}

function renderOutput(kind, content) {
  if (kind === 'images') return <ImageGallery content={content} />;
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

/** ALF-7 — change where a goal works (repo / node / workspace / peer review) and what its gate checks. */
function EditWhereDialog({ goal, onClose, onSaved }) {
  const { toast } = useToast();
  const [repo, setRepo] = useState(goal.meta?.repo ?? '');
  const [where, setWhere] = useState(goal.meta?.node ?? 'local');
  const [mode, setMode] = useState(goal.meta?.mode ?? 'auto');
  const [peerReview, setPeerReview] = useState(goal.meta?.peerReview === true);
  const self = repo.trim() === 'alfred';
  const [checksMode, setChecksMode] = useState(goal.meta?.repo === 'alfred' && goal.meta?.checks !== 'custom' ? 'auto' : 'custom');
  const [checks, setChecks] = useState(() => (goal.acceptance ?? []).map((c) => ({ ...c })));
  const [checksDirty, setChecksDirty] = useState(false);
  const editCheck = (i, k, v) => { setChecks((cs) => cs.map((c, j) => (j === i ? { ...c, [k]: v } : c))); setChecksDirty(true); };
  const [repos, setRepos] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/ops/repos').then(setRepos).catch(() => {});
    api('/api/nodes').then(setNodes).catch(() => {});
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      const body = { repo: repo.trim() || null, node: where === 'local' ? null : where, mode: mode === 'auto' ? null : mode, peerReview };
      if (checksDirty) body.checks = self && checksMode === 'auto' ? 'auto' : checks.filter((c) => c.name.trim() || c.cmd.trim());
      await patch(`/api/goals/${goal.id}`, body);
      toast('Saved — Retry to run it there', 'ok');
      onSaved();
      onClose();
    } catch (e) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Edit goal"
      onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={save}>Save</Button></>}
    >
      <Field label="Repo" htmlFor="gw-repo" hint="Registered name or absolute path; empty = scratch sandbox. alfred = this platform (isolated clone, reviewed before deploy).">
        <input id="gw-repo" className="input" list="gw-repos" autoFocus value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="e.g. alfred or /home/quinna/code/app" />
        <datalist id="gw-repos">{repos.map((r) => <option key={r.name} value={r.name} />)}</datalist>
      </Field>
      <div className="form-row">
        <Field label="Where" htmlFor="gw-where">
          <select id="gw-where" className="select" value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="local">Spark</option>
            {nodes.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
          </select>
        </Field>
        <Field label="Workspace" hint={repo.trim() === 'alfred' ? 'alfred: sandbox clone only' : undefined}>
          <Seg value={mode} onChange={setMode} options={[['auto', 'Auto'], ['sandbox', 'Sandbox clone'], ['repo', 'Worktree']]} />
        </Field>
      </div>
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={peerReview} onChange={(e) => setPeerReview(e.target.checked)} />
        <span>Peer review by coder-lg when done (an agent deploy needs its approve)</span>
      </label>
      <div className="field" style={{ marginTop: 'var(--s-3)' }}>
        <div className="label">Checks (the gate before done — also used by the next Retry)</div>
        {self && (
          <Seg value={checksMode} onChange={(v) => { setChecksMode(v); setChecksDirty(true); }} options={[['auto', 'Auto (recommended)'], ['custom', 'Custom']]} />
        )}
        {self && checksMode === 'auto' ? (
          <p className="xs muted" style={{ marginTop: 6 }}>
            Tests + typecheck. When the change touches web/, the gate also builds the UI and runs a UI smoke test in a sandboxed
            copy of alfred (every page, desktop + phone), with screenshots on this page. No need to know the checks up front.
          </p>
        ) : (
          <>
            {checks.map((c, i) => (
              <div className="row" key={i} style={{ marginTop: 6 }}>
                <input className="input" style={{ maxWidth: 140 }} aria-label={`check ${i + 1} name`} placeholder="name" value={c.name} onChange={(e) => editCheck(i, 'name', e.target.value)} />
                <input className="input mono" aria-label={`check ${i + 1} command`} placeholder="command, e.g. npm test" value={c.cmd} onChange={(e) => editCheck(i, 'cmd', e.target.value)} />
                <Button variant="ghost" icon="x" aria-label="remove check" onClick={() => { setChecks(checks.filter((_, j) => j !== i)); setChecksDirty(true); }} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon="plus" style={{ marginTop: 6 }} onClick={() => { setChecks([...checks, { name: '', cmd: '' }]); setChecksDirty(true); }}>Add check</Button>
          </>
        )}
      </div>
    </Modal>
  );
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
  const [whereOpen, setWhereOpen] = useState(false);
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
  // ALF-7: the coder-lg review, visible from every tab — running (with its step) or its verdict.
  const lg = (() => {
    const running = data?.peerReviewRunning; // from the server: never stale across a restart
    if (running) return { tone: 'info', text: `LG review: running${running.step ? ` · ${running.step}` : ''}`, running: true };
    let result = null;
    for (const e of data?.events ?? []) if (e.kind === 'peer_review') result = e;
    if (result) return { tone: { approve: 'ok', needs_human: 'warn' }[result.data?.verdict] ?? 'bad', text: `LG review: ${String(result.data?.verdict ?? '?').replace('_', ' ')}` };
    return null;
  })();

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
            <select className="select" aria-label="Set goal status" data-testid="goal-status-set" value="" style={{ width: 'auto', height: 26, padding: '0 6px', fontSize: 'var(--t-xs)' }}
              title="Override the goal's status (stands until one of its tasks changes)"
              onChange={async (e) => {
                const status = e.target.value;
                if (!status) return;
                if (!(await confirm({ title: `Mark this goal ${status}?`, body: 'This overrides the status its tasks gave it, until one of its tasks changes again.', ok: `Mark ${status}` }))) return;
                try { await patch(`/api/goals/${goal.id}`, { status }); toast(`Goal marked ${status}`, 'ok'); reload(); }
                catch (err) { toast(err?.message ?? String(err), 'bad'); }
              }}>
              <option value="">set status…</option>
              {['active', 'done', 'failed'].filter((s) => s !== goal.status).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
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
            {lg ? (
              <a className={`chip ${lg.tone}`} href={href(`/goal/${goal.id}/changes`)} data-testid="lg-review-chip" title="coder-lg peer review — details on Changes and in Outputs">
                {lg.running ? <Spinner size={11} /> : null}{lg.text}
              </a>
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
          <Button icon="git" variant="ghost" data-testid="goal-where" title="Change the repo / machine / workspace this goal works in"
            disabled={tasks.some((t) => t.status === 'running' || t.status === 'verifying')}
            onClick={() => setWhereOpen(true)}>
            Edit goal
          </Button>
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

      {whereOpen && <EditWhereDialog goal={goal} onClose={() => setWhereOpen(false)} onSaved={reload} />}

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
