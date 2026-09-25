// P12b unit: Scheduler.stop({requeue:true}) hands running tasks back to the queue; stop()
// without the option keeps the old `stopped: cancelled` behavior.
import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { Scheduler } from '../../src/runtime/scheduler.js';
import { hungLLM } from '../../src/runtime/testing.js';

function setup() {
  const store = openStore(':memory:');
  const reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  const personas = loadPersonas('personas', reg);
  const ws = mkdtempSync(join(tmpdir(), 'alfred-shut-'));
  const g = store.createGoal({ title: 'shutdown unit' });
  const task = store.createTask({ goalId: g.id, persona: 'alfred', title: 'S-JOB', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
  const sched = new Scheduler({ store, llm: hungLLM(), personas, registry: reg, maxWorkers: 2, pollMs: 20,
    leaseMs: 60_000, workspaceFor: () => ws } as any);
  return { store, task, sched };
}

async function waitStatus(store: ReturnType<typeof openStore>, id: string, want: string, ms = 5000) {
  const end = Date.now() + ms;
  while (store.getTask(id)!.status !== want && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

it('stop({requeue:true}) hands the running task back: queued, no lease, note, not stopped', async () => {
  const { store, task, sched } = setup();
  sched.start();
  await waitStatus(store, task.id, 'running');
  expect(store.getTask(task.id)!.status).toBe('running');
  await sched.stop({ requeue: true });
  const t = store.getTask(task.id)!;
  expect(t.status).toBe('queued');
  expect(t.leaseOwner).toBeNull();
  expect(t.leaseExpiresAt).toBeNull();
  expect(t.attempt).toBe(1); // handed back, not re-claimed
  expect(t.reason).toMatch(/service restart/i);
  expect(t.notes).toMatch(/service (stopped|restart)/i);
  expect(sched.running()).toEqual([]);
  store.close();
}, 15_000);

it('stop() without requeue keeps the old cancelled behavior', async () => {
  const { store, task, sched } = setup();
  sched.start();
  await waitStatus(store, task.id, 'running');
  await sched.stop();
  const t = store.getTask(task.id)!;
  expect(t.status).toBe('stopped');
  expect(t.reason).toMatch(/cancelled/i);
  store.close();
}, 15_000);
