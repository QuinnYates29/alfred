// P1 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { Scheduler } from '../../../src/runtime/scheduler.js';
import { scriptedLLM, hungLLM, call, type Step } from '../../../src/runtime/testing.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

let store: ReturnType<typeof openStore>;
let reg: ToolRegistry;
let personas: ReturnType<typeof loadPersonas>;
let ws: string;

beforeEach(() => {
  store = openStore(':memory:');
  reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  personas = loadPersonas('personas', reg);
  ws = mkdtempSync(join(tmpdir(), 'alfred-ws-'));
});

function opts(llm: LLM, extra: any = {}) {
  return { store, llm, personas, registry: reg, workerId: 'w1', workspaceFor: () => ws, pollMs: 20, ...extra };
}

function task(persona = 'coder', extra: any = {}, goalBudget: any = {}) {
  const g = store.createGoal({ title: `g-${Math.random()}`, budget: goalBudget });
  return store.createTask({ goalId: g.id, persona, title: extra.title ?? 'make hello', spec: 'create hello.txt',
    acceptance: extra.acceptance ?? [{ name: 'hello-exists', cmd: 'test -f hello.txt' }], ...extra });
}

/** Route each request to a per-task script by looking for the task title in the first user message. */
function routedLLM(scripts: Record<string, Step[]>): LLM {
  const llms = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, scriptedLLM(v)]));
  return {
    chat(req: LLMRequest) {
      const first = req.messages[0]?.content ?? '';
      const key = Object.keys(llms).find(k => first.includes(k));
      if (!key) throw new Error('routedLLM: no script for ' + first.slice(0, 80));
      return llms[key].chat(req);
    },
  };
}

const toolText = (req: LLMRequest) => req.messages.filter(m => m.role === 'tool').map(m => m.content).join('\n');

describe('runTask outcomes', () => {
  it('finishes only after the acceptance check passes in the workspace', async () => {
    const t = task();
    const llm = scriptedLLM([
      { toolCalls: [call('write_file', { path: 'hello.txt', content: 'hi' })] },
      { toolCalls: [call('finish', { summary: 'wrote it' })] },
    ]);
    const end = await runTask(t.id, opts(llm));
    expect(end.status).toBe('done');
    expect(existsSync(join(ws, 'hello.txt'))).toBe(true);
    expect(llm.requests[0].messages[0].content).toContain('test -f hello.txt');
  });

  it('a premature finish is rejected with the failing check, and the agent can recover', async () => {
    const t = task();
    const llm = scriptedLLM([
      { toolCalls: [call('finish', { summary: 'done!' })] },
      { toolCalls: [call('write_file', { path: 'hello.txt', content: 'hi' })] },
      { toolCalls: [call('finish', { summary: 'now really' })] },
    ]);
    const end = await runTask(t.id, opts(llm));
    expect(end.status).toBe('done');
    expect(toolText(llm.requests[1])).toContain('hello-exists');
  });

  it('give_up fails loudly with the reason', async () => {
    const t = task();
    const end = await runTask(t.id, opts(scriptedLLM([{ toolCalls: [call('give_up', { reason: 'spec contradicts itself' })] }])));
    expect(end.status).toBe('failed');
    expect(end.reason).toContain('spec contradicts itself');
  });

  it('ask_claude parks the task for the Claude door with the question in notes', async () => {
    const t = task();
    const end = await runTask(t.id, opts(scriptedLLM([
      { toolCalls: [call('ask_claude', { reason: 'race condition beyond me', question: 'why does merge deadlock?' })] },
    ])));
    expect(end.status).toBe('needs_claude');
    expect(end.reason).toContain('race condition');
    expect(end.notes).toContain('why does merge deadlock?');
  });
});

