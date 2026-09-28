// U1 unit tests — the Spark side of the Mac app's self-update: /app/latest, /app/download, /ops/app/build,
// and alfred_dev deploy rebuilding the app when app code changed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, type Store } from '../../src/store.js';
import { createApp } from '../../src/server/app.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import type { ToolContext } from '../../src/runtime/contract.js';
import { createOpsModule } from '../../src/ops/index.js';
import { readLatest } from '../../src/ops/app-updates.js';
import { alfredDevTool, APP_REBUILD_RE } from '../../src/powers/dev.js';

let store: Store;
let root: string;
let dist: string;
let srv: any;
let url: string;
let execCalls: { cmd: string; args: string[]; o?: any }[];
let finishBuild: ((r: { code: number; stdout: string; stderr: string }) => void) | null;

const ZIP = Buffer.from('PK fake zip bytes');
const LATEST = { version: '0.1.0', build: '20260928010203', sha256: createHash('sha256').update(ZIP).digest('hex'), size: ZIP.length, builtAt: '2026-09-28T01:02:03.000Z', commit: 'abc1234' };

async function call(method: string, path: string, body?: any, token = 'tok') {
  const res = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const buf = Buffer.from(await res.arrayBuffer());
  let parsed: any = buf;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, body: parsed, headers: res.headers, raw: buf };
}

beforeEach(async () => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'alfred-u1-ops-'));
  dist = join(root, 'app', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, 'secret.txt'), 'do not serve');
  execCalls = [];
  finishBuild = null;
  const exec = (cmd: string, args: string[], o?: any) => {
    execCalls.push({ cmd, args, o });
    return new Promise<any>((r) => { finishBuild = r; });
  };
  const deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root,
    nodes: {} as any, repoHub: {} as any, deckState: { url: null }, modules: {}, personas: new Map(),
    extra: { exec },
  } as unknown as ModuleDeps;
  const mod = await createOpsModule(deps);
  const app = createApp({ store, token: 'tok', routers: [mod.router!] });
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  url = `http://127.0.0.1:${srv.address().port}/api/v1`;
});
afterEach(() => srv?.close());

describe('app update routes', () => {
  it('404 without a build; latest.json + the zip once there is one', async () => {
    expect(await call('GET', '/app/latest')).toMatchObject({ status: 404, body: { error: 'no build yet' } });
    expect((await call('GET', '/app/download')).status).toBe(404);
    writeFileSync(join(dist, 'latest.json'), JSON.stringify(LATEST));
    expect((await call('GET', '/app/download')).status).toBe(404); // latest without the zip
    writeFileSync(join(dist, 'Alfred-mac-arm64.zip'), ZIP);
    expect(await call('GET', '/app/latest')).toMatchObject({ status: 200, body: LATEST });
    const d = await call('GET', '/app/download');
    expect(d.status).toBe(200);
    expect(d.headers.get('content-type')).toBe('application/zip');
    expect(d.headers.get('content-length')).toBe(String(ZIP.length));
    expect(d.headers.get('x-sha256')).toBe(LATEST.sha256);
    expect(d.raw.equals(ZIP)).toBe(true);
  });

  it('serves only the zip: query/path tricks do not reach other files', async () => {
    writeFileSync(join(dist, 'latest.json'), JSON.stringify(LATEST));
    writeFileSync(join(dist, 'Alfred-mac-arm64.zip'), ZIP);
    const q = await call('GET', '/app/download?path=../../secret.txt&file=/etc/passwd');
    expect(q.raw.equals(ZIP)).toBe(true);
    for (const p of ['/app/download/../../secret.txt', '/app/download/secret.txt', '/app/download%2F..%2F..%2Fsecret.txt']) {
      const r = await call('GET', p);
      expect(r.raw.toString()).not.toContain('do not serve');
    }
  });

  it('needs the token', async () => {
    writeFileSync(join(dist, 'latest.json'), JSON.stringify(LATEST));
    writeFileSync(join(dist, 'Alfred-mac-arm64.zip'), ZIP);
    expect((await call('GET', '/app/latest', undefined, '')).status).toBe(401);
    expect((await call('GET', '/app/download', undefined, 'wrong')).status).toBe(401);
    expect((await call('POST', '/ops/app/build', { confirm: true }, '')).status).toBe(401);
  });

  it('rejects a malformed latest.json', () => {
    writeFileSync(join(dist, 'latest.json'), JSON.stringify({ ...LATEST, sha256: 'nope' }));
    expect(readLatest(dist)).toBeNull();
    writeFileSync(join(dist, 'latest.json'), '{broken');
    expect(readLatest(dist)).toBeNull();
  });

  it('builds with pack:mac in the repo: confirm, 409 while running, ops event when done', async () => {
    expect((await call('POST', '/ops/app/build', {})).status).toBe(400);
    const r = await call('POST', '/ops/app/build', { confirm: true, by: 'test' });
    expect(r).toMatchObject({ status: 202, body: { ok: true, started: true } });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ cmd: 'npm', args: ['--prefix', 'app', 'run', 'pack:mac'], o: { cwd: root } });
    expect((await call('POST', '/ops/app/build', { confirm: true })).status).toBe(409);
    expect((await call('GET', '/ops/app/build')).body).toMatchObject({ running: true, latest: null });
    // downloads wait while the zip is being rewritten
    writeFileSync(join(dist, 'latest.json'), JSON.stringify(LATEST));
    writeFileSync(join(dist, 'Alfred-mac-arm64.zip'), ZIP);
    expect((await call('GET', '/app/download')).status).toBe(409);

    finishBuild!({ code: 0, stdout: 'packed', stderr: '' });
    await new Promise((res) => setTimeout(res, 20));
    const st = (await call('GET', '/ops/app/build')).body;
    expect(st).toMatchObject({ running: false, ok: true, output: 'packed', by: 'test', latest: LATEST });
    const ev = store.allEvents().filter((e: any) => e.kind === 'ops').at(-1)!;
    expect(ev.data).toMatchObject({ action: 'app.build', ok: true, target: '0.1.0 20260928010203 abc1234', by: 'test' });
    expect((await call('GET', '/app/download')).status).toBe(200);

    // a failed build is reported too
    expect((await call('POST', '/ops/app/build', { confirm: true })).status).toBe(202);
    finishBuild!({ code: 1, stdout: '', stderr: 'boom' });
    await new Promise((res) => setTimeout(res, 20));
    expect((await call('GET', '/ops/app/build')).body).toMatchObject({ running: false, ok: false, output: 'boom' });
  });
});

