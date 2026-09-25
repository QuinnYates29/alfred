// P8 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas, promptCost } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import { scriptedLLM, call, type Step } from '../../../src/runtime/testing.js';
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
  ws = mkdtempSync(join(tmpdir(), 'alfred-ctx-'));
});

const opts = (llm: LLM, extra: any = {}) => ({ store, llm, personas, registry: reg, workerId: 'w', workspaceFor: () => ws, pollMs: 20, ...extra });
const est = (r: LLMRequest) => estimateTokens(r.system) + estimateTokens(JSON.stringify(r.tools)) + estimateTokens(JSON.stringify(r.messages));

describe('compaction', () => {
  it('never sends a request over the context budget, and records compactions', async () => {
    const budget = 6000;
    const p = personas.get('coder')!;
    personas.set('coder', { ...p, contextBudgetTokens: budget });
    for (let i = 0; i < 30; i++) writeFileSync(join(ws, `big${i}.txt`), `file ${i}\n` + 'lorem ipsum dolor sit amet '.repeat(200));
    const steps: Step[] = [];
    for (let i = 0; i < 30; i++) steps.push({ content: `reading ${i}`, toolCalls: [call('read_file', { path: `big${i}.txt` })] });
    steps.push({ toolCalls: [call('give_up', { reason: 'read everything' })] });
    const llm = scriptedLLM(steps);
    const g = store.createGoal({ title: 'long', budget: { turns: 100 } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'LONG-READ', spec: 'read all', acceptance: [{ name: 'a', cmd: 'true' }] });
    const end = await runTask(t.id, opts(llm));
    expect(end.reason).toBe('read everything');
    for (const r of llm.requests) expect(est(r)).toBeLessThanOrEqual(budget);
    expect(llm.requests.at(-1)!.messages[0].content).toContain('LONG-READ'); // the brief survives
    expect(llm.requests.at(-1)!.messages.some(m => m.content.startsWith('## Compacted history'))).toBe(true);
    const u = store.taskUsage(t.id);
    expect(u.compactions).toBeGreaterThan(0);
    expect(u.turns).toBe(31);
    expect(store.getTask(t.id)!.notes).toContain('read_file');
  });

  it('nudges a spawning persona to delegate once past half its budget', async () => {
    const p = personas.get('alfred')!;
    personas.set('alfred', { ...p, contextBudgetTokens: 5000 });
    for (let i = 0; i < 6; i++) writeFileSync(join(ws, `f${i}.txt`), 'x'.repeat(3000));
    const steps: Step[] = [0, 1, 2, 3, 4, 5].map(i => ({ toolCalls: [call('read_file', { path: `f${i}.txt` })] }));
    steps.push({ toolCalls: [call('give_up', { reason: 'ok' })] });
    const llm = scriptedLLM(steps);
    const g = store.createGoal({ title: 'nudge' });
    const t = store.createTask({ goalId: g.id, persona: 'alfred', title: 'NUDGE', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    await runTask(t.id, opts(llm));
    const isNudge = (m: any) => /Delegate remaining reading\/implementation to a subagent/.test(m.content);
    // injected once: some request carries it, and no request ever carries two
    expect(llm.requests.some(r => r.messages.some(isNudge))).toBe(true);
    for (const r of llm.requests) expect(r.messages.filter(isNudge).length).toBeLessThanOrEqual(1);
    const firstWith = llm.requests.findIndex(r => r.messages.some(isNudge));
    expect(est(llm.requests[firstWith - 1] ?? llm.requests[0])).toBeGreaterThan(0);
  });
});

describe('compact child results', () => {
  it('stores finish summaries and wait_subtasks returns only short results, never child notes', async () => {
    const g = store.createGoal({ title: 'parent' });
    const parent = store.createTask({ goalId: g.id, persona: 'alfred', title: 'P-TASK', spec: 'delegate', acceptance: [{ name: 'a', cmd: 'true' }] });
    const longSummary = 'S'.repeat(5000);
    const scripts: Record<string, Step[]> = {
      'P-TASK': [
        { toolCalls: [call('spawn_subagent', { persona: 'coder', title: 'C-TASK', spec: 'x', acceptance: [{ name: 'a', cmd: 'true' }] })] },
        { toolCalls: [call('wait_subtasks', {})] },
        { toolCalls: [call('give_up', { reason: 'inspected' })] },
      ],
      'C-TASK': [
        { toolCalls: [call('note', { text: 'SECRET-SCRATCH-NOTE '.repeat(50) })] },
        { toolCalls: [call('finish', { summary: longSummary })] },
      ],
    };
    const llms = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, scriptedLLM(v)]));
    const llm: LLM = { chat: (req) => llms[Object.keys(llms).find(k => req.messages[0].content.includes(k))!].chat(req) };
    await runTask(parent.id, opts(llm));
    const [child] = store.children(parent.id);
    expect(child.status).toBe('done');
    expect(child.result!.length).toBeLessThanOrEqual(2000);
    const waitOut = (llms['P-TASK'] as any).requests[2].messages.filter((m: any) => m.role === 'tool').at(-1).content as string;
    expect(waitOut).toContain('C-TASK');
    expect(waitOut).toContain('[done]');
    expect(waitOut).not.toContain('SECRET-SCRATCH-NOTE');
    expect(waitOut.length).toBeLessThanOrEqual(800);
  });
});

