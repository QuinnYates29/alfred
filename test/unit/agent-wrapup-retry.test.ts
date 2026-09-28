// Agent loop: wrap-up warnings near the turn budget, and riding out a model server restart.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { isTransientLlmError, runTask, wrapUpMessage } from '../../src/runtime/agent.js';
import { scriptedLLM, call, type Step } from '../../src/runtime/testing.js';
import type { LLM } from '../../src/runtime/contract.js';

let store: ReturnType<typeof openStore>;
let reg: ToolRegistry;
let personas: ReturnType<typeof loadPersonas>;
let ws: string;

beforeEach(() => {
  store = openStore(':memory:');
  reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  personas = loadPersonas('personas', reg);
  ws = mkdtempSync(join(tmpdir(), 'alfred-wrap-'));
  writeFileSync(join(ws, 'a.txt'), 'hello');
});
const opts = (llm: LLM) => ({ store, llm, personas, registry: reg, workerId: 'w', workspaceFor: () => ws, pollMs: 20 });

describe('wrap-up warnings', () => {
  it('tells the agent at 10 and 3 turns left, once each, then stops at the budget', async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 30; i++) steps.push({ toolCalls: [call('read_file', { path: 'a.txt' })] });
    const llm = scriptedLLM(steps);
    const g = store.createGoal({ title: 'r', budget: { turns: 25 } });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 'research' });
    const end = await runTask(t.id, opts(llm));
    expect(end.reason).toBe('turn budget exhausted (25)');
    const warnings = (i: number) => llm.requests[i].messages.filter((m) => m.role === 'user' && m.content.startsWith('⚠')).map((m) => m.content);
    expect(warnings(14)).toEqual([]); // 11 left
    expect(warnings(15)).toEqual([wrapUpMessage(10, 25)]); // 10 left
    expect(warnings(22)).toEqual([wrapUpMessage(10, 25), wrapUpMessage(3, 25)]); // 3 left
    expect(warnings(24)).toHaveLength(2);
  });

  it('a small budget only gets the last warning', async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 10; i++) steps.push({ toolCalls: [call('read_file', { path: 'a.txt' })] });
    const llm = scriptedLLM(steps);
    const g = store.createGoal({ title: 'r', budget: { turns: 8 } });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 'research' });
    await runTask(t.id, opts(llm));
    const all = llm.requests.at(-1)!.messages.filter((m) => m.content.startsWith('⚠'));
    expect(all.map((m) => m.content)).toEqual([wrapUpMessage(3, 8)]);
  });
});

describe('transient model-server errors', () => {
  it('classifies connection failures as transient and request errors as not', () => {
    expect(isTransientLlmError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientLlmError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }))).toBe(true);
    expect(isTransientLlmError(new Error('HTTP 503 Loading model'))).toBe(true);
    expect(isTransientLlmError(new Error('HTTP 400 bad request: context too long'))).toBe(false);
  });

  it('waits out a restart (more than the 3 normal attempts) instead of failing the task', async () => {
    let failures = 4; // > 3 normal attempts
    const inner = scriptedLLM([{ toolCalls: [call('give_up', { reason: 'done after restart' })] }]);
    const llm: LLM = {
      async chat(req) {
        if (failures-- > 0) throw new TypeError('fetch failed');
        return inner.chat(req);
      },
    };
    const g = store.createGoal({ title: 'r' });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 'research' });
    const end = await runTask(t.id, opts(llm));
    expect(end.reason).toBe('done after restart');
    const progress = store.events(g.id).filter((e) => e.kind === 'progress').map((e) => e.data.msg);
    expect(progress.filter((m: string) => m.startsWith('model server unreachable'))).toHaveLength(4);
  }, 60_000);

  it('a non-transient error still fails after the normal attempts', async () => {
    let calls = 0;
    const llm: LLM = { async chat() { calls++; throw new Error('HTTP 400 bad request'); } };
    const g = store.createGoal({ title: 'r' });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 'research' });
    const end = await runTask(t.id, opts(llm));
    expect(end.status).toBe('failed');
    expect(end.reason).toContain('HTTP 400');
    expect(calls).toBe(3);
  }, 30_000);
});
