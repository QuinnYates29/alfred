// P16 §5 — HTTP surface for chat. Mounted under /api/v1 and /api behind the token.
import express, { type Router, type Request, type Response } from 'express';
import type { ChatEngine } from './engine.js';
import { ChatBusyError } from './engine.js';
import type { ChatStore } from './store.js';

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function fail(res: Response, e: any): void {
  if (e instanceof ChatBusyError) return void res.status(409).json({ error: e.message });
  const msg = e?.message ?? String(e);
  if (/no such thread/i.test(msg)) return void res.status(404).json({ error: msg });
  res.status(400).json({ error: msg });
}

export function chatRouter(engine: ChatEngine, cs: ChatStore): Router {
  const r = express.Router();
  const body = (req: Request): any => (req.body && typeof req.body === 'object' ? req.body : {});
  const text = (req: Request): string => String(body(req).text ?? '').trim();
  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response) => { fn(req, res).catch((e) => fail(res, e)); };

  r.get('/chat/threads', (_req, res) => {
    res.json(cs.listThreads().map((t) => {
      const last = cs.lastMessage(t.id);
      return { ...t, last: last ? cap(last.content, 120) : '' };
    }));
  });

  r.post('/chat/threads', (req, res) => {
    res.status(201).json(engine.createThread(body(req).title));
  });

  r.get('/chat/threads/:id', (req, res) => {
    const thread = engine.getThread(req.params.id);
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    res.json({ thread, messages: cs.messages(thread.id) });
  });

  r.delete('/chat/threads/:id', (req, res) => {
    if (!cs.deleteThread(req.params.id)) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    res.json({ ok: true });
  });

  r.post('/chat/threads/:id/messages', async_(async (req, res) => {
    const t = text(req);
    if (!t) return void res.status(400).json({ error: 'text is required' });
    const thread = engine.getThread(req.params.id);
    if (!thread) return void res.status(404).json({ error: `no such thread: ${req.params.id}` });
    if (engine.busy(thread.id)) {
      return void res.status(409).json({ error: `chat thread is busy: ${thread.id}` });
    }
    if (body(req).wait === true) {
      res.json({ reply: await engine.send(thread.id, t) });
    } else {
      void engine.send(thread.id, t).catch(() => {});
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
    if (!threadId) threadId = engine.createThread().id;
    if (engine.busy(threadId)) {
      return void res.status(409).json({ error: `chat thread is busy: ${threadId}` });
    }
    const reply = await engine.send(threadId, t);
    res.json({ threadId, reply });
  }));

  return r;
}
