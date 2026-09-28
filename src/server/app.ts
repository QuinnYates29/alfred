// P4 §3 + P11 — the HTTP API. Every route lives under /api/v1; /api is an alias.
// Token auth (when set): `Authorization: Bearer <token>` or `?token=`.
import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store } from '../store.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type { Automations } from '../automations.js';
import type { McpHub } from '../connectors/mcp.js';
import type { Persona } from '../runtime/contract.js';
import type { ToolRegistry } from '../runtime/tools.js';
import type { ModelRegistry } from '../models.js';
import { promptCost } from '../runtime/personas.js';
import type { PluginRouteReg, AlfredPlugin } from '../plugins.js';
import { createGoalWithRoot, retryTask, goalSummary } from '../ops.js';

export interface AppDeps {
  store: Store;
  scheduler?: Scheduler;
  automations?: Automations;
  hub?: McpHub;
  personas?: Map<string, Persona>;
  registry?: ToolRegistry;
  token?: string;
  staticDir?: string;
  deckUrl?: string;
  /** P11 */
  plugins?: { loaded: string[]; failed: { name: string; error: string }[] };
  pluginRoutes?: PluginRouteReg[];
  pluginStatics?: { plugin: string; dir: string }[];
  models?: ModelRegistry;
  /** P9: factory for the Claude door — served at /mcp over Streamable HTTP (stateless), behind the token. */
  door?: () => McpServer;
  /** P13+: feature-module routers, mounted at /api/v1 and /api behind the token. */
  routers?: express.Router[];
  /** P9: connected alfred-nodes (GET /nodes). */
  nodes?: { list(): { name: string; roots: string[]; caps: string[]; connectedAt: number }[] };
}

/** The UI contract: every event kind with a one-line meaning. */
export const EVENT_KINDS: { kind: string; meaning: string }[] = [
  { kind: 'goal_created', meaning: 'A goal was created (data: title, slug).' },
  { kind: 'goal_status', meaning: 'A goal moved between active/done/failed (data: status).' },
  { kind: 'goal_meta', meaning: 'Goal meta was patched (data: patch).' },
  { kind: 'notice', meaning: 'An agent sent Quinn a notification via the notify tool (system event; data: level, title, body).' },
  { kind: 'goal_deleted', meaning: 'A goal and its tasks/events/approvals were deleted (system event; data: goalId, title, slug).' },
  { kind: 'task_created', meaning: 'A task was created under a goal (data: title, persona).' },
  { kind: 'transition', meaning: 'A task changed status (data: from, to, reason, by).' },
  { kind: 'turn', meaning: 'One agent LLM turn finished (data: tokens, toolCalls).' },
  { kind: 'tool', meaning: 'A tool call finished (data: name, ok).' },
  { kind: 'progress', meaning: 'A long-running tool reported progress (data: msg).' },
  { kind: 'verify', meaning: 'Acceptance checks ran (data: results[]).' },
  { kind: 'reclaimed', meaning: 'A task with an expired lease was reclaimed.' },
  { kind: 'automation_fired', meaning: 'An automation fired (data: automation, goalId).' },
  { kind: 'approval_requested', meaning: 'A task is waiting for Quinn approval (data: approvalId, action, detail).' },
  { kind: 'approval_decided', meaning: 'An approval was decided (data: approvalId, decision, by).' },
  { kind: 'workspace', meaning: 'A run resolved its workspace (data: path, node, branch?).' },
  { kind: 'pushed', meaning: 'Finished work was pushed to the Spark hub (data: branch, sha).' },
  { kind: 'compacted', meaning: 'A run compacted its context (data: before, after, dropped).' },
  // System events (goalId ''): not about one goal.
  { kind: 'item_created', meaning: "Board item created (goalId ''; data: boardId, key, by)." },
  { kind: 'item_updated', meaning: "Board item changed (goalId ''; data: boardId, key, changes, by)." },
  { kind: 'item_moved', meaning: "Board item changed column (goalId ''; data: boardId, key, from, to, by)." },
  { kind: 'item_deleted', meaning: "Board item archived/deleted (goalId ''; data: boardId, key, by)." },
  { kind: 'item_comment', meaning: "Comment on a board item (goalId ''; data: boardId, key, commentId, author)." },
  { kind: 'board_updated', meaning: "Board columns/fields/name changed (goalId ''; data: boardId)." },
  { kind: 'chat_message', meaning: "A chat message was stored (goalId ''; data: threadId, message)." },
  { kind: 'ops', meaning: "An ops action ran (goalId ''; data: action, target, ok, by)." },
  { kind: 'goal_merged', meaning: 'A goal branch was merged in the hub (data: branch, into, sha).' },
  { kind: 'goal_discarded', meaning: 'A goal branch was discarded (data: branches).' },
];

