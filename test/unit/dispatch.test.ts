// D1 unit tests — one syntax that starts an agent run from a single prompt:
// parseDispatch / titleFor / dispatchPrompt, the /dispatch HTTP routes,
// the Slack handlers' dispatch+follow flow, and the Mac quick bar `!` kind.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { dispatchPrompt, parseDispatch, titleFor } from '../../src/dispatch.js';
import { createApp } from '../../src/server/app.js';
import type { Persona } from '../../src/runtime/contract.js';
import { handleEvent, handleSlash, type HandlerCtx } from '../../src/slack/handlers.js';
import { openThreadMap } from '../../src/slack/threadMap.js';

const require = createRequire(import.meta.url);
const { parseQuick, submitQuick } = require(join(process.cwd(), 'app/src/quick.cjs'));

const NAMES = ['alfred', 'coder', 'researcher'];
const persona = (name: string): Persona => ({
  name, description: `${name} persona`, system: 'sys', tools: [], promptBudgetTokens: 1000, canSpawn: [],
});
const personas = (): Map<string, Persona> => new Map(NAMES.map((n) => [n, persona(n)]));

describe('parseDispatch', () => {
  it('recognizes known personas (case-insensitive), optional @', () => {
    expect(parseDispatch('!coder fix x', NAMES)).toEqual({ persona: 'coder', prompt: 'fix x' });
    expect(parseDispatch('!@Researcher find y', NAMES)).toEqual({ persona: 'researcher', prompt: 'find y' });
    expect(parseDispatch('  !Coder   fix   x  ', NAMES)).toEqual({ persona: 'coder', prompt: 'fix   x' });
  });
  it('`! <prompt>` and unknown words go to alfred', () => {
    expect(parseDispatch('! plan z', NAMES)).toEqual({ persona: 'alfred', prompt: 'plan z' });
    expect(parseDispatch('!unknownword do it', NAMES)).toEqual({ persona: 'alfred', prompt: 'unknownword do it' });
    // a known persona with no prompt after it → the word is the prompt, for alfred
    expect(parseDispatch('!coder', NAMES)).toEqual({ persona: 'alfred', prompt: 'coder' });
  });
  it('null for non-dispatch text', () => {
    expect(parseDispatch('!!', NAMES)).toBeNull();
    expect(parseDispatch('!!! x', NAMES)).toBeNull();
    expect(parseDispatch('hello', NAMES)).toBeNull();
    expect(parseDispatch('!', NAMES)).toBeNull();
    expect(parseDispatch('   ', NAMES)).toBeNull();
    expect(parseDispatch('', NAMES)).toBeNull();
  });
  it('multi-line prompts are kept', () => {
    const r = parseDispatch('!coder line one\nline two\nline three', NAMES);
    expect(r).toEqual({ persona: 'coder', prompt: 'line one\nline two\nline three' });
  });
});

describe('titleFor', () => {
  it('takes the first non-empty line with whitespace collapsed', () => {
    expect(titleFor('\n\n  hello   world \nsecond line')).toBe('hello world');
  });
  it('long lines are cut at a word boundary, ≤ 81 chars, with …', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';
    const t = titleFor(long);
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith('…')).toBe(true);
    const cut = t.slice(0, -1);
    expect(long.startsWith(cut)).toBe(true);
    expect(long[cut.length]).toBe(' '); // cut on a word boundary, not inside a word
  });
  it('≤ 80 chars gets no ellipsis', () => {
    const s = 'x'.repeat(80);
    expect(titleFor(s)).toBe(s);
  });
});

