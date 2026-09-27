// P21b acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { connectNode } from '../../../src/node/client.js';
import type { LLM, ToolContext } from '../../../src/runtime/contract.js';

const idle: LLM = { async chat(req) { await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); }); return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; } };

const posted: { url: string; body: string; auth: string }[] = [];
const fakeFetch: typeof fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.startsWith('https://api.twilio.com')) { posted.push({ url: u, body: String(init?.body ?? ''), auth: String(init?.headers?.authorization ?? init?.headers?.Authorization ?? '') }); return new Response('{"sid":"SM1"}', { status: 201 }); }
  return fetch(url, init);
}) as any;

async function boot(env: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), 'alfred-p21c-'));
  const repoRoot = join(base, 'repo');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  cpSync('config/models.yaml', join(repoRoot, 'config', 'models.yaml'));
  writeFileSync(join(repoRoot, 'config', 'contacts.yaml'), '- name: Mom\n  phone: "+15550001111"\n- name: Sam Rivera\n  phone: "+15550002222"\n  imessage: sam@example.com\n');
  const alfred = await startAlfred({
    dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0', ...env }, llm: idle, gitRoot: join(base, 'git'),
    extra: { repoRoot, fetch: fakeFetch, llm: idle },
  });
  const tools: any[] = (alfred.modules.comms as any).tools;
  const run = (name: string, args: any, ctx: Partial<ToolContext> = {}) => tools.find(t => t.schema.name === name)!.run(args, { taskId: 'none', goalId: '', workspace: base, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {}, ...ctx });
  const task = () => {
    const g = alfred.store.createGoal({ title: 'comms' });
    const t = alfred.store.createTask({ goalId: g.id, persona: 'alfred', title: 'comms' });
    alfred.store.claim(t.id, 'w', 60_000);
    return t;
  };
  const approveAll = (taskId: string) => { for (const a of alfred.store.approvals({ status: 'pending', taskId })) alfred.store.decideApproval(a.id, 'approved', 'quinn'); };
  return { alfred, run, task, approveAll, base };
}

describe('contacts + texting through the Mac node', () => {
  let w: Awaited<ReturnType<typeof boot>>;
  const nodeCalls: any[] = [];
  let node: { close(): void; connected(): boolean };
  beforeAll(async () => {
    w = await boot({});
    node = connectNode({
      url: w.alfred.url.replace('http', 'ws'), name: 'macbook', roots: [w.base], caps: ['fs', 'messages', 'calls'], reconnect: false,
      comms: { run: async (op: string, args: any) => { nodeCalls.push({ op, args }); return { ok: true }; } },
    } as any);
    const end = Date.now() + 5000;
    while (!node.connected() || !w.alfred.nodes.list().length) { if (Date.now() > end) throw new Error('node did not connect'); await new Promise(r => setTimeout(r, 50)); }
  }, 60_000);
  afterAll(async () => { node?.close(); await w?.alfred.stop(); });

  it('finds contacts and sends a gated message via the node', async () => {
    expect((await w.run('contacts', { op: 'find', q: 'sam' })).output).toContain('+15550002222');
    const t = w.task();
    const ctx = { taskId: t.id, goalId: t.goalId };
    const first = await w.run('message', { to: 'Mom', text: 'Running late, home by 7' }, ctx);
    expect(first.park).toBeTruthy();
    const [ap] = w.alfred.store.approvals({ status: 'pending', taskId: t.id });
    expect(ap.detail).toContain('Running late, home by 7');
    expect(ap.detail).toContain('+15550001111');
    expect(nodeCalls).toHaveLength(0);
    w.approveAll(t.id);
    const sent = await w.run('message', { to: 'Mom', text: 'Running late, home by 7' }, ctx);
    expect(sent.ok).toBe(true);
    expect(sent.output).toMatch(/macbook|Messages/i);
    expect(nodeCalls[0]).toMatchObject({ op: 'sendMessage', args: { to: '+15550001111', text: 'Running late, home by 7' } });
    expect(w.alfred.store.allEvents().some(e => e.kind === 'comms' && e.data.provider)).toBe(true);
    // a different text is a different approval
    expect((await w.run('message', { to: 'Mom', text: 'something else' }, ctx)).park).toBeTruthy();
  });

  it('places a call through the Mac (needs a click)', async () => {
    const t = w.task();
    await w.run('call', { to: 'Sam Rivera' }, { taskId: t.id, goalId: t.goalId });
    w.approveAll(t.id);
    const r = await w.run('call', { to: 'Sam Rivera' }, { taskId: t.id, goalId: t.goalId });
    expect(r.ok).toBe(true);
    expect(nodeCalls.at(-1)).toMatchObject({ op: 'placeCall', args: { to: '+15550002222' } });
  });
});

describe('Twilio fallback and no provider', () => {
  it('texts and calls through Twilio when no node offers messages', async () => {
    const w = await boot({ TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret', TWILIO_FROM: '+15559990000' });
    try {
      const t = w.task();
      const ctx = { taskId: t.id, goalId: t.goalId };
      await w.run('message', { to: '+15557778888', text: 'hello there' }, ctx);
      w.approveAll(t.id);
      expect((await w.run('message', { to: '+15557778888', text: 'hello there' }, ctx)).ok).toBe(true);
      const sms = posted.find(p => p.url.endsWith('/Accounts/AC123/Messages.json'))!;
      expect(new URLSearchParams(sms.body).get('Body')).toBe('hello there');
      expect(new URLSearchParams(sms.body).get('From')).toBe('+15559990000');
      expect(sms.auth).toBe('Basic ' + Buffer.from('AC123:secret').toString('base64'));
      await w.run('call', { to: 'Mom', say: 'Dinner is ready' }, ctx);
      w.approveAll(t.id);
      expect((await w.run('call', { to: 'Mom', say: 'Dinner is ready' }, ctx)).ok).toBe(true);
      const call = posted.find(p => p.url.endsWith('/Calls.json'))!;
      expect(new URLSearchParams(call.body).get('Twiml')).toContain('<Say>Dinner is ready</Say>');
    } finally { await w.alfred.stop(); }
  });

  it('explains how to enable texting when nothing can send', async () => {
    const w = await boot({});
    try {
      const t = w.task();
      await w.run('message', { to: 'Mom', text: 'x' }, { taskId: t.id, goalId: t.goalId });
      w.approveAll(t.id);
      const r = await w.run('message', { to: 'Mom', text: 'x' }, { taskId: t.id, goalId: t.goalId });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/--messages|Twilio/);
    } finally { await w.alfred.stop(); }
  });
});
