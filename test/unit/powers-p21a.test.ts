// P21a unit tests — the gate/policy, connector validation, platform details, alfred_dev deploy.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import type { ToolContext } from '../../src/runtime/contract.js';
import { autoApproved, clearChatAsks, gated, loadPolicy } from '../../src/powers/gate.js';
import { RepoHub } from '../../src/git/hub.js';
import { execFileSync } from 'node:child_process';
import { validateConnector, Connectors } from '../../src/powers/connectors.js';
import { platformTool } from '../../src/powers/platform.js';
import { alfredDevTool, devAcceptance } from '../../src/powers/dev.js';

let store: Store;
let root: string;
let deps: ModuleDeps;
let fetched: { method: string; url: string; body: any }[];
let replies: Record<string, { status: number; body: any }>;
/** The fake chat thread the gate reads (only USER messages here count as Quinn's OK). */
let thread: { id: string; role: 'user' | 'assistant'; content: string; createdAt: number }[];
let seq = 0;
const say = (role: 'user' | 'assistant', content: string) => thread.push({ id: `m${String(++seq).padStart(6, '0')}`, role, content, createdAt: Date.now() });

function ctxFor(taskId: string): ToolContext {
  return { taskId, goalId: '', workspace: root, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} };
}

function task() {
  const g = store.createGoal({ title: `g-${Math.random()}` });
  const t = store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
  return t;
}