describe('watchdogs', () => {
  it('stops a model that only talks', async () => {
    const t = task();
    const end = await runTask(t.id, opts(scriptedLLM([{ content: 'I will do it' }, { content: 'Working on it' }, { content: 'Almost' }]),
      { watchdog: { maxIdleTurns: 3 } }));
    expect(end.status).toBe('stopped');
    expect(end.reason).toMatch(/no progress/);
  });

  it('fails on the same error repeated', async () => {
    const t = task();
    const same = { toolCalls: [call('read_file', { path: 'missing.txt' })] };
    const end = await runTask(t.id, opts(scriptedLLM([same, same, same, same]), { watchdog: { maxRepeatedErrors: 3 } }));
    expect(end.status).toBe('failed');
    expect(end.reason).toMatch(/^repeated error:/);
  });

  it('stops at the turn budget and leaves the last words in notes', async () => {
    const t = task('coder', {}, { turns: 2 });
    const end = await runTask(t.id, opts(scriptedLLM([
      { content: 'step one', toolCalls: [call('note', { text: 'a' })] },
      { content: 'halfway: parser done, lexer todo', toolCalls: [call('note', { text: 'b' })] },
    ])));
    expect(end.status).toBe('stopped');
    expect(end.reason).toMatch(/turn budget/);
    expect(end.notes).toContain('lexer todo');
  });

  it('stops a hung model via the stall watchdog', async () => {
    const t = task();
    const started = Date.now();
    const end = await runTask(t.id, opts(hungLLM(), { watchdog: { stallMs: 300 } }));
    expect(end.status).toBe('stopped');
    expect(end.reason).toMatch(/stall/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a retry sees the previous attempt notes', async () => {
    const t = task();
    store.appendNote(t.id, 'attempt 1: approach A broke the build');
    const llm = scriptedLLM([{ toolCalls: [call('give_up', { reason: 'x' })] }]);
    await runTask(t.id, opts(llm));
    const first = llm.requests[0].messages[0].content;
    expect(first).toContain('## Notes from previous attempts');
    expect(first).toContain('approach A broke the build');
  });
});

describe('tools and sandbox', () => {
  it('refuses to write outside the workspace and rejects tools the persona lacks', async () => {
    const t = task('researcher');
    const outside = join(tmpdir(), `alfred-escape-${Date.now()}.txt`);
    const llm = scriptedLLM([
      { toolCalls: [call('read_file', { path: '../../etc/passwd' }), call('write_file', { path: outside, content: 'x' })] },
      { toolCalls: [call('give_up', { reason: 'done testing' })] },
    ]);
    await runTask(t.id, opts(llm));
    const out = toolText(llm.requests[1]);
    expect(out).toMatch(/outside workspace|unknown tool/);
    expect(existsSync(outside)).toBe(false);
  });

  it('run_shell reports exit codes', async () => {
    const t = task();
    const llm = scriptedLLM([
      { toolCalls: [call('run_shell', { cmd: 'echo out; exit 3' })] },
      { toolCalls: [call('give_up', { reason: 'fine' })] },
    ]);
    await runTask(t.id, opts(llm));
    const out = toolText(llm.requests[1]);
    expect(out).toContain('out');
    expect(out).toContain('exit=3');
  });
});

describe('subagents', () => {
  it('alfred spawns a coder, waits for it, and finishes', async () => {
    const g = store.createGoal({ title: 'parent goal' });
    const parent = store.createTask({ goalId: g.id, persona: 'alfred', title: 'PARENT-TASK', spec: 'delegate',
      acceptance: [{ name: 'child-made-file', cmd: 'test -f c.txt' }] });
    const llm = routedLLM({
      'PARENT-TASK': [
        { toolCalls: [call('spawn_subagent', { persona: 'coder', title: 'CHILD-TASK', spec: 'make c.txt',
          acceptance: [{ name: 'c', cmd: 'test -f c.txt' }] })] },
        { toolCalls: [call('wait_subtasks', {})] },
        { toolCalls: [call('finish', { summary: 'child did it' })] },
      ],
      'CHILD-TASK': [
        { toolCalls: [call('write_file', { path: 'c.txt', content: 'c' })] },
        { toolCalls: [call('finish', { summary: 'made c' })] },
      ],
    });
    const end = await runTask(parent.id, opts(llm));
    expect(end.status).toBe('done');
    const kids = store.children(parent.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].status).toBe('done');
    expect(kids[0].persona).toBe('coder');
  });

  it('a spawn beyond the fan-out budget is an error result, not a crash', async () => {
    const g = store.createGoal({ title: 'fanout', budget: { maxSubtasks: 1 } });
    const parent = store.createTask({ goalId: g.id, persona: 'alfred', title: 'FAN-PARENT', spec: 's',
      acceptance: [{ name: 'a', cmd: 'true' }] });
    const spawn = (n: number) => call('spawn_subagent', { persona: 'researcher', title: `KID-${n}`, spec: 's',
      acceptance: [{ name: 'a', cmd: 'true' }] });
    const llm = routedLLM({
      'FAN-PARENT': [
        { toolCalls: [spawn(1)] },
        { toolCalls: [spawn(2)] },
        { toolCalls: [call('give_up', { reason: 'enough' })] },
      ],
      'KID-1': [{ toolCalls: [call('finish', { summary: 'ok' })] }],
    });
    const end = await runTask(parent.id, opts(llm));
    expect(end.status).toBe('failed');
    expect(end.reason).toBe('enough');
    expect(store.children(parent.id)).toHaveLength(1);
  });
});

