// P21a acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAlfred, type Alfred } from '../../../src/main.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import type { LLM, ToolContext } from '../../../src/runtime/contract.js';

const idle: LLM = { async chat(req) { await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); }); return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } }; } };

const calls: { cmd: string; args: string[] }[] = [];
const exec = async (cmd: string, args: string[]) => {
  calls.push({ cmd, args });
  if (cmd === 'systemctl' && args[1] === 'show') return { code: 0, stdout: 'ActiveState=active\nSubState=running\nMainPID=7\nMemoryCurrent=1048576\n', stderr: '' };
  if (cmd === 'nvidia-smi') return { code: 0, stdout: 'NVIDIA GB10, 12, 2400, 40, 20, [N/A]\n', stderr: '' };
  return { code: 0, stdout: 'ok', stderr: '' };
};

let alfred: Alfred;
let repoRoot: string;
let reconfigured: any[] = [];
let tool: (name: string, args: any, ctx?: Partial<ToolContext>) => Promise<any>;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'alfred-p21-'));
  repoRoot = join(base, 'repo');
  mkdirSync(join(repoRoot, 'config'), { recursive: true });
  cpSync('config/models.yaml', join(repoRoot, 'config', 'models.yaml'));
  writeFileSync(join(repoRoot, 'config', 'mcp.json'), JSON.stringify({ servers: {} }));
  writeFileSync(join(repoRoot, 'config', 'powers.yaml'), 'autoApprove:\n  - action: ops\n    detail: "service:qwen-server:start"\n');
  alfred = await startAlfred({
    dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: idle, gitRoot: join(base, 'git'),
    token: 'tok', mcpConfigPath: join(repoRoot, 'config', 'mcp.json'),
    extra: { exec, spawnDetached: () => {}, qwenUrl: 'http://127.0.0.1:9', repoRoot, llm: idle },
  });
  // capture hub.reconfigure calls
  const hub: any = (alfred as any).hub;
  const orig = hub.reconfigure.bind(hub);
  hub.reconfigure = async (s: any) => { reconfigured.push(s); return orig(s); };
  const powers: any = alfred.modules.powers;
  tool = async (name, args, ctx = {}) => {
    const t = powers.tools.find((x: any) => x.schema.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(args, { taskId: 'none', goalId: '', workspace: base, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {}, ...ctx });
  };
}, 60_000);
afterAll(async () => { await alfred?.stop(); });

function parkedTask() {
  const g = alfred.store.createGoal({ title: 'powers goal' });
  const t = alfred.store.createTask({ goalId: g.id, persona: 'alfred', title: 'powers task' });
  alfred.store.claim(t.id, 'w', 60_000);
  return t;
}

describe('capability card and platform reads', () => {
  it('describes what agents control, within budget', async () => {
    const card = await tool('platform', { op: 'capabilities' });
    expect(card.ok).toBe(true);
    for (const w of ['board', 'platform', 'connectors', 'alfred_dev', 'message', 'call', 'approval']) expect(card.output.toLowerCase()).toContain(w);
    expect(estimateTokens(card.output)).toBeLessThanOrEqual(900);
    const names = (alfred.modules.powers as any).tools.map((t: any) => t.schema.name).sort();
    expect(names).toEqual(expect.arrayContaining(['alfred_dev', 'connectors', 'platform']));
    for (const t of (alfred.modules.powers as any).tools) expect(estimateTokens(JSON.stringify(t.schema))).toBeLessThanOrEqual(450);
    const svc = await tool('platform', { op: 'services' });
    expect(svc.ok).toBe(true);
    expect(svc.output).toContain('qwen-server');
    expect((await tool('platform', { op: 'stats' })).output).toMatch(/GPU|gpu/);
    expect((await tool('platform', { op: 'bogus' })).ok).toBe(false);
  });
});

