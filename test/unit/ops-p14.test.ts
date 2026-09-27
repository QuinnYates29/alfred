// P14 unit tests — pure helpers (paths, validation, stats math, defaults).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { CONFIG_PATH_RE, configKind, resolveConfigPath, validateConfigContent } from '../../src/ops/config-files.js';
import { parseQwenSetting, readQwenEnv, QWEN_LIMITS } from '../../src/ops/qwen.js';
import { getHistory, getStats, qwenSlots } from '../../src/ops/stats.js';
import { launchDispatch, listDispatch, getDispatch } from '../../src/ops/dispatch.js';
import { getLogs } from '../../src/ops/logs.js';
import { makeCtx, tail2 } from '../../src/ops/exec.js';
import { listServices } from '../../src/ops/services.js';
import type { ModuleDeps } from '../../src/modules.js';

function tmp(sub = ''): string {
  const d = mkdtempSync(join(tmpdir(), `alfred-opsu-${sub}-`));
  return d;
}

function fakeCtx(over: any = {}, repoRoot = '/repo') {
  const deps = { env: {}, repoRoot, extra: over } as unknown as ModuleDeps;
  return makeCtx(deps);
}

describe('exec ctx defaults', () => {
  it('falls back to env and repo-root paths', () => {
    const ctx = makeCtx({ env: { QWEN_URL: 'http://h:1', QWEN_ENV_FILE: '/e' }, repoRoot: '/r' } as unknown as ModuleDeps);
    expect(ctx.qwenUrl).toBe('http://h:1');
    expect(ctx.qwenEnvPath).toBe('/e');
    expect(ctx.dispatchDir).toBe('/r/.dispatch');
    expect(ctx.backupDir).toBe('/r/.alfred-backup');
    expect(typeof ctx.exec).toBe('function');
  });

  it('takes the qwen url from the first model when nothing else is set', () => {
    const ctx = makeCtx({ env: {}, repoRoot: '/r', models: { list: () => [{ baseUrl: 'http://m:9' }] } } as unknown as ModuleDeps);
    expect(ctx.qwenUrl).toBe('http://m:9');
  });

  it('runs the real exec without throwing on non-zero exit', async () => {
    const ctx = fakeCtx();
    const r = await ctx.exec('sh', ['-c', 'echo hi; exit 3']);
    expect(r.code).toBe(3);
    expect(r.stdout.trim()).toBe('hi');
  });

  it('tail2 keeps the tail', () => {
    expect(tail2('abcdef', 3)).toBe('def');
    expect(tail2('ab', 10)).toBe('ab');
  });
});

describe('config path allow-list', () => {
  it('accepts repo-relative yaml/json only', () => {
    expect(CONFIG_PATH_RE.test('personas/coder.yaml')).toBe(true);
    expect(CONFIG_PATH_RE.test('config/models.yaml')).toBe(true);
    expect(CONFIG_PATH_RE.test('config/mcp.json')).toBe(true);
    for (const p of ['../etc/passwd', 'personas/../etc/passwd', '/abs/x.yaml', 'personas/a.txt', 'config/a.yml.bak', 'personas/']) {
      expect(CONFIG_PATH_RE.test(p)).toBe(false);
    }
  });

  it('kinds map as specified', () => {
    expect(configKind('personas/x.yml')).toBe('persona');
    expect(configKind('config/models.yaml')).toBe('models');
    expect(configKind('config/alfred.yaml')).toBe('alfred');
    expect(configKind('config/mcp.json')).toBe('mcp');
    expect(configKind('config/other.json')).toBe('other');
  });

  it('personas resolve into personasDir, config into repoRoot', () => {
    const deps = { personasDir: '/p', repoRoot: '/r' } as unknown as ModuleDeps;
    expect(resolveConfigPath(deps, 'personas/a.yaml')).toBe(join('/p', 'a.yaml'));
    expect(resolveConfigPath(deps, 'config/a.json')).toBe(join('/r', 'config', 'a.json'));
    expect(resolveConfigPath(deps, '../a.yaml')).toBeNull();
  });

  it('validates json, yaml, and unknown tools in personas', () => {
    const dir = tmp();
    const deps = { personasDir: dir, repoRoot: dir, registry: new ToolRegistry() } as unknown as ModuleDeps;
    expect(() => validateConfigContent(deps, 'config/a.json', '{"a":1}')).not.toThrow();
    expect(() => validateConfigContent(deps, 'config/a.json', '{"a":')).toThrow();
    expect(() => validateConfigContent(deps, 'config/alfred.yaml', 'server:\n  port: 1\n')).not.toThrow();
    expect(() => validateConfigContent(deps, 'config/alfred.yaml', 'a: [1')).toThrow();
    // personas: validated against a copy, the real dir is never touched
    writeFileSync(join(dir, 'solo.yaml'), 'name: solo\ndescription: d\ntools: [nope_not_real]\n');
    expect(() => validateConfigContent(deps, 'personas/solo.yaml', readFileSync(join(dir, 'solo.yaml'), 'utf8'))).toThrow();
  });
});

