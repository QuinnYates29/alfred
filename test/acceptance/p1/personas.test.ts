// P1 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, builtinTools } from '../../../src/runtime/tools.js';
import { loadPersonas, promptCost } from '../../../src/runtime/personas.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import { PersonaBudgetError, PersonaConfigError} from '../../../src/runtime/contract.js';

function registry() {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

describe('context budget', () => {
  it('estimates tokens conservatively', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('ships the four v1 personas, each within its own budget and within 6000 tokens', () => {
    const reg = registry();
    const ps = loadPersonas('personas', reg);
    for (const name of ['alfred', 'coder', 'researcher', 'coder-lg']) {
      const p = ps.get(name);
      expect(p, name).toBeDefined();
      expect(p!.promptBudgetTokens).toBeLessThanOrEqual(6000);
      expect(promptCost(p!, reg)).toBeLessThanOrEqual(p!.promptBudgetTokens);
      expect(p!.system).toMatch(/give_up/);
      expect(p!.system).toMatch(/ask_claude/);
    }
    expect(ps.get('alfred')!.canSpawn).toEqual(expect.arrayContaining(['coder', 'researcher']));
  });

  it('refuses a persona whose prompt plus tools exceed its budget, naming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(dir, 'chatty.yaml'), [
      'name: chatty', 'description: too much', 'promptBudgetTokens: 500', 'canSpawn: []',
      'tools: [read_file, write_file, run_shell, finish, give_up, ask_claude]',
      'system: |', '  ' + 'You are extremely verbose. '.repeat(200),
    ].join('\n'));
    expect(() => loadPersonas(dir, registry())).toThrow(PersonaBudgetError);
    expect(() => loadPersonas(dir, registry())).toThrow(/chatty/);
  });

  it('refuses unknown tools and dangling canSpawn', () => {
    const d1 = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(d1, 'x.yaml'), 'name: x\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: []\ntools: [teleport]\nsystem: hi give_up ask_claude\n');
    expect(() => loadPersonas(d1, registry())).toThrow(PersonaConfigError);
    const d2 = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(d2, 'y.yaml'), 'name: y\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: [ghost]\ntools: [spawn_subagent, finish]\nsystem: hi give_up ask_claude\n');
    expect(() => loadPersonas(d2, registry())).toThrow(PersonaConfigError);
  });
});

