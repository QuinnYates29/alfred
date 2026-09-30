// J2 — the Jev module: the fast decision layer (TypeSafe "System One"). Never writes text;
// it answers typed questions about state in ~0.3 s. Four uses: done-gate review (`review`),
// approval risk annotation (`risk`), web_fetch prompt-injection screening (`screen`) and the
// jev_decide agent tool (`tool`). Everything fails open: no key, no config, over the daily
// token cap, or a dead API ⇒ the caller behaves exactly as if Jev did not exist.
// Private chat threads never reach Jev: chat has no jev tools and the gate only asks Jev on
// goal-task approvals.
import express, { type Request, type Response } from 'express';
import type { AlfredModule, ModuleDeps } from '../modules.js';
import type { Store } from '../store.js';
import type { Tool, ToolContext } from '../runtime/contract.js';
import { storeForTask } from '../approvals.js';
import { setWebScreen } from '../runtime/web.js';
import { setApprovalTriage } from '../approvals.js';
import { makeApprovalTriage } from './triage.js';
import { jevClient, jevUsage, type JevClient, type JevClientOptions } from './client.js';
import { localJevClient, LOCAL_MODEL } from './local.js';

const NOT_CONFIGURED = 'Jev is not configured (config/jev.yaml backend: local, or TYPESAFE_API_KEY for the hosted API)';
import { loadJevPolicy, type JevPolicy } from './policy.js';
import { makeReviewHook, registerReviewHook } from './review.js';
import { askRisk, INJECTION_INSTRUCTIONS, type RiskInput, type RiskResult } from './risk.js';
import { jevTool } from './tool.js';

/** Start of the accounting day, local time. */
function startOfToday(now: () => number): number {
  const d = new Date(now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface JevModuleSurface extends AlfredModule {
  /** A client for the current env+policy, or null (no key / disabled). */
  client(): JevClient | null;
  /** The policy as config/jev.yaml says right now (defaults on a missing/broken file). */
  policy(): JevPolicy;
  /** Risk read on a gated action (null = Jev has nothing to say; never throws). */
  risk(input: RiskInput): Promise<RiskResult | null>;
}

export function createJevModule(deps: ModuleDeps): JevModuleSurface {
  const now = ((deps.extra?.jevNow as (() => number) | undefined) ?? (() => Date.now())) as () => number;
  const fetchImpl = (deps.extra?.fetch as typeof fetch | undefined) ?? globalThis.fetch;

  const policy = (): JevPolicy => loadJevPolicy(deps);
  const tokensToday = (): number => {
    const u = jevUsage(deps, startOfToday(now));
    return u.inTokens + u.outTokens;
  };

  const client = (): JevClient | null => {
    const pol = policy();
    return pol.backend === 'local'
      ? localJevClient(pol.localUrl, deps.env ?? {}, pol, fetchImpl, clientOpts)
      : jevClient(deps.env ?? {}, pol, fetchImpl, clientOpts);
  };
  const clientOpts: JevClientOptions = {
    now,
    tokensToday,
    onCall: (r) => {
      try {
        deps.store.appendEvent(r.goalId || '', null, 'jev', {
          use: r.use,
          ok: r.ok,
          ms: r.ms,
          inTokens: r.inTokens,
          outTokens: r.outTokens,
          ...(r.backend ? { backend: r.backend } : {}),
        });
      } catch {
        /* accounting must never break a call */
      }
    },
  };

  const risk = async (input: RiskInput): Promise<RiskResult | null> => {
    if (!policy().risk) return null;
    try {
      return await askRisk(client(), input);
    } catch {
      return null;
    }
  };

  const router = express.Router();
  router.get('/jev/status', (_req: Request, res: Response) => {
    try {
      const pol = policy();
      const configured = pol.backend === 'local' || !!deps.env?.TYPESAFE_API_KEY?.trim();
      const u = jevUsage(deps, startOfToday(now));
      res.json({
        configured,
        enabled: configured && pol.enabled,
        backend: pol.backend,
        model: pol.backend === 'local' ? LOCAL_MODEL : pol.model,
        policy: pol,
        today: { calls: u.calls, inTokens: u.inTokens, estUsd: u.estUsd, avgMs: u.avgMs, byUse: u.byUse },
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  router.post('/jev/test', async (_req: Request, res: Response) => {
    const jev = client();
    if (!jev) {
      res.status(400).json({ ok: false, error: NOT_CONFIGURED });
      return;
    }
    const out = await jev.ask('ping', { ok: { type: 'noul', instructions: 'Is this text a health-check ping that should be answered yes?' } }, 'test');
    res.json(out ? { ok: true, noul: out.answers?.ok?.noul ?? null, ms: out.ms } : { ok: false, error: 'no answer from Jev (call failed — fail-open)' });
  });

  const tools = policy().tool ? [jevTool(deps)] : [];
  bound.set(deps.store, tools);

  return {
    name: 'jev',
    router,
    tools,
    client,
    policy,
    risk,
    start() {
      registerReviewHook(makeReviewHook({ client, policy, store: deps.store }));
      setApprovalTriage(makeApprovalTriage({ client, policy, store: deps.store }));
      setWebScreen(async (text: string): Promise<number | null> => {
        if (!policy().screenWeb) return null;
        const jev = client();
        if (!jev) return null;
        const out = await jev.ask({ text }, { injection: { type: 'noul', instructions: INJECTION_INSTRUCTIONS } }, 'screen');
        const p = Number(out?.answers?.injection?.noul);
        return Number.isFinite(p) ? p : null;
      });
    },
    stop() {
      registerReviewHook(null);
      setApprovalTriage(null);
      setWebScreen(null);
    },
  };
}

/** Each running instance's tools, by its store (for the unbound allTools() stub below). */
const bound = new WeakMap<Store, Tool[]>();

/**
 * The same tool without a module (allTools(), for registries built outside startAlfred):
 * same schema; a run finds the instance that owns the task's store, or says Jev is not set up.
 */
export function jevToolStubs(): Tool[] {
  const t = jevTool({ modules: {}, extra: {} } as unknown as ModuleDeps);
  return [
    {
      ...t,
      run: async (args: any, ctx: ToolContext) => {
        const store = storeForTask(ctx.taskId);
        const real = store ? bound.get(store)?.find((x) => x.schema.name === t.schema.name) : undefined;
        return real ? real.run(args, ctx) : { ok: false, output: NOT_CONFIGURED };
      },
    },
  ];
}
