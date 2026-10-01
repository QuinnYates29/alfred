// P4 §3 + P11 — the HTTP API. Every route lives under /api/v1; /api is an alias.
// Token auth: `Authorization: Bearer <token>` or `?token=` (legacy; the web client uses
// single-use SSE tickets instead). Tokenless only in tests / explicit allowNoToken.
import { toolCaps } from '../runtime/caps.js';
import express, { type Express, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store, GoalOutput } from '../store.js';
import type { Goal } from '../types.js';
import type { Scheduler } from '../runtime/scheduler.js';
import type { Automations } from '../automations.js';
import type { McpHub } from '../connectors/mcp.js';
import type { Persona } from '../runtime/contract.js';
import type { ToolRegistry } from '../runtime/tools.js';
import type { ModelRegistry } from '../models.js';
import { promptCost } from '../runtime/personas.js';
import type { PluginRouteReg, AlfredPlugin } from '../plugins.js';
import { reviewInProgress } from '../review/peer.js';
import { createGoalWithRoot, retryTask, goalSummary, checkRepo, checkSelfMeta, devAcceptance, isSelfRepo, parseChecks } from '../ops.js';
import { DISPATCH_SYNTAX, dispatchPrompt, parseDispatch } from '../dispatch.js';
import { agentsOverview } from './agents.js';
import { hostGuard, safeEqual, securityHeaders, TicketBook } from './security.js';

export { safeEqual };

