// P12 acceptance — soak S1 findings (2026-09-25). Written by the orchestrator. Do not edit to make it pass.
// 1. A single slow LLM call outlived the 5-minute lease (heartbeats only happened between turns) → the scheduler
//    reclaimed the task and started a second run while the first was still alive.
// 2. The first ("zombie") run never noticed and later transitioned a task it no longer owned.
// 3. After the task parked in needs_claude, the zombie's stall timer moved it to stopped.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { scriptedLLM, call, type Step } from '../../../src/runtime/testing.js';

let store: ReturnType<typeof openStore>;
let reg: ToolRegistry;
let personas: ReturnType<typeof loadPersonas>;
let ws: string;
beforeEach(() => {
  store = openStore(':memory:');
  reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  personas = loadPersonas('personas', reg);
  ws = mkdtempSync(join(tmpdir(), 'alfred-own-'));
});
const opts = (llm: any, extra: any = {}) => ({ store, llm, personas, registry: reg, workerId: 'A', workspaceFor: () => ws, pollMs: 20, ...extra });
const slow = (s: any, ms: number): Step => async () => { await new Promise(r => setTimeout(r, ms)); return s; };
const task = () => {
  const g = store.createGoal({ title: `own-${Math.random()}` });
  return store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
};

describe('leases survive long LLM calls', () => {
  it('heartbeats during a model call longer than the lease, so the task is never reclaimed', async () => {
    const t = task();
    const reclaimer = setInterval(() => store.reclaimExpired(), 25);
    try {
      const end = await runTask(t.id, opts(scriptedLLM([
        slow({ toolCalls: [call('note', { text: 'thinking hard' })] }, 900),
        { toolCalls: [call('finish', { summary: 'ok' })] },
      ]), { leaseMs: 300 }));
      expect(end.status).toBe('done');
      expect(store.events(t.goalId).some(e => e.kind === 'reclaimed')).toBe(false);
    } finally { clearInterval(reclaimer); }
  });
});

describe('a run that lost its task never touches it again', () => {
  it('does not transition a task that was reclaimed and re-claimed by another worker', async () => {
    const t = task();
    const p = runTask(t.id, opts(scriptedLLM([
      slow({ toolCalls: [call('give_up', { reason: 'zombie verdict' })] }, 400),
    ]), { leaseMs: 60_000 }));
    await new Promise(r => setTimeout(r, 100));
    // Simulate the scheduler taking the task away: back to queued, claimed by worker B.
    store.transition(t.id, 'queued', { reason: 'test: lease lost' });
    expect(store.claim(t.id, 'B', 60_000)).toBe(true);
    await p; // must resolve, not throw
    const now = store.getTask(t.id)!;
    expect(now.status).toBe('running');
    expect(now.leaseOwner).toBe('B');
    expect(now.reason).not.toBe('zombie verdict');
  });

  it('a parked needs_claude task is not later stopped by the finished run\'s timers', async () => {
    const t = task();
    const end = await runTask(t.id, opts(scriptedLLM([
      { toolCalls: [call('ask_claude', { reason: 'outside my sandbox', question: 'how do I see the tests?' })] },
    ]), { watchdog: { stallMs: 150 }, leaseMs: 200 }));
    expect(end.status).toBe('needs_claude');
    await new Promise(r => setTimeout(r, 600));
    expect(store.getTask(t.id)!.status).toBe('needs_claude');
    expect(store.reclaimExpired()).toEqual([]);
  });
});
