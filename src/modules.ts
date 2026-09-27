// P13+ contract (written by the orchestrator). Feature modules — board, ops, review,
// chat, slack — plug into startAlfred through this one seam so each can be built in
// its own files without touching main.ts or app.ts.
//
// Lifecycle (main.ts):
//   1. deps is created with store/registry/env/paths filled in.
//   2. every factory in MODULES runs, in order; its tools are registered BEFORE personas
//      load (so persona yaml may list them) and its router is mounted at /api/v1 + /api.
//   3. the rest of deps (personas, scheduler, models, notifier, llm) is assigned.
//   4. start() runs for every module; stop() runs on shutdown, in reverse order.
// So: a factory may only READ deps.store / registry / env / paths / nodes / repoHub /
// earlier modules eagerly. Everything else must be read lazily (inside a route
// handler, tool run, or start()).
import type { Router } from 'express';
import type { Store } from './store.js';
import type { Tool, Persona, LLM } from './runtime/contract.js';
import type { ToolRegistry } from './runtime/tools.js';
import type { Scheduler } from './runtime/scheduler.js';
import type { ModelRegistry } from './models.js';
import type { NodeHub } from './node/hub.js';
import type { RepoHub } from './git/hub.js';
import type { Notifier } from './notify.js';
import type { DeckState } from './plugins/builtin/deck.js';
import type { Automations } from './automations.js';
import type { McpHub } from './connectors/mcp.js';

export interface ModuleDeps {
  store: Store;
  registry: ToolRegistry;
  env: Record<string, string | undefined>;
  /** Absolute path of the alfred repo (config/, personas/, scripts/, .dispatch/). */
  repoRoot: string;
  /** Directory the built-in personas were loaded from (absolute). */
  personasDir: string;
  workRoot: string;
  nodes: NodeHub;
  repoHub: RepoHub;
  deckState: DeckState;
  /** P21: the MCP connector hub (reconfigure/servers/status). Assigned after factories run — read lazily. */
  hub?: McpHub;
  /** P21: this server's own base URL (http://127.0.0.1:<port>), for tools that call the API in-process. Assigned after listen. */
  selfUrl?: string;
  /** The API token (when set) — for in-process calls to selfUrl. */
  token?: string;
  /** P21: path of the MCP config file alfred loaded (config/mcp.json by default). */
  mcpConfigPath?: string;
  /** Public base URL of the dashboard, when known (ALFRED_DASHBOARD_URL). Used for deep links. */
  dashboardUrl?: string;
  /** Test/extension injection point from AlfredConfig.extra (e.g. extra.exec for ops). */
  extra: Record<string, any>;
  /** Modules built earlier in MODULES order, by name. */
  modules: Record<string, AlfredModule>;
  // ---- assigned after every factory ran (read lazily) ----
  personas: Map<string, Persona>;
  scheduler?: Scheduler;
  models?: ModelRegistry;
  notifier?: Notifier;
  automations?: Automations;
  /** The runtime LLM (the model registry's default role, or a test override). */
  llm?: LLM;
  /** Re-read persona yaml into `personas` (P14 config editor calls this after a write). */
  reloadPersonas?: () => string[];
}

export interface AlfredModule {
  name: string;
  /** Mounted at /api/v1 (and the /api alias) behind the token. Paths are relative (e.g. '/items'). */
  router?: Router;
  /** Registered into the ToolRegistry before personas load. */
  tools?: Tool[];
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export type ModuleFactory = (deps: ModuleDeps) => AlfredModule | Promise<AlfredModule>;

/**
 * Event kinds that are not about a goal are stored with goalId '' (the empty string).
 * UIs refetch the matching resource instead of a goal; the markdown mirror ignores them.
 */
export const SYSTEM_GOAL_ID = '';
