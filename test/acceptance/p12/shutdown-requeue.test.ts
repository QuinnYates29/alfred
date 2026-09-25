// P12b acceptance — soak finding (2026-09-25): restarting the service cancelled in-flight tasks forever.
// A shutdown must hand running tasks back to the queue (with a note) so the next process resumes them.
// Written by the orchestrator. Do not edit to make it pass.
import { it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAlfred } from '../../../src/main.js';
import { hungLLM } from '../../../src/runtime/testing.js';
import { openStore } from '../../../src/store.js';

it('stopping Alfred requeues running tasks instead of cancelling them', async () => {
  const base = mkdtempSync(join(tmpdir(), 'alfred-shutdown-'));
  const dbPath = join(base, 'a.db');
  const a = await startAlfred({ dbPath, mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas', port: 0,
    host: '127.0.0.1', deck: null, pollMs: 25, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: hungLLM() } as any);
  const res = await fetch(`${a.url}/api/v1/goals`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Long job', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] }) });
  const { task } = await res.json();
  const end = Date.now() + 5000;
  while (a.store.getTask(task.id)!.status !== 'running' && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  expect(a.store.getTask(task.id)!.status).toBe('running');
  await a.stop();
  const s = openStore(dbPath);
  const t = s.getTask(task.id)!;
  expect(t.status).toBe('queued');
  expect(t.leaseOwner).toBeNull();
  expect(t.notes).toMatch(/service (stopped|restart)/i);
  expect(s.getGoal(t.goalId)!.status).toBe('active');
}, 30_000);

it('an explicit stop of a task via the API still cancels it', async () => {
  const base = mkdtempSync(join(tmpdir(), 'alfred-stop-'));
  const a = await startAlfred({ dbPath: join(base, 'a.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas', port: 0,
    host: '127.0.0.1', deck: null, pollMs: 25, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: hungLLM() } as any);
  const { task } = await (await fetch(`${a.url}/api/v1/goals`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Stop me', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] }) })).json();
  const end = Date.now() + 5000;
  while (a.store.getTask(task.id)!.status !== 'running' && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  await fetch(`${a.url}/api/v1/tasks/${task.id}/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'not needed' }) });
  const end2 = Date.now() + 5000;
  while (a.store.getTask(task.id)!.status === 'running' && Date.now() < end2) await new Promise(r => setTimeout(r, 20));
  expect(a.store.getTask(task.id)!.status).toBe('stopped');
  await a.stop();
}, 30_000);
