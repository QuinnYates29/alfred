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
import { NodeHub } from './node/hub.js';
import { buildDoor } from './door/server.js';
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
import { allowedHostsFromEnv } from './server/security.js';
import { envRedactor } from './redact.js';
import { RepoHub } from './git/hub.js';
import { configureSandbox, type SandboxMode } from './sandbox.js';
import type { AlfredModule, ModuleDeps, ModuleFactory } from './modules.js';
import { createBoardModule } from './board/index.js';
import { createOpsModule } from './ops/index.js';
import { createReviewModule } from './review/index.js';
import { createChatModule } from './chat/index.js';
import { createSlackModule } from './slack/index.js';
import { createPowersModule } from './powers/index.js';
import { createCommsModule } from './comms/index.js';

/** P13+: feature modules, in build order (later ones may use earlier ones via deps.modules). */
export const MODULES: ModuleFactory[] = [
  createBoardModule,
  createOpsModule,
  createReviewModule,
  createChatModule,
  createSlackModule,
  createPowersModule,
  createCommsModule,
];
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
  /** Run without a token (loopback dev/test only). Implied when NODE_ENV=test. */
  allowNoToken?: boolean;
  staticDir?: string;
  /** P11 — alternative to explicit fields; explicit fields win. */
  configPath?: string;
  pluginDirs?: string[];
  pluginConfig?: Record<string, any>;
  pluginsEnabled?: string[];
  builtins?: AlfredPlugin[];
  /** P13+: replaces MODULES (tests). */
  modules?: ModuleFactory[];
  /** P13+: passed to modules as deps.extra (test injection: exec, fetch, clocks…). */
  extra?: Record<string, any>;
  /** P10: root of the bare-repo hub (default ~/.alfred/git). */
  gitRoot?: string;
  /**
   * Agent command sandbox (src/sandbox.ts). serveConfig() (production) sets 'bwrap';
   * unset = 'off' (tests). ALFRED_SANDBOX=bwrap|off in the env overrides either.
   * The child env is scrubbed of secrets in both modes.
   */
  sandbox?: SandboxMode;
}