describe('paged reads', () => {
  it('reads a window of lines with a header and a continuation hint', async () => {
    writeFileSync(join(ws, 'long.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
    const ctx: any = { taskId: 't', goalId: 'g', workspace: ws, persona: 'coder', signal: new AbortController().signal, acceptance: [], progress: () => {} };
    const a = await reg.get('read_file')!.run({ path: 'long.txt' }, ctx);
    expect(a.output).toMatch(/\[long\.txt lines 1-400 of 1000\]/);
    expect(a.output).toContain('(more: offset=400)');
    expect(a.output).not.toContain('line 401');
    const b = await reg.get('read_file')!.run({ path: 'long.txt', offset: 990, limit: 50 }, ctx);
    expect(b.output).toContain('line 1000');
    expect(b.output).not.toContain('(more:');
  });
});

describe('personas and accounting', () => {
  it('coder can delegate to researcher; prompts stay in budget', () => {
    const coder = personas.get('coder')!;
    expect(coder.canSpawn).toContain('researcher');
    expect(coder.tools).toEqual(expect.arrayContaining(['spawn_subagent', 'wait_subtasks']));
    expect(personas.get('alfred')!.system).toMatch(/delegate/i);
    for (const p of personas.values()) expect(promptCost(p, reg)).toBeLessThanOrEqual(p.promptBudgetTokens);
  });

  it('goalUsage sums every task and splits by persona', async () => {
    const g = store.createGoal({ title: 'usage' });
    const a = store.createTask({ goalId: g.id, persona: 'coder', title: 'U1', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const b = store.createTask({ goalId: g.id, persona: 'researcher', title: 'U2', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const mk = (n: number) => scriptedLLM([
      { usage: { promptTokens: 1000 * n, completionTokens: 10 }, toolCalls: [call('note', { text: 'x' })] },
      { usage: { promptTokens: 1500 * n, completionTokens: 20 }, toolCalls: [call('give_up', { reason: 'r' })] },
    ]);
    await runTask(a.id, opts(mk(1)));
    await runTask(b.id, opts(mk(2)));
    expect(store.taskUsage(a.id)).toMatchObject({ promptTokens: 2500, completionTokens: 30, peakPromptTokens: 1500, turns: 2 });
    const gu = store.goalUsage(g.id);
    expect(gu.promptTokens).toBe(7500);
    expect(gu.completionTokens).toBe(60);
    expect(gu.byPersona.researcher.promptTokens).toBe(5000);
  });
});
