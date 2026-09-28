// P20 — mapping from Slack thread keys (`slack:<channel>:<ts>` / `slack:<user_id>`)
// to chat module thread ids, stored in the module's own table.
import type { Store } from '../store.js';

export interface ChatLike {
  createThread(title?: string): { id: string };
  getThread(id: string): unknown;
}

export function openThreadMap(store: Store, chat: () => ChatLike | undefined) {
  const db = store.raw();
  db.prepare(
    `CREATE TABLE IF NOT EXISTS slack_threads (key TEXT PRIMARY KEY, threadId TEXT)`,
  ).run();

  const getStmt = db.prepare(`SELECT threadId FROM slack_threads WHERE key = ?`);
  const putStmt = db.prepare(
    `INSERT INTO slack_threads (key, threadId) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET threadId = excluded.threadId`,
  );

  /** Resolve (creating on first use) the chat thread for a Slack thread key. */
  function resolve(key: string): string {
    const c = chat();
    if (!c) throw new Error('chat is not available');
    const row = getStmt.get(key) as { threadId: string } | undefined;
    if (row && c.getThread(row.threadId)) return row.threadId;
    const t = c.createThread(`Slack: ${key}`);
    putStmt.run(key, t.id);
    return t.id;
  }

  /** Start a fresh chat thread for this key ("new chat" in a DM). */
  function reset(key: string): string {
    const c = chat();
    if (!c) throw new Error('chat is not available');
    const t = c.createThread(`Slack: ${key}`);
    putStmt.run(key, t.id);
    return t.id;
  }

  return { resolve, reset };
}
