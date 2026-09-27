// P14 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../../src/store.js';
import { createApp } from '../../../src/server/app.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import type { ModuleDeps } from '../../../src/modules.js';
import { createOpsModule } from '../../../src/ops/index.js';

type Call = { cmd: string; args: string[]; o?: any };

function world() {
  const root = mkdtempSync(join(tmpdir(), 'alfred-ops-'));
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts', 'qwen-task.sh'), '#!/bin/sh\n');
  mkdirSync(join(repoRoot, 'docs', 'dispatch'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs', 'dispatch', 'X.md'), 'do x');
  cpSync('config/models.yaml', join(repoRoot, 'config', 'models.yaml'));
  writeFileSync(join(repoRoot, 'config', 'alfred.yaml'), 'server:\n  port: 8790\n');
  const personasDir = join(root, 'personas');
  cpSync('personas', personasDir, { recursive: true });
  const qwenEnv = join(root, 'qwen.env');
  writeFileSync(qwenEnv, '# comment\nQWEN_CTX=262144\nQWEN_NP=3\nQWEN_EXTRA="--reasoning-budget 1536"\nOTHER=1\n');
  const dispatchDir = join(root, 'dispatch');
  mkdirSync(join(dispatchDir, 'P1'), { recursive: true });
  writeFileSync(join(dispatchDir, 'P1', 'status.json'), JSON.stringify({ name: 'P1', branch: 'p1', state: 'running', attempt: 2, ts: '2026-09-27T10:00:00-04:00' }));
  writeFileSync(join(dispatchDir, 'P1', 'run.log'), Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n') + '\n');
  writeFileSync(join(dispatchDir, 'P1', 'check1.txt'), 'first');
  writeFileSync(join(dispatchDir, 'P1', 'check2.txt'), 'second');
  mkdirSync(join(dispatchDir, 'P2'), { recursive: true });
  writeFileSync(join(dispatchDir, 'P2', 'status.json'), '{broken');
  return { root, repoRoot, personasDir, qwenEnv, dispatchDir, backupDir: join(root, 'backup') };
}

function fakes() {
  const calls: Call[] = [];
  const spawned: Call[] = [];
  const exec = async (cmd: string, args: string[], o?: any) => {
    calls.push({ cmd, args, o });
    if (cmd === 'nvidia-smi') return { code: 0, stdout: 'NVIDIA GB10, 37, 2411, 41, 23.5, [N/A]\n', stderr: '' };
    if (cmd === 'df') return { code: 0, stdout: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/nvme0n1p2 3906250000 1953125000 1953125000 50% /\n', stderr: '' };
    if (cmd === 'systemctl' && args[1] === 'show') {
      const unit = args[2];
      return { code: 0, stderr: '', stdout: `ActiveState=active\nSubState=running\nExecMainStartTimestamp=Thu 2026-09-24 21:33:45 EDT\nMainPID=${unit.startsWith('qwen') ? 4242 : 77}\nMemoryCurrent=${unit.startsWith('qwen') ? '[not set]' : String(200 * 1048576)}\n` };
    }
    if (cmd === 'systemctl') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'journalctl') return { code: 0, stdout: 'a\nb\nc\n', stderr: '' };
    if (cmd === 'qwenctl' && args[0] === 'logs') return { code: 0, stdout: 'q1\nq2\n', stderr: '' };
    if (cmd === 'qwenctl') return { code: 0, stdout: `ok ${args.join(' ')}`, stderr: '' };
    if (cmd === 'npm') return { code: 0, stdout: 'built', stderr: '' };
    return { code: 127, stdout: '', stderr: 'nope' };
  };
  const fetchFn: typeof fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/slots')) return new Response(JSON.stringify([
      { id: 0, is_processing: true, n_ctx: 262144, n_prompt_tokens: 9000 },
      { id: 1, is_processing: false, n_ctx: 262144, n_prompt_tokens: 0 },
    ]), { status: 200 });
    if (u.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    return new Response('no', { status: 404 });
  }) as any;
  return { calls, spawned, exec, fetchFn, spawnDetached: (cmd: string, args: string[], o?: any) => { spawned.push({ cmd, args, o }); } };
}

let store: Store;
let w: ReturnType<typeof world>;
let f: ReturnType<typeof fakes>;
let running: string[];
let reloads: number;
let modelReloads: number;
let srv: any;
let url: string;

