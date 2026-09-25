// P4 §4 + P11 — the composition root. startAlfred wires store, plugins, tools,
// personas, notifier, mirror, automations, MCP hub and the HTTP server.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { LLM } from './runtime/contract.js';
import { openStore, type Store } from './store.js';
import { ToolRegistry } from './runtime/tools.js';
import { builtinTools } from './runtime/tools.js';
import { loadPersonas } from './runtime/personas.js';
import { Scheduler } from './runtime/scheduler.js';
import { openaiLLM, limitLLM } from './runtime/openai.js';
import { ModelRegistry, loadModels, DEFAULT_SLOTS, type ModelSpec } from './models.js';
import { workspaceFor } from './workspace.js';
import { Notifier, wireLoudFailures } from './notify.js';
import { writeMirror } from './mirror.js';
import { Automations } from './automations.js';
import { McpHub, loadMcpConfig, type McpServerConfig } from './connectors/mcp.js';
import { loadConfig, expandHome, deepMerge, type AlfredConfigFile } from './config.js';
import { loadPlugins, type PluginContext, type AlfredPlugin } from './plugins.js';
import { builtinExecutorsPlugin } from './plugins/builtin/executors.js';
import { builtinSinksPlugin } from './plugins/builtin/sinks.js';
import { builtinDeckPlugin, type DeckState } from './plugins/builtin/deck.js';
import { createApp } from './server/app.js';
import type { Persona } from './runtime/contract.js';

export interface AlfredConfig {
  dbPath?: string;
  mirrorDir?: string;
  workRoot?: string;
  personasDir?: string;
  automationsDir?: string;
  mcpConfigPath?: string;
  port?: number; // 0 = ephemeral
  host?: string;
  llm?: LLM; // override for tests
  llmSlots?: number;
  baseUrl?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  tickMs?: number;
  pollMs?: number;
  deck?: { dir: string; port: number } | null;
  token?: string;
  staticDir?: string;
  /** P11 — alternative to explicit fields; explicit fields win. */
  configPath?: string;
  pluginDirs?: string[];
  pluginConfig?: Record<string, any>;
  pluginsEnabled?: string[];
  builtins?: AlfredPlugin[];
}

export interface Alfred {
  url: string;
  store: Store;
  scheduler: Scheduler;
  automations: Automations;
  hub: McpHub;
  plugins: { loaded: string[]; failed: { name: string; error: string }[] };
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function loadFileConfig(c: AlfredConfig, env: Record<string, string | undefined>): AlfredConfigFile | null {
  if (!c.configPath) return null;
  const p = c.configPath;
  const dir = p.endsWith('.yaml') || p.endsWith('.yml') ? dirname(p) : p;
  return loadConfig(dir, env);
}

export async function startAlfred(c: AlfredConfig = {}): Promise<Alfred> {
  const env = c.env ?? process.env;
  const file = loadFileConfig(c, env);

  const port = c.port ?? file?.server?.port ?? 8790;
  const host = c.host ?? file?.server?.host ?? '127.0.0.1';
  const dbPath = c.dbPath ?? file?.paths?.db ?? join(REPO_ROOT, '.alfred-dev', 'alfred.db');
  const mirrorSpec = c.mirrorDir ?? file?.paths?.mirror ?? 'local:~/vaults/alfred';
  const mirrorDir = expandHome(String(mirrorSpec).replace(/^local:/, ''));
  const workRoot = c.workRoot ?? file?.paths?.work ?? join(REPO_ROOT, '.alfred-dev', 'work');
  const personasDir = c.personasDir ?? 'personas';
  const automationsDir = c.automationsDir;
  const mcpConfigPath = c.mcpConfigPath ?? file?.mcp;

  const store = openStore(dbPath);
  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);

  const notifier = new Notifier([]);
  const deckState: DeckState = { url: null };

  // ---- plugins (P11): built-ins dogfood the same API as file plugins.
  const pluginCfgBase: Record<string, any> = { ...(file?.plugins ?? {}) };
  delete pluginCfgBase.enabled;
  const pluginConfig: Record<string, any> = deepMerge(pluginCfgBase, c.pluginConfig ?? {});
  if (c.deck === null) {
    pluginConfig['builtin-deck'] = {}; // explicit "no deck" wins over the file
  } else if (c.deck) {
    pluginConfig['builtin-deck'] = { ...(pluginConfig['builtin-deck'] ?? {}), dir: c.deck.dir, port: c.deck.port };
  }