describe('dispatchPrompt', () => {
  it('creates goal + root task with title/spec/persona and meta.source', () => {
    const store = openStore(':memory:');
    const prompt = 'add a /health endpoint to ~/repos/foo\nwith a test';
    const out = dispatchPrompt(store, personas(), { prompt, persona: 'coder', repo: '/tmp/foo', source: 'cli' });
    const goal = store.getGoal(out.goal.id)!;
    expect(goal.title).toBe('add a /health endpoint to ~/repos/foo');
    expect(out.task.spec).toBe(prompt);
    expect(out.task.goalId).toBe(goal.id);
    expect(out.persona).toBe('coder');
    expect(store.getTask(out.task.id)!.persona).toBe('coder');
    expect(goal.meta.source).toBe('cli');
    expect(goal.meta.repo).toBe('/tmp/foo');
    expect((goal.acceptance ?? []).length).toBe(0); // no acceptance checks are ever set here
  });
  it('defaults to alfred; node goes to meta (except local)', () => {
    const store = openStore(':memory:');
    const a = dispatchPrompt(store, personas(), { prompt: 'plan the quarter', source: 'dashboard' });
    expect(a.persona).toBe('alfred');
    expect(store.getTask(a.task.id)!.persona).toBe('alfred');
    expect(store.getGoal(a.goal.id)!.meta.source).toBe('dashboard');
    const b = dispatchPrompt(store, personas(), { prompt: 'x', persona: 'coder', node: 'mac', source: 'mac-quick' });
    expect(store.getGoal(b.goal.id)!.meta.node).toBe('mac');
    const c = dispatchPrompt(store, personas(), { prompt: 'x', persona: 'coder', node: 'local', source: 'cli' });
    expect(store.getGoal(c.goal.id)!.meta.node).toBeUndefined();
  });
  it('unknown persona throws; empty prompt throws', () => {
    const store = openStore(':memory:');
    expect(() => dispatchPrompt(store, personas(), { prompt: 'x', persona: 'nope', source: 'cli' }))
      .toThrow(/unknown persona: nope/);
    expect(() => dispatchPrompt(store, personas(), { prompt: '   ', source: 'cli' })).toThrow();
  });
});

