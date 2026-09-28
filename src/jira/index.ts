// J1 — Jira module: the `jira` agent tool, the board import timer, and the dashboard routes.
// Credentials (JIRA_SITE/JIRA_EMAIL/JIRA_API_TOKEN) come from env and are never logged,
// echoed or stored. Policy = config/jira.yaml, read fresh, fail-closed.
import express, { type Request, type Response } from 'express';
import type { AlfredModule, ModuleDeps } from '../modules.js';
import type { Tool } from '../runtime/contract.js';
import { storeForTask } from '../approvals.js';
import type { Store } from '../store.js';
import type { Board } from '../board/board.js';
import { JIRA_NOT_CONFIGURED, jiraPolicyPath, loadJiraPolicy } from './config.js';
import { clientFor, jiraTool, usage } from './tool.js';
import { syncJira, type SyncResult } from './sync.js';

const boardOf = (deps: ModuleDeps): Board | undefined => (deps.modules?.board as any)?.board;

function recordSync(deps: ModuleDeps, res: SyncResult): void {
  try {
    deps.store.appendEvent('', null, 'jira', { kind: 'sync', created: res.created, updated: res.updated, closed: res.closed, errors: res.errors });
  } catch {
    /* the event log must never break anything */
  }
}

function jiraRouter(deps: ModuleDeps): express.Router {
  const r = express.Router();
  let meCache: { at: number; displayName?: string; error?: string } | null = null;
  let lastSync: SyncResult | null = null;

  r.get('/jira/status', async (_req: Request, res: Response) => {
    const client = clientFor(deps);
    const out: Record<string, any> = {
      configured: !!client,
      site: deps.env?.JIRA_SITE?.replace(/\/+$/, '') ?? null,
      policy: loadJiraPolicy(deps),
      policyPath: jiraPolicyPath(deps),
      usage: usage(deps),
      ...(lastSync ? { lastSync } : {}),
    };
    if (client) {
      if (!meCache || Date.now() - meCache.at > 600_000) {
        try {
          meCache = { at: Date.now(), displayName: (await client.myself()).displayName };
        } catch (e: any) {
          meCache = { at: Date.now(), error: String(e?.message ?? e).slice(0, 200) };
        }
      }
      if (meCache.displayName) out.user = meCache.displayName;
      else out.error = meCache.error ?? 'unknown user';
    }
    res.json(out);
  });

  r.post('/jira/sync', async (_req: Request, res: Response) => {
    const client = clientFor(deps);
    if (!client) {
      res.status(400).json({ error: JIRA_NOT_CONFIGURED });
      return;
    }
    const board = boardOf(deps);
    if (!board) {
      res.status(500).json({ error: 'the board module is not available' });
      return;
    }
    try {
      const out = await syncJira(deps, board, client, loadJiraPolicy(deps));
      lastSync = out;
      recordSync(deps, out);
      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 300) });
    }
  });

  // Quinn, from the dashboard: turn a board item into a Jira ticket (not gated — Quinn clicked it;
  // the project allowlist and the daily cap still apply).
  r.post('/jira/items/:key/ticket', async (req: Request, res: Response) => {
    try {
      const client = clientFor(deps);
      if (!client) {
        res.status(400).json({ error: JIRA_NOT_CONFIGURED });
        return;
      }
      const policy = loadJiraPolicy(deps);
      const project = String(req.body?.project ?? '').trim().toUpperCase();
      const type = String(req.body?.type ?? '').trim();
      if (!policy.projects.includes(project)) {
        res.status(400).json({ error: `project ${project || '?'} is not allowed. Allowed: ${policy.projects.join(', ') || 'none (config/jira.yaml)'}` });
        return;
      }
      if (!policy.issueTypes.includes(type)) {
        res.status(400).json({ error: `issue type "${type || '?'}" is not allowed. Allowed: ${policy.issueTypes.join(', ')}` });
        return;
      }
      const board = boardOf(deps);
      const item = board?.getItem(String(req.params.key ?? ''));
      if (!board || !item) {
        res.status(404).json({ error: `no such item: ${req.params.key}` });
        return;
      }
      const u = usage(deps);
      if (u.createsToday >= policy.limits.createsPerDay) {
        res.status(429).json({ error: `daily limit of ${policy.limits.createsPerDay} Jira tickets reached` });
        return;
      }
      try {
        const t = await client.create({
          project,
          type,
          summary: item.title.slice(0, 200),
          description: item.description || undefined,
          labels: ['alfred'],
        });
        const labels = item.labels.includes('jira') ? item.labels : [...item.labels, 'jira'];
        board.updateItem(item.key, { labels, fields: { ...(item.fields ?? {}), jira: t.url } }, 'quinn');
        deps.store.appendEvent('', null, 'jira', { kind: 'create', ok: true, key: t.key, summary: item.title, project });
        res.json({ key: t.key, url: t.url });
      } catch (e: any) {
        try {
          deps.store.appendEvent('', null, 'jira', { kind: 'create', ok: false, project });
        } catch {
          /* ignore */
        }
        res.status(502).json({ error: String(e?.message ?? e).slice(0, 300) });
      }
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 300) });
    }
  });

  return r;
}

/** Each running instance's tools, by its store (for the unbound stubs below). */
const bound = new WeakMap<Store, Tool[]>();

export function createJiraModule(deps: ModuleDeps): AlfredModule {
  const tool = jiraTool(deps);
  bound.set(deps.store, [tool]);
  let timers: NodeJS.Timeout[] = [];

  const runImport = async () => {
    try {
      const client = clientFor(deps);
      const board = boardOf(deps);
      if (!client || !board) return;
      const res = await syncJira(deps, board, client, loadJiraPolicy(deps));
      recordSync(deps, res);
    } catch (e: any) {
      console.error(`[jira] import failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  };

  return {
    name: 'jira',
    router: jiraRouter(deps),
    tools: [tool],
    start() {
      const policy = loadJiraPolicy(deps);
      if (!policy.import.enabled || !clientFor(deps)) return;
      const first = setTimeout(() => void runImport(), 30_000);
      const every = setInterval(() => void runImport(), policy.import.everyMinutes * 60_000);
      first.unref();
      every.unref();
      timers = [first, every];
    },
    stop() {
      for (const t of timers) clearTimeout(t);
      timers = [];
    },
  };
}

/**
 * The same tool without a module (allTools(), for registries built outside startAlfred):
 * same schema; a run finds the instance that owns the task's store, or answers unavailable.
 */
export function jiraToolStubs(): Tool[] {
  const template = jiraTool({ extra: {} } as unknown as ModuleDeps);
  return [
    {
      kind: template.kind,
      caps: template.caps,
      schema: template.schema,
      run: async (args, ctx) => {
        const store = storeForTask(ctx.taskId);
        const real = store ? bound.get(store)?.find((x) => x.schema.name === 'jira') : undefined;
        return real ? real.run(args, ctx) : { ok: false, output: 'jira is not available in this runtime' };
      },
    },
  ];
}