async function call(method: string, path: string, body?: any) {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

beforeEach(async () => {
  store = openStore(':memory:');
  w = world();
  f = fakes();
  running = [];
  reloads = 0;
  modelReloads = 0;
  const registry = new ToolRegistry();
  for (const t of allTools()) registry.register(t);
  const deps: ModuleDeps = {
    store, registry, env: {}, repoRoot: w.repoRoot, personasDir: w.personasDir, workRoot: join(w.root, 'work'),
    nodes: {} as any,
    repoHub: { branches: async (n: string) => (n === 'proj' ? ['main', 'alfred/x/1'] : []), ensure: async () => '/bare' } as any,
    deckState: { url: 'http://127.0.0.1:8787' },
    extra: { exec: f.exec, fetch: f.fetchFn, spawnDetached: f.spawnDetached, qwenUrl: 'http://qwen.test:1110', qwenEnvPath: w.qwenEnv, dispatchDir: w.dispatchDir, backupDir: w.backupDir },
    modules: {},
    personas: loadPersonas(w.personasDir, registry),
    scheduler: { running: () => running } as any,
    models: { reload: () => { modelReloads++; }, list: () => [] } as any,
    reloadPersonas: () => { reloads++; return []; },
  };
  const mod = await createOpsModule(deps);
  const app = createApp({ store, routers: [mod.router!] });
  srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  url = `http://127.0.0.1:${srv.address().port}/api/v1`;
});
afterEach(() => srv?.close());

describe('stats', () => {
  it('reports host, gpu, qwen slots, tokens and task counts', async () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.appendEvent(g.id, t.id, 'turn', { turn: 1, usage: { promptTokens: 1000, completionTokens: 100 } });
    store.appendEvent(g.id, t.id, 'turn', { turn: 2, usage: { promptTokens: 2000, completionTokens: 200 } });
    const q = store.createTask({ goalId: g.id, persona: 'alfred', title: 'q' });
    store.claim(q.id, 'w', 60_000);
    store.transition(q.id, 'failed', { reason: 'x', by: 'w' });
    const { status, body } = await call('GET', '/stats');
    expect(status).toBe(200);
    expect(body.host.cpus).toBeGreaterThan(0);
    expect(body.host.mem.totalMb).toBeGreaterThan(0);
    expect(body.host.load).toHaveLength(3);
    expect(body.host.disk).toMatchObject({ path: '/', totalGb: 3725.3, usedGb: 1862.6 });
    expect(body.gpu).toEqual({ name: 'NVIDIA GB10', utilPct: 37, smMhz: 2411, tempC: 41, powerW: 23.5, memUsedMb: null });
    expect(body.qwen).toMatchObject({ ok: true, busy: 1, total: 2 });
    expect(body.qwen.slots[0]).toEqual({ id: 0, processing: true, nCtx: 262144, promptTokens: 9000 });
    expect(body.tokens.last24h).toEqual({ prompt: 3000, completion: 300, turns: 2 });
    expect(body.tokens.last1h.prompt).toBe(3000);
    expect(body.tokens.byPersona24h.coder).toEqual({ prompt: 3000, completion: 300 });
    expect(body.tasks).toMatchObject({ queued: 1, running: 0, parked: 0, failed24h: 1, done24h: 0 });
    expect(body.goals.active + body.goals.failed + body.goals.done).toBe(1);
  });

  it('degrades gracefully when the GPU tool or Qwen is unavailable, and buckets history', async () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.appendEvent(g.id, t.id, 'turn', { usage: { promptTokens: 10, completionTokens: 5 } });
    const h = await call('GET', '/stats/history?hours=3&bucket=3600');
    expect(h.status).toBe(200);
    expect(h.body.length).toBeGreaterThanOrEqual(3);
    expect(h.body.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < h.body.length; i++) expect(h.body[i].t - h.body[i - 1].t).toBe(3600_000);
    const sum = h.body.reduce((a: number, b: any) => a + b.prompt, 0);
    expect(sum).toBe(10);
    expect(h.body.at(-1)).toMatchObject({ prompt: 10, completion: 5, turns: 1, done: 0, failed: 0 });
  });
});

