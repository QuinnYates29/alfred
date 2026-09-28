// Models page: per-model tool deny lists (validation, runtime filter + refusal, matrix writes)
// and the llama-server extra-flags parser.
import { describe, it, expect, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModels, ModelConfigError, ModelRegistry } from '../../src/models.js';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { runTask } from '../../src/runtime/agent.js';
import { call, scriptedLLM } from '../../src/runtime/testing.js';
import type { LLM, Tool } from '../../src/runtime/contract.js';
import type { ModuleDeps } from '../../src/modules.js';
import { validateConfigContent } from '../../src/ops/config-files.js';
import { applyPermissions } from '../../src/ops/permissions.js';
import { parseQwenExtra, parseQwenSetting, runQwenctl, validateQwenExtra } from '../../src/ops/qwen.js';
import { makeCtx } from '../../src/ops/exec.js';
import { ChatEngine } from '../../src/chat/engine.js';
import { openChatStore } from '../../src/chat/store.js';
// @ts-expect-error — plain JS module from the web app
import { joinRows, parseExtra, rowError } from '../../web/src/lib/qwenFlags.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'alfred-perm-'));

function modelsFile(deny?: unknown): string {
  const p = join(tmp(), 'models.yaml');
  const d = deny === undefined ? '' : `    deny: ${JSON.stringify(deny)}\n`;
  writeFileSync(p, `models:\n  - name: local\n    baseUrl: http://x:1\n    model: m\n${d}  - name: remote\n    baseUrl: http://y:1\n    model: r\nroles:\n  default: local\n  planner: local\n  coder: local\n  fast: remote\n`);
  return p;
}

function registry() {
  const tr = new ToolRegistry();
  for (const t of allTools()) tr.register(t);
  return tr;
}

describe('models.yaml deny list', () => {
  it('parses, dedupes, and exposes deny per model/role', () => {
    const cfg = loadModels(modelsFile(['run_shell', 'message', 'run_shell']));
    expect(cfg.models[0].deny).toEqual(['run_shell', 'message']);
    expect(cfg.models[1].deny).toBeUndefined();
    const reg = new ModelRegistry(cfg);
    expect([...reg.denied('coder')]).toEqual(['run_shell', 'message']);
    expect(reg.denied('fast').size).toBe(0);
    expect(reg.denied('nope').size).toBe(0);
    expect(reg.list()[0].deny).toEqual(['run_shell', 'message']);
    expect(loadModels(modelsFile([])).models[0].deny).toBeUndefined();
  });

  it('rejects bad shapes, control tools, and (with a registry) unknown tools', () => {
    expect(() => loadModels(modelsFile('run_shell'))).toThrow(ModelConfigError);
    expect(() => loadModels(modelsFile([1]))).toThrow(/tool names/);
    expect(() => loadModels(modelsFile(['finish']))).toThrow(/cannot deny "finish"/);
    expect(() => loadModels(modelsFile(['give_up']))).toThrow(/cannot deny/);
    expect(() => loadModels(modelsFile(['nosuch']), { knownTools: ['run_shell'] })).toThrow(/unknown tool "nosuch"/);
    expect(() => loadModels(modelsFile(['nosuch']))).not.toThrow(); // startup: no registry yet
  });

  it('the config editor validates deny names against the tool registry', () => {
    const deps = { registry: registry(), repoRoot: '/r', personasDir: '/p' } as unknown as ModuleDeps;
    const ok = readFileSync(modelsFile(['run_shell']), 'utf8');
    expect(() => validateConfigContent(deps, 'config/models.yaml', ok)).not.toThrow();
    const bad = readFileSync(modelsFile(['rm_rf']), 'utf8');
    expect(() => validateConfigContent(deps, 'config/models.yaml', bad)).toThrow(/unknown tool "rm_rf"/);
  });
});

