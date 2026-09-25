// P7 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModels, ModelRegistry, ModelConfigError, type ModelSpec } from '../../../src/models.js';
import { openStore } from '../../../src/store.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { allTools } from '../../../src/runtime/alltools.js';
import { loadPersonas } from '../../../src/runtime/personas.js';
import { runTask } from '../../../src/runtime/agent.js';
import { call } from '../../../src/runtime/testing.js';
import type { LLM } from '../../../src/runtime/contract.js';

const YAML = `
models:
  - name: alpha
    baseUrl: http://127.0.0.1:1110
    model: qwen-a
    slots: 1
  - name: beta
    baseUrl: http://127.0.0.1:1110
    model: qwen-b
  - name: remote
    baseUrl: https://api.example.com
    model: big/model
    apiKeyEnv: EXAMPLE_KEY
roles:
  default: alpha
  coder: beta
  planner: alpha
  fast: alpha
`;

function cfgFile(text = YAML) {
  const p = join(mkdtempSync(join(tmpdir(), 'alfred-models-')), 'models.yaml');
  writeFileSync(p, text);
  return p;
}

/** A factory whose LLMs record which model answered and how many were in flight. */
function recordingFactory() {
  const calls: string[] = [];
  let inFlight = 0, peak = 0;
  const keys: Record<string, string | undefined> = {};
  const factory = (spec: ModelSpec, apiKey: string | undefined): LLM => {
    keys[spec.name] = apiKey;
    return {
      async chat() {
        calls.push(spec.name); inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 20));
        inFlight--;
        return { content: '', toolCalls: [call('give_up', { reason: `answered by ${spec.name}` })], usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
  };
  return { factory, calls, keys, peak: () => peak };
}

describe('model config', () => {
  it('loads, resolves names and roles, and rejects bad configs', () => {
    const cfg = loadModels(cfgFile());
    const reg = new ModelRegistry(cfg, { env: { EXAMPLE_KEY: 'k123' } });
    expect(reg.resolve().name).toBe('alpha');
    expect(reg.resolve('coder').name).toBe('beta');
    expect(reg.resolve('remote').model).toBe('big/model');
    expect(() => reg.resolve('nope')).toThrow(ModelConfigError);
    expect(reg.list().find(m => m.name === 'alpha')!.roles).toEqual(expect.arrayContaining(['default', 'planner', 'fast']));
    expect(() => loadModels(cfgFile(YAML.replace('coder: beta', 'coder: ghost')))).toThrow(ModelConfigError);
    expect(() => loadModels(cfgFile(YAML.replace('default: alpha', 'x: alpha')))).toThrow(ModelConfigError);
    expect(() => loadModels(cfgFile(YAML.replace('name: beta', 'name: alpha')))).toThrow(ModelConfigError);
  });

  it('ships a valid default config and personas that name roles', () => {
    const cfg = loadModels('config/models.yaml');
    const reg = new ModelRegistry(cfg);
    expect(reg.resolve().model).toBe('qwen3.8-flash-next');
    const tr = new ToolRegistry();
    for (const t of allTools()) tr.register(t);
    for (const p of loadPersonas('personas', tr).values()) expect(() => reg.resolve(p.model), p.name).not.toThrow();
  });
});

describe('registry behaviour', () => {
  it('passes the api key from env, caches per spec, and shares slots per endpoint', async () => {
    const rec = recordingFactory();
    const reg = new ModelRegistry(loadModels(cfgFile()), { env: { EXAMPLE_KEY: 'k123' }, llmFactory: rec.factory });
    expect(reg.llm('alpha')).toBe(reg.llm('alpha'));
    await reg.llm('remote').chat({ system: '', messages: [], tools: [] });
    expect(rec.keys.remote).toBe('k123');
    // alpha (slots 1) and beta share http://127.0.0.1:1110 → one semaphore of size max(1, default 3) = 3
    await Promise.all([1, 2, 3, 4, 5, 6].map(i => reg.llm(i % 2 ? 'alpha' : 'beta').chat({ system: '', messages: [], tools: [] })));
    expect(rec.peak()).toBeLessThanOrEqual(3);
    expect(rec.peak()).toBeGreaterThanOrEqual(2);
  });

  it('setRole switches and persists; reload picks up edits; a broken edit keeps the old config', () => {
    const path = cfgFile();
    const reg = new ModelRegistry(loadModels(path), { path });
    reg.setRole('coder', 'remote');
    expect(reg.resolve('coder').name).toBe('remote');
    expect(loadModels(path).roles.coder).toBe('remote');
    expect(() => reg.setRole('coder', 'ghost')).toThrow(ModelConfigError);
    writeFileSync(path, readFileSync(path, 'utf8').replace('model: qwen-b', 'model: qwen-b2'));
    reg.reload();
    expect(reg.resolve('beta').model).toBe('qwen-b2');
    writeFileSync(path, 'models: [ this is not valid');
    expect(() => reg.reload()).toThrow();
    expect(reg.resolve('beta').model).toBe('qwen-b2');
  });
});

describe('runtime uses the registry', () => {
  function setup() {
    const rec = recordingFactory();
    const models = new ModelRegistry(loadModels(cfgFile()), { llmFactory: rec.factory });
    const store = openStore(':memory:');
    const tr = new ToolRegistry();
    for (const t of allTools()) tr.register(t);
    const personas = loadPersonas('personas', tr);
    const ws = mkdtempSync(join(tmpdir(), 'alfred-m-'));
    const base = { store, personas, registry: tr, workerId: 'w', workspaceFor: () => ws, models,
      llm: { chat: async () => { throw new Error('fallback llm must not be used'); } } as LLM };
    return { rec, models, store, base };
  }

  it("uses the persona's role, and a goal-level model overrides it", async () => {
    const { rec, store, base } = setup();
    const g1 = store.createGoal({ title: 'role goal' });
    const t1 = store.createTask({ goalId: g1.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    expect((await runTask(t1.id, base as any)).reason).toBe('answered by beta'); // coder → role coder → beta
    const g2 = store.createGoal({ title: 'override goal', meta: { model: 'remote' } });
    const t2 = store.createTask({ goalId: g2.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    expect((await runTask(t2.id, base as any)).reason).toBe('answered by remote');
  });

  it('a role switch applies to the next task without a restart', async () => {
    const { models, store, base } = setup();
    models.setRole('coder', 'alpha');
    const g = store.createGoal({ title: 'switched' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 't', acceptance: [{ name: 'a', cmd: 'true' }] });
    expect((await runTask(t.id, base as any)).reason).toBe('answered by alpha');
  });
});
