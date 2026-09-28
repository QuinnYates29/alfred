// #/chat[/<threadId>] — chat with alfred. Threads sidebar, Markdown conversation,
// tool-action chips, a composer (Enter sends, Shift+Enter newline) and the palette deep link
// #/chat?ask=<text> (creates a thread and sends that text once). Replies arrive via chat_message events.
// While a turn runs, a "thinking" bubble shows what alfred is doing. The server's `pending` (GET thread) is the
// truth: chat_progress events and stream reconnects just refetch it, so a reopened page or a restart recovers.
import { useEffect, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { useLiveState, useResource } from '../lib/live.jsx';
import { go, href, useRoute } from '../lib/router.js';
import { timeAgo } from '../lib/format.js';
import { Button, Empty, Icon, Markdown, Menu, useAction, useToast } from '../ui/index.jsx';
import { threadTitle } from './home/model.js';
import './Chat.css';

const msgMatches = (threadId) => (ev) =>
  (ev.kind === 'chat_message' || ev.kind === 'chat_progress') && ev.data?.threadId === threadId;

/** What the thinking bubble says for a server `pending` ({phase, tool?, turn?}); null = just sent. */
export function thinkingLabel(p) {
  if (p?.phase === 'tool' && p.tool) return `using ${p.tool.replace(/_/g, ' ')}…`;
  if (p?.phase === 'thinking' && p.turn > 1) return 'writing reply…';
  return 'thinking…';
}

function ActionChips({ actions }) {
  const [open, setOpen] = useState(null);
  if (!actions?.length) return null;
  return (
    <div className="chat-actions">
      {actions.map((a, i) => (
        <span className="chat-action" key={i}>
          <button
            type="button"
            className={`chip ${a.ok ? 'ok' : 'bad'}`}
            title={a.output || a.args}
            onClick={() => setOpen(open === i ? null : i)}
          >
            <Icon name={a.ok ? 'check' : 'x'} size={11} />
            {a.name}
          </button>
          {open === i && a.output && <pre className="codeblock wrap chat-action-out">{a.output}</pre>}
        </span>
      ))}
    </div>
  );
}

function Message({ m }) {
  const mine = m.role === 'user';
  return (
    <div className={`chat-msg ${mine ? 'me' : 'agent'}`}>
      {!mine && <span className="chat-face"><Icon name="sparkles" size={14} /></span>}
      <div className="chat-body">
        {mine
          ? <div className="chat-bubble">{m.content}</div>
          : <Markdown text={m.content} className="chat-md" />}
        {!mine && <ActionChips actions={m.actions} />}
        <div className="chat-time xs faint">{timeAgo(m.createdAt)}</div>
      </div>
      {mine && <span className="chat-face"><Icon name="user" size={14} /></span>}
    </div>
  );
}

function Typing({ pending }) {
  const label = thinkingLabel(pending);
  return (
    <div className="chat-msg agent chat-thinking" data-testid="chat-typing" data-phase={pending?.phase ?? 'thinking'} role="status" aria-live="polite">
      <span className="chat-face"><Icon name="sparkles" size={14} /></span>
      <div className="chat-body">
        <div className="chat-bubble chat-thinking-bubble">
          <span className="chat-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="chat-thinking-label" data-testid="chat-thinking" key={label}>alfred is {label}</span>
        </div>
      </div>
    </div>
  );
}

function ThreadList({ threads, current, onDelete }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost sm show-mobile chat-threads-toggle" onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'x' : 'chat'} size={14} /> Threads
      </button>
      <aside className={`chat-threads ${open ? 'open' : ''}`}>
        <Button variant="primary" icon="plus" data-testid="new-thread" onClick={() => { setOpen(false); go('/chat'); }}>
          New chat
        </Button>
        <div className="chat-thread-scroll">
          {(threads ?? []).map((t) => (
            <div key={t.id} className={`chat-thread ${t.id === current ? 'on' : ''}`}>
              <a href={href(`/chat/${t.id}`)} onClick={() => setOpen(false)}>
                <span className="ellipsis" style={{ display: 'block' }}>{t.title}</span>
                {/* Preview deliberately shows the time, not the message text: the last
                    message must not be duplicated outside the open conversation. */}
                <span className="xs faint ellipsis" style={{ display: 'block' }}>{timeAgo(t.updatedAt ?? t.createdAt)}</span>
              </a>
              <Menu
                align="right"
                trigger={<span className="btn ghost sm icon" aria-label="Thread menu"><Icon name="more" size={14} /></span>}
                items={[{ label: 'Delete', icon: 'trash', danger: true, onClick: () => onDelete(t) }]}
              />
            </div>
          ))}
          {threads != null && !threads.length && <div className="small faint" style={{ padding: 'var(--s-3)' }}>No chats yet.</div>}
        </div>
      </aside>
    </>
  );
}

