// P10 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { RepoHub } from '../../../src/git/hub.js';
import { resolveWorkspace } from '../../../src/workspace.js';
import { guardCommand } from '../../../src/approvals.js';
import { openStore } from '../../../src/store.js';
import { NodeHub } from '../../../src/node/hub.js';
import { connectNode } from '../../../src/node/client.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { scriptedLLM, call } from '../../../src/runtime/testing.js';

const git = (cwd: string, cmd: string) => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' }).trim();
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `alfred-${p}-`));
function sourceRepo(): string {
  const d = tmp('src');
  execSync('git init -q -b main && echo one > a.txt && git add . && git -c user.email=a@b -c user.name=t commit -q -m init', { cwd: d });
  return d;
}
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); }
};
let cleanup: (() => any)[] = [];
afterEach(async () => { for (const c of cleanup.reverse()) await c(); cleanup = []; });

describe('repo hub on the Spark', () => {
  it('creates a bare hub seeded from a source repo, idempotently, with per-machine URLs', async () => {
    const hub = new RepoHub({ root: tmp('hub'), sshUser: 'quinna', sshHost: 'gx10-de9a' });
    const src = sourceRepo();
    const p = await hub.ensure('proj', src);
    expect(p).toBe(hub.barePath('proj'));
    expect(git(p, 'rev-parse --is-bare-repository')).toBe('true');
    expect(await hub.branches('proj')).toContain('main');
    expect(await hub.ensure('proj', src)).toBe(p);
    expect(hub.urlFor('proj', 'local')).toBe(p);
    expect(hub.urlFor('proj', 'macbook')).toBe(`ssh://quinna@gx10-de9a${p}`);
  });

  it('pushes to the spark remote are not guarded; other pushes still are', () => {
    expect(guardCommand('git push spark HEAD:alfred/x/1234abcd')).toBeNull();
    expect(guardCommand('git push -u spark alfred/x/1234abcd')).toBeNull();
    expect(guardCommand('git push origin main')).not.toBeNull();
    expect(guardCommand('git push')).not.toBeNull();
  });
});

