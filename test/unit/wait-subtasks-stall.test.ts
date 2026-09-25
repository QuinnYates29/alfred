// Regression (soak S1, 2026-09-25): a parent in wait_subtasks was killed by its own stall watchdog
// while its child was busy. The parent must stay alive as long as its children make progress.
import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { runTask } from '../../src/runtime/agent.js';
import { scriptedLLM, call, type Step } from '../../src/runtime/testing.js';
import type { LLM } from '../../src/runtime/contract.js';

const slow = (s: any, ms: number): Step => async () => { await new Promise(r => setTimeout(r, ms)); return s; };

it('a waiting parent survives a child that runs longer than stallMs', async () => {
  const store = openStore(':memory:');
  const reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  const personas = loadPersonas('personas', reg);
  const ws = mkdtempSync(join(tmpdir(), 'alfred-wait-'));
  const g = store.createGoal({ title: 'wait stall' });
  const parent = store.createTask({ goalId: g.id, persona: 'alfred', title: 'W-PARENT', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
  const kid: Step[] = [];
  for (let i = 0; i < 6; i++) kid.push(slow({ toolCalls: [call('note', { text: `step ${i}` })] }, 150));
  kid.push({ toolCalls: [call('finish', { summary: 'kid done' })] });
  const scripts: Record<string, ReturnType<typeof scriptedLLM>> = {
    'W-PARENT': scriptedLLM([
      { toolCalls: [call('spawn_subagent', { persona: 'researcher', title: 'W-KID', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] })] },
      { toolCalls: [call('wait_subtasks', {})] },
      { toolCalls: [call('finish', { summary: 'parent done' })] },
    ]),
    'W-KID': scriptedLLM(kid),
  };
  const llm: LLM = { chat: (req) => scripts[Object.keys(scripts).find(k => req.messages[0].content.includes(k))!].chat(req) };
  const end = await runTask(parent.id, { store, llm, personas, registry: reg, workerId: 'w', workspaceFor: () => ws, pollMs: 20,
    watchdog: { stallMs: 400 } } as any);
  expect(end.reason ?? '').not.toMatch(/stall/);
  expect(end.status).toBe('done');
  expect(store.children(parent.id)[0].status).toBe('done');
}, 20_000);
