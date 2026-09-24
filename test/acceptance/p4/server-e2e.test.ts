// P4 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { scriptedLLM, call, type Step } from '../../../src/runtime/testing.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

async function listen(app: any): Promise<{ url: string; close: () => void }> {
  return new Promise(r => {
    const srv = app.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

const j = (url: string, init?: RequestInit) => fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });

describe('HTTP API', () => {
  it('creates, lists, shows, notes, stops and retries goals; enforces the token', async () => {
    const store = openStore(':memory:');
    const { url, close } = await listen(createApp({ store, token: 'sekrit' }));
    const auth = { authorization: 'Bearer sekrit' };
    try {
      expect((await fetch(`${url}/api/goals`)).status).toBe(401);
      expect((await j(`${url}/api/goals`, { method: 'POST', headers: auth, body: JSON.stringify({}) })).status).toBe(400);
      const res = await j(`${url}/api/goals`, { method: 'POST', headers: auth, body: JSON.stringify({
        title: 'API Goal', body: 'do it', persona: 'coder', acceptance: [{ name: 'a', cmd: 'true' }] }) });
      expect(res.status).toBe(201);
      const { goal, task } = await res.json();
      expect(task.persona).toBe('coder');
      expect(task.spec).toBe('do it');
      const list = await (await fetch(`${url}/api/goals?token=sekrit`)).json();
      expect(list[0]).toMatchObject({ id: goal.id, counts: { queued: 1 } });
      const shown = await (await fetch(`${url}/api/goals/api-goal`, { headers: auth })).json();
      expect(shown.tasks).toHaveLength(1);
      expect((await j(`${url}/api/tasks/${task.id}/note`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hint: use X' }) })).status).toBeLessThan(300);
      const stopped = await j(`${url}/api/tasks/${task.id}/stop`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'changed my mind' }) });
      expect(stopped.status).toBeLessThan(300);
      expect(store.getTask(task.id)!.status).toBe('stopped');
      expect((await j(`${url}/api/tasks/${task.id}/stop`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(409);
      const retried = await j(`${url}/api/tasks/${task.id}/retry`, { method: 'POST', headers: auth, body: JSON.stringify({ note: 'try Y' }) });
      expect(retried.status).toBe(201);
      const nt = await retried.json();
      expect(store.getTask(nt.id)!.status).toBe('queued');
      expect(store.getTask(nt.id)!.notes).toContain('hint: use X');
      expect(store.getTask(nt.id)!.notes).toContain('try Y');
      expect(store.getGoal(goal.id)!.status).toBe('active');
    } finally { close(); }
  });

  it('streams events over SSE with replay', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'sse' });
    const first = store.appendEvent(g.id, null, 'before', {});
    const { url, close } = await listen(createApp({ store }));
    const ac = new AbortController();
    try {
      const res = await fetch(`${url}/api/events?since=0`, { signal: ac.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      let buf = '';
      setTimeout(() => store.appendEvent(g.id, null, 'live_one', { x: 1 }), 100);
      const deadline = Date.now() + 3000;
      while (!buf.includes('live_one') && Date.now() < deadline) buf += new TextDecoder().decode((await reader.read()).value);
      expect(buf).toContain(`id: ${first.id}`);
      expect(buf).toContain('"kind":"before"');
      expect(buf).toContain('live_one');
    } finally { ac.abort(); close(); }
  });
});

function routedLLM(scripts: Record<string, Step[]>): LLM {
  const llms = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, scriptedLLM(v)]));
  return { chat(req: LLMRequest) {
    const key = Object.keys(llms).find(k => (req.messages[0]?.content ?? '').includes(k));
    if (!key) throw new Error('no script');
    return llms[key].chat(req);
  } };
}

let alfred: Alfred | undefined;
afterEach(async () => { await alfred?.stop(); alfred = undefined; });

describe('startAlfred end to end', () => {
  it('runs a goal to done, fails an impossible one loudly, and mirrors both to markdown', async () => {
    const base = mkdtempSync(join(tmpdir(), 'alfred-e2e-'));
    alfred = await startAlfred({
      dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'),
      personasDir: 'personas', port: 0, host: '127.0.0.1', tickMs: 1000, pollMs: 25, deck: null,
      env: { ALFRED_NOTIFY_DESKTOP: '0' },
      llm: routedLLM({
        'E2E-HAPPY': [
          { toolCalls: [call('write_file', { path: 'result.txt', content: 'ok' })] },
          { toolCalls: [call('finish', { summary: 'done' })] },
        ],
        'E2E-IMPOSSIBLE': [
          { toolCalls: [call('give_up', { reason: 'requires a GPU that does not exist' })] },
        ],
      }),
    });
    const mk = (title: string) => j(`${alfred!.url}/api/goals`, { method: 'POST', body: JSON.stringify({
      title, persona: 'coder', spec: 'make result.txt', acceptance: [{ name: 'result', cmd: 'test -f result.txt' }] }) }).then(r => r.json());
    const happy = await mk('E2E-HAPPY');
    const bad = await mk('E2E-IMPOSSIBLE');
    const deadline = Date.now() + 10_000;
    const status = (id: string) => alfred!.store.getGoal(id)!.status;
    while (Date.now() < deadline && (status(happy.goal.id) === 'active' || status(bad.goal.id) === 'active')) await new Promise(r => setTimeout(r, 50));
    expect(status(happy.goal.id)).toBe('done');
    expect(status(bad.goal.id)).toBe('failed');
    await new Promise(r => setTimeout(r, 900)); // mirror debounce
    const hm = join(base, 'vault', happy.goal.slug, 'GOAL.md');
    const bm = join(base, 'vault', bad.goal.slug, 'GOAL.md');
    expect(existsSync(hm)).toBe(true);
    expect(readFileSync(hm, 'utf8')).toContain('Status: **DONE**');
    expect(readFileSync(bm, 'utf8')).toContain('Status: **FAILED**');
    expect(readFileSync(bm, 'utf8')).toContain('requires a GPU that does not exist');
    const health = await (await fetch(`${alfred.url}/api/health`)).json();
    expect(health.ok).toBe(true);
    const personas = await (await fetch(`${alfred.url}/api/personas`)).json();
    const coder = personas.find((p: any) => p.name === 'coder');
    expect(coder.promptCost).toBeLessThanOrEqual(coder.promptBudgetTokens);
  }, 30_000);
});