export default function Chat({ threadId }) {
  const act = useAction();
  const { confirm } = useToast();
  const { query } = useRoute();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState(null); // D1: local "Started <persona> → <goal>" line
  // Optimistic "thinking" from the moment Enter is pressed until the thread shows the new message.
  const [sent, setSent] = useState(null); // { threadId, count } | null
  const sendingRef = useRef(false);
  const askedRef = useRef(null);
  const listRef = useRef(null);

  const threads = useResource('/api/chat/threads', { on: ['chat_message'] });
  const convo = useResource(threadId ? `/api/chat/threads/${threadId}` : null, { on: msgMatches(threadId) });
  const data = convo.data?.thread?.id === threadId ? convo.data : null;

  // The optimistic state ends once the server has our message (from then on `pending` is the truth).
  useEffect(() => {
    if (sent && data && data.thread.id === sent.threadId && data.messages.length > sent.count) setSent(null);
  }, [data, sent]);

  // After the live stream reconnects (e.g. alfred restarted) refetch: a turn that died is no longer pending.
  const live = useLiveState();
  const wasOpen = useRef(true);
  const reloadRef = useRef(convo.reload);
  reloadRef.current = convo.reload;
  useEffect(() => {
    if (live === 'open' && !wasOpen.current) void reloadRef.current();
    wasOpen.current = live === 'open';
  }, [live]);

  const inflight = data?.pending ?? null;
  const thinking = !!threadId && (sent?.threadId === threadId || !!inflight);

  const send = async (raw) => {
    const text = String(raw ?? draft).trim();
    if (!text || sendingRef.current || (thinking && raw == null)) return;
    // D1 — a message starting with a single `!` dispatches an agent run instead of chatting.
    if (/^!(?!!)/.test(text)) {
      sendingRef.current = true;
      setDraft('');
      try {
        const r = await api('/api/v1/dispatch', { method: 'POST', body: { text } });
        setNotice(r?.goal ? { persona: r.persona ?? 'alfred', id: r.goal.id, title: r.goal.title } : { err: 'dispatch failed' });
      } catch (e) {
        setNotice({ err: e?.message ?? String(e) });
      } finally {
        sendingRef.current = false;
      }
      return;
    }
    sendingRef.current = true;
    setDraft('');
    try {
      let id = threadId;
      if (!id) {
        const t = await act(() => post('/api/chat/threads', { title: threadTitle(text) }));
        if (!t) return;
        id = t.id;
        go(`/chat/${id}`);
      }
      setSent({ threadId: id, count: id === threadId ? (data?.messages.length ?? 0) : 0 });
      const ok = await act(() => post(`/api/chat/threads/${id}/messages`, { text }));
      if (!ok) {
        setSent(null);
        setDraft((d) => d || text); // don't lose what was typed
      }
    } finally {
      sendingRef.current = false;
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // Palette deep link: #/chat?ask=<text> creates a thread and sends that text once.
  useEffect(() => {
    const ask = query.ask;
    if (!ask || askedRef.current === ask) return;
    askedRef.current = ask;
    void sendRef.current(ask);
  }, [query.ask]);

  // Keep the newest message in view.
  const messages = data?.messages ?? [];
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, thinking]);

  const removeThread = async (t) => {
    if (!(await confirm({ title: `Delete "${t.title}"?`, body: 'The whole conversation goes with it.', danger: true, ok: 'Delete' }))) return;
    await act(() => api(`/api/chat/threads/${t.id}`, { method: 'DELETE' }), 'Thread deleted');
    if (t.id === threadId) go('/chat');
  };

  return (
    <div className="page chat-page">
      <ThreadList threads={threads.data} current={threadId} onDelete={removeThread} />
      <section className="chat-main card">
        <div className="chat-scroll" ref={listRef}>
          {threadId ? (
            <>
              {messages.map((m) => <Message m={m} key={m.id} />)}
              {!messages.length && !thinking && <Empty icon="chat" title="Say something to alfred." />}
              {thinking && <Typing pending={inflight} />}
            </>
          ) : (
            <Empty icon="sparkles" title="New chat">Ask alfred about goals, the board, models — anything. Enter sends.</Empty>
          )}
          {notice && (
            <div className="chat-msg agent" data-testid="chat-dispatch-notice">
              <span className="chat-face"><Icon name="zap" size={14} /></span>
              <div className="chat-body">
                <div className="chat-bubble">
                  {notice.err
                    ? `⚠ ${notice.err}`
                    : <>Started {notice.persona} → <a href={href(`/goal/${notice.id}`)}>{notice.title}</a></>}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className={`chat-composer ${thinking ? 'busy' : ''}`} data-testid="chat-composer" aria-busy={thinking}>
          <textarea
            data-testid="chat-input"
            className="input chat-input"
            rows={1}
            placeholder={thinking
              ? 'alfred is replying… (you can type the next message)'
              : 'Ask alfred anything… (Enter to send, Shift+Enter for a newline)'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            variant="primary"
            icon="send"
            data-testid="chat-send"
            aria-label={thinking ? 'alfred is replying' : 'Send'}
            title={thinking ? 'alfred is replying…' : undefined}
            disabled={!draft.trim() || thinking}
            onClick={() => void send()}
          />
        </div>
      </section>
    </div>
  );
}
