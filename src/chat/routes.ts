// P16 §5 — HTTP surface for chat. Mounted under /api/v1 and /api behind the token.
import express, { type Router, type Request, type Response } from 'express';
import type { ChatEngine } from './engine.js';
import { ChatBusyError } from './engine.js';
import type { ChatStore } from './store.js';
import { datasetDir, purgeThread, readRecords, recordFeedback, stats, type DatasetKind } from './dataset.js';

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const SOURCES = ['dashboard', 'slack', 'cli', 'mac', 'api'] as const;
type Source = (typeof SOURCES)[number];
const sourceOf = (v: unknown): Source => (SOURCES.includes(v as Source) ? (v as Source) : 'api');

function fail(res: Response, e: any): void {
  if (e instanceof ChatBusyError) return void res.status(409).json({ error: e.message });
  const msg = e?.message ?? String(e);
  if (/no such thread/i.test(msg)) return void res.status(404).json({ error: msg });
  res.status(400).json({ error: msg });
}

export function chatRouter(engine: ChatEngine, cs: ChatStore, env: Record<string, string | undefined> = process.env): Router {
  const r = express.Router();
  const body = (req: Request): any => (req.body && typeof req.body === 'object' ? req.body : {});
  const text = (req: Request): string => String(body(req).text ?? '').trim();
  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => { fn(req, res).catch((e) => fail(res, e)); };

  r.get('/chat/threads', (_req, res) => {
    res.json(cs.listThreads().map((t) => {
      const last = cs.lastMessage(t.id);
      return { ...t, last: t.private ? '' : cap(last?.content ?? '', 120) };
    }));
  });

  r.post('/chat/threads', (req, res) => {
    res.status(201).json(engine.createThread(body(req).title, { private: body(req).private === true }));
  });

  r.get('/chat/threads/:id', (req, res) => {
    const thread = engine.getThread(req.params.id);
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    res.json({ thread, messages: cs.messages(thread.id), pending: engine.pending(thread.id) ?? null });
  });

  r.patch('/chat/threads/:id', (req, res) => {
    const thread = engine.getThread(req.params.id);
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    if (typeof body(req).private !== 'boolean') return void res.status(400).json({ error: 'private (boolean) is required' });
    const updated = cs.setThreadPrivate(thread.id, body(req).private);
    // Switching ON with purge:true also drops everything this thread already wrote to the dataset.
    if (body(req).private === true && body(req).purge === true) purgeThread(env, thread.id);
    res.json(updated);
  });

  r.delete('/chat/threads/:id', (req, res) => {
    if (!cs.deleteThread(req.params.id)) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    res.json({ ok: true });
  });

  r.post('/chat/threads/:id/messages', async_(async (req, res) => {
    const t = text(req);
    if (!t) return void res.status(400).json({ error: 'text is required' });
    const thread = engine.getThread(String(req.params.id));
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    if (engine.busy(thread.id)) {
      return void res.status(409).json({ error: `chat thread is busy: ${thread.id}` });
    }
    const o = { source: 'dashboard' as Source };
    if (body(req).wait === true) {
      res.json({ reply: await engine.send(thread.id, t, o) });
    } else {
      void engine.send(thread.id, t, o).catch(() => {});
      res.status(202).json({ accepted: true });
    }
  }));

  r.post('/chat', async_(async (req, res) => {
    const t = text(req);
    if (!t) return void res.status(400).json({ error: 'text is required' });
    let threadId = body(req).threadId ? String(body(req).threadId) : undefined;
    if (threadId && !engine.getThread(threadId)) {
      return void res.status(404).json({ error: `no such thread: ${threadId}` });
    }
    if (!threadId) threadId = engine.createThread(undefined, { private: body(req).private === true }).id;
    if (engine.busy(threadId)) {
      return void res.status(409).json({ error: `chat thread is busy: ${threadId}` });
    }
    const reply = await engine.send(threadId, t, { source: sourceOf(body(req).source) });
    res.json({ threadId, reply });
  }));

  // 👍 / 👎 on one assistant reply — stored on the message, appended to the dataset
  // (never for private threads). rating null clears it.
  r.post('/chat/threads/:id/messages/:mid/feedback', (req, res) => {
    const thread = engine.getThread(String(req.params.id));
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    const message = cs.getMessage(String(req.params.mid));
    if (!message || message.threadId !== thread.id) {
      return void res.status(404).json({ error: `no such message: ${req.params.mid}` });
    }
    const rating = body(req).rating;
    if (rating !== 'up' && rating !== 'down' && rating !== null) {
      return void res.status(400).json({ error: "rating must be 'up', 'down' or null" });
    }
    const note = body(req).note != null ? cap(String(body(req).note), 2000) : undefined;
    const correction = body(req).correction != null ? cap(String(body(req).correction), 20_000) : undefined;
    const updated = cs.setMessageFeedback(message.id, rating, rating ? { note, correction } : null);
    if (!thread.private) {
      recordFeedback(env, {
        threadId: thread.id,
        messageId: message.id,
        rating,
        ...(note ? { note } : {}),
        ...(correction ? { correction } : {}),
      });
    }
    res.json({ ok: true, message: updated });
  });

  r.get('/chat/dataset/stats', (_req, res) => {
    res.json({ ...stats(env), dir: datasetDir(env) ?? '' });
  });

  r.get('/chat/dataset/export', (req, res) => {
    const kind = String(req.query.kind ?? 'chat') as DatasetKind;
    if (!['chat', 'feedback', 'goals'].includes(kind)) return void res.status(400).json({ error: `unknown kind: ${kind}` });
    const since = Number(req.query.since);
    const recs = readRecords(env, kind, Number.isFinite(since) ? { since } : {});
    res.type('application/x-ndjson');
    res.send(recs.length ? `${recs.map((x) => JSON.stringify(x)).join('\n')}\n` : '');
  });

  return r;
}
