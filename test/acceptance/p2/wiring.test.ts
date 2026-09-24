// P2 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { allTools } from '../../../src/runtime/alltools.js';
import { ToolRegistry } from '../../../src/runtime/tools.js';
import { loadPersonas, promptCost } from '../../../src/runtime/personas.js';

describe('persona budgets with every executor registered', () => {
  it('all personas still fit, coder has dsh_code + pipeline_run, coder-lg is constrained to langgraph_code', () => {
    const reg = new ToolRegistry();
    for (const t of allTools()) reg.register(t);
    const ps = loadPersonas('personas', reg);
    for (const p of ps.values()) expect(promptCost(p, reg), p.name).toBeLessThanOrEqual(p.promptBudgetTokens);
    expect(ps.get('coder')!.tools).toEqual(expect.arrayContaining(['dsh_code', 'pipeline_run']));
    const lg = ps.get('coder-lg')!.tools;
    expect(lg).toContain('langgraph_code');
    expect(lg).not.toContain('run_shell');
    expect(lg).not.toContain('write_file');
  });
});