describe('scheduler', () => {
  it('runs queued tasks to completion and stop() cancels hung ones', async () => {
    const g = store.createGoal({ title: 'sched' });
    for (const n of [1, 2]) {
      mkdirSync(join(ws, `d${n}`), { recursive: true });
      store.createTask({ goalId: g.id, persona: 'coder', title: `SCHED-${n}`, spec: 's',
        acceptance: [{ name: 'f', cmd: `test -f d${n}/f.txt` }] });
    }
    const llm = routedLLM(Object.fromEntries([1, 2].map(n => [`SCHED-${n}`, [
      { toolCalls: [call('write_file', { path: `d${n}/f.txt`, content: 'x' })] },
      { toolCalls: [call('finish', { summary: 'ok' })] },
    ]])));
    const s = new Scheduler({ store, llm, personas, registry: reg, workspaceFor: () => ws, maxWorkers: 4, pollMs: 20 });
    s.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && store.listTasks(g.id).some(t => t.status !== 'done')) await new Promise(r => setTimeout(r, 25));
    await s.stop();
    expect(store.listTasks(g.id).map(t => t.status)).toEqual(['done', 'done']);
    expect(store.getGoal(g.id)!.status).toBe('done');

    const g2 = store.createGoal({ title: 'hung' });
    const h = store.createTask({ goalId: g2.id, persona: 'coder', title: 'HUNG', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const s2 = new Scheduler({ store, llm: hungLLM(), personas, registry: reg, workspaceFor: () => ws, maxWorkers: 2, pollMs: 20 });
    s2.start();
    await new Promise(r => setTimeout(r, 150));
    await s2.stop();
    const hs = store.getTask(h.id)!;
    expect(hs.status).toBe('stopped');
    expect(hs.reason).toMatch(/cancelled/);
  });
});

describe('long tools and parking', () => {
  it('progress from a long-running tool keeps the stall watchdog quiet', async () => {
    reg.register({
      kind: 'exec',
      schema: { name: 'slow_build', description: 'slow', parameters: { type: 'object', properties: {} } },
      async run(_args, ctx) {
        for (let i = 0; i < 8; i++) { await new Promise(r => setTimeout(r, 100)); ctx.progress(`step ${i}`); }
        return { ok: true, output: `built with ${ctx.acceptance.length} checks` };
      },
    });
    const p = personas.get('coder')!;
    personas.set('coder', { ...p, tools: [...p.tools, 'slow_build'] });
    const t = task();
    const llm = scriptedLLM([
      { toolCalls: [call('slow_build', {})] },
      { toolCalls: [call('give_up', { reason: 'checked' })] },
    ]);
    const end = await runTask(t.id, opts(llm, { watchdog: { stallMs: 300 } }));
    expect(end.reason).toBe('checked');
    expect(toolText(llm.requests[1])).toContain('built with 1 checks');
    expect(store.events(t.goalId).filter(e => e.kind === 'progress').length).toBeGreaterThanOrEqual(8);
  });

  it('a tool result with park blocks the task with its reason', async () => {
    reg.register({
      kind: 'exec',
      schema: { name: 'push_it', description: 'push', parameters: { type: 'object', properties: {} } },
      async run() { return { ok: false, output: 'needs approval', park: { status: 'blocked', reason: 'approval needed: git push' } }; },
    });
    const p = personas.get('coder')!;
    personas.set('coder', { ...p, tools: [...p.tools, 'push_it'] });
    const t = task();
    const end = await runTask(t.id, opts(scriptedLLM([{ toolCalls: [call('push_it', {})] }])));
    expect(end.status).toBe('blocked');
    expect(end.reason).toBe('approval needed: git push');
  });
});
