// H1: the chat dataset (turn / feedback / goal records on disk) and Private threads
// (local model only, no tools, nothing recorded, no content in events).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { createApp } from '../../src/server/app.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { scriptedLLM, call as tc } from '../../src/runtime/testing.js';
import type { LLM } from '../../src/runtime/contract.js';
import type { ModuleDeps } from '../../src/modules.js';
import { createChatModule } from '../../src/chat/index.js';
import { ChatEngine } from '../../src/chat/engine.js';
import { readRecords, stats } from '../../src/chat/dataset.js';
import { handleEvent } from '../../src/slack/handlers.js';

let store: Store;
let srv: any;
afterEach(() => srv?.close());

function boot(o: { llm?: LLM; models?: any } = {}) {
  store = openStore(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'alfred-ds-'));
  const env = { ALFRED_DATASET_DIR: dir };
  const deps: ModuleDeps = {
    store, registry: new ToolRegistry(), env, repoRoot: process.cwd(), personasDir: 'personas', workRoot: '/tmp/w',
    nodes: {} as any, repoHub: {} as any, deckState: { url: null }, extra: o.llm ? { llm: o.llm } : {}, modules: {},
    personas: new Map(),
    ...(o.models ? { models: o.models } : {}),
  } as any;
  const mod: any = createChatModule(deps);
  mod.start?.();
  return { mod, engine: mod.chat as ChatEngine, deps, dir, env };
}

