// #/chat[/<threadId>] — chat with alfred. Threads sidebar, Markdown conversation,
// tool-action chips, a composer (Enter sends, Shift+Enter newline) and the palette deep link
// #/chat?ask=<text> (creates a thread and sends that text once). Replies arrive via chat_message events.
import { useEffect, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { useResource } from '../lib/live.jsx';
import { go, href, useRoute } from '../lib/router.js';
import { timeAgo } from '../lib/format.js';
import { Button, Empty, Icon, Markdown, Menu, useAction, useToast } from '../ui/index.jsx';
import { threadTitle } from './home/model.js';
import './Chat.css';

const msgMatches = (threadId) => (ev) => ev.kind === 'chat_message' && ev.data?.threadId === threadId;

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

function Typing() {
  return (
    <div className="chat-msg agent" data-testid="chat-typing">
      <span className="chat-face"><Icon name="sparkles" size={14} /></span>
      <div className="chat-body">
        <div className="chat-bubble chat-dots"><i /><i /><i /></div>
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
                <span className="xs faint ellipsis" style={{ display: 'block' }}>{t.last || '—'}</span>
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
  const [pending, setPending] = useState(null); // threadId we are waiting on a reply for
  const sendingRef = useRef(false);
  const askedRef = useRef(null);
  const listRef = useRef(null);

  const threads = useResource('/api/chat/threads', { on: ['chat_message'] });
  const convo = useResource(threadId ? `/api/chat/threads/${threadId}` : null, { on: msgMatches(threadId) });

  // Stop "typing" when the reply has landed (or the thread changed).
  useEffect(() => { setPending(null); }, [threadId]);
  useEffect(() => {
    const list = convo.data?.messages;
    if (pending && list?.length && list[list.length - 1].role === 'assistant') setPending(null);
  }, [convo.data, pending]);

  const send = async (raw) => {
    const text = String(raw ?? draft).trim();
    if (!text || sendingRef.current) return;
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
      setPending(id);
      await act(() => post(`/api/chat/threads/${id}/messages`, { text }));
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
  const messages = convo.data?.messages ?? [];
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, pending]);

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
              {!messages.length && pending !== threadId && <Empty icon="chat" title="Say something to alfred." />}
              {pending === threadId && <Typing />}
            </>
          ) : (
            <Empty icon="sparkles" title="New chat">Ask alfred about goals, the board, models — anything. Enter sends.</Empty>
          )}
        </div>
        <div className="chat-composer">
          <textarea
            data-testid="chat-input"
            className="input chat-input"
            rows={1}
            placeholder="Ask alfred anything… (Enter to send, Shift+Enter for a newline)"
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
            aria-label="Send"
            disabled={!draft.trim()}
            onClick={() => void send()}
          />
        </div>
      </section>
    </div>
  );
}
