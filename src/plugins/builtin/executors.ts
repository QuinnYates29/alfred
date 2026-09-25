// P11 built-in plugin: the coding executors (dsh / pipeline / langgraph).
// Dogfoods the extension API — disable `builtin-executors` and these tools
// simply do not exist.
import type { AlfredPlugin } from '../../plugins.js';
import type { ToolRegistry } from '../../runtime/tools.js';
import type { ModelRegistry } from '../../models.js';
import { dshTool } from '../../executors/dsh.js';
import { pipelineTool } from '../../executors/pipeline.js';
import { langgraphTool } from '../../executors/langgraph.js';

export interface BuiltinExecutorsDeps {
  registry: ToolRegistry;
  models?: () => ModelRegistry | undefined;
}

export function builtinExecutorsPlugin(deps: BuiltinExecutorsDeps): AlfredPlugin {
  return {
    name: 'builtin-executors',
    version: '1.0.0',
    setup(ctx) {
      const cfg = ctx.config ?? {};
      const models = deps.models?.();
      deps.registry.register(dshTool({ bin: cfg.dshBin, defaultTimeoutMin: cfg.dshTimeoutMin }));
      deps.registry.register(
        pipelineTool({ bin: cfg.pipelineBin, baseUrl: cfg.pipelineBaseUrl, models }),
      );
      deps.registry.register(
        langgraphTool({
          python: cfg.langgraphPython,
          baseUrl: cfg.langgraphBaseUrl,
          defaultTimeoutMin: cfg.langgraphTimeoutMin,
          models,
        }),
      );
    },
  };
}
