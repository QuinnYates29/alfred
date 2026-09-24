// P11 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { loadConfig } from '../../../src/config.js';
import { scriptedLLM, call } from '../../../src/runtime/testing.js';

let alfred: Alfred | undefined;
afterEach(async () => { await alfred?.stop(); alfred = undefined; });

function base() {
  const b = mkdtempSync(join(tmpdir(), 'alfred-ext-'));
  return { dbPath: join(b, 'a.db'), mirrorDir: join(b, 'v'), workRoot: join(b, 'w'), personasDir: 'personas', port: 0, host: '127.0.0.1',
    deck: null, pollMs: 25, env: { ALFRED_NOTIFY_DESKTOP: '0' } };
}

describe('plugins', () => {
  it('loads a plugin that adds a tool, persona, sink, route and event hook; a broken plugin is reported, not fatal', async () => {
    const llm = scriptedLLM([
      { toolCalls: [call('hello_world', { who: 'quinn' })] },
      { toolCalls: [call('give_up', { reason: 'greeted' })] },
    ]);
    alfred = await startAlfred({ ...base(), llm, pluginDirs: [resolve('test/fixtures/plugins')],
      pluginConfig: { hello: { greeting: 'howdy' } } } as any);

    const health = await (await fetch(`${alfred.url}/api/v1/health`)).json();
    expect(health.plugins.loaded).toContain('hello');
    expect(health.plugins.failed.map((f: any) => f.name)).toContain('broken');
    expect(JSON.stringify(health.plugins.failed)).toContain('exploded on purpose');

    expect(await (await fetch(`${alfred.url}/api/v1/plugins/hello/ping`)).json()).toEqual({ pong: true, greeting: 'howdy' });
    const tools = await (await fetch(`${alfred.url}/api/v1/tools`)).json();
    expect(tools.map((t: any) => t.name)).toContain('hello_world');
    const personas = await (await fetch(`${alfred.url}/api/v1/personas`)).json();
    expect(personas.map((p: any) => p.name)).toContain('greeter');

    const res = await fetch(`${alfred.url}/api/v1/goals`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Greet', persona: 'greeter', spec: 'say hi', acceptance: [{ name: 'a', cmd: 'true' }] }) });
    const { goal } = await res.json();
    const end = Date.now() + 10_000;
    while (alfred.store.getGoal(goal.id)!.status === 'active' && Date.now() < end) await new Promise(r => setTimeout(r, 25));
    expect(alfred.store.getGoal(goal.id)!.status).toBe('failed');
    const secondReq = llm.requests[1];
    expect(secondReq.messages.find(m => m.role === 'tool')!.content).toContain('hello quinn (howdy)');

    const { sent } = await import('../../fixtures/plugins/hello/index.js');
    await new Promise(r => setTimeout(r, 200));
    expect(sent.some((n: any) => n.goalId === goal.id && n.level === 'failure')).toBe(true);
  }, 30_000);

  it('built-ins are plugins too, and can be disabled', async () => {
    alfred = await startAlfred({ ...base(), llm: scriptedLLM([]), pluginsEnabled: ['builtin-sinks'] } as any);
    const tools = (await (await fetch(`${alfred.url}/api/v1/tools`)).json()).map((t: any) => t.name);
    expect(tools).toContain('read_file');
    expect(tools).not.toContain('dsh_code');
    const plugins = await (await fetch(`${alfred.url}/api/v1/plugins`)).json();
    expect(JSON.stringify(plugins)).toContain('builtin-sinks');
  }, 30_000);
});

describe('config and API contract', () => {
  it('merges alfred.yaml, alfred.local.yaml and env, in that order', () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-cfg-'));
    writeFileSync(join(d, 'alfred.yaml'), 'server: { port: 8790, host: 127.0.0.1 }\npaths: { db: ~/.alfred/alfred.db }\n');
    writeFileSync(join(d, 'alfred.local.yaml'), 'server: { port: 9999 }\n');
    const c = loadConfig(d, { ALFRED_HOST: '0.0.0.0' });
    expect(c.server.port).toBe(9999);
    expect(c.server.host).toBe('0.0.0.0');
    expect(c.paths.db).toMatch(/\.alfred\/alfred\.db$/);
    expect(c.paths.db.startsWith('~')).toBe(false);
  });

  it('serves /api/v1, keeps /api as an alias, and documents event kinds', async () => {
    alfred = await startAlfred({ ...base(), llm: scriptedLLM([]) } as any);
    expect((await fetch(`${alfred.url}/api/v1/goals`)).status).toBe(200);
    expect((await fetch(`${alfred.url}/api/goals`)).status).toBe(200);
    const kinds = await (await fetch(`${alfred.url}/api/v1/schema/events`)).json();
    for (const k of ['transition', 'turn', 'tool', 'progress', 'verify', 'goal_status', 'approval_requested'])
      expect(kinds.map((x: any) => x.kind)).toContain(k);
  }, 30_000);
});