describe('qwen env + settings', () => {
  it('reads QWEN_* lines, strips quotes, ignores the rest', () => {
    const f = join(tmp(), 'q.env');
    writeFileSync(f, `# c\nQWEN_A=1\nQWEN_B="x y"\nQWEN_C='z'\nNOPE=2\nQWEN_D=\n`);
    expect(readQwenEnv(f)).toEqual({ QWEN_A: '1', QWEN_B: 'x y', QWEN_C: 'z', QWEN_D: '' });
    expect(readQwenEnv(join(tmp(), 'missing.env'))).toEqual({});
  });

  it('accepts exactly one setting within limits', () => {
    expect(parseQwenSetting({ preset: 'lean' })).toEqual({ verb: 'preset', value: 'lean' });
    expect(parseQwenSetting({ slots: QWEN_LIMITS.slots[1] })).toEqual({ verb: 'slots', value: '8' });
    expect(parseQwenSetting({ offload: 0 })).toEqual({ verb: 'offload', value: '0' });
    expect(parseQwenSetting({ extra: '--foo bar' })).toEqual({ verb: 'extra', value: '--foo bar' });
    expect(() => parseQwenSetting({})).toThrow(/exactly one/);
    expect(() => parseQwenSetting({ slots: 2, ctx: 1024 })).toThrow(/exactly one/);
    expect(() => parseQwenSetting({ preset: 'nope' })).toThrow(/unknown preset/);
    for (const v of [0, 9, 1.5, 'x']) expect(() => parseQwenSetting({ slots: v })).toThrow();
  });
});

describe('stats over a store', () => {
  it('buckets the whole window with zeros and counts transitions', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't' });
    store.appendEvent(g.id, t.id, 'turn', { usage: { promptTokens: 7, completionTokens: 2 } });
    store.appendEvent(g.id, t.id, 'turn', { usage: {} }); // no usage → still a turn? no: counted as a turn with 0
    store.appendEvent(g.id, t.id, 'transition', { from: 'review', to: 'done', by: 'gate' });
    const b = getHistory(store, 2, 60);
    expect(b.length).toBeGreaterThanOrEqual(2);
    expect(b.every((x) => x.t % 60000 === 0)).toBe(true);
    expect(b.reduce((a, x) => a + x.prompt, 0)).toBe(7);
    expect(b.reduce((a, x) => a + x.turns, 0)).toBe(2);
    expect(b.reduce((a, x) => a + x.done, 0)).toBe(1);
    expect(b.at(-1)!.t).toBeLessThanOrEqual(Date.now());
  });

  it('degrades when gpu/df/qwen all fail', async () => {
    const store = openStore(':memory:');
    const ctx = fakeCtx({
      exec: async () => ({ code: 127, stdout: '', stderr: 'no' }),
      fetch: async () => {
        throw new Error('down');
      },
    });
    const s = await getStats(store, ctx);
    expect(s.host.disk).toBeNull();
    expect(s.gpu).toBeNull();
    expect(s.qwen).toMatchObject({ ok: false, error: 'down' });
    expect(s.tasks).toMatchObject({ running: 0, queued: 0, parked: 0, done24h: 0, failed24h: 0 });
    expect(s.host.cpus).toBeGreaterThan(0);
  });

  it('qwenSlots normalises and reports busy', async () => {
    const ctx = fakeCtx({
      qwenUrl: 'http://q',
      fetch: async () => new Response(JSON.stringify([{ id: 1, is_processing: true, n_ctx: 4, n_prompt_tokens: 5 }]), { status: 200 }),
    });
    expect(await qwenSlots(ctx)).toMatchObject({ ok: true, url: 'http://q', busy: 1, total: 1 });
  });

  it('services list handles a failing systemctl and a live deck', async () => {
    const ctx = fakeCtx({ exec: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
    const list = await listServices(ctx, 'http://deck');
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    expect(by.alfred).toMatchObject({ active: 'unknown', pid: null, memMb: null, since: null });
    expect(by.deck).toMatchObject({ unit: null, active: 'active', url: 'http://deck', controllable: [] });
  });
});

