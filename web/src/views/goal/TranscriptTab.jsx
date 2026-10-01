// Transcript: one task's story as a conversation — turns (Markdown), tool-call chips,
// collapsible tool results, transition separators, workspace/push notes.
import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { clock } from '../../lib/format.js';
import { Empty, Icon, Markdown, Spinner } from '../../ui/index.jsx';
import { callLabel, firstLine } from './model.js';

const NOTE_KINDS = {
  workspace: (d) => `workspace ${d.path ?? ''}${d.node ? ` @ ${d.node}` : ''}`,
  pushed: (d) => `pushed ${d.branch ?? ''} ${(d.sha ?? '').slice(0, 8)}`,
  push_failed: (d) => `push failed: ${d.error ?? ''}`,
  compacted: () => 'context compacted',
  progress: (d) => d.message ?? d.text ?? '',
  approval_requested: (d) => `approval requested: ${d.action ?? ''}`,
  approval_decided: (d) => `approval ${d.decision ?? 'decided'}`,
  verify: (d) => `checks: ${(Array.isArray(d.results) ? d.results : [d]).map((r) => `${r.name ?? 'check'} ${r.ok === false ? '✗' : '✓'}`).join(' · ')}`,
};

function ToolResult({ ev }) {
  const d = ev;
  return (
    <details className="tr-tool">
      <summary>
        <span style={{ color: d.ok === false ? 'var(--bad)' : 'var(--ok)' }}>{d.ok === false ? '✗' : '✓'}</span>{' '}
        {d.name ?? 'tool'} — {firstLine(d.output) || (d.ok === false ? 'failed' : 'ok')}
      </summary>
      <pre className="codeblock wrap">{String(d.output ?? '')}</pre>
    </details>
  );
}

export default function TranscriptTab({ goal, tasks }) {
  // The latest root task: after a retry, that is the attempt you want to read.
  const root = useMemo(() => [...tasks].reverse().find((t) => !t.parentTaskId) ?? tasks[0] ?? null, [tasks]);
  const [taskId, setTaskId] = useState('');
  const picked = taskId && tasks.some((t) => t.id === taskId) ? taskId : root?.id ?? '';

  // Keep the picker honest when the task list arrives/changes after mount.
  useEffect(() => {
    if (root && !taskId) setTaskId(root.id);
  }, [root, taskId]);

  const { data, loading, error } = useResource(picked ? `/api/tasks/${picked}/transcript` : null, {
    on: (ev) => ev.goalId === goal.id,
  });
  const events = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  if (!tasks.length) return <Empty icon="chat" title="This goal has no tasks yet" />;

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="row" style={{ gap: 6 }}>
          <label className="xs faint" htmlFor="transcript-task">task</label>
          <select id="transcript-task" className="select" style={{ width: 'auto', maxWidth: 380 }} value={picked} onChange={(e) => setTaskId(e.target.value)}>
            {tasks.map((t, i) => (
              <option key={t.id} value={t.id}>
                {t.persona} · {t.title.length > 46 ? `${t.title.slice(0, 46)}…` : t.title}
                {t.id === root?.id ? ' (root)' : ''}
                {t.status ? ` — ${t.status}` : ''}
              </option>
            ))}
          </select>
        </span>
        <span className="grow" />
        {loading && <Spinner size={14} />}
        <span className="xs faint">{events.length ? `${events.length} events` : ''}</span>
      </div>

      <div className="card pad" data-testid="transcript" style={{ maxHeight: '68vh', overflow: 'auto' }}>
        {error && <Empty icon="alert" title={`Could not load the transcript: ${error.message}`} />}
        {!error && !loading && events.length === 0 && <Empty icon="chat" title="Nothing said yet" />}
        {events.map((ev, i) => {
          const key = `${ev.id ?? i}`;
          if (ev.kind === 'turn') {
            return (
              <div className="tr-turn" key={key}>
                {ev.turn ? <div className="xs faint">turn {ev.turn} · {clock(ev.ts)}</div> : <div className="xs faint">{clock(ev.ts)}</div>}
                {ev.text ? <div className="md-wrap"><Markdown text={ev.text} /></div> : null}
                {Array.isArray(ev.calls) && ev.calls.length > 0 && (
                  <div className="tr-tools">
                    {ev.calls.map((c, j) => (
                      <span className="tr-call" key={j} title={c?.args ? String(c.args) : undefined}>
                        <Icon name="terminal" size={11} />{callLabel(c)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (ev.kind === 'tool') return <div key={key} style={{ padding: '3px 0' }}><ToolResult ev={ev} /></div>;
          if (ev.kind === 'transition') {
            return (
              <div className="tr-sep" key={key}>
                <span>{ev.from ?? '?'} → {ev.to ?? '?'}{ev.reason ? ` — ${ev.reason}` : ''}</span>
              </div>
            );
          }
          const note = (NOTE_KINDS[ev.kind] ?? (() => ev.kind))(ev);
          if (!note) return null;
          return <div className="tr-note" key={key}>{clock(ev.ts)} · {note}</div>;
        })}
      </div>
    </div>
  );
}
