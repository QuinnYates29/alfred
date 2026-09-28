// Chat thinking indicator (chat_progress events + pending) and restart-interrupted replies.
import { describe, it, expect, afterEach } from 'vitest';
import { openStore, type Store } from '../../src/store.js';
import { createApp } from '../../src/server/app.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { scriptedLLM, call as tc } from '../../src/runtime/testing.js';
import type { LLM } from '../../src/runtime/contract.js';
import type { ModuleDeps } from '../../src/modules.js';
import { createChatModule } from '../../src/chat/index.js';
import { INTERRUPTED_REPLY, INTERRUPTED_WINDOW_MS } from '../../src/chat/engine.js';

let store: Store;
let srv: any;

function boot(llm?: LLM, s?: Store) {
  store = s ?? openStore(':memory:');
  const deps: ModuleDeps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: '/tmp/w',
    nodes: {} as any, repoHub: {} as any, deckState: { url: null }, extra: llm ? { llm } : {}, modules: {},
    personas: new Map(),
  };
  const mod: any = createChatModule(deps);
  return { mod, engine: mod.chat, deps };
}
afterEach(() => srv?.close());

const progress = (threadId?: string) =>
  store.allEvents().filter((e) => e.kind === 'chat_progress' && (!threadId || e.data.threadId === threadId)).map((e) => e.data);
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe('chat_progress', () => {
  it('emits thinking, tool and done for a turn with a tool call', async () => {
    const { engine } = boot(scriptedLLM([{ toolCalls: [tc('goals', { op: 'list' })] }, { content: 'no goals' }]));
    const t = engine.createThread();
    const reply = await engine.send(t.id, 'what is running?');
    expect(reply.content).toBe('no goals');
    expect(progress(t.id)).toEqual([
      { threadId: t.id, phase: 'thinking', turn: 1 },
      { threadId: t.id, phase: 'tool', tool: 'goals', turn: 1 },
      { threadId: t.id, phase: 'thinking', turn: 2 },
      { threadId: t.id, phase: 'done' },
    ]);
    // the terminal phase comes after the stored reply
    const kinds = store.allEvents().map((e) => e.kind);
    expect(kinds.lastIndexOf('chat_message')).toBeLessThan(kinds.lastIndexOf('chat_progress'));
    expect(engine.pending(t.id)).toBeUndefined();
  });

  it('ends with error and a readable assistant message when the LLM throws', async () => {
    const { engine } = boot({ async chat() { throw new Error('model server down\n    at fetch (x.js:1:1)'); } });
    const t = engine.createThread();
    const reply = await engine.send(t.id, 'hi');
    expect(reply.role).toBe('assistant');
    expect(reply.content).toMatch(/^⚠ .*model server down/);
    expect(reply.content).not.toContain('at fetch');
    expect(progress(t.id).map((p) => p.phase)).toEqual(['thinking', 'error']);
  });

  it('ends with error when building the turn throws (no LLM configured)', async () => {
    const { engine } = boot(undefined);
    const t = engine.createThread();
    const reply = await engine.send(t.id, 'hi');
    expect(reply.content).toContain('no LLM configured');
    expect(progress(t.id).at(-1)).toEqual({ threadId: t.id, phase: 'error' });
    expect(engine.busy(t.id)).toBe(false);
  });

  it('GET /chat/threads/:id reports pending while a turn is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { mod, engine } = boot(scriptedLLM([
      { toolCalls: [tc('goals', { op: 'list' })] },
      async () => { await gate; return { content: 'done' }; },
    ]));
    const app = createApp({ store, routers: [mod.router] });
    srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/api/v1`;
    const t = engine.createThread();
    const idle = await (await fetch(`${base}/chat/threads/${t.id}`)).json();
    expect(idle.pending).toBeNull();
    const before = Date.now();
    const p = engine.send(t.id, 'go');
    await until(() => progress(t.id).length >= 3);
    const busy = await (await fetch(`${base}/chat/threads/${t.id}`)).json();
    expect(busy.pending).toMatchObject({ phase: 'thinking', turn: 2 });
    expect(busy.pending.since).toBeGreaterThanOrEqual(before);
    release();
    await p;
    expect((await (await fetch(`${base}/chat/threads/${t.id}`)).json()).pending).toBeNull();
  });
});

describe('interrupted replies', () => {
  it('stop() gives an in-flight turn the interrupted note and never runs its tools', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let toolRan = false;
    const { mod, engine, deps } = boot(scriptedLLM([
      async () => { await gate; return { toolCalls: [tc('approvals', { op: 'list' })] }; },
      { content: 'never' },
    ]));
    const t = engine.createThread();
    const p = engine.send(t.id, 'go ahead');
    // (after the state snapshot, which also lists approvals)
    deps.store.approvals = (() => { toolRan = true; return []; }) as any;
    await mod.stop();
    release();
    const reply = await p;
    expect(reply.content).toBe(INTERRUPTED_REPLY);
    expect(toolRan).toBe(false);
    const msgs = store.allEvents().filter((e) => e.kind === 'chat_message').map((e) => e.data.message);
    expect(msgs.map((m: any) => [m.role, m.content])).toEqual([['user', 'go ahead'], ['assistant', INTERRUPTED_REPLY]]);
    expect(progress(t.id).map((x) => x.phase)).toEqual(['thinking', 'error']);
    await expect(engine.send(t.id, 'again')).rejects.toThrow(/shutting down/);
  });

  it('startup marks recent unanswered threads only', async () => {
    const s = openStore(':memory:');
    const first = boot(undefined, s);
    const recent = first.engine.createThread('recent');
    const old = first.engine.createThread('old');
    const answered = first.engine.createThread('answered');
    // write messages directly, as a killed process would have left them
    const db = s.raw();
    const add = (threadId: string, role: string, content: string, at: number) => {
      db.prepare('INSERT INTO chat_messages (id, threadId, role, content, actions, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(`m_${threadId}_${at}_${role}`, threadId, role, content, '[]', at);
      db.prepare('UPDATE chat_threads SET updatedAt = ? WHERE id = ?').run(at, threadId);
    };
    const now = Date.now();
    add(recent.id, 'user', 'go ahead', now - 13_000);
    add(old.id, 'user', 'ancient', now - INTERRUPTED_WINDOW_MS - 60_000);
    add(answered.id, 'user', 'hi', now - 5000);
    add(answered.id, 'assistant', 'hello', now - 4000);

    const second = boot(undefined, s);
    await second.mod.start();
    const last = (id: string) => (s.raw().prepare('SELECT role, content FROM chat_messages WHERE threadId = ? ORDER BY createdAt DESC LIMIT 1').get(id) as any);
    expect(last(recent.id)).toEqual({ role: 'assistant', content: INTERRUPTED_REPLY });
    expect(last(old.id)).toEqual({ role: 'user', content: 'ancient' });
    expect(last(answered.id)).toEqual({ role: 'assistant', content: 'hello' });
    expect(progress(recent.id)).toEqual([{ threadId: recent.id, phase: 'error' }]);
    // idempotent: a second start adds nothing
    expect(second.engine.recoverInterrupted()).toEqual([]);
  });
});
