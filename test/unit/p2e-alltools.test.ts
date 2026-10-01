import { describe, it, expect } from 'vitest';
import { allTools } from '../../src/runtime/alltools.js';
import { ToolRegistry, builtinTools } from '../../src/runtime/tools.js';

describe('allTools', () => {
  it('is builtins plus the three executors, ui_test, the board tool, the P21 powers, comms, jira and vault tools', () => {
    const names = allTools().map((t) => t.schema.name);
    expect(names).toEqual([...builtinTools().map((t) => t.schema.name), 'dsh_code', 'pipeline_run', 'langgraph_code', 'ui_test', 'board', 'platform', 'connectors', 'alfred_dev', 'notify', 'ask_quinn', 'contacts', 'message', 'call', 'jev_decide', 'jira', 'vault']);
    for (const n of ['dsh_code', 'pipeline_run', 'langgraph_code']) {
      expect(allTools().find((t) => t.schema.name === n)!.kind).toBe('exec');
    }
  });

  it('registers without name collisions', () => {
    const reg = new ToolRegistry();
    expect(() => {
      for (const t of allTools()) reg.register(t);
    }).not.toThrow();
    expect(reg.schemasFor(['dsh_code', 'pipeline_run', 'langgraph_code']).map((s) => s.name)).toEqual([
      'dsh_code',
      'pipeline_run',
      'langgraph_code',
    ]);
  });

  it('accepts per-executor overrides', () => {
    const ts = allTools({ dsh: { bin: 'x' }, pipeline: { bin: 'y' }, langgraph: { python: 'z' } });
    expect(ts).toHaveLength(allTools().length);
  });
});