async function serve(mod: any) {
  const app = createApp({ store, routers: [mod.router] });
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${srv.address().port}/api/v1`;
}
const json = (method: string, body: any) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/** A fake model registry: planner + optional others, each backed by its own scripted LLM. */
function registry(models: { name: string; baseUrl: string; llm: LLM }[]) {
  return {
    resolve: () => ({ name: models[0].name, model: models[0].name, baseUrl: models[0].baseUrl }),
    list: () => models.map((m) => ({ name: m.name, model: m.name, baseUrl: m.baseUrl, roles: [], deny: [] })),
    llm: (ref?: string) => (models.find((m) => m.name === ref) ?? models[0]).llm,
    denied: () => new Set<string>(),
  };
}

describe('dataset records', () => {
  it('a normal turn writes one 0600 record with model, usage, latency, messages and source; prompt stored by sha', async () => {
    const { mod, dir } = boot({ llm: scriptedLLM([{ toolCalls: [tc('goals', { op: 'list' })] }, { content: 'no goals' }]) });
    const base = await serve(mod);
    const t = await (await fetch(`${base}/chat/threads`, json('POST', {}))).json();
    await (await fetch(`${base}/chat/threads/${t.id}/messages`, json('POST', { text: 'what is running?', wait: true }))).json();
    const recs = readRecords({ ALFRED_DATASET_DIR: dir }, 'chat');
    expect(recs).toHaveLength(1);
    const r: any = recs[0];
    expect(r).toMatchObject({ v: 1, type: 'turn', threadId: t.id, source: 'dashboard', reply: 'no goals', llmCalls: 2, ok: true });
    expect(r.messages.some((m: any) => m.role === 'tool')).toBe(true);
    expect(typeof r.latencyMs).toBe('number');
    const chatFile = files(dir).find((f) => f.startsWith('chat-'))!;
    expect(statSync(join(dir, chatFile)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'prompts', `${r.systemSha}.txt`), 'utf8')).toContain('Live state');
  });

  it('feedback is stored on the message and appended; null clears; stats count up/down', async () => {
    const { mod, engine, dir } = boot({ llm: scriptedLLM([{ content: 'a' }, { content: 'b' }]) });
    const base = await serve(mod);
    const t = engine.createThread();
    const m1 = await engine.send(t.id, 'q1');
    const m2 = await engine.send(t.id, 'q2');
    let r = await fetch(`${base}/chat/threads/${t.id}/messages/${m1.id}/feedback`, json('POST', { rating: 'up' }));
    expect(r.status).toBe(200);
    r = await fetch(`${base}/chat/threads/${t.id}/messages/${m2.id}/feedback`, json('POST', { rating: 'down', note: 'wrong', correction: 'better' }));
    expect((await r.json()).message).toMatchObject({ rating: 'down' });
    expect((await fetch(`${base}/chat/threads/${t.id}/messages/${m2.id}/feedback`, json('POST', { rating: 'meh' }))).status).toBe(400);
    const fb = readRecords({ ALFRED_DATASET_DIR: dir }, 'feedback') as any[];
    expect(fb.find((f) => f.messageId === m2.id)).toMatchObject({ rating: 'down', note: 'wrong', correction: 'better' });
    expect(stats({ ALFRED_DATASET_DIR: dir }).feedback).toEqual({ up: 1, down: 1 });
    await fetch(`${base}/chat/threads/${t.id}/messages/${m1.id}/feedback`, json('POST', { rating: null }));
    expect(stats({ ALFRED_DATASET_DIR: dir }).feedback).toEqual({ up: 0, down: 1 });
  });

  it('export streams NDJSON and since filters', async () => {
    const { mod, engine } = boot({ llm: scriptedLLM([{ content: 'a' }]) });
    const base = await serve(mod);
    await engine.send(engine.createThread().id, 'q');
    const all = await fetch(`${base}/chat/dataset/export?kind=chat`);
    expect(all.headers.get('content-type')).toContain('ndjson');
    const lines = (await all.text()).trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'turn', reply: 'a' });
    expect((await (await fetch(`${base}/chat/dataset/export?kind=chat&since=${Date.now() + 60_000}`)).text()).trim()).toBe('');
    expect((await fetch(`${base}/chat/dataset/export?kind=secrets`)).status).toBe(400);
  });

  it('a finished goal is recorded; a private goal is not', async () => {
    const { dir } = boot({ llm: scriptedLLM([]) });
    const g = store.createGoal({ title: 'ship it', body: 'spec' });
    store.setGoalMeta(g.id, { source: 'cli' });
    store.appendEvent(g.id, null, 'goal_status', { status: 'done' });
    const p = store.createGoal({ title: 'secret', body: 'x' });
    store.setGoalMeta(p.id, { private: true });
    store.appendEvent(p.id, null, 'goal_status', { status: 'done' });
    const goals = readRecords({ ALFRED_DATASET_DIR: dir }, 'goals') as any[];
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ type: 'goal', goalId: g.id, title: 'ship it', status: 'done', source: 'cli' });
  });
});

describe('private threads', () => {
  it('get no tools, the private system line, record nothing, and events carry no content or tool names', async () => {
    const llm = scriptedLLM([{ toolCalls: [tc('goals', { op: 'list' })] }, { content: 'secret answer' }]);
    const { mod, dir } = boot({ llm });
    const base = await serve(mod);
    const t = await (await fetch(`${base}/chat/threads`, json('POST', { private: true }))).json();
    expect(t.private).toBe(true);
    const out = await (await fetch(`${base}/chat/threads/${t.id}/messages`, json('POST', { text: 'my secret question', wait: true }))).json();
    expect(llm.requests[0].tools).toEqual([]);
    expect(llm.requests[0].system).toContain(ChatEngine.PRIVATE_SYSTEM_LINE);
    // a tool call the model makes anyway is refused
    expect(llm.requests[1].messages.find((m) => m.role === 'tool')?.content).toBe(ChatEngine.PRIVATE_TOOL_REPLY);
    expect(out.reply?.content ?? out.content ?? '').toBeDefined();
    // nothing on disk
    expect(files(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
    // feedback on it is stored on the message but not recorded
    const msgs = (await (await fetch(`${base}/chat/threads/${t.id}`)).json()).messages;
    const a = msgs.find((m: any) => m.role === 'assistant');
    expect(a.content).toBe('secret answer'); // the chat itself still has it
    await fetch(`${base}/chat/threads/${t.id}/messages/${a.id}/feedback`, json('POST', { rating: 'up' }));
    expect(files(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([]);
    // events: no message text, no tool names
    const evs = store.allEvents({ limit: 1000 }).filter((e) => e.data?.threadId === t.id);
    const dump = JSON.stringify(evs);
    expect(dump).not.toContain('secret');
    expect(evs.every((e) => !('tool' in (e.data ?? {})))).toBe(true);
    expect(dump).not.toContain('goals');
    expect(evs.filter((e) => e.kind === 'chat_message').every((e) => e.data.private === true)).toBe(true);
  });

  it('refuses without calling a remote model when no local one exists; uses the local one when there is', async () => {
    const remote = scriptedLLM([{ content: 'remote!' }]);
    const a = boot({ models: registry([{ name: 'cloud', baseUrl: 'https://api.example.com/v1', llm: remote }]) });
    const t = a.engine.createThread(undefined, { private: true });
    const r = await a.engine.send(t.id, 'hi');
    expect(r.content).toBe(ChatEngine.PRIVATE_REPLY);
    expect(remote.requests).toHaveLength(0);

    const remote2 = scriptedLLM([{ content: 'remote!' }]);
    const local = scriptedLLM([{ content: 'local answer' }]);
    const b = boot({ models: registry([
      { name: 'cloud', baseUrl: 'https://api.example.com/v1', llm: remote2 },
      { name: 'spark', baseUrl: 'http://127.0.0.1:1110', llm: local },
    ]) });
    const t2 = b.engine.createThread(undefined, { private: true });
    expect((await b.engine.send(t2.id, 'hi')).content).toBe('local answer');
    expect(remote2.requests).toHaveLength(0);
    // a normal thread on the same registry still uses the planner (cloud)
    const t3 = b.engine.createThread();
    expect((await b.engine.send(t3.id, 'hi')).content).toBe('remote!');
  });

  it('PATCH private:true + purge:true removes only that thread\'s earlier records', async () => {
    const { mod, engine, dir } = boot({ llm: scriptedLLM([{ content: 'a' }, { content: 'b' }]) });
    const base = await serve(mod);
    const t1 = engine.createThread();
    const t2 = engine.createThread();
    const m = await engine.send(t1.id, 'one');
    await engine.send(t2.id, 'two');
    await fetch(`${base}/chat/threads/${t1.id}/messages/${m.id}/feedback`, json('POST', { rating: 'up' }));
    const r = await fetch(`${base}/chat/threads/${t1.id}`, json('PATCH', { private: true, purge: true }));
    expect((await r.json()).private).toBe(true);
    const env = { ALFRED_DATASET_DIR: dir };
    expect((readRecords(env, 'chat') as any[]).map((x) => x.threadId)).toEqual([t2.id]);
    expect(readRecords(env, 'feedback')).toEqual([]);
    expect((await fetch(`${base}/chat/threads/${t1.id}`, json('PATCH', {}))).status).toBe(400);
  });

  it('Slack never answers in a private thread and never calls the engine', async () => {
    const { engine } = boot({ llm: scriptedLLM([]) });
    const t = engine.createThread(undefined, { private: true });
    const posted: any[] = [];
    let sent = false;
    const chat = { send: async () => { sent = true; return { content: 'x' }; }, getThread: (id: string) => engine.getThread(id) };
    const done = new Promise<void>((resolve) => {
      const ctx: any = {
        store, getBoard: () => undefined, getChat: () => chat,
        threads: { resolve: () => t.id, reset: () => t.id },
        slackApi: { postMessage: async (m: any) => { posted.push(m); resolve(); return 'ts1'; }, update: async () => true },
        postUrl: async () => {}, enqueue: (fn: any) => void fn(), setError: () => {},
        allowedUsers: new Set(['U1']),
      };
      handleEvent(ctx, { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '1.0' });
    });
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toBe(false);
    expect(posted.map((p) => p.text).join('\n')).toContain('private');
  });
});