function getToken(req: Request): string {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const q = req.query.token;
  return typeof q === 'string' ? q : '';
}

function buildRouter(d: AppDeps): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  const send = (res: Response, code: number, body: unknown) => res.status(code).json(body);

  r.get('/health', (_req, res) => {
    res.json({
      ok: true,
      mcp: d.hub?.status() ?? [],
      running: d.scheduler?.running() ?? [],
      deckUrl: d.deckUrl ?? null,
      plugins: d.plugins ?? { loaded: [], failed: [] },
    });
  });

  r.get('/schema/events', (_req, res) => res.json(EVENT_KINDS));

  r.get('/tools', (_req, res) => {
    const reg = d.registry;
    if (!reg) return res.json([]);
    res.json(
      reg.all().map((t) => ({
        name: t.schema.name,
        description: t.schema.description,
        kind: t.kind,
        parameters: t.schema.parameters,
      })),
    );
  });

  r.get('/plugins', (_req, res) => res.json(d.plugins ?? { loaded: [], failed: [] }));

  r.get('/personas', (_req, res) => {
    const list = [...(d.personas?.values() ?? [])].map((p) => ({
      name: p.name,
      description: p.description,
      model: p.model ?? 'default',
      tools: p.tools,
      canSpawn: p.canSpawn,
      promptBudgetTokens: p.promptBudgetTokens,
      promptCost: d.registry ? costOf(p, d.registry) : 0,
    }));
    res.json(list);
  });

  r.get('/goals', (_req, res) => {
    const goals = d.store.listGoals().slice().reverse();
    res.json(goals.map((g) => goalSummary(d.store, g.id)));
  });

  r.post('/goals', (req, res) => {
    const b = req.body ?? {};
    if (!b.title || typeof b.title !== 'string') return send(res, 400, { error: 'title is required' });
    if (b.persona && d.personas && !d.personas.has(String(b.persona))) {
      return send(res, 400, { error: `unknown persona: ${b.persona}` });
    }
    try {
      const out = createGoalWithRoot(d.store, {
        title: String(b.title),
        body: b.body,
        persona: b.persona,
        spec: b.spec,
        acceptance: Array.isArray(b.acceptance) ? b.acceptance : undefined,
        repo: b.repo,
        budget: b.budget,
        model: b.model,
      });
      // Where/how the workspace lives (P9/P10): node name, sandbox|repo mode, in-place checkout.
      const meta: Record<string, any> = {};
      if (typeof b.node === 'string' && b.node && b.node !== 'local') meta.node = b.node;
      if (b.mode === 'sandbox' || b.mode === 'repo') meta.mode = b.mode;
      if (b.inPlace === true) meta.inPlace = true;
      if (Object.keys(meta).length) out.goal = d.store.setGoalMeta(out.goal.id, meta);
      res.status(201).json(out);
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? String(e) });
    }
  });

  const findGoal = (idOrSlug: string) =>
    d.store.getGoal(idOrSlug) ?? d.store.listGoals().find((g) => g.slug === idOrSlug);

  r.delete('/goals/:id', (req, res) => {
    const goal = findGoal(req.params.id);
    if (!goal) return send(res, 404, { error: 'no such goal' });
    try {
      d.store.deleteGoal(goal.id);
    } catch (e: any) {
      return send(res, 409, { error: e?.message ?? String(e) });
    }
    res.json({ ok: true, deleted: goal.id });
  });

  r.get('/goals/:id', (req, res) => {
    const goal = findGoal(req.params.id);
    if (!goal) return send(res, 404, { error: 'no such goal' });
    const body: Record<string, any> = {
      goal,
      tasks: d.store.listTasks(goal.id),
      events: d.store.events(goal.id).slice(-200),
    };
    const usage = (d.store as any).goalUsage;
    if (typeof usage === 'function') body.usage = usage.call(d.store, goal.id);
    res.json(body);
  });

  r.post('/tasks/:id/stop', (req, res) => {
    const task = d.store.getTask(req.params.id);
    if (!task) return send(res, 404, { error: 'no such task' });
    const reason = String(req.body?.reason ?? 'stopped by Quinn');
    if (d.scheduler?.cancel(task.id, reason)) return res.json({ ok: true, via: 'scheduler' });
    try {
      const t = d.store.transition(task.id, 'stopped', { reason, by: 'api' });
      res.json({ ok: true, task: t });
    } catch (e: any) {
      send(res, 409, { error: e?.message ?? String(e) });
    }
  });

  r.post('/tasks/:id/retry', (req, res) => {
    try {
      res.status(201).json(retryTask(d.store, req.params.id, req.body?.note));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      send(res, /no such task/.test(msg) ? 404 : 409, { error: msg });
    }
  });

  r.post('/tasks/:id/note', (req, res) => {
    const task = d.store.getTask(req.params.id);
    if (!task) return send(res, 404, { error: 'no such task' });
    const text = String(req.body?.text ?? '');
    if (!text) return send(res, 400, { error: 'text is required' });
    d.store.appendNote(task.id, text);
    res.json({ ok: true });
  });

  // Approvals: the P3 door lands them in the store; the dashboard decides here.
  r.get('/approvals', (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    res.json(d.store.approvals(status ? { status: status as any } : {}));
  });
  r.post('/approvals/:id', (req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (decision !== 'approved' && decision !== 'denied') return send(res, 400, { error: 'decision must be approved|denied' });
    try {
      res.json(d.store.decideApproval(req.params.id, decision, String(req.body?.by ?? 'dashboard')));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      send(res, /no such approval/i.test(msg) ? 404 : 409, { error: msg });
    }
  });

  r.get('/automations', (_req, res) => res.json(d.automations?.list() ?? []));
  r.post('/automations', (req, res) => {
    if (!d.automations) return send(res, 501, { error: 'automations not enabled' });
    try {
      res.status(201).json(d.automations.upsert(req.body ?? {}));
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? String(e) });
    }
  });
  r.delete('/automations/:id', (req, res) => {
    const ok = d.automations?.remove(req.params.id) ?? false;
    if (!ok) return send(res, 404, { error: 'no such automation' });
    res.json({ ok: true });
  });
  r.post('/automations/:id/enabled', (req, res) => {
    if (!d.automations) return send(res, 501, { error: 'automations not enabled' });
    try {
      res.json(d.automations.setEnabled(req.params.id, Boolean(req.body?.on)));
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      send(res, /no such/.test(msg) ? 404 : 400, { error: msg });
    }
  });

  // P9: connected alfred-nodes (the old code asked the MCP hub, which never has nodes).
  r.get('/nodes', (_req, res) => res.json(d.nodes?.list() ?? []));

  // Newest event id, so a fresh UI can subscribe with ?since=<last> instead of replaying history.
  r.get('/events/last', (_req, res) => {
    const row = d.store.raw().prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null };
    res.json({ id: row?.id ?? 0 });
  });

  // P7 — model roles, live.
  r.get('/models', (_req, res) =>
    res.json(d.models ? { models: d.models.list(), roles: d.models.roles() } : { models: [], roles: {} }));
  r.post('/models/roles', (req, res) => {
    if (!d.models) return send(res, 501, { error: 'models not configured' });
    try {
      d.models.setRole(String(req.body?.role), String(req.body?.model));
      res.json({ ok: true, roles: d.models.roles() });
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? String(e) });
    }
  });
  r.post('/models/reload', (_req, res) => {
    if (!d.models) return send(res, 501, { error: 'models not configured' });
    try {
      d.models.reload();
      res.json({ ok: true });
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? String(e) });
    }
  });

  // SSE: replay, then live events. `id: <eventId>\ndata: <json>\n\n`.
  r.get('/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Proxies (tailscale serve) hold the response until body bytes flow: send one now, or the
    // client sits in "connecting" until the first heartbeat.
    res.write(': open\n\n');
    const since = Number(req.query.since ?? 0);
    for (const e of d.store.allEvents({ sinceId: since })) {
      res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    }
    const unsub = d.store.onEvent((e) => {
      try {
        res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
      } catch {
        /* socket gone */
      }
    });
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* socket gone */
      }
    }, 10_000);
    if (typeof hb.unref === 'function') hb.unref();
    req.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  });

  return r;
}

