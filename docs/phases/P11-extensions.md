# P11 — Extension API (future-proofing)

Status: **SPEC** · Branch: `p11-extensions` · Acceptance: `npx vitest run test/acceptance/p11`
Depends on: P1–P4. **P4b's `startAlfred` builds on this**, so it lands before P4b.

Quinn will rethink the control side (dashboard/CLI/Slack/phone). The core must let new tools, executors, personas, alert channels, connectors,
API routes and UIs be added **without editing core files**, and give any future UI a stable contract.

## 1. Plugins (`src/plugins.ts`)
```ts
export interface AlfredPlugin { name: string; version?: string; setup(ctx: PluginContext): void | Promise<void>; teardown?(): void | Promise<void> }
export interface PluginContext {
  name: string; config: Record<string, any>;           // this plugin's block from config/alfred.yaml `plugins.<name>`
  store: Store; log(msg: string): void;
  registerTool(tool: Tool): void;                      // joins the ToolRegistry (personas opt in by listing it)
  registerPersonaDir(dir: string): void;               // extra persona yaml dir (loaded after the built-ins; budget rules apply)
  registerSink(sink: Sink): void;                      // joins the Notifier
  registerMcpServer(name: string, cfg: McpServerConfig): void;
  registerAutomationDir(dir: string): void;
  registerRoute(method: 'get' | 'post' | 'put' | 'delete', path: string, handler: (req, res) => any): void; // mounted at /api/v1/plugins/<name><path>, behind the token
  registerStatic(dir: string): void;                   // served at /plugins/<name>/ (a future alternate UI lives here)
  onEvent(cb: (e: EventRow) => void): () => void;
}
export async function loadPlugins(o: { dirs: string[]; enabled?: string[] /* default: all found */; config: Record<string, any>; makeContext: (name: string) => PluginContext }):
  Promise<{ loaded: string[]; failed: { name: string; error: string }[] }>
```
- A plugin is `<dir>/<name>/index.ts` (or `.js`) with a default export `AlfredPlugin`. Plugin dirs: `<repo>/plugins` plus `~/.alfred/plugins`.
- **A plugin that throws on import or setup is skipped and reported, and never stops Alfred.** `/api/v1/health` lists `plugins: {loaded, failed}`.
- **Built-ins dogfood the same API:** executors (dsh/pipeline/langgraph), the sinks (desktop/slack/markdown/node) and the Mission Deck supervisor are registered
  as internal plugins in `src/plugins/builtin/*.ts`, so they can be disabled in config the same way.

## 2. One config file: `config/alfred.yaml` (+ gitignored `config/alfred.local.yaml` merged over it, then env vars override)
```yaml
server:  { port: 8790, host: 127.0.0.1 }        # tokens come from env ALFRED_TOKEN, never the file
paths:   { db: ~/.alfred/alfred.db, work: ~/.alfred/work, gitHub: ~/.alfred/git, mirror: "local:~/vaults/alfred" }
models:  config/models.yaml
mcp:     config/mcp.json
plugins:
  enabled: [builtin-executors, builtin-sinks, builtin-deck]
  builtin-deck: { dir: ~/mission-deck/server, port: 8787 }
```
`loadConfig(repoRoot, env) → AlfredConfigFile` with defaults; `startAlfred` accepts `{configPath}`, `pluginDirs?: string[]`, `pluginConfig?: Record<string, any>` and `pluginsEnabled?: string[]` (when given, only those plugins load, built-ins included) as an alternative to explicit fields (explicit fields win).

## 3. Stable API contract
- Every route is served under **`/api/v1/…`**. `/api/…` remains an alias (the tests use it).
- `GET /api/v1/tools`, `GET /api/v1/plugins`, `GET /api/v1/schema/events`: the list of event kinds with a one-line meaning each (the UI contract).
- `docs/API.md`: every route, request/response shape, and the SSE event format. `docs/EXTENDING.md`: writing a plugin, with the fixture plugin as the example.

## Done when
`npx vitest run test/acceptance/p11` + all earlier suites + typecheck are green on `p11-extensions`.
