// Transcript: one task's story as a conversation — turns (Markdown), tool-call chips,
// collapsible tool results, transition separators, workspace/push notes.
import { useEffect, useMemo, useState } from 'react';
import { useResource } from '../../lib/live.jsx';
import { clock } from '../../lib/format.js';
import { Empty, Icon, Markdown, Spinner } from '../../ui/index.jsx';
import { callGist, firstLine, parseArgs, splitThink } from './model.js';

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

/** The call's input: shell commands as a command line, file writes as path + content, anything else as JSON. */
function CallInput({ name, args }) {
  const a = parseArgs(args);
  if (typeof a === 'string') return <pre className="codeblock wrap">{a}</pre>;
  if (typeof a.cmd === 'string') return <pre className="codeblock wrap tr-cmd"><span className="faint">$ </span>{a.cmd}</pre>;
  if (name === 'write_file' && typeof a.content === 'string') {
    return (
      <>
        <div className="xs mono faint">{a.path}</div>
        <pre className="codeblock wrap">{a.content}</pre>
      </>
    );
  }
  return <pre className="codeblock wrap">{JSON.stringify(a, null, 2)}</pre>;
}

/** One tool call, whole: what went in and what came out. */
function ToolCall({ ev, args }) {
  const failed = ev.ok === false;
  return (
    <details className={`tr-tool${failed ? ' bad' : ''}`}>
      <summary>
        <span className="tr-mark" style={{ color: failed ? 'var(--bad)' : 'var(--ok)' }}>{failed ? '✗' : '✓'}</span>
        <b>{ev.name ?? 'tool'}</b>
        {args != null ? <span className="tr-gist">{callGist(ev.name, args)}</span> : null}
        <span className="tr-out1">→ {firstLine(ev.output) || (failed ? 'failed' : 'ok')}</span>
      </summary>
      {args != null && (
        <div className="tr-io">
          <div className="tr-io-h">in</div>
          <CallInput name={ev.name} args={args} />
        </div>
      )}
      <div className="tr-io">
        <div className="tr-io-h">out</div>
        <pre className="codeblock wrap">{String(ev.output ?? '') || '(no output)'}</pre>
      </div>
    </details>
  );
}

/** A model turn: its thinking (collapsed) and its response (open unless long). */
function Turn({ ev }) {
  const split = splitThink(ev.text);
  const thinking = [ev.thinking, split.thinking].filter(Boolean).join('\n\n');
  const answer = split.answer;
  const u = ev.usage ?? {};
  return (
    <div className="tr-turn">
      <div className="xs faint">
        turn {ev.turn ?? '?'} · {clock(ev.ts)}
        {u.promptTokens ? ` · ${u.promptTokens.toLocaleString()} in / ${(u.completionTokens ?? 0).toLocaleString()} out tokens` : ''}
      </div>
      {thinking && (
        <details className="tr-think">
          <summary>Thinking · {thinking.length.toLocaleString()} chars</summary>
          <div className="md-wrap"><Markdown text={thinking} /></div>
        </details>
      )}
      {answer && (
        <details className="tr-reply" open={answer.length <= 1200}>
          <summary>Response{answer.length > 1200 ? ` · ${answer.length.toLocaleString()} chars` : ''}</summary>
          <div className="md-wrap"><Markdown text={answer} /></div>
        </details>
      )}
      {!thinking && !answer && !(ev.calls ?? []).length && <div className="xs faint">(no text, no tool calls)</div>}
    </div>
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
        {(() => {
          // Tool events carry their own input now; older ones get it from their turn's calls, matched by name.
          let pending = [];
          return events.map((ev, i) => {
            const key = `${ev.id ?? i}`;
            if (ev.kind === 'turn') {
              pending = [...(ev.calls ?? [])];
              return <Turn key={key} ev={ev} />;
            }
            if (ev.kind === 'tool') {
              const j = pending.findIndex((c) => c?.name === ev.name);
              const call = j >= 0 ? pending.splice(j, 1)[0] : null;
              return <ToolCall key={key} ev={ev} args={ev.args ?? call?.args ?? null} />;
            }
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
          });
        })()}
      </div>
    </div>
  );
}
