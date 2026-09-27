// P16 chat — data layer. Own tables in the shared SQLite file via store.raw().
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatAction {
  name: string;
  args: string;
  ok: boolean;
  /** ≤ 300 chars of tool output. */
  output: string;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Tool calls the assistant made while producing this message. */
  actions: ChatAction[];
  createdAt: number;
}

export const NEW_CHAT_TITLE = 'New chat';

export interface ChatStore {
  createThread(title?: string): Thread;
  getThread(id: string): Thread | undefined;
  listThreads(): Thread[];
  setThreadTitle(id: string, title: string): void;
  addMessage(o: { threadId: string; role: 'user' | 'assistant'; content: string; actions?: ChatAction[] }): ChatMessage;
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

  // Monotonic ids: messages created in the same millisecond must still order correctly.
  let seq = 0;
  const nextId = (p: string) => `${p}_${(++seq).toString().padStart(9, '0')}_${randomUUID()}`;
  const now = () => Date.now();
  const ev = (threadId: string, message: ChatMessage) =>
    store.appendEvent('', null, 'chat_message', { threadId, message });

  const rowToThread = (r: any): Thread => ({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt });
  const rowToMessage = (r: any): ChatMessage => ({
    id: r.id, threadId: r.threadId, role: r.role, content: r.content,
    actions: JSON.parse(r.actions || '[]'), createdAt: r.createdAt,
  });

  function createThread(title?: string): Thread {
    const t = now();
    const thread: Thread = { id: nextId('thr'), title: (title && title.trim()) || NEW_CHAT_TITLE, createdAt: t, updatedAt: t };
    db.prepare('INSERT INTO chat_threads (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)')
      .run(thread.id, thread.title, thread.createdAt, thread.updatedAt);
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

  return { createThread, getThread, listThreads, setThreadTitle, addMessage, messages, lastMessage, deleteThread };
}
