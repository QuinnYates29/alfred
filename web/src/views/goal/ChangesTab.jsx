// Changes: the goal's pushed branches, commits, files with +/−, a per-file diff viewer,
// Merge (strategy/target/delete-branch) and Discard.
import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { useRoute, setQuery } from '../../lib/router.js';
import { post } from '../../api.js';
import { timeAgo } from '../../lib/format.js';
import { Button, Empty, Field, Icon, Modal, Spinner, useAction, useToast } from '../../ui/index.jsx';
import { diffLines } from './model.js';

const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type' };

function DiffView({ diff }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  if (!lines.length) return <Empty icon="git" title="No diff for this file" />;
  return (
    <div className="diff" role="region" aria-label="diff">
      {lines.map((l, i) => <span key={i} className={`ln ${l.cls}`}>{l.text || ' '}</span>)}
    </div>
  );
}

function MergeDialog({ goalId, branch, branches, base, head, baseSha, repo, onClose }) {
  const [strategy, setStrategy] = useState('merge');
  const [into, setInto] = useState(base ?? 'main');
  const [delBranch, setDelBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState(null);
  const [result, setResult] = useState(null); // ALF-7: what Merge & update did, step by step
  const { toast } = useToast();
  // Goals on alfred can go live in one click: merge, update the live checkout, rebuild, restart as needed.
  const updatable = repo === 'alfred';
  const targets = [...new Set([base, 'main', 'master', ...branches].filter(Boolean))];

  const run = async (update = false) => {
    setBusy(true);
    setConflicts(null);
    setResult(null);
    try {
      // Merge exactly the commit shown here; onto the base it was diffed against (else the server refuses).
      const pin = { ...(head ? { sha: head } : {}), ...(baseSha && into === base ? { baseSha } : {}) };
      if (update) {
        const r = await post(`/api/goals/${goalId}/deploy`, { confirm: true, strategy, deleteBranch: delBranch, ...pin });
        setResult({ ok: true, text: r.output ?? 'done' });
        toast('Merged and live', 'ok');
        return;
      }
      const r = await post(`/api/goals/${goalId}/merge`, { confirm: true, branch, into, strategy, deleteBranch: delBranch, ...pin });
      if (r.localUpdated === false) {
        // Landed in the hub (and kept on the Spark), but what's running didn't move: say so, don't hide it.
        setResult({ ok: false, text: `Merged into ${r.into ?? into} (${String(r.sha ?? '').slice(0, 8)}) in the hub, but the live checkout was not updated: ${r.localNote ?? 'unknown reason'}` });
        toast('Merged — not live yet', 'warn');
        return;
      }
      toast(`Merged into ${r.into ?? into} (${String(r.sha ?? '').slice(0, 8)})${updatable ? ' — Merge & update makes it live' : ''}`, 'ok');
      onClose(true);
    } catch (e) {
      if (update && e?.data?.error) {
        setResult({ ok: false, text: String(e.data.error) });
        return;
      }
      if (e?.status === 409 && Array.isArray(e.data?.conflicts) && e.data.conflicts.length) setConflicts(e.data.conflicts);
      else if (e?.status === 409) setConflicts(['(no file list from the server)']);
      else toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Merge ${branch}`}
      onClose={() => onClose(false)}
      footer={<>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant={updatable ? undefined : 'primary'} icon="merge" disabled={busy} onClick={() => run(false)}>{busy ? 'Working…' : 'Merge'}</Button>
        {updatable && (
          <Button variant="primary" icon="merge" data-testid="merge-update-btn" disabled={busy} onClick={() => run(true)}
            title="Merge, update the live checkout, rebuild the web UI (and the Mac app if needed), restart alfred if server code changed">
            {busy ? 'Working…' : 'Merge & update'}
          </Button>
        )}
      </>}
    >
      <div className="form">
        <Field label="Strategy" htmlFor="merge-strategy">
          <div className="seg" role="group" id="merge-strategy">
            {[['merge', 'Merge commit'], ['squash', 'Squash']].map(([v, label]) => (
              <button key={v} type="button" className={strategy === v ? 'on' : ''} aria-pressed={strategy === v} onClick={() => setStrategy(v)}>
                {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Into branch" htmlFor="merge-into">
          <select id="merge-into" className="select" value={into} onChange={(e) => setInto(e.target.value)}>
            {targets.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={delBranch} onChange={(e) => setDelBranch(e.target.checked)} />
          Delete <span className="mono">{branch}</span> after merging
        </label>
        {result && (
          <div className={`card pad ${result.ok ? '' : 'amber'}`} role="status" data-testid="merge-result">
            <strong className="small">{result.ok ? 'Merged and live' : 'Not live yet'}</strong>
            <pre className="codeblock wrap" style={{ margin: '6px 0 0' }}>{result.text}</pre>
          </div>
        )}
        {conflicts && (
          <div className="conflicts" role="alert">
            <strong className="small">Merge conflict</strong>
            <p className="xs muted">Resolve these files on the branch, then merge again:</p>
            <ul>{conflicts.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function ChangesTab({ id }) {
  const { query } = useRoute();
  const [merging, setMerging] = useState(false);
  const act = useAction();
  const { confirm, toast } = useToast();
  const { data, loading, error, reload } = useResource(`/api/goals/${id}/changes`, { on: (ev) => ev.goalId === id });

  const files = data?.files ?? [];
  const branch = data?.branches?.[0]?.branch ?? null;
  const sel = query.file && files.some((f) => f.path === query.file) ? query.file : files[0]?.path ?? '';

  const one = useResource(sel ? `/api/goals/${id}/changes?file=${encodeURIComponent(sel)}` : null, {
    on: (ev) => ev.goalId === id,
  });

  useEffect(() => {
    if (query.file && files.length && !files.some((f) => f.path === query.file)) setQuery({ file: '' });
  }, [query.file, files]);

  const discard = () =>
    act(async () => {
      if (!(await confirm({ title: 'Discard these changes?', body: `Deletes ${branch} in the hub. This cannot be undone.`, danger: true, ok: 'Discard' }))) return;
      const r = await post(`/api/goals/${id}/discard`, { confirm: true, branch });
      toast(r?.ok === false ? 'Nothing to discard' : 'Branch discarded', 'ok');
      reload();
    }, null);

  // ALF-7: undo the latest landed merge (a revert commit; on alfred itself also rebuild + restart).
  const landed = data?.landed ?? null;
  const rollback = () =>
    act(async () => {
      const self = data?.repo === 'alfred';
      if (!(await confirm({
        title: 'Roll back this merge?',
        body: `Reverts ${String(landed.sha).slice(0, 8)} on ${landed.into} with a new commit (history is kept, so this can be undone too).${self ? ' alfred is rebuilt and restarted as needed.' : ''}`,
        danger: true,
        ok: 'Roll back',
      }))) return;
      const r = await post(`/api/goals/${id}/rollback`, { confirm: true });
      toast(r?.output ? String(r.output).split('\n').pop() : 'Rolled back', 'ok');
      reload();
    }, null);
  // ALF-7: coder-lg's peer review of the branch head (read-only, deterministic verdict).
  const pr = data?.peerReview ?? null;
  const prStale = pr && data?.branches?.[0]?.sha && pr.sha !== data.branches[0].sha;
  const PR_TONE = { approve: 'ok', changes_requested: 'bad', needs_human: 'warn', error: 'bad' };
  const prRunning = data?.peerReviewRunning ?? null;
  const reviewChip = prRunning ? (
    <span className="chip info" title={`coder-lg is reviewing ${String(prRunning.sha).slice(0, 8)}`}>
      <Spinner size={11} /> LG review: running{prRunning.step ? ` · ${prRunning.step}` : ''}
    </span>
  ) : pr ? (
    <span className={`chip ${prStale ? '' : PR_TONE[pr.verdict] ?? ''}`} title={`coder-lg review of ${String(pr.sha).slice(0, 8)}${prStale ? ' (older commit)' : ''} — details in Outputs`}>
      LG review: {String(pr.verdict).replace('_', ' ')}{prStale ? ' (older commit)' : ''}
    </span>
  ) : null;
  const peerReview = () =>
    act(async () => {
      await post(`/api/goals/${id}/peer-review`, { confirm: true });
      toast('coder-lg is reviewing — the verdict appears here and in Outputs', 'ok');
    }, null);

  const rollbackBtn = landed ? (
    <Button variant="danger" size="sm" icon="retry" data-testid="rollback-btn" onClick={rollback} title={`Revert merge ${String(landed.sha).slice(0, 8)} on ${landed.into}`}>
      Roll back
    </Button>
  ) : null;

  if (loading && !data) {
    return <div className="row"><Spinner /> <span className="muted">Loading changes…</span></div>;
  }
  if (error) return <Empty icon="alert" title={`Could not load changes: ${error.message}`} />;
  if (!branch) {
    return landed ? (
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="chip" title="landed">merged {String(landed.sha).slice(0, 7)} into {landed.into}</span>
        <span className="grow" />
        {rollbackBtn}
      </div>
    ) : <Empty icon="git" title="No code changes pushed" />;
  }

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="chip accent" title="branch"><Icon name="git" size={12} />{branch}</span>
        {data.base ? <span className="chip" title="base">base {data.base}</span> : null}
        {data.repo ? <span className="chip" title="repo">{data.repo}</span> : null}
        <span className="grow" />
        {reviewChip}
        <Button size="sm" variant="ghost" data-testid="peer-review-btn" onClick={peerReview} disabled={!!prRunning} title="Have coder-lg review this branch (read-only)">{prRunning ? 'Reviewing…' : 'LG review'}</Button>
        {rollbackBtn}
        <Button variant="danger" size="sm" data-testid="discard-btn" onClick={discard}>Discard</Button>
        <Button variant="primary" size="sm" icon="merge" data-testid="merge-btn" onClick={() => setMerging(true)}>Merge</Button>
      </div>

      <div className="changes-grid">
        <div className="stack" style={{ gap: 'var(--s-3)' }}>
          <div className="card">
            <div className="card-head"><h3>Files</h3><span className="chip">{files.length}</span></div>
            {files.length === 0 ? <Empty icon="file" title="No files changed" /> : files.map((f) => (
              <button key={f.path} className={`file-row ${f.path === sel ? 'sel' : ''}`} onClick={() => setQuery({ file: f.path })} title={`${f.path} — ${STATUS_LABEL[f.status] ?? f.status}`}>
                <span className="path grow">{f.path}</span>
                <span className="plus xs">{f.additions ? `+${f.additions}` : ''}</span>
                <span className="minus xs">{f.deletions ? `−${f.deletions}` : ''}</span>
              </button>
            ))}
          </div>
          {(data.commits ?? []).length > 0 && (
            <div className="card pad">
              <h3 style={{ marginBottom: 6 }}>Commits</h3>
              {data.commits.map((c) => (
                <div className="commit-row" key={c.sha}>
                  <span className="key">{String(c.sha).slice(0, 7)}</span>
                  <span className="grow ellipsis">{c.subject}</span>
                  <span className="xs faint" title={c.author}>{timeAgo(Date.parse(c.date))}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="stack tight">
          <div className="row between">
            <span className="mono small ellipsis">{sel}</span>
            {one.loading && <Spinner size={14} />}
          </div>
          {one.error
            ? <Empty icon="alert" title={one.error.message} />
            : <DiffView diff={one.data?.diff ?? ''} />}
          {data.truncated ? <div className="xs faint">diff truncated — open the branch to see the rest</div> : null}
        </div>
      </div>

      {merging && (
        <MergeDialog goalId={id} branch={branch} branches={(data.branches ?? []).map((b) => b.branch)} base={data.base} head={data.head} baseSha={data.baseSha} repo={data.repo} onClose={() => setMerging(false)} />
      )}
    </div>
  );
}
