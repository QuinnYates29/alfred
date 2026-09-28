// J1 unit tests — the jira client (stubbed fetch: URLs, Basic auth, ADF bodies, safe errors),
// the config/jira.yaml policy (fail closed, clamped), the agent tool (allowlist, caps, gate),
// the board import, and the /jira routes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import type { LLM, ToolContext } from '../../src/runtime/contract.js';
import { jiraClient, type JiraClient } from '../../src/jira/client.js';
import { loadJiraPolicy } from '../../src/jira/config.js';
import { jiraTool } from '../../src/jira/tool.js';
import { syncJira, mapPriority, type FakeItem } from '../../src/jira/sync.js';
import { startAlfred } from '../../src/main.js';

const SITE = 'https://test.atlassian.net';
const EMAIL = 'quinn@example.com';
const TOKEN = 'sup3r-s3cret';
const AUTH = 'Basic ' + Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');
const CREDS = { JIRA_SITE: SITE, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN };

type Call = { method: string; url: string; auth?: string; body?: any };
function stubFetch(handler: (method: string, url: string, body: any) => { status?: number; body: any }) {
  const calls: Call[] = [];
  const f = (async (url: string, init: any = {}) => {
    const method = String(init?.method ?? 'GET');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), auth: init?.headers?.authorization, body });
    const r = handler(method, String(url), body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const rawIssue = (key: string, over: Record<string, any> = {}) => ({
  key,
  fields: {
    summary: `sum ${key}`,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    priority: { name: 'High' },
    duedate: '2026-02-01',
    issuetype: { name: 'Task' },
    project: { key: 'WORK' },
    assignee: { displayName: 'Quinn' },
    updated: '2026-01-30T10:00:00.000+0000',
    labels: [],
    ...over,
  },
});

function mkCtx(taskId: string): ToolContext {
  return { taskId, goalId: '', workspace: root, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} };
}

let store: Store;
let root: string;

function depsFor(env: Record<string, string | undefined>, extra: Record<string, unknown> = {}): ModuleDeps {
  return {
    store, registry: new ToolRegistry(), env, repoRoot: root, personasDir: 'personas', workRoot: root,
    nodes: { list: () => [] } as any, repoHub: {} as any, deckState: { url: null },
    modules: {}, personas: new Map(), extra: { repoRoot: root, ...extra }, selfUrl: 'http://self', token: 'tok',
  };
}