describe('the approval gate', () => {
  it('parks a mutating op, runs it once after approval, parks again after', async () => {
    const t = parkedTask();
    const ctx = { taskId: t.id, goalId: t.goalId };
    const first = await tool('platform', { op: 'service', name: 'qwen-server', action: 'restart' }, ctx);
    expect(first.ok).toBe(false);
    expect(first.park).toMatchObject({ status: 'blocked' });
    const [ap] = alfred.store.approvals({ status: 'pending', taskId: t.id });
    expect(ap.detail).toBe('service:qwen-server:restart');
    expect(calls.some(c => c.cmd === 'systemctl' && c.args.includes('restart'))).toBe(false);
    alfred.store.decideApproval(ap.id, 'approved', 'quinn');
    const second = await tool('platform', { op: 'service', name: 'qwen-server', action: 'restart' }, ctx);
    expect(second.ok).toBe(true);
    expect(calls.some(c => c.cmd === 'systemctl' && c.args.join(' ').includes('restart qwen-server.service'))).toBe(true);
    const third = await tool('platform', { op: 'service', name: 'qwen-server', action: 'restart' }, ctx);
    expect(third.park).toBeTruthy();
  });

  it('honours powers.yaml autoApprove and chat confirm', async () => {
    const t = parkedTask();
    const auto = await tool('platform', { op: 'service', name: 'qwen-server', action: 'start' }, { taskId: t.id, goalId: t.goalId });
    expect(auto.ok).toBe(true);
    const ask = await tool('platform', { op: 'service', name: 'qwen-server', action: 'stop' }, { taskId: 'chat:th1' });
    expect(ask.ok).toBe(false);
    expect(ask.park).toBeUndefined();
    expect(ask.output).toContain('confirm');
    const ok = await tool('platform', { op: 'service', name: 'qwen-server', action: 'stop', confirm: true }, { taskId: 'chat:th1' });
    expect(ok.ok).toBe(true);
    expect(alfred.store.allEvents().some(e => e.kind === 'power' && e.goalId === '')).toBe(true);
  });
});

describe('connectors', () => {
  it('adds and removes an MCP server in config/mcp.json and reconnects', async () => {
    const t = parkedTask();
    const ctx = { taskId: t.id, goalId: t.goalId };
    const add = { op: 'add', name: 'weather', url: 'http://127.0.0.1:9/mcp' };
    expect((await tool('connectors', add, ctx)).park).toBeTruthy();
    const [ap] = alfred.store.approvals({ status: 'pending', taskId: t.id });
    expect(ap.detail).toBe('connector:weather:add');
    alfred.store.decideApproval(ap.id, 'approved', 'quinn');
    expect((await tool('connectors', add, ctx)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(repoRoot, 'config', 'mcp.json'), 'utf8')).servers.weather.url).toBe('http://127.0.0.1:9/mcp');
    expect(reconfigured.at(-1)).toHaveProperty('weather');
    const list = await (await fetch(`${alfred.url}/api/v1/connectors`, { headers: { authorization: 'Bearer tok' } })).json();
    expect(list.find((c: any) => c.name === 'weather')).toMatchObject({ ok: false });
    const del = await fetch(`${alfred.url}/api/v1/connectors/weather`, { method: 'DELETE', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    expect(del.status).toBe(200);
    expect(JSON.parse(readFileSync(join(repoRoot, 'config', 'mcp.json'), 'utf8')).servers.weather).toBeUndefined();
  });
});

describe('self-development', () => {
  it('proposes a change to alfred as a coder goal in a worktree, and gates deploy', async () => {
    const r = await tool('alfred_dev', { op: 'propose', title: 'Add a clock to the top bar', spec: 'show HH:MM', area: 'web' });
    expect(r.ok).toBe(true);
    const goal = alfred.store.listGoals().find(g => g.title === 'Add a clock to the top bar')!;
    expect(goal.meta).toMatchObject({ repo: 'alfred', mode: 'repo' });
    expect(alfred.store.getRepo('alfred')!.paths.local).toBe(repoRoot);
    const root = alfred.store.listTasks(goal.id)[0];
    expect(root.persona).toBe('coder');
    const cmds = root.acceptance.map(a => a.cmd).join(' | ');
    expect(cmds).toContain('build:web');
    expect(cmds).toContain('vitest');
    const t = parkedTask();
    const dep = await tool('alfred_dev', { op: 'deploy', goal: goal.slug }, { taskId: t.id, goalId: t.goalId });
    expect(dep.park).toBeTruthy();
    expect(alfred.store.approvals({ status: 'pending', taskId: t.id })[0].detail).toBe(`deploy:${goal.slug}`);
  });
});
