// P20 unit tests — slack handlers, thread mapping, sink blocks.
import { describe, it, expect } from 'vitest';
import { openStore, type Store } from '../../src/store.js';
import { openBoard } from '../../src/board/board.js';
import { handleSlash, handleInteractive, handleEvent, type HandlerCtx } from '../../src/slack/handlers.js';
import { openThreadMap, type ChatLike } from '../../src/slack/threadMap.js';
import { slackSink } from '../../src/notify/sinks.js';

function fakeChat() {
  const threads = new Map<string, any>();
  let n = 0;
  const sent: { threadId: string; text: string }[] = [];
  const chat: ChatLike & { send(t: string, x: string): Promise<any> } = {
    createThread: (title?: string) => {
      const t = { id: `th-${++n}`, title };
      threads.set(t.id, t);
      return t;
    },
    getThread: (id) => threads.get(id),
    send: async (threadId, text) => {
      sent.push({ threadId, text });
      return { content: `echo:${text}` };
    },
  };
  return { chat, sent, threads };
}

function testCtx(store: Store, o: Partial<HandlerCtx> = {}) {
  const posts: { url: string; body: any }[] = [];
  const apiPosts: any[] = [];
  const errors: string[] = [];
  const jobs: Promise<void>[] = [];
  const { chat, sent, threads } = fakeChat();
  const ctx: HandlerCtx = {
    store,
    getBoard: () => openBoard(store) as any,
    getChat: () => chat,
    threads: openThreadMap(store, () => chat),
    slackApi: { postMessage: async (b: any) => { apiPosts.push(b); return null; }, update: async () => false } as any,
    postUrl: async (url, body) => { posts.push({ url, body }); },
    enqueue: (fn) => { jobs.push(fn().catch((e) => { errors.push(String(e?.message ?? e)); })); },
    setError: (m) => errors.push(m),
    allowedUsers: new Set(['U1']),
    ...o,
  };
  const flush = () => Promise.all(jobs.splice(0));
  return { ctx, posts, apiPosts, errors, chat, sent, threads, flush };
}

describe('slash commands', () => {
  it('status lists active goals and task counts', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'My Goal' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'w', 60_000);
    const { ctx } = testCtx(store);
    const ack = handleSlash(ctx, { user_id: 'U1', text: 'status' });
    expect(ack.text).toContain('my-goal [active] My Goal');
    expect(ack.text).toContain('1 running');
    expect(ack.text).toContain('0 queued');
  });

  it('inbox shows pending approvals and parked tasks, else Inbox zero', () => {
    const store = openStore(':memory:');
    const { ctx } = testCtx(store);
    expect(handleSlash(ctx, { user_id: 'U1', text: 'inbox' }).text).toBe('Inbox zero.');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'stuck' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'needs_claude', { reason: 'need help', by: 'w' });
    const ap = store.requestApproval(t.id, 'git push', 'git push origin main');
    const text = handleSlash(ctx, { user_id: 'U1', text: 'Inbox' }).text;
    expect(text).toContain(`${ap.id.slice(0, 8)} git push: git push origin main`);
    expect(text).toContain(`[${'needs_claude'}] stuck — need help`);
  });

  it('add creates a board item; free text without chat reports unavailable', () => {
    const store = openStore(':memory:');
    const board = openBoard(store);
    const { ctx } = testCtx(store, { getBoard: () => board as any });
    const ack = handleSlash(ctx, { user_id: 'U1', text: 'add Buy milk', user_name: 'quinn' });
    expect(ack.text).toBe('Added ALF-1: Buy milk');
    expect(board.getItem('ALF-1')!.createdBy).toBe('slack:quinn');
    const noChat = testCtx(store, { getChat: () => undefined });
    expect(handleSlash(noChat.ctx, { user_id: 'U1', text: 'hello there' }).text).toBe('chat is not available');
  });
});

