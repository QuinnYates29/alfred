// P16 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openStore, type Store } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import { scriptedLLM, call as tc } from '../../../src/runtime/testing.js';
import type { LLM, LLMRequest, Persona } from '../../../src/runtime/contract.js';
import type { ModuleDeps } from '../../../src/modules.js';
import { createBoardModule } from '../../../src/board/index.js';
import { createChatModule } from '../../../src/chat/index.js';
import { ChatBusyError } from '../../../src/chat/engine.js';

const persona = (name: string): Persona => ({ name, description: '', system: '', tools: [], promptBudgetTokens: 4000, canSpawn: [] });

let store: Store, srv: any, url: string, deps: ModuleDeps, chatMod: any;

async function boot(llm: LLM) {
  store = openStore(':memory:');
  deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: '/tmp/w',
    nodes: {} as any, repoHub: {} as any, deckState: { url: null }, extra: { llm }, modules: {},
    personas: new Map([['alfred', persona('alfred')], ['coder', persona('coder')], ['researcher', persona('researcher')]]),
  };
  const board = await createBoardModule(deps);
  deps.modules.board = board;
  chatMod = await createChatModule(deps);
  deps.modules.chat = chatMod;
  const app = createApp({ store, routers: [board.router!, chatMod.router!] });
  srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  url = `http://127.0.0.1:${srv.address().port}/api/v1`;
}
afterEach(() => srv?.close());