  let modelsRegistry: ModelRegistry | undefined; // defined below; plugins may use it
  const mcpExtra: Record<string, McpServerConfig> = {};
  const extraPersonaDirs: string[] = [];
  const extraAutomationDirs: string[] = [];
  const unsubscribes: (() => void)[] = [];

  const makeContext = (name: string): PluginContext => ({
    name,
    config: pluginConfig[name] ?? {},
    store,
    log: (msg: string) => console.log(`[plugin ${name}] ${msg}`),
    registerTool: (t) => {
      if (!registry.get(t.schema.name)) registry.register(t);
    },
    registerPersonaDir: (d) => extraPersonaDirs.push(d),
    registerSink: (s) => notifier.addSink(s),
    registerMcpServer: (server, cfg) => {
      mcpExtra[server] = cfg;
    },
    registerAutomationDir: (d) => extraAutomationDirs.push(d),
    registerRoute: (method, path, handler) => pluginRoutes.push({ plugin: name, method, path, handler }),
    registerStatic: (dir) => pluginStatics.push({ plugin: name, dir }),
    onEvent: (cb) => {
      const un = store.onEvent(cb);
      unsubscribes.push(un);
      return un;
    },
  });
  const pluginRoutes: import('./plugins.js').PluginRouteReg[] = [];
  const pluginStatics: { plugin: string; dir: string }[] = [];

  const builtinPlugins =
    c.builtins ??
    [
      builtinExecutorsPlugin({ registry, models: () => modelsRegistry }),
      builtinSinksPlugin({ env: () => env, store, mirrorDir: () => mirrorDir }),
      builtinDeckPlugin({ deckState }),
    ];

  const pluginDirs = [...(c.pluginDirs ?? []), join(REPO_ROOT, 'plugins'), expandHome('~/.alfred/plugins')];
  const pluginsEnabled = c.pluginsEnabled ?? file?.plugins?.enabled;

  const pluginRt = await loadPlugins({
    dirs: pluginDirs,
    ...(pluginsEnabled ? { enabled: pluginsEnabled } : {}),
    config: pluginConfig,
    makeContext,
    builtins: builtinPlugins,
  });

  // ---- personas: built-ins first, plugin dirs after (budget rules apply).
  const personas: Map<string, Persona> = new Map();
  const tryLoadPersonas = (dir: string) => {
    try {
      if (!existsSync(dir)) return;
      for (const [k, v] of loadPersonas(dir, registry)) personas.set(k, v);
    } catch (e: any) {
      console.error(`[personas] skipping ${dir}: ${e?.message ?? e}`);
    }
  };
  tryLoadPersonas(personasDir);
  for (const d of extraPersonaDirs) tryLoadPersonas(d);

  // ---- LLM: explicit override for tests; else the ModelRegistry (roles live).
  const fallback = openaiLLM({
    baseUrl: c.baseUrl ?? 'http://127.0.0.1:1110/v1',
    model: c.model ?? 'qwen3.8-flash-next',
    apiKey: env.ALFRED_LLM_API_KEY ?? env.OPENAI_API_KEY,
  });
  // The registry is ALWAYS built (P8 addendum: /api/v1/models + roles are live
  // even in tests where c.llm overrides the runtime LLM). c.llm only overrides
  // what the Scheduler/executors run — it never hides the registry.
  let llm: LLM | undefined = c.llm;
  {
    const relModels = file?.models ?? 'config/models.yaml';
    const modelsPath = relModels.startsWith('/') ? relModels : resolve(REPO_ROOT, relModels);
    const localPath = modelsPath.replace(/\.ya?ml$/, '.local.yaml');
    const cfgPath = existsSync(localPath) ? localPath : modelsPath;
    try {
      const cfg = loadModels(cfgPath);
      modelsRegistry = new ModelRegistry(cfg, {
        ...(existsSync(cfgPath) ? { path: cfgPath } : {}),
        env,
        llmFactory: (spec: ModelSpec, apiKey: string | undefined) =>
          openaiLLM({ baseUrl: `${spec.baseUrl}/v1`, model: spec.model, apiKey, temperature: spec.temperature }),
      });
    } catch (e: any) {
      console.error(`[models] ${e?.message ?? e} — falling back to ${c.baseUrl ?? 'http://127.0.0.1:1110/v1'}`);
    }
  }
  const runtimeLLM = c.llm ?? (modelsRegistry ? modelsRegistry.llm() : fallback);