export interface AppDeps {
  store: Store;
  scheduler?: Scheduler;
  automations?: Automations;
  hub?: McpHub;
  personas?: Map<string, Persona>;
  registry?: ToolRegistry;
  token?: string;
  /** Serve /api and /mcp without a token. Implied under NODE_ENV=test; never in production. */
  allowNoToken?: boolean;
  /** Extra hostnames accepted in the Host header (loopback and IP literals always are). */
  allowedHosts?: string[];
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
  { kind: 'output', meaning: 'An agent published/updated a goal output (data: id, name, kind, bytes, taskId — never the content).' },
  // System events (goalId ''): not about one goal.
  { kind: 'item_created', meaning: "Board item created (goalId ''; data: boardId, key, by)." },
  { kind: 'item_updated', meaning: "Board item changed (goalId ''; data: boardId, key, changes, by)." },
  { kind: 'item_moved', meaning: "Board item changed column (goalId ''; data: boardId, key, from, to, by)." },
  { kind: 'item_deleted', meaning: "Board item archived/deleted (goalId ''; data: boardId, key, by)." },
  { kind: 'item_comment', meaning: "Comment on a board item (goalId ''; data: boardId, key, commentId, author)." },
  { kind: 'board_updated', meaning: "Board columns/fields/name changed (goalId ''; data: boardId)." },
  { kind: 'chat_message', meaning: "A chat message was stored (goalId ''; data: threadId, message)." },
  { kind: 'chat_progress', meaning: "A chat turn's progress (goalId ''; data: threadId, phase thinking|tool|done|error, tool?, turn?); every turn ends with done or error." },
  { kind: 'ops', meaning: "An ops action ran (goalId ''; data: action, target, ok, by)." },
  { kind: 'goal_merged', meaning: 'A goal branch was merged in the hub (data: branch, into, sha).' },
  { kind: 'goal_discarded', meaning: 'A goal branch was discarded (data: branches).' },
  { kind: 'goal_reverted', meaning: 'A landed goal was reverted on its base (data: into, sha, reverted).' },
  { kind: 'goal_checks', meaning: 'A goal\'s acceptance checks were replaced (data: checks).' },
  { kind: 'ui_test', meaning: 'A UI test ran against a sandboxed copy of alfred (data: ok, mode, shots, errors).' },
  { kind: 'peer_review_progress', meaning: 'A step of a running coder-lg review (data: sha, msg).' },
  { kind: 'peer_review_started', meaning: 'coder-lg started reviewing a goal branch (data: sha, branch, base).' },
  { kind: 'peer_review', meaning: 'coder-lg reviewed a goal branch (data: sha, branch, base, verdict, checksOk, findings, reviewed).' },
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
        caps: toolCaps(t.schema.name, t),
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
      if (b.peerReview === true) meta.peerReview = true;
      checkSelfMeta(d.store, { repo: b.repo, ...meta });
      if (Object.keys(meta).length) out.goal = d.store.setGoalMeta(out.goal.id, meta);
      res.status(201).json(out);
    } catch (e: any) {
      send(res, 400, { error: e?.message ?? String(e) });
    }
  });

  // The Agents view: every active/recent goal's task tree, live activity, what waits on Quinn.
  r.get('/agents', (_req, res) => {
    res.json(agentsOverview(d.store));
  });

  // D1 — dispatch an agent straight from a prompt: `!<persona> <prompt>`.
  r.get('/dispatch/help', (_req, res) => {
    res.json({
      personas: [...(d.personas?.values() ?? [])].map((p) => ({ name: p.name, description: p.description })),
      syntax: DISPATCH_SYNTAX,
    });
  });

  r.post('/dispatch', (req, res) => {
    const b = req.body ?? {};
    const personas = d.personas ?? new Map<string, Persona>();
    const src = String(b.source ?? '');
    const source = src === 'mac-quick' || src === 'cli' || src === 'dashboard' ? src : 'dashboard';
    let prompt = '';
    let persona = 'alfred';
    if (typeof b.text === 'string' && b.text.trim()) {
      const parsed = parseDispatch(b.text, [...personas.keys()]);
      if (parsed) ({ persona, prompt } = parsed);
      else prompt = b.text.trim(); // not dispatch syntax: the whole text is an alfred prompt
    } else if (typeof b.prompt === 'string') {
      prompt = b.prompt.trim();
      if (b.persona) persona = String(b.persona);
    }
    if (!prompt) return send(res, 400, { error: 'prompt is required' });
    try {
      const out = dispatchPrompt(d.store, personas, { prompt, persona, repo: b.repo, node: b.node, source });
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

  // ALF-7 — change where a goal works (repo / node / mode / inPlace), e.g. a goal made from a board
  // item. Only while none of its tasks is running; the next run or retry uses it. `null` clears a key.
  r.patch('/goals/:id', (req, res) => {
    const goal = findGoal(req.params.id);
    if (!goal) return send(res, 404, { error: 'no such goal' });
    const b = req.body ?? {};
    const live = d.store.listTasks(goal.id).find((t) => t.status === 'running' || t.status === 'verifying');
    if (live) return send(res, 409, { error: `task ${live.id.slice(0, 8)} is ${live.status}; stop it first` });
    const patch: Record<string, any> = {};
    const str = (k: string) => {
      if (!(k in b)) return;
      if (b[k] === null || b[k] === '') patch[k] = undefined;
      else if (typeof b[k] === 'string') patch[k] = b[k].trim();
      else throw new Error(`${k} must be a string or null`);
    };
    try {
      str('repo');
      str('node');
      if ('mode' in b) {
        if (b.mode !== null && b.mode !== 'sandbox' && b.mode !== 'repo') throw new Error('mode must be sandbox, repo or null');
        patch.mode = b.mode ?? undefined;
      }
      if ('inPlace' in b) patch.inPlace = b.inPlace === true ? true : undefined;
      if ('peerReview' in b) patch.peerReview = b.peerReview === true ? true : undefined;
      if (patch.node === 'local') patch.node = undefined;
      // ALF-7: checks — 'auto' (goals on alfred: the dev gate, grown from the diff at finish) or a custom list.
      // Applied to the goal and its unfinished tasks, so the next retry gates on them.
      let checks: import('../types.js').AcceptanceCheck[] | null = null;
      if ('checks' in b) {
        const self = isSelfRepo(d.store, 'repo' in patch ? patch.repo : goal.meta?.repo);
        if (b.checks === 'auto') {
          if (!self) throw new Error('auto checks exist for goals on alfred only; give a list of checks');
          checks = devAcceptance();
          patch.checks = undefined;
        } else {
          checks = parseChecks(b.checks);
          if (self) patch.checks = 'custom';
        }
      }
      if (!Object.keys(patch).length && !checks) throw new Error('nothing to change (repo, node, mode, inPlace, peerReview, checks)');
      if (patch.repo) checkRepo(d.store, patch.repo);
      checkSelfMeta(d.store, { ...goal.meta, ...patch });
      if (checks) d.store.setAcceptance(goal.id, checks);
    } catch (e: any) {
      return send(res, 400, { error: e?.message ?? String(e) });
    }
    res.json({ goal: Object.keys(patch).length ? d.store.setGoalMeta(goal.id, patch) : d.store.getGoal(goal.id) });
  });

  r.get('/goals/:id', (req, res) => {
    const goal = findGoal(req.params.id);
    if (!goal) return send(res, 404, { error: 'no such goal' });
    const body: Record<string, any> = {
      goal,
      tasks: d.store.listTasks(goal.id),
      events: d.store.events(goal.id).slice(-200),
      outputs: d.store.outputs(goal.id),
      // ALF-7: a coder-lg review running in this server right now (null after a restart, never stale).
      peerReviewRunning: reviewInProgress(d, goal.id),
    };
    const usage = (d.store as any).goalUsage;
    if (typeof usage === 'function') body.usage = usage.call(d.store, goal.id);
    res.json(body);
  });

  // O1 — goal outputs: deliverables an agent published for Quinn to read on the goal page.
  const outputEntry = (req: Request<{ id: string; oid: string }>): { goal: Goal; row: GoalOutput } | { err: number } => {
    const goal = findGoal(req.params.id);
    if (!goal) return { err: 404 };
    const row = d.store.getOutput(req.params.oid);
    if (!row || row.goalId !== goal.id) return { err: 404 };
    return { goal, row };
  };
  const OUTPUT_EXT: Record<string, string> = { markdown: 'md', text: 'txt', json: 'json', csv: 'csv', 'html-code': 'html', images: 'json' };
  const OUTPUT_CT: Record<string, string> = {
    markdown: 'text/markdown; charset=utf-8',
    text: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    'html-code': 'text/plain; charset=utf-8',
    images: 'application/json; charset=utf-8',
  };

  r.get('/goals/:id/outputs', (req, res) => {
    const goal = findGoal(req.params.id);
    if (!goal) return send(res, 404, { error: 'no such goal' });
    res.json(d.store.outputs(goal.id));
  });

  r.get('/goals/:id/outputs/:oid', (req, res) => {
    const e = outputEntry(req);
    if ('err' in e) return send(res, e.err, { error: 'no such output' });
    res.json(e.row);
  });

  r.get('/goals/:id/outputs/:oid/raw', (req, res) => {
    const e = outputEntry(req);
    if ('err' in e) return send(res, e.err, { error: 'no such output' });
    const clean = e.row.name.replace(/["\\/;\x00-\x1f\x7f]/g, '_').trim() || 'output';
    res.setHeader('Content-Type', OUTPUT_CT[e.row.kind] ?? 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${clean}.${OUTPUT_EXT[e.row.kind] ?? 'txt'}"`);
    res.send(e.row.content ?? '');
  });

  r.delete('/goals/:id/outputs/:oid', (req, res) => {
    const e = outputEntry(req);
    if ('err' in e) return send(res, e.err, { error: 'no such output' });
    d.store.deleteOutput(e.row.id);
    res.json({ ok: true, deleted: e.row.id });
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
      // `by` is set here, never from the body: a caller must not be able to claim to be someone else.
      res.json(d.store.decideApproval(req.params.id, decision, 'dashboard'));
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

  // DNS-rebinding guard first, then CSP & friends on every response (dashboard + API).
  app.use(hostGuard(d.allowedHosts ?? []));
  app.use(securityHeaders(() => d.deckUrl));

  const tokenless = !d.token && (d.allowNoToken === true || process.env.NODE_ENV === 'test');
  const tickets = new TicketBook();
  const isEventsPath = (p: string) => p === '/events' || p === '/v1/events';
  app.use('/api', (req, res, next) => {
    if (tokenless) return next();
    if (d.token && safeEqual(getToken(req), d.token)) return next();
    // EventSource can't send headers: a single-use ticket opens exactly one stream.
    if (req.method === 'GET' && isEventsPath(req.path) && tickets.consume(req.query.ticket)) return next();
    res.status(401).json({ error: d.token ? 'unauthorized' : 'server has no token configured' });
  });
  const issueTicket = (_req: Request, res: Response) => res.json(tickets.issue());
  app.post('/api/v1/events/ticket', issueTicket);
  app.post('/api/events/ticket', issueTicket);

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
      if (tokenless) return true;
      if (d.token && safeEqual(getToken(req), d.token)) return true;
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