describe('interactive approve/deny', () => {
  it('denies a pending approval and replaces the message', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'blocked', { reason: 'approval needed', by: 'w' });
    const ap = store.requestApproval(t.id, 'rm', 'rm -rf /tmp/x');
    const { ctx, posts, flush } = testCtx(store);
    handleInteractive(ctx, {
      type: 'block_actions',
      user: { id: 'U1', username: 'quinn' },
      response_url: 'https://hooks.test/r',
      actions: [{ action_id: 'deny', value: ap.id }],
    });
    await flush();
    expect(store.approvals({ status: 'denied' })[0].decidedBy).toBe('slack:quinn');
    expect(posts[0].body).toMatchObject({ replace_original: true });
    expect(posts[0].body.text).toContain('Denied by quinn: rm -rf /tmp/x');
  });

  it('re-deciding an already decided approval posts a warning', async () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'blocked', { reason: 'x', by: 'w' });
    const ap = store.requestApproval(t.id, 'a', 'd');
    store.decideApproval(ap.id, 'approved', 'cli');
    const { ctx, posts, flush } = testCtx(store);
    handleInteractive(ctx, {
      type: 'block_actions',
      user: { id: 'U1' },
      response_url: 'https://hooks.test/r2',
      actions: [{ action_id: 'approve', value: ap.id }],
    });
    await flush();
    expect(posts[0].body.replace_original).toBe(false);
    expect(posts[0].body.text).toContain('⚠');
    expect(posts[0].body.text).toContain('already approved');
  });
});

describe('events', () => {
  it('ignores bot messages and edited messages; strips the mention prefix', async () => {
    const store = openStore(':memory:');
    const { ctx, apiPosts, sent, flush } = testCtx(store);
    handleEvent(ctx, { type: 'message', channel_type: 'im', channel: 'D1', bot_id: 'B', text: 'x', ts: '1' });
    handleEvent(ctx, { type: 'message', channel_type: 'im', channel: 'D1', subtype: 'message_changed', text: 'x', ts: '2' });
    handleEvent(ctx, { type: 'message', channel: 'C1', text: 'not an im', ts: '3' });
    await flush();
    expect(sent).toHaveLength(0);
    handleEvent(ctx, { type: 'app_mention', channel: 'C9', user: 'U1', text: '<@UBOT>  hi bot', ts: '5' });
    await flush();
    expect(sent[0].text).toBe('hi bot');
    expect(apiPosts[0].text).toContain('thinking'); // placeholder first; with no ts from Slack the reply is posted after it
    expect(apiPosts.at(-1)).toMatchObject({ channel: 'C9', thread_ts: '5', text: 'echo:hi bot' });
  });
});

describe('thread map', () => {
  it('reuses a mapped thread and recreates it when the chat thread is gone', () => {
    const store = openStore(':memory:');
    const { chat, threads } = fakeChat();
    const map = openThreadMap(store, () => chat);
    const a = map.resolve('slack:D1:1');
    expect(map.resolve('slack:D1:1')).toBe(a);
    threads.delete(a); // chat thread deleted behind slack's back
    const b = map.resolve('slack:D1:1');
    expect(b).not.toBe(a);
    expect(map.resolve('slack:D1:2')).toBe('th-3');
  });
});

describe('slackSink blocks', () => {
  it('webhook mode never sends blocks, even with an approvalId', async () => {
    const posted: any[] = [];
    const f = (async (_u: any, init: any) => {
      posted.push(JSON.parse(init.body));
      return new Response('{"ok":true}');
    }) as typeof fetch;
    const sink = slackSink({ webhookUrl: 'https://hooks.test/wh', fetch: f });
    await sink.send({ level: 'warn', goalId: 'g', title: 'Approval needed: x', body: 'b', approvalId: 'ap-9' });
    expect(posted[0].blocks).toBeUndefined();
    expect(posted[0].text).toContain('Approval needed');
  });
});