export interface Alfred {
  url: string;
  store: Store;
  scheduler: Scheduler;
  automations: Automations;
  hub: McpHub;
  plugins: { loaded: string[]; failed: { name: string; error: string }[] };
  /** P13+ feature modules by name. */
  modules: Record<string, AlfredModule>;
  nodes: NodeHub;
  stop(): Promise<void>;
}

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function personasDirOf(c: AlfredConfig): string {
  const d = c.personasDir ?? 'personas';
  return d.startsWith('/') ? d : resolve(d);
}

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
  const token = c.token ?? env.ALFRED_TOKEN;

  // P9: a public bind without a token is refused. Tailscale serve lets us stay on 127.0.0.1.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const hasToken = typeof token === 'string' && Boolean(token.trim());
  if (!isLoopback && !hasToken) {
    throw new Error(
      `refusing to bind ${host} without a token: set ALFRED_TOKEN (or pass token in config)`,
    );
  }
  // Even on loopback a tokenless server is drivable by any website (DNS rebinding, CSRF):
  // only tests or an explicit opt-in may run without one.
  const allowNoToken = c.allowNoToken === true || process.env.NODE_ENV === 'test' || env.NODE_ENV === 'test';
  if (!hasToken && !allowNoToken) {
    throw new Error('refusing to start without a token: set ALFRED_TOKEN (or pass token in config)');
  }

  const dbPath = c.dbPath ?? file?.paths?.db ?? join(REPO_ROOT, '.alfred-dev', 'alfred.db');
  // P9 Mac-first: mirror spec is `local:/path` (default) or `node:<name>:/abs/path`.
  const mirrorSpec = String(c.mirrorDir ?? file?.paths?.mirror ?? 'local:~/vaults/alfred');
  const isNodeMirror = mirrorSpec.startsWith('node:');
  const mirrorDir = isNodeMirror ? join(REPO_ROOT, '.alfred-dev', 'mirror-unused') : expandHome(mirrorSpec.replace(/^local:/, ''));
  const workRoot = c.workRoot ?? file?.paths?.work ?? join(REPO_ROOT, '.alfred-dev', 'work');
  const personasDir = c.personasDir ?? 'personas';
  const automationsDir = c.automationsDir;
  const mcpConfigPath = c.mcpConfigPath ?? file?.mcp;

  // A fresh machine has no ~/.alfred yet: create the DB directory (not for :memory:).
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  // Secrets in env never land in stored events/notes/results (e.g. an agent running `env`).
  const store = openStore(dbPath, { redact: envRedactor({ ...process.env, ...env, ...(token ? { ALFRED_TOKEN: token } : {}) }) });
  const registry = new ToolRegistry();
  for (const t of builtinTools()) registry.register(t);

  const notifier = new Notifier([]);
  const deckState: DeckState = { url: null };

  // P9: the node network — alfred-nodes dial OUT to /api/nodes/connect (token-checked).
  const nodeHub = new NodeHub({ ...(token ? { token } : {}) });
  // P10: the bare-repo hub on the Spark (every workspace gets a `spark` remote).
  const repoHub = new RepoHub({ ...(c.gitRoot ? { root: c.gitRoot } : {}) });
  // Agent commands: bubblewrap sandbox + scrubbed env (self-tested; loud warning on failure).
  const sb = configureSandbox({ ...(c.sandbox ? { mode: c.sandbox } : {}), env, gitHub: repoHub.root });
  if (sb.mode === 'bwrap') console.log('[sandbox] agent commands run under bubblewrap');
  else if (sb.requested === 'off' && c.sandbox === 'off') console.warn('[sandbox] OFF by config: agent commands run unsandboxed (env scrubbed)');

  // ---- P13+ feature modules: tools are registered before personas load.
  const personas: Map<string, Persona> = new Map();
  const moduleDeps: ModuleDeps = {
    store,
    registry,
    env,
    repoRoot: REPO_ROOT,
    personasDir: resolve(personasDirOf(c)),
    workRoot,
    nodes: nodeHub,
    repoHub,
    deckState,
    ...(env.ALFRED_DASHBOARD_URL ? { dashboardUrl: env.ALFRED_DASHBOARD_URL } : {}),
    extra: c.extra ?? {},
    ...(token ? { token } : {}),
    modules: {},
    personas,
  };
  const moduleList: AlfredModule[] = [];
  for (const factory of c.modules ?? MODULES) {
    const m = await factory(moduleDeps);
    moduleList.push(m);
    moduleDeps.modules[m.name] = m;
    for (const t of m.tools ?? []) if (!registry.get(t.schema.name)) registry.register(t);
  }

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
      builtinSinksPlugin({
        env: () => env,
        store,
        mirrorDir: () => mirrorDir,
        mirrorSpec: () => mirrorSpec,
        nodes: nodeHub,
      }),
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
  const loadErrors: string[] = [];
  const tryLoadPersonas = (dir: string) => {
    try {
      if (!existsSync(dir)) return;
      for (const [k, v] of loadPersonas(dir, registry)) personas.set(k, v);
    } catch (e: any) {
      loadErrors.push(`${dir}: ${e?.message ?? e}`);
      console.error(`[personas] skipping ${dir}: ${e?.message ?? e}`);
    }
  };
  tryLoadPersonas(personasDir);
  for (const d of extraPersonaDirs) tryLoadPersonas(d);
  /** P14: re-read every persona dir into the SAME map (running tasks keep their copy). Returns errors. */
  moduleDeps.reloadPersonas = () => {
    loadErrors.length = 0;
    const before = new Map(personas);
    personas.clear();
    tryLoadPersonas(personasDir);
    for (const d of extraPersonaDirs) tryLoadPersonas(d);
    // A broken file must not delete personas that were loaded fine before.
    for (const [k, v] of before) if (!personas.has(k)) personas.set(k, v);
    return [...loadErrors];
  };

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
  moduleDeps.hub = hub;
  moduleDeps.mcpConfigPath = mcpConfigPath ? resolve(mcpConfigPath) : join(REPO_ROOT, 'config', 'mcp.json');
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
    nodes: nodeHub, // P9: resolveWorkspace(store, task, { root: workRoot, nodes })
    hub: repoHub, // P10: repo/sandbox-with-repo workspaces clone from and push to the Spark hub
    workRoot,
    ...(c.pollMs != null ? { pollMs: c.pollMs } : {}),
  } as any);
  scheduler.start();
  moduleDeps.scheduler = scheduler;
  if (modelsRegistry) moduleDeps.models = modelsRegistry;
  moduleDeps.notifier = notifier;
  moduleDeps.llm = runtimeLLM;

  // ---- notifier + loud failures + debounced markdown mirror
  wireLoudFailures(store, notifier);
  const pendingMirrors = new Map<string, ReturnType<typeof setTimeout>>();
  const mirrorUnsub = store.onEvent((e) => {
    if (isNodeMirror) return; // node mirrors are written by the node-markdown sink
    if (!e.goalId) return; // system events (board, chat, ops) have no goal to mirror
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

  // P9: when a node returns, re-queue every task blocked by exactly that node.
  const nodeWatcherUnsub = nodeHub.onChange((e) => {
    if (!e.online) return;
    try {
      for (const g of store.listGoals()) {
        for (const t of store.listTasks(g.id)) {
          if (t.status !== 'blocked' || t.reason !== `node ${e.node} offline`) continue;
          try {
            store.appendNote(t.id, `node ${e.node} back online`);
            store.transition(t.id, 'queued', { reason: `node ${e.node} back online`, by: 'nodes' });
          } catch {
            /* raced with another transition */
          }
        }
      }
    } catch {
      /* a hub event must never take Alfred down */
    }
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

  moduleDeps.automations = automations;
  for (const m of moduleList) await m.start?.();

  // ---- HTTP
  const app = createApp({
    routers: moduleList.filter((m) => m.router).map((m) => m.router!),
    nodes: nodeHub,
    store,
    scheduler,
    automations,
    hub,
    personas,
    registry,
    // P9: the resolved token (config OR ALFRED_TOKEN) guards /api and the /mcp door.
    ...(token ? { token } : { allowNoToken }),
    allowedHosts: allowedHostsFromEnv(env, host),
    door: () => buildDoor(store, workRoot),
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
  // P9: node dial-outs attach to the same HTTP server (GET /api/nodes/connect upgrade).
  nodeHub.attach(server);
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  moduleDeps.selfUrl = `http://127.0.0.1:${actualPort}`;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    store,
    scheduler,
    automations,
    hub,
    plugins: { loaded: pluginRt.loaded, failed: pluginRt.failed },
    modules: moduleDeps.modules,
    nodes: nodeHub,
    async stop() {
      for (const m of [...moduleList].reverse()) {
        try {
          await m.stop?.();
        } catch {
          /* a module must never block shutdown */
        }
      }
      clearInterval(reconnectTimer);
      clearInterval(autoTimer);
      try {
        nodeWatcherUnsub();
      } catch {
        /* ignore */
      }
      nodeHub.close();
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
      // P12b: a stop of the service hands running tasks back to the queue (note + queued, lease
      // cleared) so the next process resumes them — it must not cancel them.
      await scheduler.stop({ requeue: true });
      await pluginRt.teardownAll();
      await hub.close();
      // Open SSE streams (the dashboard's live feed) never end on their own: drop every
      // connection, or close() waits forever and systemd has to SIGKILL us after 90 s.
      const closed = new Promise<void>((res) => server.close(() => res()));
      server.closeAllConnections?.();
      await closed;
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
    sandbox: 'bwrap', // ALFRED_SANDBOX=off overrides (see configureSandbox)
    env,
  };
}