describe('runtime enforcement', () => {
  function setup(deny: string[], llm: LLM) {
    const tr = registry();
    const models = new ModelRegistry(loadModels(modelsFile(deny)), { llmFactory: () => llm });
    const store = openStore(':memory:');
    const personas = loadPersonas('personas', tr);
    const ws = mkdtempSync(join(tmpdir(), 'alfred-permws-'));
    return { store, base: { store, personas, registry: tr, workerId: 'w', workspaceFor: () => ws, models, llm } };
  }

  it('drops denied tools from the offer and refuses them if called anyway', async () => {
    const llm = scriptedLLM([
      { toolCalls: [call('run_shell', { cmd: 'touch pwned' })] },
      { toolCalls: [call('give_up', { reason: 'done testing' })] },
    ]);
    const { store, base } = setup(['run_shell', 'dsh_code'], llm);
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    const out = await runTask(t.id, base as any);
    expect(out.status).toBe('failed');
    const offered = llm.requests[0].tools!.map((s) => s.name);
    expect(offered).not.toContain('run_shell');
    expect(offered).not.toContain('dsh_code');
    expect(offered).toContain('write_file');
    const tool = store.events(g.id).find((e: any) => e.kind === 'tool' && e.data.name === 'run_shell') as any;
    expect(tool.data.ok).toBe(false);
    expect(tool.data.output).toMatch(/not allowed on model local/);
    expect(existsSync(join((base as any).workspaceFor(), 'pwned'))).toBe(false);
  });

  it('with no deny the persona tool set is unchanged', async () => {
    const llm = scriptedLLM([{ toolCalls: [call('give_up', { reason: 'x' })] }]);
    const { store, base } = setup([], llm);
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    await runTask(t.id, base as any);
    expect(llm.requests[0].tools!.map((s) => s.name)).toContain('run_shell');
  });

  it('chat drops and refuses tools denied on the planner model', async () => {
    const ran = vi.fn();
    const board: Tool = {
      kind: 'read',
      schema: { name: 'board', description: 'b', parameters: { type: 'object', properties: {} } },
      run: async () => { ran(); return { ok: true, output: 'items' }; },
    };
    const llm = scriptedLLM([
      { toolCalls: [call('board', {})] },
      { content: 'ok' },
    ]);
    const store = openStore(':memory:');
    const models = new ModelRegistry(loadModels(modelsFile(['board'])), { llmFactory: () => llm });
    const deps = { store, env: {}, extra: {}, models, modules: { board: { name: 'board', tools: [board] } }, personas: new Map() } as unknown as ModuleDeps;
    const engine = new ChatEngine(deps, openChatStore(store));
    const th = engine.createThread('t');
    const msg = await engine.send(th.id, 'show the board');
    expect(llm.requests[0].tools!.map((s) => s.name)).not.toContain('board');
    expect(ran).not.toHaveBeenCalled();
    expect(msg.actions?.[0]).toMatchObject({ name: 'board', ok: false });
    expect(msg.actions?.[0].output).toMatch(/not allowed/);
  });
});

describe('permissions matrix writes', () => {
  function setup() {
    const root = tmp();
    mkdirSync(join(root, 'config'));
    cpSync('config/models.yaml', join(root, 'config', 'models.yaml'));
    cpSync('personas', join(root, 'personas'), { recursive: true });
    const tr = registry();
    const modelsPath = join(root, 'config', 'models.yaml');
    const models = new ModelRegistry(loadModels(modelsPath), { path: modelsPath });
    const reloadPersonas = vi.fn(() => []);
    const deps = { registry: tr, repoRoot: root, personasDir: join(root, 'personas'), models, reloadPersonas } as unknown as ModuleDeps;
    return { root, deps, models, reloadPersonas, backup: join(root, 'bak') };
  }

  it("rewrites a persona's tools list keeping the rest of the file, backs up and reloads", () => {
    const { root, deps, reloadPersonas, backup } = setup();
    const before = readFileSync(join(root, 'personas', 'researcher.yaml'), 'utf8');
    const out = applyPermissions(deps, backup, { personas: { researcher: ['read_file', 'list_dir', 'note', 'finish', 'give_up', 'ask_claude'] } });
    expect(out.written).toEqual(['personas/researcher.yaml']);
    const after = readFileSync(join(root, 'personas', 'researcher.yaml'), 'utf8');
    expect(after).toContain('tools: [ read_file, list_dir, note, finish, give_up, ask_claude ]');
    expect(after.slice(after.indexOf('system:'))).toBe(before.slice(before.indexOf('system:')));
    expect(reloadPersonas).toHaveBeenCalled();
    expect(readdirSync(join(backup, 'personas')).length).toBe(1);
    expect(loadPersonas(join(root, 'personas'), deps.registry).get('researcher')!.tools).not.toContain('run_shell');
  });

  it('writes and clears a model deny list and reloads the registry live', () => {
    const { root, deps, models, backup } = setup();
    applyPermissions(deps, backup, { models: { 'qwen-local': ['message', 'call'] } });
    expect(readFileSync(join(root, 'config', 'models.yaml'), 'utf8')).toContain('deny: [ message, call ]');
    expect([...models.denied('planner')]).toEqual(['message', 'call']);
    applyPermissions(deps, backup, { models: { 'qwen-local': [] } });
    expect(readFileSync(join(root, 'config', 'models.yaml'), 'utf8')).not.toContain('deny');
    expect(models.denied('planner').size).toBe(0);
  });

  it('validates everything before writing anything', () => {
    const { root, deps, backup } = setup();
    const models0 = readFileSync(join(root, 'config', 'models.yaml'), 'utf8');
    const coder0 = readFileSync(join(root, 'personas', 'coder.yaml'), 'utf8');
    const res0 = readFileSync(join(root, 'personas', 'researcher.yaml'), 'utf8');
    // unknown tool in a deny list → nothing written, persona change included
    expect(() => applyPermissions(deps, backup, { personas: { researcher: ['read_file', 'finish'] }, models: { 'qwen-local': ['nosuch'] } }))
      .toThrow(/unknown tool/);
    // spawn_subagent without canSpawn, unknown persona tool, unknown model, finish denied, bad shapes
    expect(() => applyPermissions(deps, backup, { personas: { coder: ['read_file', 'finish', 'give_up'] } })).toThrow(/spawn_subagent/);
    expect(() => applyPermissions(deps, backup, { personas: { researcher: ['read_file', 'hack'] } })).toThrow(/hack/);
    expect(() => applyPermissions(deps, backup, { personas: { '../x': ['read_file'] } })).toThrow(/persona name/);
    expect(() => applyPermissions(deps, backup, { personas: { ghost: ['read_file'] } })).toThrow(/no file/);
    expect(() => applyPermissions(deps, backup, { models: { nope: [] } })).toThrow(/unknown model/);
    expect(() => applyPermissions(deps, backup, { models: { 'qwen-local': ['finish'] } })).toThrow(/cannot deny/);
    expect(() => applyPermissions(deps, backup, { models: { 'qwen-local': 'run_shell' } })).toThrow(/list of tool names/);
    expect(() => applyPermissions(deps, backup, {})).toThrow(/nothing to change/);
    expect(readFileSync(join(root, 'config', 'models.yaml'), 'utf8')).toBe(models0);
    expect(readFileSync(join(root, 'personas', 'coder.yaml'), 'utf8')).toBe(coder0);
    expect(readFileSync(join(root, 'personas', 'researcher.yaml'), 'utf8')).toBe(res0);
    expect(existsSync(backup)).toBe(false);
  });
});