describe('POST /api/v1/dispatch + GET /dispatch/help', () => {
  let srv: any;
  afterEach(() => srv?.close());

  function boot() {
    const store = openStore(':memory:');
    const app = createApp({ store, personas: personas(), allowNoToken: true });
    return new Promise<{ url: string; store: Store }>((r) => {
      srv = app.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/api/v1`, store }));
    });
  }
  const post = (url: string, body: any) =>
    fetch(`${url}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('parses dispatch text → 201 with the persona', async () => {
    const { url, store } = await boot();
    const res = await post(url, { text: '!coder do a thing' });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.persona).toBe('coder');
    expect(j.goal.title).toBe('do a thing');
    expect(store.getGoal(j.goal.id)!.meta.source).toBe('dashboard'); // no source given → dashboard
  });
  it('non-dispatch text is an alfred prompt; empty text → 400', async () => {
    const { url } = await boot();
    const ok = await post(url, { text: 'hello there alfred' });
    expect(ok.status).toBe(201);
    expect((await ok.json()).persona).toBe('alfred');
    expect((await post(url, { text: '   ' })).status).toBe(400);
    expect((await post(url, {})).status).toBe(400);
  });
  it('unknown persona → 400; only trusted source values are stored', async () => {
    const { url, store } = await boot();
    expect((await post(url, { prompt: 'x', persona: 'nope' })).status).toBe(400);
    const evil = await post(url, { prompt: 'x', source: 'evil' });
    expect(evil.status).toBe(201);
    const e = await evil.json();
    expect(store.getGoal(e.goal.id)!.meta.source).toBe('dashboard');
    const cli = await post(url, { prompt: 'x', persona: 'coder', source: 'cli' });
    const c = await cli.json();
    expect(store.getGoal(c.goal.id)!.meta.source).toBe('cli');
  });
  it('GET /dispatch/help lists personas and syntax', async () => {
    const { url } = await boot();
    const j = await (await fetch(`${url}/dispatch/help`)).json();
    expect(j.syntax).toBe('!<persona> <prompt>');
    expect(j.personas.map((p: any) => p.name)).toEqual(NAMES);
    expect(j.personas[0].description).toBeTruthy();
  });
});

// Fake HandlerCtx (same shape as test/unit/slack.test.ts / p20 acceptance).
function fakeCtx(o: Partial<HandlerCtx> = {}) {
  const posts: { url: string; body: any }[] = [];
  const apiPosts: any[] = [];
  const errors: string[] = [];
  const jobs: Promise<void>[] = [];
  const chat = {
    createThread: (title?: string) => ({ id: 'th-1', title: title ?? 'New chat' }),
    getThread: () => undefined,
    send: async () => ({ content: 'ok' }),
  };
  const dispatched: string[] = [];
  let doneCb: ((status: string, summary: string) => void) | null = null;
  const ctx: HandlerCtx = {
    store: openStore(':memory:'),
    getBoard: () => undefined,
    getChat: () => chat,
    threads: openThreadMap(openStore(':memory:'), () => chat),
    slackApi: { postMessage: async (b: any) => { apiPosts.push(b); return { ts: '9.1' }; }, update: async () => false } as any,
    postUrl: async (url, body) => { posts.push({ url, body }); },
    enqueue: (fn) => { jobs.push(fn().catch((e) => { errors.push(String(e?.message ?? e)); })); },
    setError: (m) => errors.push(m),
    allowedUsers: new Set(['U1']),
    personaNames: () => NAMES,
    dispatch: (text) => {
      dispatched.push(text);
      return { goalId: 'g-1', slug: 'do-it', title: 'do it', persona: 'coder' };
    },
    follow: (_goalId, onDone) => { doneCb = onDone; },
    ...o,
  };
  const flush = () => Promise.all(jobs.splice(0));
  const finish = (status: string, summary: string) => doneCb?.(status, summary);
  return { ctx, posts, apiPosts, errors, dispatched, flush, finish, followCalled: () => !!doneCb };
}

describe('slack dispatch flow', () => {
  it('a DM `!coder do it` dispatches, posts Started, and posts the done line on follow', async () => {
    const f = fakeCtx({ dashboardUrl: 'https://d.example' });
    handleEvent(f.ctx, { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: '!coder do it', ts: '1' });
    await f.flush();
    expect(f.dispatched).toEqual(['!coder do it']);
    expect(f.followCalled()).toBe(true);
    expect(f.apiPosts[0].text).toContain(':rocket: Started *coder* → do it');
    expect(f.apiPosts[0].text).toContain('https://d.example/#/goal/g-1');
    f.finish('done', 'all shipped');
    await f.flush();
    expect(f.apiPosts[1].text).toContain(':white_check_mark: done — do it');
    expect(f.apiPosts[1].text).toContain('all shipped');
  });
  it('a failed run posts the failed line', async () => {
    const f = fakeCtx();
    handleEvent(f.ctx, { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: '!coder do it', ts: '1' });
    await f.flush();
    f.finish('failed', 'boom');
    await f.flush();
    expect(f.apiPosts[1].text).toContain(':x: failed — do it');
    expect(f.apiPosts[1].text).toContain('boom');
  });
  it('/alfred run researcher look up x acks Started and reports to response_url on finish', async () => {
    const f = fakeCtx({
      dispatch: (text) => {
        f.dispatched.push(text);
        return { goalId: 'g-2', slug: 'look-up-x', title: 'look up x', persona: 'researcher' };
      },
    });
    const ack = handleSlash(f.ctx, { user_id: 'U1', text: 'run researcher look up x', response_url: 'https://hooks.slack.test/R2' });
    expect(ack.text).toContain(':rocket: Started *researcher* → look up x');
    expect(f.dispatched).toEqual(['!researcher look up x']);
    f.finish('done', 'found it');
    await f.flush();
    expect(f.posts[0].url).toBe('https://hooks.slack.test/R2');
    expect(f.posts[0].body.text).toContain(':white_check_mark: done — look up x');
  });
  it('/alfred run <prompt> (no persona) dispatches alfred; unauthorized users are refused', () => {
    const f = fakeCtx({ dispatch: (text) => { f.dispatched.push(text); return { goalId: 'g-3', slug: 's', title: 't', persona: 'alfred' }; } });
    const ack = handleSlash(f.ctx, { user_id: 'U1', text: 'run tidy the board' });
    expect(ack.text).toContain('Started *alfred*');
    expect(f.dispatched).toEqual(['!alfred tidy the board']);
    const f2 = fakeCtx();
    const res = handleSlash(f2.ctx, { user_id: 'U2', text: 'run coder x' });
    expect(res.text).toContain('not authorized');
    expect(f2.dispatched.length).toBe(0);
  });
});

describe('quick bar (Mac) — ! starts a run', () => {
  it('`!coder x` is a run with the original trimmed text', () => {
    expect(parseQuick('!coder x')).toEqual({ kind: 'run', text: '!coder x' });
    expect(parseQuick('  !@Researcher find y  ')).toEqual({ kind: 'run', text: '!@Researcher find y' });
  });
  it('`!!`/`!!!` stay priority words inside items', () => {
    expect(parseQuick('fix it !!')).toMatchObject({ kind: 'item', title: 'fix it', priority: 'high' });
    expect(parseQuick('pay rent !!!')).toMatchObject({ kind: 'item', priority: 'urgent' });
  });
  it('submitQuick posts dispatch with source mac-quick and reports the run', async () => {
    const calls: any[] = [];
    const api = { request: async (m: string, p: string, b: any) => { calls.push({ m, p, b }); return { persona: 'coder', goal: { id: 'g1', slug: 'do-a-thing' } }; } };
    expect(await submitQuick('!coder do a thing', api)).toBe('Started coder → do-a-thing');
    expect(calls[0].m).toBe('POST');
    expect(calls[0].p).toBe('/api/v1/dispatch');
    expect(calls[0].b).toEqual({ text: '!coder do a thing', source: 'mac-quick' });
  });
});