beforeEach(() => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'alfred-jira-'));
  mkdirSync(join(root, 'config'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('jira client', () => {
  it('is null when unconfigured and builds search with Basic auth', async () => {
    expect(jiraClient({}, fetch)).toBeNull();
    expect(jiraClient({ JIRA_SITE: 'http://evil.example.com', JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN }, fetch)).toBeNull();
    expect(jiraClient({ JIRA_SITE: 'https://notjira.example.com', JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN }, fetch)).toBeNull();
    const { f, calls } = stubFetch(() => ({ body: { issues: [rawIssue('WORK-1')] } }));
    const c = jiraClient(CREDS, f)!;
    const r = await c.search('project = WORK', 99);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${SITE}/rest/api/3/search/jql`, auth: AUTH });
    expect(calls[0]!.body).toMatchObject({ jql: 'project = WORK', maxResults: 50 });
    expect(calls[0]!.body.fields).toContain('duedate');
    expect(r.issues[0]).toMatchObject({
      key: 'WORK-1', summary: 'sum WORK-1', status: 'In Progress', statusCategory: 'indeterminate',
      priority: 'High', due: '2026-02-01', type: 'Task', project: 'WORK', assignee: 'Quinn', url: `${SITE}/browse/WORK-1`,
    });
  });

  it('get returns the issue with the ADF description flattened', async () => {
    const adf = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'line one' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] },
    ] };
    const { f, calls } = stubFetch(() => ({ body: { ...rawIssue('WORK-2'), fields: { ...rawIssue('WORK-2').fields, description: adf } } }));
    const i = await jiraClient(CREDS, f)!.get('WORK-2');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain(`${SITE}/rest/api/3/issue/WORK-2?fields=`);
    expect(calls[0]!.url).toContain('description');
    expect(i.description).toContain('line one');
    expect(i.description).toContain('line two');
    expect(String(i.description)).not.toContain('[object');
  });

  it('create posts ADF (one paragraph per line) with the alfred label', async () => {
    const { f, calls } = stubFetch(() => ({ body: { key: 'WORK-9' } }));
    const r = await jiraClient(CREDS, f)!.create({ project: 'WORK', type: 'Task', summary: 's', description: 'a\nb', labels: ['alfred'] });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${SITE}/rest/api/3/issue`, auth: AUTH });
    expect(calls[0]!.body.fields).toMatchObject({ project: { key: 'WORK' }, issuetype: { name: 'Task' }, summary: 's', labels: ['alfred'] });
    const d = calls[0]!.body.fields.description;
    expect(d.type).toBe('doc');
    expect(d.content).toHaveLength(2);
    expect(d.content[0].content[0].text).toBe('a');
    expect(r).toEqual({ key: 'WORK-9', url: `${SITE}/browse/WORK-9` });
  });

  it('comment posts ADF and myself works', async () => {
    const { f, calls } = stubFetch((m, u) => ({ body: u.endsWith('/comment') ? { id: '10001' } : { accountId: 'acc-1', displayName: 'Quinn Yates' } }));
    const c = jiraClient(CREDS, f)!;
    expect(await c.comment('WORK-1', 'hello')).toEqual({ id: '10001' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${SITE}/rest/api/3/issue/WORK-1/comment`, auth: AUTH });
    expect(calls[0]!.body.body.type).toBe('doc');
    expect(await c.myself()).toEqual({ accountId: 'acc-1', displayName: 'Quinn Yates' });
  });

  it('errors carry status + messages but never the token', async () => {
    const { f } = stubFetch(() => ({ status: 401, body: { errorMessages: ['Unauthorized', `no auth for ${EMAIL}`] } }));
    const e = await jiraClient(CREDS, f)!.search('x', 5).catch((err: Error) => err);
    expect(String((e as Error).message)).toMatch(/Jira 401: Unauthorized/);
    expect((e as Error).message).not.toContain(TOKEN);
    const thrower = (async () => {
      throw new Error(`ECONNREFUSED ${EMAIL}:${TOKEN}`);
    }) as unknown as typeof fetch;
    const e2 = await jiraClient(CREDS, thrower)!.search('x', 5).catch((err: Error) => err);
    expect((e2 as Error).message).not.toContain(TOKEN);
    expect((e2 as Error).message).toContain('Jira');
  });

  it('rejects bad issue keys before making any request', async () => {
    const { f, calls } = stubFetch(() => ({ body: {} }));
    const c = jiraClient(CREDS, f)!;
    for (const bad of ['work-1', 'ABC-01234567', 'A-12345678', 'X 1', '../etc/passwd', 'WORK-1/comment', '']) {
      await expect(c.get(bad)).rejects.toThrow(/invalid Jira issue key/);
      await expect(c.comment(bad, 'hi')).rejects.toThrow(/invalid Jira issue key/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('jira policy', () => {
  const write = (yaml: string) => writeFileSync(join(root, 'config', 'jira.yaml'), yaml);

  it('missing file = safe defaults (projects empty)', () => {
    const p = loadJiraPolicy(depsFor({}));
    expect(p.projects).toEqual([]);
    expect(p.issueTypes).toEqual(['Task', 'Bug']);
    expect(p.limits).toEqual({ createsPerDay: 5, commentsPerDay: 20, searchesPerHour: 60 });
    expect(p.import.enabled).toBe(false);
    expect(p.import.everyMinutes).toBe(15);
  });

  it('broken yaml = defaults too (fail closed)', () => {
    write('projects: [WORK\nlimits: {oops');
    expect(loadJiraPolicy(depsFor({})).projects).toEqual([]);
  });

  it('drops invalid project names and clamps numbers', () => {
    write([
      'projects: [WORK, work, A, WAYTOOLONGPROJECTNAME, OPS_2, WORK]',
      'issueTypes: [Task, Story]',
      'limits:',
      '  createsPerDay: 999',
      '  commentsPerDay: 5000',
      '  searchesPerHour: 100000',
      'import:',
      '  enabled: true',
      '  everyMinutes: 1',
      '  max: 900',
    ].join('\n'));
    const p = loadJiraPolicy(depsFor({}));
    expect(p.projects).toEqual(['WORK', 'OPS_2']);
    expect(p.issueTypes).toEqual(['Task', 'Story']);
    expect(p.limits).toEqual({ createsPerDay: 50, commentsPerDay: 200, searchesPerHour: 600 });
    expect(p.import).toMatchObject({ enabled: true, everyMinutes: 5, max: 100 });
  });
});

describe('jira tool', () => {
  const policy = (yaml: string) => writeFileSync(join(root, 'config', 'jira.yaml'), yaml);
  const okPolicy = () => policy('projects: [WORK]\n');
  const task = () => {
    const g = store.createGoal({ title: 'g' });
    return store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
  };
  const seed = (kind: 'create' | 'comment' | 'search', n: number, data: Record<string, unknown> = {}) => {
    for (let i = 0; i < n; i++) store.appendEvent('', null, 'jira', { kind, ok: true, ...data });
  };
  const goodFetch = () => stubFetch((m, u) => ({ body: u.endsWith('/search/jql') ? { issues: [rawIssue('WORK-5')] } : { key: 'WORK-42', id: 'c1' } }));

  it('refuses unknown ops and works unconfigured only with the config message', async () => {
    const t = jiraTool(depsFor(CREDS, { fetch: goodFetch() }));
    for (const op of ['transition', 'delete', 'assign', 'edit', 'bulk']) {
      const r = await t.run({ op }, mkCtx('t0'));
      expect(r.ok).toBe(false);
      expect(r.output).toBe('not allowed: jira supports search, get, create, comment only');
    }
    const bare = jiraTool(depsFor({}));
    expect((await bare.run({ op: 'search', jql: 'x' }, mkCtx('t0'))).output).toContain('JIRA_API_TOKEN');
  });

  it('create: allowlist, type, summary and duplicate rules', async () => {
    const run = (a: Record<string, unknown>) => jiraTool(depsFor(CREDS, { fetch: goodFetch() })).run(a as any, mkCtx('t1'));
    expect((await run({ op: 'create', project: 'WORK', type: 'Task', summary: 'fix the thing' })).output).toContain('no Jira projects are allowed');
    okPolicy();
    expect((await run({ op: 'create', project: 'OPS', type: 'Task', summary: 'fix the thing' })).output).toContain('Allowed: WORK');
    expect((await run({ op: 'create', project: 'WORK', type: 'Epic', summary: 'fix the thing' })).output).toContain('issue type');
    expect((await run({ op: 'create', project: 'WORK', type: 'Task', summary: 'no' })).output).toContain('summary');
    expect((await run({ op: 'create', project: 'WORK', type: 'Task', summary: 'two\nlines' })).output).toContain('summary');
    seed('create', 1, { summary: 'fix the thing' });
    expect((await run({ op: 'create', project: 'WORK', type: 'Task', summary: 'fix the thing' })).output).toContain('already created');
  });

  it('create: daily cap refuses', async () => {
    okPolicy();
    policy('projects: [WORK]\nlimits:\n  createsPerDay: 2\n');
    seed('create', 2);
    const r = await jiraTool(depsFor(CREDS, { fetch: goodFetch() })).run({ op: 'create', project: 'WORK', type: 'Task', summary: 'a new one' }, mkCtx('t2'));
    expect(r.output).toContain('daily limit of 2 Jira tickets reached');
  });

  it('create parks for Quinn, then creates exactly one ticket labelled alfred', async () => {
    okPolicy();
    const { f, calls } = goodFetch();
    const t = jiraTool(depsFor(CREDS, { fetch: f }));
    const g = store.createGoal({ title: 'g' });
    const tk = store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
    const ctx = mkCtx(tk.id);
    const r1 = await t.run({ op: 'create', project: 'WORK', type: 'Task', summary: 'ship the report', description: 'by friday' }, ctx);
    expect(r1.ok).toBe(false);
    expect(r1.output).toContain('approval needed: jira.create');
    expect(calls).toHaveLength(0);
    const ap = store.approvals({ status: 'pending', taskId: tk.id }).find((a) => a.action === 'jira.create');
    expect(ap).toBeTruthy();
    store.decideApproval(ap!.id, 'approved', 'quinn');
    const r2 = await t.run({ op: 'create', project: 'WORK', type: 'Task', summary: 'ship the report', description: 'by friday' }, ctx);
    expect(r2.ok).toBe(true);
    expect(r2.output).toBe(`created WORK-42 ${SITE}/browse/WORK-42`);
    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.fields.labels).toContain('alfred');
    const text = JSON.stringify(posts[0]!.body.fields.description);
    expect(text).toContain('by friday');
    expect(text).toContain('— created by alfred (Quinn');
  });

  it('comment: needs an allowed project and Quinns OK; honors its cap', async () => {
    const { f, calls } = goodFetch();
    const deps = depsFor(CREDS, { fetch: f });
    const t = jiraTool(deps);
    expect((await t.run({ op: 'comment', key: 'WORK-1', text: 'hi' }, mkCtx('t3'))).output).toContain('is not allowed');
    okPolicy();
    const g = store.createGoal({ title: 'g' });
    const tk = store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
    expect((await t.run({ op: 'comment', key: 'WORK-1', text: 'hi' }, mkCtx(tk.id))).output).toContain('approval needed: jira.comment');
    const ap = store.approvals({ status: 'pending', taskId: tk.id }).find((a) => a.action === 'jira.comment');
    store.decideApproval(ap!.id, 'approved', 'quinn');
    expect((await t.run({ op: 'comment', key: 'WORK-1', text: 'hi' }, mkCtx(tk.id))).ok).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/issue/WORK-1/comment'))).toBe(true);
    policy('projects: [WORK]\nlimits:\n  commentsPerDay: 1\n');
    seed('comment', 1);
    expect((await t.run({ op: 'comment', key: 'WORK-2', text: 'again' }, mkCtx(tk.id))).output).toContain('daily limit of 1 Jira comments reached');
  });

  it('search: needs jql, honors the hourly cap', async () => {
    policy('projects: [WORK]\nlimits:\n  searchesPerHour: 1\n');
    const { f, calls } = goodFetch();
    const t = jiraTool(depsFor(CREDS, { fetch: f }));
    expect((await t.run({ op: 'search' }, mkCtx('t4'))).output).toContain('jql is required');
    const r1 = await t.run({ op: 'search', jql: 'project = WORK' }, mkCtx('t4'));
    expect(r1.ok).toBe(true);
    expect(r1.output).toContain('WORK-5 [In Progress] (Task, High) sum WORK-5 — due 2026-02-01');
    expect(r1.output).toContain('1 issue');
    const r2 = await t.run({ op: 'search', jql: 'project = WORK' }, mkCtx('t4'));
    expect(r2.output).toContain('hourly limit of 1 Jira searches reached');
    expect(calls.filter((c) => c.url.endsWith('/search/jql'))).toHaveLength(1);
  });
});

// ---- sync: fake board + fake client ----
function fakeBoard() {
  const state = {
    def: { id: 'b1', key: 'MAIN', name: 'Work', columns: [
      { id: 'c1', name: 'To do', kind: 'todo' as const }, { id: 'c2', name: 'In progress', kind: 'indeterminate' as const }, { id: 'c3', name: 'Done', kind: 'done' as const },
    ], fields: [] as any[], createdAt: 0, updatedAt: 0 },
    items: [] as FakeItem[],
    boardUpdates: 0,
  };
  let n = 0;
  const board = {
    getBoard: () => state.def,
    defaultBoard: () => state.def,
    updateBoard: (_k: string, patch: { fields?: any[] }) => {
      state.boardUpdates++;
      if (patch.fields) state.def.fields = patch.fields;
      return state.def;
    },
    listItems: (q: any = {}) => state.items.filter((i) => q.includeArchived || !i.archived),
    createItem: (i: any) => {
      const it: FakeItem = {
        key: `B-${++n}`, boardId: 'MAIN', title: i.title, description: i.description ?? '', status: 'To do', kind: 'todo',
        priority: i.priority ?? 'none', labels: i.labels ?? [], due: i.due ?? null, fields: i.fields ?? {}, archived: false,
      };
      state.items.push(it);
      return it;
    },
    updateItem: (key: string, patch: Partial<FakeItem>) => {
      const it = state.items.find((x) => x.key === key)!;
      Object.assign(it, patch);
      return it;
    },
    moveItem: (key: string, to: { status: string }) => {
      const it = state.items.find((x) => x.key === key)!;
      it.status = to.status;
      it.kind = to.status === 'Done' ? 'done' : 'todo';
      return it;
    },
  };
  return { board: board as any, state };
}
const impPolicy = () => {
  policyImport();
  return loadJiraPolicy(depsFor(CREDS));
};
function policyImport() {
  writeFileSync(join(root, 'config', 'jira.yaml'), 'projects: [WORK]\nimport:\n  enabled: true\n  board: MAIN\n');
}
const issueOf = (key: string, over: Record<string, any> = {}) => ({
  key, summary: `sum ${key}`, status: 'In Progress', statusCategory: 'indeterminate' as const, priority: 'High',
  due: '2026-02-01', type: 'Task', project: 'WORK', assignee: null, updated: 'u', url: `${SITE}/browse/${key}`, ...over,
});

describe('jira sync', () => {
  const clientWith = (issues: () => any[]): JiraClient => ({ search: async () => ({ issues: issues() }), get: async () => ({} as any), create: async () => ({ key: '', url: '' }), comment: async () => ({ id: '' }), myself: async () => ({ accountId: '', displayName: '' }) });

  it('adds the jira field once, creates items with labels/priority, skips done issues', async () => {
    const { board, state } = fakeBoard();
    const issues = [issueOf('WORK-1'), issueOf('WORK-3', { statusCategory: 'done' as const, priority: 'Lowest' })];
    const r = await syncJira(depsFor(CREDS), board, clientWith(() => issues), impPolicy());
    expect(r.created).toEqual(['WORK-1']);
    expect(state.boardUpdates).toBe(1);
    expect(state.def.fields.some((f: any) => f.id === 'jira' && f.type === 'url')).toBe(true);
    const it = state.items[0]!;
    expect(it.title).toBe('WORK-1 sum WORK-1');
    expect(it.labels).toEqual(['jira', 'work']);
    expect(it.priority).toBe('high');
    expect(it.due).toBe('2026-02-01');
    expect(it.fields.jira).toBe(`${SITE}/browse/WORK-1`);
    expect(r.errors).toEqual([]);

    const r2 = await syncJira(depsFor(CREDS), board, clientWith(() => issues), impPolicy());
    expect(r2.created).toEqual([]);
    expect(r2.updated).toEqual([]);
    expect(state.boardUpdates).toBe(1);
  });

  it('a changed summary updates the title only; a done issue moves to the done column', async () => {
    const { board, state } = fakeBoard();
    const v1 = [issueOf('WORK-1')];
    await syncJira(depsFor(CREDS), board, clientWith(() => v1), impPolicy());
    const v2 = [issueOf('WORK-1', { summary: 'new summary' })];
    const r2 = await syncJira(depsFor(CREDS), board, clientWith(() => v2), impPolicy());
    expect(r2.updated).toEqual(['WORK-1']);
    expect(r2.created).toEqual([]);
    expect(state.items[0]!.title).toBe('WORK-1 new summary');
    const v3 = [issueOf('WORK-1', { summary: 'new summary', statusCategory: 'done' as const })];
    const r3 = await syncJira(depsFor(CREDS), board, clientWith(() => v3), impPolicy());
    expect(r3.closed).toEqual(['WORK-1']);
    expect(state.items[0]!.status).toBe('Done');
    expect(state.items).toHaveLength(1);
  });

  it('an item Quinn archived is not re-imported or updated', async () => {
    const { board, state } = fakeBoard();
    await syncJira(depsFor(CREDS), board, clientWith(() => [issueOf('WORK-1')]), impPolicy());
    state.items[0]!.archived = true;
    const r = await syncJira(depsFor(CREDS), board, clientWith(() => [issueOf('WORK-1', { summary: 'changed' })]), impPolicy());
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]!.title).toBe('WORK-1 sum WORK-1');
  });

  it('maps priorities', () => {
    expect(mapPriority('Highest')).toBe('urgent');
    expect(mapPriority('Blocker')).toBe('urgent');
    expect(mapPriority('High')).toBe('high');
    expect(mapPriority('Medium')).toBe('medium');
    expect(mapPriority('Low')).toBe('low');
    expect(mapPriority('Lowest')).toBe('low');
    expect(mapPriority(null)).toBe('none');
  });
});

// ---- routes ----
const idle: LLM = { async chat() { return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; } };

describe('jira routes', () => {
  it('GET /jira/status answers configured:false when unconfigured', async () => {
    const base = mkdtempSync(join(tmpdir(), 'alfred-jira-r1-'));
    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, 'config'), { recursive: true });
    const a = await startAlfred({
      dbPath: join(base, 'a.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas',
      port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: idle, gitRoot: join(base, 'git'),
      extra: { repoRoot, llm: idle },
    });
    try {
      const s = await (await fetch(`${a.url}/api/v1/jira/status`)).json();
      expect(s.configured).toBe(false);
      expect(s.policy.projects).toEqual([]);
      expect(s.usage).toMatchObject({ createsToday: 0 });
    } finally {
      await a.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('POST /jira/items/:key/ticket creates a ticket and sets the items jira field', async () => {
    const base = mkdtempSync(join(tmpdir(), 'alfred-jira-r2-'));
    const repoRoot = join(base, 'repo');
    mkdirSync(join(repoRoot, 'config'), { recursive: true });
    writeFileSync(join(repoRoot, 'config', 'jira.yaml'), 'projects: [WORK]\nissueTypes: [Task, Bug]\n');
    const { f, calls } = stubFetch((m, u) => ({ body: u.endsWith('/search/jql') ? { issues: [] } : { key: 'WORK-42' } }));
    const a = await startAlfred({
      dbPath: join(base, 'a.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas',
      port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0', ...CREDS }, llm: idle, gitRoot: join(base, 'git'),
      extra: { repoRoot, llm: idle, fetch: f },
    });
    try {
      const board = (a.modules as any).board.board;
      const item = board.createItem({ title: 'Fix the widget', description: 'the widget is broken', labels: [] });
      const res = await fetch(`${a.url}/api/v1/jira/items/${item.key}/ticket`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'WORK', type: 'Task' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: 'WORK-42', url: `${SITE}/browse/WORK-42` });
      const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/rest/api/3/issue'));
      expect(post).toBeTruthy();
      expect(post!.body.fields.summary).toBe('Fix the widget');
      const got = board.getItem(item.key);
      expect(got.fields.jira).toBe(`${SITE}/browse/WORK-42`);
      expect(got.labels).toContain('jira');
      const bad = await fetch(`${a.url}/api/v1/jira/items/${item.key}/ticket`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'NOPE', type: 'Task' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await a.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