describe('workspace modes on the Spark', () => {
  function setup() {
    const store = openStore(':memory:');
    const hub = new RepoHub({ root: tmp('hub') });
    const src = sourceRepo();
    store.upsertRepo({ name: 'proj', paths: { local: src } });
    return { store, hub, src, root: tmp('work') };
  }

  it('sandbox mode clones the hub into the sandbox root with a spark remote and task branch', async () => {
    const { store, hub, src, root } = setup();
    const g = store.createGoal({ title: 'Sandboxed', meta: { repo: 'proj', mode: 'sandbox' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    const ws = await resolveWorkspace(store, t, { root, hub } as any);
    expect(ws.path.startsWith(root)).toBe(true);
    expect(readFileSync(join(ws.path, 'a.txt'), 'utf8').trim()).toBe('one');
    expect(git(ws.path, 'remote get-url spark')).toBe(hub.barePath('proj'));
    expect(git(ws.path, 'branch --show-current')).toBe(`alfred/sandboxed/${t.id.slice(0, 8)}`);
    expect(git(src, 'branch --show-current')).toBe('main');
  });

  it('repo mode works in a worktree inside the existing repo and adds a spark remote to it', async () => {
    const { store, hub, src, root } = setup();
    const g = store.createGoal({ title: 'In Repo', meta: { repo: 'proj', mode: 'repo' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    const ws = await resolveWorkspace(store, t, { root, hub } as any);
    expect(ws.path).toBe(join(src, '.alfred-worktrees', t.id.slice(0, 8)));
    expect(git(src, 'remote get-url spark')).toBe(hub.barePath('proj'));
    expect(git(ws.path, 'branch --show-current')).toBe(`alfred/in-repo/${t.id.slice(0, 8)}`);
  });

  it('repo mode inPlace branches the checkout itself, refusing a dirty tree', async () => {
    const { store, hub, src, root } = setup();
    const g = store.createGoal({ title: 'Here', meta: { repo: 'proj', mode: 'repo', inPlace: true } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    writeFileSync(join(src, 'dirty.txt'), 'x');
    await expect(resolveWorkspace(store, t, { root, hub } as any)).rejects.toThrow(/dirty/);
    execSync('rm dirty.txt', { cwd: src });
    const ws = await resolveWorkspace(store, t, { root, hub } as any);
    expect(ws.path).toBe(src);
    expect(git(src, 'branch --show-current')).toBe(`alfred/here/${t.id.slice(0, 8)}`);
  });

  it('an absolute path repo is auto-registered', async () => {
    const { store, hub, root } = setup();
    const other = sourceRepo();
    const g = store.createGoal({ title: 'Adhoc', meta: { repo: other, mode: 'repo' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    await resolveWorkspace(store, t, { root, hub } as any);
    expect(store.listRepos().some(r => r.paths.local === other)).toBe(true);
  });

  it('a finished task is committed and pushed to the hub', async () => {
    const { store, hub, root } = setup();
    const reg = new ToolRegistry();
    for (const x of allTools()) reg.register(x);
    const personas = loadPersonas('personas', reg);
    const g = store.createGoal({ title: 'Pushy', meta: { repo: 'proj', mode: 'sandbox' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'add b', acceptance: [{ name: 'b', cmd: 'test -f b.txt' }] });
    const end = await runTask(t.id, { store, personas, registry: reg, workerId: 'w', workRoot: root, hub, pollMs: 20,
      llm: scriptedLLM([
        { toolCalls: [call('write_file', { path: 'b.txt', content: 'two' })] },
        { toolCalls: [call('finish', { summary: 'added b' })] },
      ]) } as any);
    expect(end.status).toBe('done');
    const branch = `alfred/pushy/${t.id.slice(0, 8)}`;
    await until(() => (git(hub.barePath('proj'), 'branch --list') as string).includes(branch));
    expect(git(hub.barePath('proj'), `show ${branch}:b.txt`)).toBe('two');
    expect(store.events(g.id).some(e => e.kind === 'pushed')).toBe(true);
  }, 20_000);
});

describe('workspace on a node (the Mac) is wired to the Spark hub', () => {
  it('clones from the hub URL for that node into the node sandbox, and the remote points back at the hub', async () => {
    const nodes = new NodeHub({ token: 'tok' });
    const srv: Server = createServer();
    nodes.attach(srv);
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    cleanup.push(() => { nodes.close(); srv.close(); });
    const macRoot = tmp('mac');
    const n = connectNode({ url: `ws://127.0.0.1:${(srv.address() as any).port}`, token: 'tok', name: 'macbook', roots: [macRoot],
      caps: ['fs', 'shell', 'git'], sandbox: join(macRoot, 'alfred-sandbox'), reconnect: false } as any);
    cleanup.push(() => n.close());
    await until(() => nodes.list().length === 1);

    // In the test the "ssh" URL for the node is just the local bare path.
    const hub = new RepoHub({ root: tmp('hub'), urlForNode: (_node, bare) => bare });
    const store = openStore(':memory:');
    store.upsertRepo({ name: 'proj', paths: { local: sourceRepo() } });
    const g = store.createGoal({ title: 'On Mac', meta: { repo: 'proj', where: 'macbook', mode: 'sandbox' } });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    const ws = await resolveWorkspace(store, t, { root: tmp('work'), hub, nodes } as any);
    expect(ws.backend.node).toBe('macbook');
    expect(ws.path.startsWith(join(macRoot, 'alfred-sandbox'))).toBe(true);
    expect(existsSync(join(ws.path, 'a.txt'))).toBe(true);
    expect(git(ws.path, 'remote get-url spark')).toBe(hub.barePath('proj'));
  }, 20_000);
});
