// P16 chat — data layer. Own tables in the shared SQLite file via store.raw().
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Private: local model only, no tools, nothing recorded to the dataset. */
  private: boolean;
}

export interface ChatAction {
  name: string;
  args: string;
  ok: boolean;
  /** ≤ 300 chars of tool output. */
  output: string;
}

export interface ChatFeedback {
  note?: string;
  correction?: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls the assistant made while producing this message. */
  actions: ChatAction[];
  createdAt: number;
  /** Quinn's rating of this reply (dataset feedback); null/absent = unrated. */
  rating?: 'up' | 'down' | null;
  /** The 👎 form ({ note, correction }) that came with the rating. */
  feedback?: ChatFeedback | null;
}

export const NEW_CHAT_TITLE = 'New chat';

export interface ChatStore {
  createThread(title?: string, o?: { private?: boolean }): Thread;
  getThread(id: string): Thread | undefined;
  listThreads(): Thread[];
  setThreadTitle(id: string, title: string): void;
  setThreadPrivate(id: string, priv: boolean): Thread | undefined;
  addMessage(o: { threadId: string; role: 'user' | 'assistant'; content: string; actions?: ChatAction[] }): ChatMessage;
  getMessage(id: string): ChatMessage | undefined;
  /** Store/clear Quinn's rating on a message (null clears both columns). */
  setMessageFeedback(id: string, rating: 'up' | 'down' | null, feedback?: ChatFeedback | null): ChatMessage | undefined;
  messages(threadId: string, opts?: { limit?: number }): ChatMessage[];
  lastMessage(threadId: string): ChatMessage | undefined;
  deleteThread(id: string): boolean;
}