async function call(method: string, path: string, body?: any) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('chat', () => {
  it('answers with live state, edits the board and starts a linked goal', async () => {
    const llm = scriptedLLM([
      { toolCalls: [tc('board', { op: 'create', title: 'Renew passport', due: '2026-10-02', status: 'todo' })] },
      { toolCalls: [tc('start_goal', { title: 'Fix flaky test', spec: 'make test/x pass', persona: 'coder', item: 'ALF-1', node: 'macbook' })] },
      { content: 'Added ALF-1 and started a coder goal.' },
    ]);
    await boot(llm);
    const r = await call('POST', '/chat', { text: 'add renew passport for friday and get the coder on the flaky test' });
    expect(r.status).toBe(200);
    expect(r.body.reply.content).toBe('Added ALF-1 and started a coder goal.');
    expect(r.body.reply.role).toBe('assistant');
    expect(r.body.reply.actions.map((a: any) => a.name)).toEqual(['board', 'start_goal']);
    expect(r.body.reply.actions.every((a: any) => a.ok)).toBe(true);
    const board = (deps.modules.board as any).board;
    expect(board.getItem('ALF-1').title).toBe('Renew passport');
    const goal = store.listGoals()[0];
    expect(goal.title).toBe('Fix flaky test');
    expect(goal.meta.node).toBe('macbook');
    expect(store.listTasks(goal.id)[0].persona).toBe('coder');
    expect(board.getItem('ALF-1').goalIds).toEqual([goal.id]);

    // the request carried a state snapshot and the lean tool set
    const req = llm.requests[0];
    expect(req.system).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(req.tools.map(t => t.name).sort()).toEqual(['approvals', 'board', 'goals', 'start_goal']);
    expect(estimateTokens(req.system) + estimateTokens(JSON.stringify(req.tools))).toBeLessThanOrEqual(2500);
    expect(req.messages.at(-1)).toMatchObject({ role: 'user' });

    const threads = (await call('GET', '/chat/threads')).body;
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('add renew passport for friday and get the coder on the flaky'.slice(0, 60));
    const shown = (await call('GET', `/chat/threads/${r.body.threadId}`)).body;
    expect(shown.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    const ev = store.allEvents().filter(e => e.kind === 'chat_message');
    expect(ev).toHaveLength(2);
    expect(ev.every(e => e.goalId === '')).toBe(true);
  });

  it('replays history, reports tool errors to the model, caps the loop, survives LLM errors', async () => {
    let n = 0;
    const seen: LLMRequest[] = [];
    const llm: LLM = { async chat(req) {
      seen.push(req); n++;
      if (n === 1) return { content: 'hi Quinn', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      if (n === 2) return { content: '', toolCalls: [{ id: 'x', name: 'start_goal', args: { title: 't', spec: 's', persona: 'ghost' } }], usage: { promptTokens: 1, completionTokens: 1 } };
      if (n === 3) return { content: 'that persona does not exist', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
      if (n >= 4 && n < 10) return { content: 'looping', toolCalls: [{ id: 'g' + n, name: 'goals', args: { op: 'list' } }], usage: { promptTokens: 1, completionTokens: 1 } };
      throw new Error('model server down');
    } };
    await boot(llm);
    const t = (await call('POST', '/chat/threads', {})).body;
    expect(t.title).toBe('New chat');
    expect((await call('POST', `/chat/threads/${t.id}/messages`, { text: '' })).status).toBe(400);
    expect((await call('POST', `/chat/threads/nope/messages`, { text: 'x' })).status).toBe(404);
    expect((await call('POST', `/chat/threads/${t.id}/messages`, { text: 'hello', wait: true })).body.reply.content).toBe('hi Quinn');
    const second = await call('POST', `/chat/threads/${t.id}/messages`, { text: 'start a ghost goal', wait: true });
    expect(second.body.reply.content).toBe('that persona does not exist');
    expect(second.body.reply.actions[0]).toMatchObject({ name: 'start_goal', ok: false });
    expect(store.listGoals()).toHaveLength(0);
    // history: the second request carried the first exchange
    expect(seen[1].messages.map(m => m.content)).toEqual(['hello', 'hi Quinn', 'start a ghost goal']);
    const capped = await call('POST', `/chat/threads/${t.id}/messages`, { text: 'loop', wait: true });
    expect(capped.body.reply.content).toContain('stopped after 6 steps');
    const failed = await call('POST', `/chat/threads/${t.id}/messages`, { text: 'again', wait: true });
    expect(failed.status).toBe(200);
    expect(failed.body.reply.content).toContain('model server down');
    expect((await call('DELETE', `/chat/threads/${t.id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/chat/threads/${t.id}`)).status).toBe(404);
  });

  it('answers async with a chat_message event, rejects a busy thread, decides approvals', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let calls = 0;
    const llm: LLM = { async chat(req) {
      calls++;
      if (calls === 1) { await gate; return { content: 'slow answer', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; }
      if (calls === 2) return { content: '', toolCalls: [{ id: 'a', name: 'approvals', args: { op: 'list' } }], usage: { promptTokens: 1, completionTokens: 1 } };
      if (calls === 3) {
        const listed = req.messages.at(-1)!.content;
        const id = /[0-9a-f-]{36}/.exec(listed)![0];
        return { content: '', toolCalls: [{ id: 'b', name: 'approvals', args: { op: 'approve', id } }], usage: { promptTokens: 1, completionTokens: 1 } };
      }
      return { content: 'approved it', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
    } };
    await boot(llm);
    const t = (await call('POST', '/chat/threads', { title: 'ops' })).body;
    const acc = await call('POST', `/chat/threads/${t.id}/messages`, { text: 'slow one' });
    expect(acc.status).toBe(202);
    expect((await call('POST', `/chat/threads/${t.id}/messages`, { text: 'again' })).status).toBe(409);
    await expect(chatMod.chat.send(t.id, 'x')).rejects.toBeInstanceOf(ChatBusyError);
    release();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !store.allEvents().some(e => e.kind === 'chat_message' && e.data.message.content === 'slow answer')) await new Promise(r => setTimeout(r, 20));
    expect(store.allEvents().some(e => e.kind === 'chat_message' && e.data.message.content === 'slow answer')).toBe(true);

    const g = store.createGoal({ title: 'needs ok' });
    const task = store.createTask({ goalId: g.id, persona: 'coder', title: 'push' });
    store.claim(task.id, 'w', 60_000);
    store.transition(task.id, 'blocked', { reason: 'approval needed', by: 'w' });
    const ap = store.requestApproval(task.id, 'git push', 'git push origin main');
    const r = await call('POST', `/chat/threads/${t.id}/messages`, { text: 'approve the push', wait: true });
    expect(r.body.reply.content).toBe('approved it');
    expect(store.approvals({ status: 'approved' })[0].id).toBe(ap.id);
    expect(store.approvals({ status: 'approved' })[0].decidedBy).toBe('chat');
    expect(store.getTask(task.id)!.status).toBe('queued');
  });
});
