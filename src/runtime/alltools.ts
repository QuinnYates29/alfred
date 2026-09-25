// P2 wiring: every tool a persona can be given — builtins plus the three executors.
import type { Tool } from './contract.js';
import type { ModelRegistry } from '../models.js';
import { builtinTools } from './tools.js';
import { dshTool } from '../executors/dsh.js';
import { pipelineTool } from '../executors/pipeline.js';
import { langgraphTool } from '../executors/langgraph.js';

export function allTools(
  o: {
    dsh?: Parameters<typeof dshTool>[0];
    pipeline?: Parameters<typeof pipelineTool>[0];
    langgraph?: Parameters<typeof langgraphTool>[0];
    /** P7: passed to the langgraph/pipeline executors (the 'coder' role's endpoint). */
    models?: ModelRegistry;
  } = {},
): Tool[] {
  return [
    ...builtinTools(),
    dshTool(o.dsh),
    pipelineTool({ ...o.pipeline, models: o.pipeline?.models ?? o.models }),
    langgraphTool({ ...o.langgraph, models: o.langgraph?.models ?? o.models }),
  ];
}
