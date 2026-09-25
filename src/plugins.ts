// P11 — the extension surface. A plugin is <dir>/<name>/index.ts (or .js)
// with a default export `AlfredPlugin`. A plugin that throws on import or in
// setup is skipped and reported; it never stops Alfred.
import { existsSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Tool } from './runtime/contract.js';
import type { Sink } from './types.js';
import type { EventRow } from './types.js';
import type { McpServerConfig } from './connectors/mcp.js';

export interface PluginContext {
  name: string;
  /** This plugin's block from config/alfred.yaml `plugins.<name>`. */
  config: Record<string, any>;
  store: Store;
  log(msg: string): void;
  /** Joins the ToolRegistry (personas opt in by listing it). */
  registerTool(tool: Tool): void;
  /** Extra persona yaml dir, loaded after the built-ins (budget rules apply). */
  registerPersonaDir(dir: string): void;
  /** Joins the Notifier. */
  registerSink(sink: Sink): void;
  registerMcpServer(name: string, cfg: McpServerConfig): void;
  registerAutomationDir(dir: string): void;
  /** Mounted at /api/v1/plugins/<name><path>, behind the token. */
  registerRoute(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    handler: (req: any, res: any) => any,
  ): void;
  /** Served at /plugins/<name>/ — a future alternate UI lives here. */
  registerStatic(dir: string): void;
  onEvent(cb: (e: EventRow) => void): () => void;
}

export interface AlfredPlugin {
  name: string;
  version?: string;
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export interface PluginRouteReg {
  plugin: string;
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  handler: (req: any, res: any) => any;
}

export interface PluginRuntime {
  loaded: string[];
  failed: { name: string; error: string }[];
  routes: PluginRouteReg[];
  statics: { plugin: string; dir: string }[];
  personaDirs: string[];
  sinks: Sink[];
  mcpServers: Record<string, McpServerConfig>;
  automationDirs: string[];
  /** Runs teardown hooks, oldest-loaded first; a throwing teardown is ignored. */
  teardownAll(): Promise<void>;
}

export interface LoadPluginsOpts {
  dirs: string[];
  /** Default: all found. When given, only these names load (built-ins included). */
  enabled?: string[];
  config: Record<string, any>;
  makeContext: (name: string) => PluginContext;
  /** Internal plugins that dogfood the same API (src/plugins/builtin). */
  builtins?: AlfredPlugin[];
}

function entryFile(pluginDir: string): string | null {
  for (const f of ['index.ts', 'index.js']) {
    const p = join(pluginDir, f);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function loadPlugins(o: LoadPluginsOpts): Promise<PluginRuntime> {
  const found = new Map<string, string>(); // name -> entry file (first dir wins)
  for (const dir of o.dirs) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (found.has(name)) continue;
      const file = entryFile(join(dir, name));
      if (file) found.set(name, file);
    }
  }

  const builtinByName = new Map((o.builtins ?? []).map((p) => [p.name, p]));
  const wanted = o.enabled
    ? [...new Set(o.enabled)]
    : [...new Set([...builtinByName.keys(), ...found.keys()])];

  const rt: PluginRuntime = {
    loaded: [],
    failed: [],
    routes: [],
    statics: [],
    personaDirs: [],
    sinks: [],
    mcpServers: {},
    automationDirs: [],
    async teardownAll() {
      for (const name of [...rt.loaded].reverse()) {
        const p = loadedPlugins.get(name);
        try {
          await p?.teardown?.();
        } catch {
          /* a broken teardown never blocks shutdown */
        }
      }
    },
  };
  const loadedPlugins = new Map<string, AlfredPlugin>();

  for (const name of wanted) {
    try {
      let plugin: AlfredPlugin | undefined = builtinByName.get(name);
      if (!plugin) {
        const file = found.get(name);
        if (!file) throw new Error('plugin not found');
        const mod: any = await import(pathToFileURL(file).href);
        plugin = mod?.default ?? undefined;
        if (!plugin || typeof plugin.setup !== 'function' || typeof plugin.name !== 'string') {
          throw new Error('no default export implementing AlfredPlugin (name + setup)');
        }
      }
      const ctx = o.makeContext(name);
      await plugin.setup(ctx);
      loadedPlugins.set(name, plugin);
      rt.loaded.push(name);
    } catch (e: any) {
      rt.failed.push({ name, error: e?.message ?? String(e) });
    }
  }
  return rt;
}
