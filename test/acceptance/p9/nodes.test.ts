// P9 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NodeHub } from '../../../src/node/hub.js';
import { connectNode } from '../../../src/node/client.js';
import { resolveWorkspace } from '../../../src/workspace.js';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { scriptedLLM, call } from '../../../src/runtime/testing.js';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { NodeOfflineError } from '../../../src/runtime/contract.js';

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); }
};

let cleanup: (() => any)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

async function hubServer(token = 'tok') {
  const hub = new NodeHub({ token, callTimeoutMs: 5000 });
  const srv: Server = createServer((_q, s) => { s.statusCode = 404; s.end(); });
  hub.attach(srv);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(srv.address() as any).port}`;
  cleanup.push(() => { hub.close(); srv.close(); });
  return { hub, url };
}

describe('node protocol', () => {
  it('rejects a bad token, registers a good node, and enforces its roots', async () => {
    const { hub, url } = await hubServer();
    const root = mkdtempSync(join(tmpdir(), 'alfred-node-root-'));
    const bad = connectNode({ url, token: 'wrong', name: 'evil', roots: [root], reconnect: false });
    cleanup.push(() => bad.close());
    const good = connectNode({ url, token: 'tok', name: 'macbook', roots: [root], caps: ['fs', 'shell', 'git'], reconnect: false });
    cleanup.push(() => good.close());
    await until(() => hub.list().some(n => n.name === 'macbook'));
    await new Promise(r => setTimeout(r, 200));
    expect(hub.list().map(n => n.name)).toEqual(['macbook']);

    const be = hub.backend('macbook');
    expect(be.node).toBe('macbook');
    await be.writeFile(join(root, 'sub/a.txt'), 'hello');
    expect(readFileSync(join(root, 'sub/a.txt'), 'utf8')).toBe('hello');
    expect(await be.readFile(join(root, 'sub/a.txt'))).toBe('hello');
    expect((await be.listDir(root)).map(e => e.name)).toContain('sub');
    const r = await be.exec('pwd; echo out; exit 4', { cwd: root, timeoutMs: 5000 });
    expect(r.exitCode).toBe(4);
    expect(r.output).toContain(root);
    await expect(be.readFile('/etc/hostname')).rejects.toThrow(/outside node roots/);
    await expect(be.exec('true', { cwd: '/', timeoutMs: 1000 })).rejects.toThrow(/outside node roots/);
    const t0 = Date.now();
    const slow = await be.exec('sleep 30', { cwd: root, timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 20_000);

  it('an absent node raises NodeOfflineError and onChange reports connect/disconnect', async () => {
    const { hub, url } = await hubServer();
    await expect(hub.backend('ghost').readFile('/x')).rejects.toBeInstanceOf(NodeOfflineError);
    const seen: string[] = [];
    hub.onChange(e => seen.push(`${e.node}:${e.online}`));
    const n = connectNode({ url, token: 'tok', name: 'lap', roots: [tmpdir()], reconnect: false });
    await until(() => seen.includes('lap:true'));
    n.close();
    await until(() => seen.includes('lap:false'));
  }, 15_000);
});

describe('tasks on a node workspace', () => {
  it('tools and the acceptance gate run on the node; losing the node parks the task loudly', async () => {
    const { hub, url } = await hubServer();
    const root = mkdtempSync(join(tmpdir(), 'alfred-lap-'));
    const repo = join(root, 'proj');
    const node = connectNode({ url, token: 'tok', name: 'lap', roots: [root], caps: ['fs', 'shell'], reconnect: false });
    await until(() => hub.list().length === 1);
    await hub.backend('lap').writeFile(join(repo, 'README.md'), '# proj');

    const store = openStore(':memory:');
    const reg = new ToolRegistry();
    for (const t of allTools()) reg.register(t);
    const personas = loadPersonas('personas', reg);
    const g = store.createGoal({ title: 'Laptop Goal', meta: { node: 'lap', repo } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'NODE-TASK', spec: 's',
      acceptance: [{ name: 'made', cmd: 'test -f made.txt && grep -q laptop made.txt' }] });
    const ws = await resolveWorkspace(store, t, { root: mkdtempSync(join(tmpdir(), 'alfred-spark-')), nodes: hub });
    expect(ws.backend.node).toBe('lap');

    const o = { store, personas, registry: reg, workerId: 'w', nodes: hub, workRoot: mkdtempSync(join(tmpdir(), 'alfred-spark-')), pollMs: 20 };
    const end = await runTask(t.id, { ...o, llm: scriptedLLM([
      { toolCalls: [call('write_file', { path: 'made.txt', content: 'made on the laptop' })] },
      { toolCalls: [call('run_shell', { cmd: 'cat README.md' })] },
      { toolCalls: [call('finish', { summary: 'done' })] },
    ]) } as any);
    expect(end.status).toBe('done');
    expect(existsSync(join(ws.path, 'made.txt'))).toBe(true);

    const t2 = store.createTask({ goalId: g.id, persona: 'coder', title: 'NODE-TASK-2', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    node.close();
    await until(() => hub.list().length === 0);
    const end2 = await runTask(t2.id, { ...o, llm: scriptedLLM([
      { toolCalls: [call('write_file', { path: 'x.txt', content: 'x' })] },
    ]) } as any);
    expect(end2.status).toBe('blocked');
    expect(end2.reason).toBe('node lap offline');
  }, 30_000);
});

describe('remote access through startAlfred', () => {
  let alfred: Alfred | undefined;
  afterEach(async () => { await alfred?.stop(); alfred = undefined; });

  it('refuses a public bind without a token; serves the door over HTTP MCP; requeues blocked tasks when their node returns', async () => {
    const base = mkdtempSync(join(tmpdir(), 'alfred-remote-'));
    const common = { dbPath: join(base, 'a.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'), personasDir: 'personas',
      port: 0, deck: null, pollMs: 25, llm: scriptedLLM([]) };
    await expect(startAlfred({ ...common, host: '0.0.0.0', env: { ALFRED_NOTIFY_DESKTOP: '0' } } as any)).rejects.toThrow(/token/i);

    alfred = await startAlfred({ ...common, host: '127.0.0.1', env: { ALFRED_NOTIFY_DESKTOP: '0', ALFRED_TOKEN: 'tok' } } as any);
    const client = new Client({ name: 'laptop-claude', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${alfred.url}/mcp`), { requestInit: { headers: { Authorization: 'Bearer tok' } } }));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('alfred_status');
    expect(names).toContain('alfred_claim');
    await client.close();
    const unauth = await fetch(`${alfred.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauth.status).toBe(401);

    const g = alfred.store.createGoal({ title: 'requeue', meta: { node: 'lap', repo: '/tmp' } });
    const t = alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'r', acceptance: [{ name: 'a', cmd: 'true' }] });
    alfred.store.transition(t.id, 'blocked', { reason: 'node lap offline' });
    const other = alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'r2', acceptance: [{ name: 'a', cmd: 'true' }] });
    alfred.store.transition(other.id, 'blocked', { reason: 'approval needed: git push' });
    const wsUrl = alfred.url.replace('http', 'ws');
    const node = connectNode({ url: wsUrl, token: 'tok', name: 'lap', roots: [tmpdir()], reconnect: false });
    cleanup.push(() => node.close());
    await until(() => alfred!.store.getTask(t.id)!.status !== 'blocked');
    expect(alfred.store.getTask(t.id)!.notes).toContain('node lap back online');
    expect(alfred.store.getTask(other.id)!.status).toBe('blocked');
  }, 30_000);
});

describe('Mac-first additions', () => {
  it('notifications are delivered to nodes that advertise notify', async () => {
    const { hub, url } = await hubServer();
    const got: any[] = [];
    const n = connectNode({ url, token: 'tok', name: 'mac', roots: [tmpdir()], caps: ['fs', 'shell', 'notify'], reconnect: false,
      onNotify: (m: any) => got.push(m) } as any);
    cleanup.push(() => n.close());
    await until(() => hub.list().length === 1);
    const { nodeNotifySink } = await import('../../../src/notify/sinks.js');
    await nodeNotifySink(hub).send({ level: 'failure', goalId: 'g', title: 'Build failed', body: 'tests red' });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ level: 'failure', title: 'Build failed' });
  }, 15_000);

  it('langgraph_code works on a node workspace through the file bridge', async () => {
    const { hub, url } = await hubServer();
    const root = mkdtempSync(join(tmpdir(), 'alfred-mac-'));
    const n = connectNode({ url, token: 'tok', name: 'mac', roots: [root], caps: ['fs', 'shell'], reconnect: false });
    cleanup.push(() => n.close());
    await until(() => hub.list().length === 1);
    const { langgraphTool } = await import('../../../src/executors/langgraph.js');
    const srv = createServer((req, res) => {
      let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
        const first = !(JSON.parse(b).messages as any[]).some(m => m.role === 'tool');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: first
            ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'answer.txt', content: '42' }) } }] }
            : { role: 'assistant', content: 'done' } }] }));
      });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    cleanup.push(() => srv.close());
    const ctx: any = { taskId: 't', goalId: 'g', workspace: root, persona: 'coder-lg', signal: new AbortController().signal,
      acceptance: [{ name: 'a', cmd: 'grep -q 42 answer.txt' }], progress: () => {}, backend: hub.backend('mac') };
    const r = await langgraphTool({ baseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, model: 'm' }).run({ task: 'answer' }, ctx);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(root, 'answer.txt'), 'utf8')).toBe('42');
  }, 60_000);
});
