// P21a — agent powers: the agents run the platform (platform), its connectors
// (connectors) and alfred's own code (alfred_dev), behind the approval gate.
// Exposes `(module as any).card()` (the capability card) and `.reloadMcp()`.
import type { AlfredModule, ModuleDeps } from '../modules.js';
import type { Tool } from '../runtime/contract.js';
import type { Store } from '../store.js';
import { storeForTask } from '../approvals.js';
import { capabilityCard } from './card.js';
import { Connectors, connectorsRouter, connectorsTool } from './connectors.js';
import { platformTool } from './platform.js';
import { alfredDevTool, devRouter } from './dev.js';
import express from 'express';
import { notifyTool } from './notify.js';

/** Each running instance's tools, by its store (for the unbound stubs below). */
const bound = new WeakMap<Store, Tool[]>();

function buildTools(deps: ModuleDeps, conns: Connectors): Tool[] {
  return [platformTool(deps), connectorsTool(deps, conns), alfredDevTool(deps), notifyTool(deps)];
}

export function createPowersModule(deps: ModuleDeps): AlfredModule {
  const conns = new Connectors(deps);
  const tools = buildTools(deps, conns);
  bound.set(deps.store, tools);
  const mod: AlfredModule = {
    name: 'powers',
    router: express.Router().use(connectorsRouter(deps, conns), devRouter(deps)),
    tools,
  };
  (mod as any).card = () => capabilityCard(deps);
  (mod as any).reloadMcp = () => conns.reload();
  return mod;
}

/**
 * The same tools without a module (allTools(), for registries built outside startAlfred —
 * persona loading in tests): same schemas; a run finds the instance that owns the task's
 * store, or answers that the platform is unavailable.
 */
export function powersToolStubs(): Tool[] {
  const shape = buildTools({ extra: {} } as unknown as ModuleDeps, new Connectors({} as ModuleDeps));
  return shape.map((t) => ({
    ...t,
    run: async (args, ctx) => {
      const store = storeForTask(ctx.taskId);
      const real = store ? bound.get(store)?.find((x) => x.schema.name === t.schema.name) : undefined;
      return real ? real.run(args, ctx) : { ok: false, output: `${t.schema.name} is not available in this runtime` };
    },
  }));
}