function costOf(p: Persona, reg: ToolRegistry): number {
  return promptCost(p, reg);
}

export function createApp(d: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  if (d.token) {
    app.use('/api', (req, res, next) => {
      if (getToken(req) !== d.token) return res.status(401).json({ error: 'unauthorized' });
      next();
    });
  }

  const router = buildRouter(d);
  app.use('/api/v1', router);
  app.use('/api', router);
  for (const mr of d.routers ?? []) {
    app.use('/api/v1', express.json({ limit: '4mb' }), mr);
    app.use('/api', express.json({ limit: '4mb' }), mr);
  }

  // Plugin routes: /api/v1/plugins/<name><path> (the /api alias router sees them too).
  for (const pr of d.pluginRoutes ?? []) {
    const full = `/plugins/${pr.plugin}${pr.path.startsWith('/') ? pr.path : `/${pr.path}`}`;
    const handler = async (req: Request, res: Response) => {
      try {
        await pr.handler(req, res);
        if (!res.headersSent) res.status(404).json({ error: 'plugin handler returned nothing' });
      } catch (e: any) {
        if (!res.headersSent) res.status(500).json({ error: e?.message ?? String(e) });
      }
    };
    app.get(`/api/v1${full}`, handler);
    app.post(`/api/v1${full}`, handler);
    app.put(`/api/v1${full}`, handler);
    app.delete(`/api/v1${full}`, handler);
  }

  for (const s of d.pluginStatics ?? []) {
    if (existsSync(s.dir)) app.use(`/plugins/${s.plugin}/`, express.static(s.dir));
  }

  // P9 — the Claude door over Streamable HTTP MCP at /mcp (stateless: one fresh
  // door per request). Same tools as the stdio door; behind the token.
  if (d.door) {
    app.use('/mcp', express.json({ limit: '4mb' }));
    const authorize = (req: Request, res: Response): boolean => {
      if (!d.token) return true;
      if (getToken(req) === d.token) return true;
      res.status(401).json({ error: 'unauthorized' });
      return false;
    };
    app.post('/mcp', (req, res) => {
      if (!authorize(req, res)) return;
      const server = d.door!();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      void server
        .connect(transport)
        .then(() => transport.handleRequest(req, res, req.body))
        .catch((e: any) => {
          if (!res.headersSent) res.status(500).json({ error: e?.message ?? String(e) });
        });
    });
    const methodNotAllowed = (req: Request, res: Response) => {
      if (!authorize(req, res)) return;
      res.status(405).end();
    };
    app.get('/mcp', methodNotAllowed);
    app.delete('/mcp', methodNotAllowed);
  }

  if (d.staticDir && existsSync(d.staticDir)) app.use('/', express.static(d.staticDir));

  return app;
}

export { type AlfredPlugin };
