// P4b acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { scriptedLLM } from '../../../src/runtime/testing.js';

const run = promisify(execFile);
let alfred: Alfred;

beforeAll(async () => {
  const b = mkdtempSync(join(tmpdir(), 'alfred-cli-'));
  alfred = await startAlfred({ dbPath: join(b, 'a.db'), mirrorDir: join(b, 'v'), workRoot: join(b, 'w'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', deck: null, pollMs: 25, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: scriptedLLM([]) } as any);
}, 30_000);
afterAll(async () => { await alfred?.stop(); });

const cli = (args: string[]) => run(resolve('node_modules/.bin/tsx'), [resolve('src/cli.ts'), ...args],
  { env: { ...process.env, ALFRED_URL: alfred.url }, timeout: 30_000 });

describe('models API', () => {
  it('lists models + roles and switches a role, rejecting unknown models', async () => {
    const m = await (await fetch(`${alfred.url}/api/v1/models`)).json();
    expect(m.models.map((x: any) => x.name)).toContain('qwen-local');
    expect(m.roles.default).toBe('qwen-local');
    const ok = await fetch(`${alfred.url}/api/v1/models/roles`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'fast', model: 'qwen-local' }) });
    expect(ok.status).toBeLessThan(300);
    const bad = await fetch(`${alfred.url}/api/v1/models/roles`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'fast', model: 'no-such-model' }) });
    expect(bad.status).toBe(400);
  });

  it('goal detail includes usage', async () => {
    const { goal } = await (await fetch(`${alfred.url}/api/v1/goals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Usage goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] }) })).json();
    const d = await (await fetch(`${alfred.url}/api/v1/goals/${goal.id}`)).json();
    expect(d.usage).toMatchObject({ promptTokens: expect.any(Number), completionTokens: expect.any(Number) });
  });
});

describe('alfred CLI', () => {
  it('creates a goal with checks, shows status, and shows a goal', async () => {
    const c = await cli(['goal', 'CLI made goal', '--spec', 'do it', '--check', 'tests=true', '--persona', 'coder']);
    expect(c.stdout).toMatch(/cli-made-goal/);
    const g = alfred.store.listGoals().find(x => x.title === 'CLI made goal')!;
    expect(g).toBeDefined();
    const t = alfred.store.listTasks(g.id)[0];
    expect(t.persona).toBe('coder');
    expect(t.acceptance).toEqual([{ name: 'tests', cmd: 'true' }]);
    expect((await cli(['status'])).stdout).toContain('CLI made goal');
    expect((await cli(['show', 'cli-made-goal'])).stdout).toContain('coder');
  }, 60_000);

  it('stop and retry work by task id', async () => {
    const g = alfred.store.listGoals().find(x => x.title === 'CLI made goal')!;
    const t = alfred.store.listTasks(g.id)[0];
    await cli(['stop', t.id, 'not needed']);
    await expect.poll(() => alfred.store.getTask(t.id)!.status, { timeout: 5000 }).toBe('stopped');
    const r = await cli(['retry', t.id, 'try again']);
    expect(r.stdout).toMatch(/[0-9a-f-]{8,}/);
  }, 60_000);
});

describe('deploy', () => {
  it('ships a systemd user unit and installer', () => {
    const unit = readFileSync('deploy/alfred.service', 'utf8');
    expect(unit).toMatch(/ExecStart=.*alfred.*serve|ExecStart=.*cli\.ts serve/);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('EnvironmentFile=-%h/.config/alfred.env');
    expect(existsSync('deploy/install.sh')).toBe(true);
    expect(existsSync('bin/alfred')).toBe(true);
  });
});