describe('services, qwen, logs', () => {
  it('lists services with parsed unit state', async () => {
    const { body } = await call('GET', '/ops/services');
    const byName = Object.fromEntries(body.map((s: any) => [s.name, s]));
    expect(byName.alfred).toMatchObject({ unit: 'alfred.service', active: 'active', sub: 'running', pid: 77, memMb: 200, controllable: ['restart'] });
    expect(byName['qwen-server']).toMatchObject({ pid: 4242, memMb: null, controllable: ['start', 'stop', 'restart'] });
    expect(byName['qwen-server'].since).toBe(Date.parse('Thu 2026-09-24 21:33:45 EDT'));
    expect(byName.deck).toMatchObject({ unit: null, active: 'active', url: 'http://127.0.0.1:8787', controllable: [] });
  });

  it('controls services with confirm, protects running agents, restarts alfred detached', async () => {
    expect((await call('POST', '/ops/services/qwen-server/restart', {})).status).toBe(400);
    expect((await call('POST', '/ops/services/nope/restart', { confirm: true })).status).toBe(404);
    expect((await call('POST', '/ops/services/alfred/stop', { confirm: true })).status).toBe(400);
    expect((await call('POST', '/ops/services/deck/restart', { confirm: true })).status).toBe(400);
    running = ['task-1'];
    const blocked = await call('POST', '/ops/services/qwen-server/restart', { confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.running).toEqual(['task-1']);
    const forced = await call('POST', '/ops/services/qwen-server/restart', { confirm: true, force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.ok).toBe(true);
    expect(f.calls.some(c => c.cmd === 'systemctl' && c.args.join(' ') === '--user restart qwen-server.service')).toBe(true);
    const r = await call('POST', '/ops/services/alfred/restart', { confirm: true });
    expect(r.status).toBe(202);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0].cmd).toBe('systemctl');
    expect(f.spawned[0].args).toEqual(['--user', 'restart', 'alfred.service']);
    const ops = store.allEvents().filter(e => e.kind === 'ops');
    expect(ops.length).toBeGreaterThanOrEqual(2);
    expect(ops.every(e => e.goalId === '')).toBe(true);
  });

  it('reads and changes the Qwen server config with validation', async () => {
    const g = await call('GET', '/ops/qwen');
    expect(g.body.env).toEqual({ QWEN_CTX: '262144', QWEN_NP: '3', QWEN_EXTRA: '--reasoning-budget 1536' });
    expect(g.body.health).toBe(true);
    expect(g.body.presets).toContain('fast');
    expect((await call('POST', '/ops/qwen', { confirm: true, slots: 9 })).status).toBe(400);
    expect((await call('POST', '/ops/qwen', { confirm: true, preset: 'turbo' })).status).toBe(400);
    expect((await call('POST', '/ops/qwen', { confirm: true, slots: 2, ctx: 1024 })).status).toBe(400);
    const ok = await call('POST', '/ops/qwen', { confirm: true, slots: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(f.calls.find(c => c.cmd === 'qwenctl')!.args).toEqual(['slots', '2']);
    running = ['t'];
    expect((await call('POST', '/ops/qwen', { confirm: true, preset: 'fast' })).status).toBe(409);
  });

  it('tails logs', async () => {
    const a = await call('GET', '/ops/logs/alfred?lines=50');
    expect(a.body).toEqual({ name: 'alfred', lines: ['a', 'b', 'c'] });
    expect(f.calls.find(c => c.cmd === 'journalctl')!.args).toEqual(['--user', '-u', 'alfred.service', '-n', '50', '--no-pager', '-o', 'short-iso']);
    expect((await call('GET', '/ops/logs/qwen-server')).body.lines).toEqual(['q1', 'q2']);
    expect((await call('GET', '/ops/logs/zzz')).status).toBe(404);
  });
});

describe('config files', () => {
  it('lists, reads, validates, backs up, writes and reloads', async () => {
    const list = (await call('GET', '/ops/config')).body;
    const paths = list.map((x: any) => x.path);
    expect(paths).toContain('personas/coder.yaml');
    expect(paths).toContain('config/models.yaml');
    expect(list.find((x: any) => x.path === 'config/models.yaml').kind).toBe('models');
    expect(list.find((x: any) => x.path === 'personas/coder.yaml').kind).toBe('persona');
    expect((await call('GET', '/ops/config/file?path=../etc/passwd')).status).toBe(400);
    expect((await call('GET', '/ops/config/file?path=personas/nope.yaml')).status).toBe(404);
    const file = (await call('GET', '/ops/config/file?path=personas/coder.yaml')).body;
    expect(file.content).toContain('name: coder');

    // invalid yaml, unknown tool, over budget → 400, file untouched
    const put = (content: string, extra: any = {}) => call('PUT', '/ops/config/file', { path: 'personas/coder.yaml', content, confirm: true, ...extra });
    expect((await put('name: [unclosed')).status).toBe(400);
    expect((await put(file.content.replace('tools: [', 'tools: [no_such_tool, '))).status).toBe(400);
    expect(readFileSync(join(w.personasDir, 'coder.yaml'), 'utf8')).toBe(file.content);
    expect((await put(file.content, { mtime: file.mtime - 5000 })).status).toBe(409);
    expect((await call('PUT', '/ops/config/file', { path: 'personas/coder.yaml', content: file.content })).status).toBe(400); // no confirm

    const edited = file.content.replace(/description: .*/, 'description: Edited from the Mac.');
    const ok = await put(edited, { mtime: file.mtime });
    expect(ok.status).toBe(200);
    expect(ok.body.reloaded).toContain('personas');
    expect(reloads).toBe(1);
    expect(readFileSync(join(w.personasDir, 'coder.yaml'), 'utf8')).toContain('Edited from the Mac.');
    const backups = readdirSync(join(w.backupDir, 'personas'));
    expect(backups.some(b => b.startsWith('coder.yaml.'))).toBe(true);

    const models = (await call('GET', '/ops/config/file?path=config/models.yaml')).body;
    expect((await call('PUT', '/ops/config/file', { path: 'config/models.yaml', content: 'models: 5', confirm: true })).status).toBe(400);
    const mOk = await call('PUT', '/ops/config/file', { path: 'config/models.yaml', content: models.content + '\n', confirm: true });
    expect(mOk.status).toBe(200);
    expect(mOk.body.reloaded).toContain('models');
    expect(modelReloads).toBe(1);
  });
});

describe('build harness, repos, web build', () => {
  it('lists and inspects dispatch jobs and launches with limits', async () => {
    const list = (await call('GET', '/ops/dispatch')).body;
    expect(list).toEqual([{ name: 'P1', branch: 'p1', state: 'running', attempt: 2, ts: '2026-09-27T10:00:00-04:00' }]);
    const one = (await call('GET', '/ops/dispatch/P1')).body;
    expect(one.log).toHaveLength(100);
    expect(one.log.at(-1)).toBe('line 149');
    expect(one.check).toBe('second');
    expect((await call('GET', '/ops/dispatch/none')).status).toBe(404);
    const bad = await call('POST', '/ops/dispatch', { name: 'x; rm', branch: 'b', promptFile: 'docs/dispatch/X.md', check: 'true', confirm: true });
    expect(bad.status).toBe(400);
    expect((await call('POST', '/ops/dispatch', { name: 'X', branch: 'x', promptFile: 'docs/dispatch/missing.md', check: 'true', confirm: true })).status).toBe(400);
    const ok = await call('POST', '/ops/dispatch', { name: 'X', branch: 'px', promptFile: 'docs/dispatch/X.md', check: 'npx vitest run', confirm: true });
    expect(ok.status).toBe(202);
    expect(f.spawned[0].cmd).toBe('bash');
    expect(f.spawned[0].args).toEqual([join(w.repoRoot, 'scripts', 'qwen-task.sh'), 'X', 'px', join(w.repoRoot, 'docs', 'dispatch', 'X.md'), 'npx vitest run', '4', '60']);
    for (const n of ['A', 'B']) {
      mkdirSync(join(w.dispatchDir, n), { recursive: true });
      writeFileSync(join(w.dispatchDir, n, 'status.json'), JSON.stringify({ name: n, branch: n, state: 'running', attempt: 1, ts: 'x' }));
    }
    expect((await call('POST', '/ops/dispatch', { name: 'Y', branch: 'py', promptFile: 'docs/dispatch/X.md', check: 'true', confirm: true })).status).toBe(409);
  });

  it('registers repos and rebuilds the web UI', async () => {
    const r = await call('POST', '/ops/repos', { name: 'proj', paths: { macbook: '/Users/q/proj' }, confirm: true });
    expect(r.status).toBe(201);
    const repos = (await call('GET', '/ops/repos')).body;
    expect(repos[0]).toMatchObject({ name: 'proj', paths: { macbook: '/Users/q/proj' }, branches: ['main', 'alfred/x/1'] });
    expect((await call('POST', '/ops/repos', { name: 'bad name!', paths: {}, confirm: true })).status).toBe(400);
    const b = await call('POST', '/ops/alfred/build-web', { confirm: true });
    expect(b.body).toMatchObject({ ok: true });
    expect(f.calls.find(c => c.cmd === 'npm')!.o.cwd).toBe(w.repoRoot);
  });
});
