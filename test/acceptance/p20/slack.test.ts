// P20 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { openStore, type Store } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import type { ModuleDeps } from '../../../src/modules.js';
import { slackSink } from '../../../src/notify/sinks.js';
import { createBoardModule } from '../../../src/board/index.js';
import { createSlackModule } from '../../../src/slack/index.js';

type Posted = { url: string; body: any; auth?: string };

async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timed out waiting');
}

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function world(o: { withBoard?: boolean; env?: Record<string, string> } = {}) {
  const store: Store = openStore(':memory:');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise(r => wss.on('listening', r));
  const port = (wss.address() as any).port;
  const sockets: WebSocket[] = [];
  const received: any[] = [];
  let connections = 0;
  wss.on('connection', ws => {
    connections++;
    sockets.push(ws);
    ws.on('message', m => received.push(JSON.parse(String(m))));
    ws.send(JSON.stringify({ type: 'hello' }));
  });
  const posted: Posted[] = [];
  const fetchFn: typeof fetch = (async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    posted.push({ url: u, body, auth: init?.headers?.authorization ?? init?.headers?.Authorization });
    if (u.endsWith('/apps.connections.open')) return new Response(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${port}/socket` }));
    return new Response(JSON.stringify({ ok: true }));
  }) as any;
  const sent: { threadId: string; text: string }[] = [];
  const threads = new Map<string, any>();
  let tn = 0;
  const chat = {
    createThread: (title?: string) => { const t = { id: `th-${++tn}`, title: title ?? 'New chat', createdAt: 0, updatedAt: 0 }; threads.set(t.id, t); return t; },
    getThread: (id: string) => threads.get(id),
    send: async (threadId: string, text: string) => { sent.push({ threadId, text }); return { id: 'm', threadId, role: 'assistant', content: `echo:${text}`, actions: [], createdAt: 0 }; },
  };
  const deps: ModuleDeps = {
    store, registry: new ToolRegistry(), env: o.env ?? { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1', SLACK_CHANNEL: 'C1', SLACK_ALLOWED_USERS: 'U1, U9' },
    repoRoot: process.cwd(), personasDir: 'personas', workRoot: '/tmp/w', nodes: {} as any, repoHub: {} as any, deckState: { url: null },
    extra: { fetch: fetchFn, WebSocket, slackApi: 'https://slack.test/api', slackBackoffMs: [30, 30] },
    modules: { chat: { name: 'chat', chat } as any }, personas: new Map(),
  };
  if (o.withBoard !== false) deps.modules.board = await createBoardModule(deps);
  const mod = await createSlackModule(deps);
  await mod.start?.();
  const app = createApp({ store, routers: [mod.router!] });
  const srv: any = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/v1`;
  cleanup.push(async () => { await mod.stop?.(); srv.close(); for (const s of sockets) s.terminate(); wss.close(); });
  const envelope = (type: string, payload: any, id = `e${Math.random()}`) => { sockets.at(-1)!.send(JSON.stringify({ envelope_id: id, type, payload })); return id; };
  return { store, deps, posted, received, sent, envelope, url, get connections() { return connections; }, sockets, wss };
}

describe('approval buttons', () => {
  it('the bot-token sink posts Approve/Deny buttons for approval notices only', async () => {
    const posted: Posted[] = [];
    const f: typeof fetch = (async (url: any, init: any) => { posted.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{"ok":true}'); }) as any;
    const sink = slackSink({ botToken: 'xoxb', channel: 'C1', fetch: f });
    await sink.send({ level: 'warn', goalId: 'g', title: 'Approval needed: git push', body: 'git push origin main', approvalId: 'ap-1' });
    await sink.send({ level: 'failure', goalId: 'g', title: 'broke', body: 'x' });
    const blocks = posted[0].body.blocks;
    expect(posted[0].body.text).toContain('Approval needed');
    const actions = blocks.find((b: any) => b.type === 'actions').elements;
    expect(actions.map((a: any) => [a.action_id, a.value])).toEqual([['approve', 'ap-1'], ['deny', 'ap-1']]);
    expect(posted[1].body.blocks).toBeUndefined();
  });
});

describe('socket mode', () => {
  it('connects with the app token, acks, and approves from a button click', async () => {
    const w = await world();
    await until(() => w.connections === 1);
    expect(w.posted[0]).toMatchObject({ url: 'https://slack.test/api/apps.connections.open' });
    expect(String(w.posted[0].auth)).toContain('xapp-1');
    expect((await (await fetch(`${w.url}/slack/status`)).json())).toMatchObject({ configured: true, connected: true });

    const g = w.store.createGoal({ title: 'g' });
    const t = w.store.createTask({ goalId: g.id, persona: 'coder', title: 'push it' });
    w.store.claim(t.id, 'w', 60_000);
    w.store.transition(t.id, 'blocked', { reason: 'approval needed', by: 'w' });
    const ap = w.store.requestApproval(t.id, 'git push', 'git push origin main');
    const id = w.envelope('interactive', { type: 'block_actions', user: { id: 'U1', username: 'quinn' }, response_url: 'https://hooks.test/r1',
      actions: [{ action_id: 'approve', value: ap.id }] });
    await until(() => w.received.some(r => r.envelope_id === id));
    await until(() => w.posted.some(p => p.url === 'https://hooks.test/r1'));
    const a = w.store.approvals({ status: 'approved' })[0];
    expect(a.id).toBe(ap.id);
    expect(a.decidedBy).toBe('slack:quinn');
    expect(w.store.getTask(t.id)!.status).toBe('queued');
    const upd = w.posted.find(p => p.url === 'https://hooks.test/r1')!.body;
    expect(upd.replace_original).toBe(true);
    expect(upd.text).toContain('Approved by quinn');

    // deciding an unknown approval reports instead of crashing
    w.envelope('interactive', { type: 'block_actions', user: { id: 'U1' }, response_url: 'https://hooks.test/r2', actions: [{ action_id: 'deny', value: 'nope' }] });
    await until(() => w.posted.some(p => p.url === 'https://hooks.test/r2'));
    expect(w.posted.find(p => p.url === 'https://hooks.test/r2')!.body.text).toContain('⚠');

    // a Slack user not in SLACK_ALLOWED_USERS cannot approve; the refusal names their id
    const t2 = w.store.createTask({ goalId: g.id, persona: 'coder', title: 'text mom' });
    w.store.claim(t2.id, 'w', 60_000);
    w.store.transition(t2.id, 'blocked', { reason: 'approval needed', by: 'w' });
    const ap2 = w.store.requestApproval(t2.id, 'message', 'message to Mom');
    w.envelope('interactive', { type: 'block_actions', user: { id: 'U666', username: 'mallory' }, response_url: 'https://hooks.test/r3', actions: [{ action_id: 'approve', value: ap2.id }] });
    await until(() => w.posted.some(p => p.url === 'https://hooks.test/r3'));
    expect(w.posted.find(p => p.url === 'https://hooks.test/r3')!.body.text).toContain('U666');
    expect(w.store.approvals({ status: 'pending' }).some(x => x.id === ap2.id)).toBe(true);
  });

  it('handles /alfred status, inbox, add and free text', async () => {
    const w = await world();
    await until(() => w.connections === 1);
    const g = w.store.createGoal({ title: 'Big goal' });
    const t = w.store.createTask({ goalId: g.id, persona: 'coder', title: 'stuck task' });
    w.store.claim(t.id, 'w', 60_000);
    w.store.transition(t.id, 'needs_claude', { reason: 'need help', by: 'w' });
    const cmd = (text: string) => w.envelope('slash_commands', { command: '/alfred', text, user_id: 'U9', user_name: 'quinn', response_url: 'https://hooks.test/cmd' });
    const ackFor = async (id: string) => { await until(() => w.received.some(r => r.envelope_id === id)); return w.received.find(r => r.envelope_id === id); };
    expect((await ackFor(cmd('status'))).payload.text).toContain('big-goal');
    expect((await ackFor(cmd('inbox'))).payload.text).toContain('need help');
    const added = await ackFor(cmd('add Renew passport'));
    expect(added.payload.text).toContain('ALF-1');
    expect((w.deps.modules.board as any).board.getItem('ALF-1').createdBy).toBe('slack:quinn');
    const free = await ackFor(cmd('what is running?'));
    expect(free.payload.text).toContain('On it');
    await until(() => w.posted.some(p => p.url === 'https://hooks.test/cmd'));
    expect(w.posted.find(p => p.url === 'https://hooks.test/cmd')!.body.text).toBe('echo:what is running?');
    expect(w.sent[0].threadId).toBe('th-1');
  });

  it('answers DMs and mentions in thread, reusing the chat thread per Slack thread', async () => {
    const w = await world();
    await until(() => w.connections === 1);
    const ev = (event: any) => w.envelope('events_api', { event });
    ev({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello', ts: '100.1' });
    ev({ type: 'message', channel_type: 'im', channel: 'D1', bot_id: 'B1', text: 'my own echo', ts: '100.2' });
    ev({ type: 'message', channel_type: 'im', channel: 'D1', subtype: 'message_changed', text: 'edit', ts: '100.3' });
    await until(() => w.posted.filter(p => p.url.endsWith('/chat.postMessage')).length >= 1);
    ev({ type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'follow up', ts: '100.4', thread_ts: '100.1' });
    ev({ type: 'app_mention', channel: 'C7', user: 'U1', text: '<@UBOT> status please', ts: '200.1' });
    await until(() => w.posted.filter(p => p.url.endsWith('/chat.postMessage')).length >= 3);
    const posts = w.posted.filter(p => p.url.endsWith('/chat.postMessage')).map(p => p.body);
    expect(posts[0]).toMatchObject({ channel: 'D1', thread_ts: '100.1', text: 'echo:hello' });
    expect(posts.map(p => p.text)).toContain('echo:status please');
    expect(w.sent.map(s => s.text)).toEqual(['hello', 'follow up', 'status please']);
    expect(w.sent[0].threadId).toBe(w.sent[1].threadId);
    expect(w.sent[2].threadId).not.toBe(w.sent[0].threadId);
  });

  it('reconnects after a disconnect and stays off without tokens', async () => {
    const w = await world();
    await until(() => w.connections === 1);
    w.envelope('disconnect', {});
    w.sockets[0].close();
    await until(() => w.connections === 2);
    const off = await world({ env: {} });
    await new Promise(r => setTimeout(r, 100));
    expect(off.connections).toBe(0);
    expect(await (await fetch(`${off.url}/slack/status`)).json()).toMatchObject({ configured: false, connected: false });
  });
});
