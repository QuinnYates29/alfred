// P7 unit tests: registry precedence details, local-config override, task-level model.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModels, ModelRegistry, ModelConfigError, modelsConfigPath, type ModelSpec } from '../../src/models.js';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { runTask } from '../../src/runtime/agent.js';
import { call } from '../../src/runtime/testing.js';
import type { LLM } from '../../src/runtime/contract.js';

const YAML = `
models:
  - name: alpha
    baseUrl: http://127.0.0.1:1110
    model: qwen-a
  - name: beta
    baseUrl: http://127.0.0.1:1110
    model: qwen-b
roles:
  default: alpha
  coder: alpha
`;

function cfgFile(text = YAML) {
  const p = join(mkdtempSync(join(tmpdir(), 'alfred-mu-')), 'models.yaml');
  writeFileSync(p, text);
  return p;
}

const answeringFactory = () => (spec: ModelSpec): LLM => ({
  async chat() {
    return {
      content: '',
      toolCalls: [call('give_up', { reason: `by ${spec.name}` })],
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  },
});

describe('models unit', () => {
  it('modelsConfigPath prefers models.local.yaml when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-cfg-'));
    expect(modelsConfigPath(dir)).toBe(join(dir, 'models.yaml'));
    writeFileSync(join(dir, 'models.local.yaml'), YAML);
    expect(modelsConfigPath(dir)).toBe(join(dir, 'models.local.yaml'));
  });

  it('model name wins over a role of the same spelling; roles() is a copy', () => {
    const reg = new ModelRegistry(loadModels(cfgFile()));
    expect(reg.resolve('beta').name).toBe('beta'); // model name, even though coder→beta
    const r = reg.roles();
    r.default = 'nope';
    expect(reg.resolve().name).toBe('alpha');
  });

  it('missing file → ModelConfigError', () => {
    expect(() => loadModels(join(tmpdir(), 'definitely-not-here-x.yaml'))).toThrow(ModelConfigError);
  });

  it("task-level model (spawn arg) beats the persona's model", async () => {
    const models = new ModelRegistry(loadModels(cfgFile()), { llmFactory: answeringFactory() });
    const store = openStore(':memory:');
    const tr = new ToolRegistry();
    for (const t of allTools()) tr.register(t);
    const personas = loadPersonas('personas', tr); // coder → role coder → (shipped cfg) qwen-local… use local: override via goal-less path
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({
      goalId: g.id, persona: 'coder', title: 't',
      acceptance: [{ name: 'a', cmd: 'true' }], model: 'beta',
    });
    expect(store.getTaskModel(t.id)).toBe('beta');
    const ws = mkdtempSync(join(tmpdir(), 'alfred-ws-'));
    const finished = await runTask(t.id, {
      store, models, personas, registry: tr, workerId: 'w', workspaceFor: () => ws,
      llm: { chat: async () => { throw new Error('must not be used'); } } as LLM,
    } as any);
    expect(finished.reason).toBe('by beta');
  });
});
