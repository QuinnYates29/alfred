# Extending alfred

Everything a plugin can do, alfred's own built-ins do through the same API
(`src/plugins/builtin/*.ts` is the best reference). A plugin can add tools,
personas, alert sinks, MCP servers, automation dirs, HTTP routes and static
UIs — **no core file ever needs editing**.

## The shape

A plugin is a directory: `<plugin-dir>/<name>/index.ts` (or `.js`) whose
**default export** is an `AlfredPlugin`:

```ts
export default {
  name: 'hello',
  version: '1.0.0',
  setup(ctx) { /* register things; may be async */ },
  teardown() { /* optional; runs on shutdown, oldest-loaded first */ },
};
```

Plugin directories searched, first match wins: `ALFRED_PLUGIN_DIRS` (none by
default), `<repo>/plugins`, `~/.alfred/plugins`. Tests/fixtures pass their own.

**A plugin that throws on import or in `setup` is skipped and reported** —
`GET /api/v1/health` shows it under `plugins.failed`. Alfred keeps running.

## `PluginContext`

| Method | What it does |
|---|---|
| `ctx.config` | this plugin's `plugins.<name>` block from `config/alfred.yaml` |
| `ctx.log(msg)` | namespaced console log |
| `ctx.registerTool(tool)` | joins the tool registry; personas opt in by listing the name (see the `Tool` contract in `src/runtime/contract.ts`: `{schema, kind, run(args, toolCtx)}`) |
| `ctx.registerPersonaDir(dir)` | extra persona yamls, loaded **after** the built-ins (budget rules still apply) |
| `ctx.registerSink(sink)` | `{name, send(notice)}` joined to the alert fan-out |
| `ctx.registerMcpServer(name, cfg)` | extra MCP server (same shape as `config/mcp.json`) |
| `ctx.registerAutomationDir(dir)` | extra markdown automations |
| `ctx.registerRoute(method, path, handler)` | mounted at `/api/v1/plugins/<name><path>`, behind the token |
| `ctx.registerStatic(dir)` | served at `/plugins/<name>/` — an alternate UI lives here |
| `ctx.onEvent(cb)` | every stored event; returns an unsubscribe fn |

## The `hello` fixture (the whole API in 20 lines)

`test/fixtures/plugins/hello/index.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  name: 'hello',
  version: '1.0.0',
  setup(ctx) {
    ctx.registerTool({
      kind: 'read',
      schema: {
        name: 'hello_world',
        description: 'Say hello.',
        parameters: { type: 'object', properties: { who: { type: 'string' } } },
      },
      async run(args) {
        return { ok: true, output: `hello ${args.who ?? 'world'} (${ctx.config.greeting ?? 'hi'})` };
      },
    });
    ctx.registerPersonaDir(join(here, 'personas'));            // adds persona `greeter`
    ctx.registerSink({ name: 'hello-sink', async send(n) { /* … */ } });
    ctx.registerRoute('get', '/ping', (_req, res) => res.json({ pong: true, greeting: ctx.config.greeting }));
    ctx.onEvent((e) => { if (e.kind === 'goal_created') ctx.log(`saw goal ${e.goalId}`); });
  },
};
```

## Enabling / disabling

`config/alfred.yaml` → `plugins.enabled` (list names, built-ins included) pins
the set; unset means "load everything found". Per-plugin settings live under
`plugins.<name>`. Built-ins: `builtin-executors` (dsh/pipeline/langgraph),
`builtin-sinks` (desktop/slack/markdown/node), `builtin-deck`. Disabling
`builtin-executors` really removes `dsh_code`/`pipeline_run`/`langgraph_run`
from every persona's reach.

## Personas a plugin ships

Plain yaml, same rules as `personas/`: `name`, `description`, `tools` (every
name must exist in the registry — your `registerTool` calls happen first),
`canSpawn`, `promptBudgetTokens`, `system`. See
`test/fixtures/plugins/hello/personas/greeter.yaml`.