describe('QWEN_EXTRA flags', () => {
  const current = '--reasoning-budget 1536 --tensor-read-lazy on -t 10 --cpu-mask 0xF83E0 --cpu-strict 1';

  it('parses the live value into rows and round-trips it', () => {
    const rows = parseQwenExtra(current);
    expect(rows).toEqual([
      { flag: '--reasoning-budget', value: '1536' },
      { flag: '--tensor-read-lazy', value: 'on' },
      { flag: '-t', value: '10' },
      { flag: '--cpu-mask', value: '0xF83E0' },
      { flag: '--cpu-strict', value: '1' },
    ]);
    expect(validateQwenExtra(`  ${current.replace(/ /g, '   ')} `)).toBe(current);
    expect(parseQwenExtra('--seed -1 --jinja -ot per_layer_token_embd=CPU')).toEqual([
      { flag: '--seed', value: '-1' },
      { flag: '--jinja', value: '' },
      { flag: '-ot', value: 'per_layer_token_embd=CPU' },
    ]);
    expect(validateQwenExtra('')).toBe('');
  });

  it('rejects injection attempts and non-flags', () => {
    for (const bad of [
      '--x 1; rm -rf ~', '--x $(id)', '--x `id`', '--x 1 | sh', '--x 1 && reboot', '--x 1 > /etc/passwd',
      '--x <in', '--x 1\n--y 2', '--x "a b"', "--x 'a'", '--x a\\b', '--x ${HOME}', '--x 1 & ',
      'rm -rf /', '1 --x', '--', '-', '--bad=flag', '-1x',
    ]) {
      expect(() => validateQwenExtra(bad), bad).toThrow();
    }
    expect(() => validateQwenExtra(42)).toThrow(/string/);
    expect(() => parseQwenSetting({ extra: '--x; id' })).toThrow();
    expect(parseQwenSetting({ extra: ' --jinja  ' })).toEqual({ verb: 'extra', value: '--jinja' });
  });

  it('hands qwenctl the flags as ONE argv element', async () => {
    const calls: string[][] = [];
    const ctx = makeCtx({ env: {}, repoRoot: '/r', extra: { exec: async (_c: string, a: string[]) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; } } } as unknown as ModuleDeps);
    const s = parseQwenSetting({ extra: current });
    await runQwenctl(ctx, s.verb, s.value);
    expect(calls).toEqual([['extra', current]]);
  });

  it('the web editor parses and validates the same way', () => {
    expect(parseExtra(current)).toEqual(parseQwenExtra(current));
    expect(() => parseExtra('--x $(id)')).toThrow();
    expect(() => parseExtra('oops')).toThrow(/start with -/);
    expect(rowError({ flag: 'x', value: '' })).toMatch(/start with -/);
    expect(rowError({ flag: '--x', value: '1;id' })).toMatch(/no ;/);
    expect(rowError({ flag: '--x', value: '1 --y' })).toMatch(/another flag/);
    expect(rowError({ flag: '--x', value: '-1' })).toBe('');
    expect(joinRows([{ flag: ' -t ', value: ' 10 ' }, { flag: '', value: '' }, { flag: '--jinja', value: '' }])).toBe('-t 10 --jinja');
  });
});