  // ---- MCP hub: file config + plugin-registered servers; reconnect forever.
  const mcpFile = mcpConfigPath ? loadMcpConfig(mcpConfigPath, env) : { servers: {} };
  const hub = new McpHub({ servers: { ...(mcpFile.servers ?? {}), ...mcpExtra } });
  const syncHubTools = () => {
    for (const t of hub.tools()) if (!registry.get(t.schema.name)) registry.register(t);
  };
  const tryConnect = () => {
    void hub.connectAll().then(syncHubTools).catch(() => {});
  };
  tryConnect();
  const reconnectTimer = setInterval(tryConnect, 5 * 60 * 1000);
  reconnectTimer.unref?.();

  // ---- scheduler
  const scheduler = new Scheduler({
    store,
    llm: limitLLM(runtimeLLM, c.llmSlots ?? DEFAULT_SLOTS),
    ...(modelsRegistry && !c.llm ? { models: modelsRegistry } : {}),
    personas,
    registry,
    maxWorkers: 12, // waiting parents hold a worker; LLM concurrency is limited separately by the model registry
    workspaceFor: (t: any) => workspaceFor(store, t, { root: workRoot }),
    ...(c.pollMs != null ? { pollMs: c.pollMs } : {}),
  } as any);
  scheduler.start();

  // ---- notifier + loud failures + debounced markdown mirror
  wireLoudFailures(store, notifier);
  const pendingMirrors = new Map<string, ReturnType<typeof setTimeout>>();
  const mirrorUnsub = store.onEvent((e) => {
    if (pendingMirrors.has(e.goalId)) return;
    const t = setTimeout(() => {
      pendingMirrors.delete(e.goalId);
      try {
        mkdirSync(mirrorDir, { recursive: true });
        writeMirror(store, e.goalId, mirrorDir);
      } catch {
        /* goal deleted mid-flight */
      }
    }, 500);
    t.unref?.();
    pendingMirrors.set(e.goalId, t);
  });

  // ---- automations
  const automations = new Automations(store, { ...(automationsDir ? { dir: automationsDir } : {}) });
  for (const d of extraAutomationDirs) automations.reloadFiles();
  const autoTimer = setInterval(() => {
    try {
      automations.tick();
    } catch {
      /* a broken tick must never take Alfred down */
    }
  }, c.tickMs ?? 30_000);
  autoTimer.unref?.();

  // ---- HTTP
  const app = createApp({
    store,
    scheduler,
    automations,
    hub,
    personas,
    registry,
    ...(c.token ? { token: c.token } : {}),
    staticDir: c.staticDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist'),
    ...(deckState.url ? { deckUrl: deckState.url } : {}),
    plugins: { loaded: pluginRt.loaded, failed: pluginRt.failed },
    pluginRoutes,
    pluginStatics,
    ...(modelsRegistry ? { models: modelsRegistry } : {}),
  });
  const server: Server = await new Promise((res) => {
    const s = app.listen(port, host, () => res(s));
  });
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    store,
    scheduler,
    automations,
    hub,
    plugins: { loaded: pluginRt.loaded, failed: pluginRt.failed },
    async stop() {
      clearInterval(reconnectTimer);
      clearInterval(autoTimer);
      for (const t of pendingMirrors.values()) clearTimeout(t);
      pendingMirrors.clear();
      mirrorUnsub();
      for (const un of unsubscribes) {
        try {
          un();
        } catch {
          /* ignore */
        }
      }
      await scheduler.stop();
      await pluginRt.teardownAll();
      await hub.close();
      await new Promise<void>((res) => server.close(() => res()));
      store.close();
    },
  };
}

/** Read env-style config for the CLI (`alfred serve`). */
export function serveConfig(env: Record<string, string | undefined> = process.env): AlfredConfig {
  const deckDir = env.ALFRED_DECK_DIR ?? expandHome('~/mission-deck/server');
  return {
    dbPath: env.ALFRED_DB ? expandHome(env.ALFRED_DB) : expandHome('~/.alfred/alfred.db'),
    mirrorDir: env.ALFRED_MIRROR_DIR ? expandHome(env.ALFRED_MIRROR_DIR) : expandHome('~/vaults/alfred'),
    workRoot: env.ALFRED_WORK_ROOT ? expandHome(env.ALFRED_WORK_ROOT) : expandHome('~/.alfred/work'),
    port: env.ALFRED_PORT ? Number(env.ALFRED_PORT) : 8790,
    host: env.ALFRED_HOST ?? '0.0.0.0',
    deck: existsSync(deckDir) ? { dir: deckDir, port: Number(env.ALFRED_DECK_PORT ?? 8787) } : null,
    env,
  };
}