describe('alfred_dev deploy rebuilds the Mac app when app code changed', () => {
  it('matches app/, src/node/ and src/cli*', () => {
    for (const f of ['app/src/main.cjs', 'src/node/client.ts', 'src/cli.ts', 'src/cli/util.ts']) expect(APP_REBUILD_RE.test(f)).toBe(true);
    for (const f of ['src/server/app.ts', 'web/src/App.jsx', 'docs/app/x.md', 'src/clinic.ts'.replace('clinic', 'x')]) expect(APP_REBUILD_RE.test(f)).toBe(false);
  });

  it('merge → build-web → app build (waits for it) → restart', async () => {
    const fetched: string[] = [];
    let polls = 0;
    const replies: Record<string, { status: number; body: any }> = {};
    const selfFetch = async (u: string, init: any) => {
      const p = u.replace('http://self/api/v1', '');
      const key = `${init?.method ?? 'GET'} ${p}`;
      fetched.push(key);
      if (key === 'GET /ops/app/build') return new Response(JSON.stringify({ running: ++polls < 3, ok: polls >= 3 }), { status: 200 });
      const r = replies[key] ?? { status: 200, body: { ok: true } };
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    const deps = {
      store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root,
      nodes: { list: () => [] } as any, repoHub: {} as any, deckState: { url: null }, modules: {}, personas: new Map(),
      extra: { repoRoot: root, selfFetch, appBuildPollMs: 5 }, selfUrl: 'http://self', token: 'tok',
    } as unknown as ModuleDeps;
    mkdirSync(join(root, 'config'), { recursive: true });
    const goal = store.createGoal({ title: 'app tweak', meta: { repo: 'alfred' } } as any);
    const ctx: ToolContext = { taskId: 'chat:x', goalId: '', workspace: root, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} };
    const tool = alfredDevTool(deps);

    replies[`GET /goals/${goal.id}/changes`] = { status: 200, body: { files: [{ path: 'app/src/main.cjs' }, { path: 'src/cli/util.ts' }] } };
    replies[`POST /goals/${goal.id}/merge`] = { status: 200, body: { ok: true, into: 'master', sha: 'abcdef12' } };
    const r = await tool.run({ op: 'deploy', goal: goal.slug, confirm: true }, ctx);
    expect(r.ok).toBe(true);
    expect(fetched).toEqual([
      `GET /goals/${goal.id}/changes`,
      `POST /goals/${goal.id}/merge`,
      'POST /ops/alfred/build-web',
      'POST /ops/app/build',
      'GET /ops/app/build', 'GET /ops/app/build', 'GET /ops/app/build',
      'POST /ops/services/alfred/restart',
    ]);
    expect(r.output).toMatch(/mac-app: rebuilding[\s\S]*mac-app: built[\s\S]*restart/);

    // app-only change: no waiting, no restart
    fetched.length = 0;
    replies[`GET /goals/${goal.id}/changes`] = { status: 200, body: { files: [{ path: 'app/src/tray.cjs' }] } };
    const r2 = await tool.run({ op: 'deploy', goal: goal.slug, confirm: true }, ctx);
    expect(r2.ok).toBe(true);
    expect(fetched.slice(2)).toEqual(['POST /ops/alfred/build-web', 'POST /ops/app/build']);
    expect(r2.output).toContain('restart: not needed');
  });
});