beforeEach(() => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'alfred-p21u-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  fetched = [];
  replies = {};
  thread = [];
  clearChatAsks();
  const selfFetch = async (url: string, init: any) => {
    const path = url.replace('http://self/api/v1', '');
    fetched.push({ method: init?.method ?? 'GET', url: path, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = replies[`${init?.method ?? 'GET'} ${path.split('?')[0]}`] ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root,
    nodes: { list: () => [] } as any, repoHub: {} as any, deckState: { url: null },
    modules: { chat: { name: 'chat', chat: { threadMessages: () => thread } } as any }, personas: new Map(),
    extra: { repoRoot: root, selfFetch }, selfUrl: 'http://self', token: 'tok',
  };
});

describe('powers policy', () => {
  it('matches action-only, exact, prefix and `to` rules', () => {
    const p = { autoApprove: [
      { action: 'board' },
      { action: 'ops', detail: 'service:qwen-server:start' },
      { action: 'ops', detail: ['qwen:preset=*'] },
      { action: 'message', to: ['Mom'] },
    ] };
    expect(autoApproved(p, 'board', 'anything')).toBe(true);
    expect(autoApproved(p, 'ops', 'service:qwen-server:start')).toBe(true);
    expect(autoApproved(p, 'ops', 'service:qwen-server:stop')).toBe(false);
    expect(autoApproved(p, 'ops', 'qwen:preset=fast')).toBe(true);
    expect(autoApproved(p, 'ops', 'qwen:slots=4')).toBe(false);
    expect(autoApproved(p, 'message', 'message to Mom', 'Mom')).toBe(true);
    expect(autoApproved(p, 'message', 'message to Bob', 'Bob')).toBe(false);
    expect(autoApproved(p, 'message', 'message to ?')).toBe(false);
    expect(autoApproved(p, 'connectors', 'connector:x:add')).toBe(false);
  });

  it('fails closed on a missing or broken powers.yaml', () => {
    expect(loadPolicy(deps).autoApprove).toEqual([]);
    writeFileSync(join(root, 'config', 'powers.yaml'), 'autoApprove: [ {action: ops');
    expect(loadPolicy(deps).autoApprove).toEqual([]);
  });
});

describe('gate', () => {
  it('asks in chat; only a later user "yes" runs it (once); a goal task parks and spends an approval once', async () => {
    let runs = 0;
    const run = async () => ({ ok: true, output: `ran ${++runs}` });
    say('user', 'restart qwen please');
    const asked = await gated({ deps, tool: ctxFor('chat:x') }, 'ops', 'd1', run);
    expect(asked.ok).toBe(false);
    expect(asked.park).toBeUndefined();
    expect(asked.output).toContain('needs Quinn’s OK');
    // no new user message yet: asking again doesn't run it
    expect((await gated({ deps, tool: ctxFor('chat:x'), confirm: true } as any, 'ops', 'd1', run)).ok).toBe(false);
    say('assistant', 'Shall I?');
    say('user', 'Yes!');
    expect((await gated({ deps, tool: ctxFor('chat:x') }, 'ops', 'd1', run)).ok).toBe(true);
    // spent: the same yes doesn't run it twice
    expect((await gated({ deps, tool: ctxFor('chat:x') }, 'ops', 'd1', run)).ok).toBe(false);
    const t = task();
    const parked = await gated({ deps, tool: ctxFor(t.id) }, 'ops', 'd1', run);
    expect(parked.park?.status).toBe('blocked');
    const [ap] = store.approvals({ status: 'pending', taskId: t.id });
    store.decideApproval(ap!.id, 'approved', 'quinn');
    expect((await gated({ deps, tool: ctxFor(t.id) }, 'ops', 'd1', run)).ok).toBe(true);
    expect((await gated({ deps, tool: ctxFor(t.id) }, 'ops', 'd1', run)).park).toBeTruthy();
    expect(runs).toBe(2);
    const outcomes = store.allEvents().filter((e) => e.kind === 'power').map((e) => e.data.outcome);
    expect(outcomes).toEqual(['asked', 'asked', 'ran', 'asked', 'parked', 'ran', 'parked']);
  });

  it('re-asks when the bound content changed after approval', async () => {
    const t = task();
    const run = async () => ({ ok: true, output: 'ran' });
    await gated({ deps, tool: ctxFor(t.id) }, 'connectors', 'connector:w:add', run, { bind: 'A' });
    store.decideApproval(store.approvals({ status: 'pending', taskId: t.id })[0]!.id, 'approved', 'quinn');
    const swapped = await gated({ deps, tool: ctxFor(t.id) }, 'connectors', 'connector:w:add', run, { bind: 'B' });
    expect(swapped.park).toBeTruthy();
    store.decideApproval(store.approvals({ status: 'pending', taskId: t.id })[0]!.id, 'approved', 'quinn');
    expect((await gated({ deps, tool: ctxFor(t.id) }, 'connectors', 'connector:w:add', run, { bind: 'B' })).ok).toBe(true);
  });

  it('refuses without a task to park', async () => {
    const r = await gated({ deps, tool: ctxFor('nope') }, 'ops', 'd', async () => ({ ok: true, output: '' }));
    expect(r.ok).toBe(false);
    expect(r.park).toBeUndefined();
  });
});

describe('connector validation', () => {
  it('accepts stdio and http servers', () => {
    expect(validateConnector({ name: 'fs', command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${T}' }, envAllow: ['T'] }))
      .toEqual({ name: 'fs', cfg: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: '${T}' }, envAllow: ['T'] } });
    expect(validateConnector({ name: 'w', url: 'https://h/mcp', headers: { Authorization: 'Bearer x' } }).cfg)
      .toEqual({ url: 'https://h/mcp', headers: { Authorization: 'Bearer x' }, envAllow: [] });
  });

  it.each([
    [{ name: '../x', url: 'http://h' }],
    [{ name: 'x' }],
    [{ name: 'x', url: 'http://h', command: 'npx' }],
    [{ name: 'x', command: 'npx -y evil' }],
    [{ name: 'x', command: 'sh;rm' }],
    [{ name: 'x', command: '$(id)' }],
    [{ name: 'x', command: 'npx', args: 'a b' }],
    [{ name: 'x', command: 'npx', env: { 'BAD-KEY': 'v' } }],
    [{ name: 'x', url: 'file:///etc/passwd' }],
    [{ name: 'x', url: 'http://h', headers: { A: 'v\r\nX: y' } }],
    [{ name: 'x', url: 'http://h', args: ['a'] }],
  ])('rejects %j', (input) => {
    expect(() => validateConnector(input)).toThrow();
  });

  it('writes mcp.json with a backup and keeps plugin servers in the hub', async () => {
    const path = join(root, 'config', 'mcp.json');
    writeFileSync(path, JSON.stringify({ servers: { old: { url: 'http://h/old' } }, note: 'kept' }));
    let servers: Record<string, any> = { old: { url: 'http://h/old' }, plugin: { command: 'p' } };
    const calls: any[] = [];
    deps.hub = {
      servers: () => ({ ...servers }),
      status: () => [],
      tools: () => [],
      reconfigure: async (s: any) => { calls.push(s); servers = s; },
    } as any;
    deps.mcpConfigPath = path;
    const c = new Connectors(deps);
    await c.add({ name: 'new', url: 'http://h/new' });
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.note).toBe('kept');
    expect(Object.keys(file.servers).sort()).toEqual(['new', 'old']);
    expect(Object.keys(calls.at(-1)).sort()).toEqual(['new', 'old', 'plugin']);
    expect(readdirSync(join(root, '.alfred-backup', 'config')).some((f) => f.startsWith('mcp.json.'))).toBe(true);
    expect(await c.remove('old')).toBe(true);
    expect(Object.keys(calls.at(-1)).sort()).toEqual(['new', 'plugin']);
    expect(await c.remove('missing')).toBe(false);
    expect(c.list().map((x) => x.name).sort()).toEqual(['new', 'plugin']);
  });
});

describe('platform tool', () => {
  it('binds config_set approvals to a sha256 of the content', async () => {
    const t = task();
    const tool = platformTool(deps);
    replies['GET /ops/config/file'] = { status: 200, body: { path: 'config/alfred.yaml', content: 'a: 0\n' } };
    const r = await tool.run({ op: 'config_set', path: 'config/alfred.yaml', content: 'a: 1\n' }, ctxFor(t.id));
    expect(r.park).toBeTruthy();
    const hash = createHash('sha256').update('a: 1\n').digest('hex');
    const [ap] = store.approvals({ status: 'pending', taskId: t.id });
    expect(ap!.detail).toBe(`config:config/alfred.yaml sha256=${hash}`);
    // Quinn sees the change itself, as a unified diff against the current file
    expect(ap!.info).toContain('--- config/alfred.yaml');
    expect(ap!.info).toContain('+a: 1');
    expect(ap!.info).toContain('-a: 0');
    store.decideApproval(ap!.id, 'approved', 'quinn');
    // different content → a different detail → not approved
    expect((await tool.run({ op: 'config_set', path: 'config/alfred.yaml', content: 'a: 2\n' }, ctxFor(t.id))).park).toBeTruthy();
    expect(fetched.filter((f) => f.method !== 'GET')).toHaveLength(0);
    const ok = await tool.run({ op: 'config_set', path: 'config/alfred.yaml', content: 'a: 1\n' }, ctxFor(t.id));
    expect(ok.ok).toBe(true);
    expect(fetched.filter((f) => f.method !== 'GET')[0]).toMatchObject({ method: 'PUT', url: '/ops/config/file', body: { path: 'config/alfred.yaml', content: 'a: 1\n', confirm: true } });
  });

  it('validates qwen_set and reports route errors as text', async () => {
    const tool = platformTool(deps);
    expect((await tool.run({ op: 'qwen_set', slots: 4, ctx: 1024 }, ctxFor('chat:x'))).ok).toBe(false);
    replies['POST /ops/qwen'] = { status: 409, body: { error: 'tasks are running on the model' } };
    expect((await tool.run({ op: 'qwen_set', slots: 4, confirm: true }, ctxFor('chat:x'))).ok).toBe(false);
    expect(fetched).toHaveLength(0);
    // approved in the Inbox (the chat ask has an approval row)
    const [row] = store.approvals({ status: 'pending', taskId: 'chat:x' });
    expect(row!.detail).toBe('qwen:slots=4');
    store.decideApproval(row!.id, 'approved', 'dashboard');
    const r = await tool.run({ op: 'qwen_set', slots: 4 }, ctxFor('chat:x'));
    expect(r).toMatchObject({ ok: false, output: 'http 409: tasks are running on the model' });
    expect(fetched[0]!.body).toMatchObject({ slots: 4, confirm: true });
  });
});

describe('alfred_dev', () => {
  it('builds acceptance per area', () => {
    expect(devAcceptance('web').map((a) => a.name)).toEqual(['build-web', 'tests', 'typecheck']);
    expect(devAcceptance('server').map((a) => a.name)).toEqual(['tests', 'typecheck']);
  });

  it('deploys an approved alfred goal: merge → build-web → restart when src changed', async () => {
    // a real hub: the approval names the branch head and base head read from its refs
    const hub = new RepoHub({ root: join(root, 'git') });
    deps.repoHub = hub;
    const src = join(root, 'src-repo');
    const g = (args: string[], cwd = src) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    mkdirSync(src);
    g(['init', '-q', '-b', 'master']);
    writeFileSync(join(src, 'a.txt'), '1');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    const baseSha = g(['rev-parse', 'HEAD']);
    await hub.ensure('alfred', src);
    const tool = alfredDevTool(deps);
    expect((await tool.run({ op: 'propose', title: 'Tweak', spec: 's', area: 'bogus' }, ctxFor('chat:x'))).ok).toBe(false);
    expect((await tool.run({ op: 'propose', title: 'Tweak', spec: 's', area: 'server' }, ctxFor('chat:x'))).ok).toBe(true);
    const goal = store.listGoals().find((x) => x.title === 'Tweak')!;
    const other = store.createGoal({ title: 'elsewhere', meta: { repo: 'other' } } as any);
    expect((await tool.run({ op: 'deploy', goal: other.slug }, ctxFor('chat:x'))).output).toContain('not an alfred change');

    // the goal's branch in the hub
    g(['checkout', '-q', '-b', 'alfred/tweak/1']);
    writeFileSync(join(src, 'a.txt'), '2');
    g(['commit', '-q', '-am', 'change']);
    const head = g(['rev-parse', 'HEAD']);
    g(['push', '-q', hub.barePath('alfred'), 'alfred/tweak/1']);
    const t0 = store.listTasks(goal.id)[0]!;
    store.appendEvent(goal.id, t0.id, 'pushed', { branch: 'alfred/tweak/1', sha: 'stale-sha-from-event' });

    replies[`GET /goals/${goal.id}/changes`] = { status: 200, body: { files: [{ path: 'src/x.ts' }] } };
    replies[`POST /goals/${goal.id}/merge`] = { status: 200, body: { ok: true, into: 'master', sha: 'abcdef123456' } };
    const t = task();
    expect((await tool.run({ op: 'deploy', goal: goal.slug }, ctxFor(t.id))).park).toBeTruthy();
    expect(fetched).toHaveLength(0);
    const [ap] = store.approvals({ status: 'pending', taskId: t.id });
    expect(ap!.detail).toBe(`deploy:${goal.slug} alfred/tweak/1@${head} onto master@${baseSha}`);
    store.decideApproval(ap!.id, 'approved', 'quinn');
    const r = await tool.run({ op: 'deploy', goal: goal.slug }, ctxFor(t.id));
    expect(r.ok).toBe(true);
    expect(fetched.map((f) => `${f.method} ${f.url}`)).toEqual([
      `GET /goals/${goal.id}/changes`,
      `POST /goals/${goal.id}/merge`,
      'POST /ops/alfred/build-web',
      'POST /ops/services/alfred/restart',
    ]);
    // the merge is pinned to exactly the approved commits
    expect(fetched[1]!.body).toMatchObject({ confirm: true, branch: 'alfred/tweak/1', sha: head, into: 'master', baseSha });
    expect(r.output).toMatch(/merge: ok[\s\S]*build-web: ok[\s\S]*restart/);

    // a new commit on the branch → a different detail → the old approval doesn't cover it
    writeFileSync(join(src, 'a.txt'), '3');
    g(['commit', '-q', '-am', 'more']);
    g(['push', '-q', hub.barePath('alfred'), 'alfred/tweak/1']);
    const t2 = task();
    fetched = [];
    expect((await tool.run({ op: 'deploy', goal: goal.slug }, ctxFor(t2.id))).park).toBeTruthy();
    expect(store.approvals({ status: 'pending', taskId: t2.id })[0]!.detail).toContain(g(['rev-parse', 'HEAD']));
    expect(fetched).toHaveLength(0);
    expect(existsSync(root)).toBe(true);
  });
});