export function openChatStore(store: Store): ChatStore {
  const db = store.raw();
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, threadId TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
      actions TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(threadId);
  `);

  // Migration-safe additions (older DBs predate these columns), same guarded style as store.ts.
  const threadCols = db.prepare(`PRAGMA table_info(chat_threads)`).all() as { name: string }[];
  if (!threadCols.some((c) => c.name === 'private')) {
    db.exec(`ALTER TABLE chat_threads ADD COLUMN private INTEGER NOT NULL DEFAULT 0`);
  }
  const msgCols = db.prepare(`PRAGMA table_info(chat_messages)`).all() as { name: string }[];
  if (!msgCols.some((c) => c.name === 'rating')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN rating TEXT`);
  }
  if (!msgCols.some((c) => c.name === 'feedback')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN feedback TEXT`);
  }

  // Monotonic ids: messages created in the same millisecond must still order correctly.
  let seq = 0;
  const nextId = (p: string) => `${p}_${(++seq).toString().padStart(9, '0')}_${randomUUID()}`;
  const now = () => Date.now();
  // A private thread's content never enters the event log / SSE stream / plugins / Mac notifications:
  // its event carries ids only (the dashboard just refetches the thread).
  const ev = (threadId: string, message: ChatMessage) => {
    const priv = !!(db.prepare('SELECT private FROM chat_threads WHERE id = ?').get(threadId) as any)?.private;
    store.appendEvent('', null, 'chat_message', priv
      ? { threadId, private: true, message: { id: message.id, threadId, role: message.role, createdAt: message.createdAt } }
      : { threadId, message });
  };

  const rowToThread = (r: any): Thread => ({
    id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, private: !!r.private,
  });
  const rowToMessage = (r: any): ChatMessage => ({
    id: r.id, threadId: r.threadId, role: r.role, content: r.content,
    actions: JSON.parse(r.actions || '[]'), createdAt: r.createdAt,
    rating: (r.rating as 'up' | 'down' | null) ?? null,
    feedback: r.feedback ? JSON.parse(r.feedback) : null,
  });

  function createThread(title?: string, o: { private?: boolean } = {}): Thread {
    const t = now();
    const thread: Thread = {
      id: nextId('thr'), title: (title && title.trim()) || NEW_CHAT_TITLE,
      createdAt: t, updatedAt: t, private: o.private === true,
    };
    db.prepare('INSERT INTO chat_threads (id, title, createdAt, updatedAt, private) VALUES (?, ?, ?, ?, ?)')
      .run(thread.id, thread.title, thread.createdAt, thread.updatedAt, thread.private ? 1 : 0);
    return thread;
  }

  function getThread(id: string): Thread | undefined {
    const r = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
    return r ? rowToThread(r) : undefined;
  }

  function listThreads(): Thread[] {
    return (db.prepare('SELECT * FROM chat_threads ORDER BY updatedAt DESC, id').all() as any[]).map(rowToThread);
  }

  function setThreadTitle(id: string, title: string): void {
    db.prepare('UPDATE chat_threads SET title = ?, updatedAt = ? WHERE id = ?').run(title, now(), id);
  }

  function setThreadPrivate(id: string, priv: boolean): Thread | undefined {
    if (!getThread(id)) return undefined;
    db.prepare('UPDATE chat_threads SET private = ? WHERE id = ?').run(priv ? 1 : 0, id);
    return getThread(id);
  }

  function addMessage(o: { threadId: string; role: 'user' | 'assistant'; content: string; actions?: ChatAction[] }): ChatMessage {
    const t = now();
    const message: ChatMessage = {
      id: nextId('msg'), threadId: o.threadId, role: o.role, content: o.content,
      actions: o.actions ?? [], createdAt: t,
    };
    db.prepare('INSERT INTO chat_messages (id, threadId, role, content, actions, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.threadId, message.role, message.content, JSON.stringify(message.actions), t);
    const thread = getThread(o.threadId);
    if (thread && message.role === 'user' && thread.title === NEW_CHAT_TITLE) {
      setThreadTitle(o.threadId, message.content.slice(0, 60));
    } else {
      db.prepare('UPDATE chat_threads SET updatedAt = ? WHERE id = ?').run(t, o.threadId);
    }
    ev(o.threadId, message);
    return message;
  }

  function getMessage(id: string): ChatMessage | undefined {
    const r = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id);
    return r ? rowToMessage(r) : undefined;
  }

  function setMessageFeedback(
    id: string,
    rating: 'up' | 'down' | null,
    feedback?: ChatFeedback | null,
  ): ChatMessage | undefined {
    const m = getMessage(id);
    if (!m) return undefined;
    const fb = rating && feedback && (feedback.note || feedback.correction)
      ? JSON.stringify({ ...(feedback.note ? { note: feedback.note } : {}), ...(feedback.correction ? { correction: feedback.correction } : {}) })
      : null;
    db.prepare('UPDATE chat_messages SET rating = ?, feedback = ? WHERE id = ?').run(rating, fb, id);
    return getMessage(id);
  }

  function messages(threadId: string, opts: { limit?: number } = {}): ChatMessage[] {
    const rows = db.prepare('SELECT * FROM chat_messages WHERE threadId = ? ORDER BY createdAt ASC, id ASC').all(threadId) as any[];
    const all = rows.map(rowToMessage);
    return opts.limit && all.length > opts.limit ? all.slice(all.length - opts.limit) : all;
  }

  function lastMessage(threadId: string): ChatMessage | undefined {
    const r = db.prepare('SELECT * FROM chat_messages WHERE threadId = ? ORDER BY createdAt DESC, id DESC LIMIT 1').get(threadId);
    return r ? rowToMessage(r) : undefined;
  }

  function deleteThread(id: string): boolean {
    if (!getThread(id)) return false;
    db.prepare('DELETE FROM chat_messages WHERE threadId = ?').run(id);
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
    return true;
  }

  return {
    createThread, getThread, listThreads, setThreadTitle, setThreadPrivate, addMessage,
    getMessage, setMessageFeedback, messages, lastMessage, deleteThread,
  };
}