describe('logs + dispatch helpers', () => {
  it('drops the trailing newline and rejects unknown sources', async () => {
    const ctx = fakeCtx({ exec: async () => ({ code: 0, stdout: 'x\ny\n', stderr: '' }) });
    expect(await getLogs(ctx, 'alfred', 10)).toEqual({ name: 'alfred', lines: ['x', 'y'] });
    expect(await getLogs(ctx, 'nope', 10)).toMatchObject({ status: 404 });
    const bad = fakeCtx({ exec: async () => ({ code: 2, stdout: '', stderr: 'no journal\n' }) });
    expect(await getLogs(bad, 'alfred', 10)).toMatchObject({ status: 500, error: 'no journal' });
  });

  it('skips broken status.json and reads the newest check file', () => {
    const d = tmp('disp');
    mkdirSync(join(d, 'A'), { recursive: true });
    writeFileSync(join(d, 'A', 'status.json'), '{oops');
    mkdirSync(join(d, 'B'), { recursive: true });
    writeFileSync(join(d, 'B', 'status.json'), JSON.stringify({ name: 'B', branch: 'b', state: 'done', attempt: 3, ts: 1700 }));
    writeFileSync(join(d, 'B', 'check10.txt'), 'ten');
    writeFileSync(join(d, 'B', 'check2.txt'), 'two');
    expect(listDispatch(d)).toEqual([{ name: 'B', branch: 'b', state: 'done', attempt: 3, ts: '1700' }]);
    const one = getDispatch(d, 'B')!;
    expect(one.check).toBe('ten');
    expect(getDispatch(d, 'ghost')).toBeNull();
  });

  it('validates launches and caps running jobs at 3', () => {
    const root = tmp('rr');
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'P.md'), 'go');
    const spawned: any[] = [];
    const ctx = fakeCtx({ dispatchDir: join(root, '.dispatch'), spawnDetached: (c: string, a: string[], o?: any) => spawned.push({ c, a, o }) }, root);
    const base = { confirm: true, name: 'P9', branch: 'p9', promptFile: 'docs/P.md', check: 'true' };
    expect(launchDispatch(ctx, { ...base, name: 'a b' })).toMatchObject({ status: 400 });
    expect(launchDispatch(ctx, { ...base, promptFile: 'docs/nope.md' })).toMatchObject({ status: 400 });
    expect(launchDispatch(ctx, { ...base, promptFile: '../etc/hosts' })).toMatchObject({ status: 400 });
    expect(launchDispatch(ctx, { ...base, attempts: 0 })).toMatchObject({ status: 400 });
    expect(launchDispatch(ctx, { name: 'P9', branch: 'p9', promptFile: 'docs/P.md', check: 'true' })).toMatchObject({ status: 400 });
    expect(launchDispatch(ctx, base)).toEqual({ ok: true, name: 'P9' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].a[0]).toBe(join(root, 'scripts', 'qwen-task.sh'));
    expect(spawned[0].a.slice(1)).toEqual(['P9', 'p9', join(root, 'docs', 'P.md'), 'true', '4', '60']);
    for (const n of ['J1', 'J2']) {
      mkdirSync(join(root, '.dispatch', n), { recursive: true });
      writeFileSync(join(root, '.dispatch', n, 'status.json'), JSON.stringify({ name: n, state: 'running' }));
    }
    expect(launchDispatch(ctx, { ...base, name: 'P10' })).toMatchObject({ status: 409 });
  });
});
