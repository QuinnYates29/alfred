// Unit tests for the Claude door (buildDoor) over an in-memory transport.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openStore } from '../../src/store.js';
import { buildDoor } from '../../src/door/server.js';

async function linked() {
  const store = openStore(':memory:');
  const wsRoot = mkdtempSync(join(tmpdir(), 'alfred-door-unit-'));
  const server = buildDoor(store, wsRoot);
  const client = new Client({ name: 'u', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    let json: any;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { isError: !!r.isError, text, json };
  };
  return { store, client, call };
}

describe('door tools', () => {
  it('alfred_status reports parked tasks and pending approvals', async () => {
    const { store, call } = await linked();
    const g = store.createGoal({ title: 'g one' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't1' });
    store.claim(t.id, 'qwen', 60_000);
    store.transition(t.id, 'needs_claude', { reason: 'stuck' });
    const ap = store.requestApproval(t.id, 'git push', 'git push origin main');

    const s = await call('alfred_status');
    expect(s.isError).toBe(false);
    expect(s.json.parked[0].taskId).toBe(t.id);
    expect(s.json.parked[0].reason).toBe('stuck');
    expect(s.json.approvals.map((a: any) => a.id)).toContain(ap.id);
    expect(s.json.goals[0].counts.needs_claude).toBe(1);
  });

  it('claim refuses terminal tasks and points at alfred_retry', async () => {
    const { store, call } = await linked();
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'qwen', 60_000);
    store.transition(t.id, 'failed', { reason: 'nope' });

    const bad = await call('alfred_claim', { taskId: t.id });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/alfred_retry/);

    const retry = await call('alfred_retry', { taskId: t.id, note: 'again' });
    expect(retry.json.ok).toBe(true);
    const again = await call('alfred_claim', { taskId: retry.json.taskId });
    expect(again.isError).toBe(false);
    expect(again.json.task.status).toBe('running');
    expect(store.getTask(retry.json.taskId)!.leaseOwner).toBe('claude');
  });

  it('claim from blocked lands in running with a workspace; approve unblocks', async () => {
    const { store, call } = await linked();
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'qwen', 60_000);
    store.transition(t.id, 'blocked', { reason: 'approval needed: git push: git push' });
    const [ap] = store.approvals({ status: 'pending' }).filter((a) => a.taskId === t.id);

    const c = await call('alfred_claim', { taskId: t.id });
    expect(c.isError).toBe(false);
    expect(c.json.task.status).toBe('running');
    expect(typeof c.json.workspace).toBe('string');

    if (ap) {
      const d = await call('alfred_approve', { approvalId: ap.id, decision: 'approved' });
      expect(d.isError).toBe(false);
    }
  });

  it('unknown ids and goals error instead of crashing', async () => {
    const { call } = await linked();
    expect((await call('alfred_claim', { taskId: 'nope' })).isError).toBe(true);
    expect((await call('alfred_goal', { goal: 'nope' })).isError).toBe(true);
    expect((await call('alfred_complete', { taskId: 'nope', summary: 'x' })).isError).toBe(true);
    expect((await call('alfred_create_goal', { title: '  ' })).isError).toBe(true);
  });

  it('release hands a running task back to queued with the note', async () => {
    const { store, call } = await linked();
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    await call('alfred_claim', { taskId: t.id });
    const r = await call('alfred_release', { taskId: t.id, note: 'try the event log' });
    expect(r.isError).toBe(false);
    expect(store.getTask(t.id)!.status).toBe('queued');
    expect(store.getTask(t.id)!.notes).toContain('try the event log');
  });
});
