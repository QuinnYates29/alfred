// P21a §4 — self-development: agents change alfred itself, safely.
// propose → a coder goal in a sandbox clone of repo `alfred` (never a worktree, never in place);
// Quinn reviews it in Goals → Changes; deploy (gated) merges, rebuilds, restarts.
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { createGoalWithRoot, devAcceptance, isSelfRepo, resolveGoal, SELF_REPO } from '../ops.js';
import { pushedBranches, resolveBase, resolveRepo } from '../review/changes.js';
import { landedMerges } from '../review/land.js';
import { peerReviewBlocks, runPeerReview } from '../review/peer.js';
import express from 'express';
import { selfApi, apiError } from './api.js';
import { gated, powersRoot } from './gate.js';

const AREAS = ['web', 'server', 'app', 'cli'] as const;
/** A deploy restarts alfred only when the merged diff touched what the running process loaded. */
const RESTART_RE = /^(src|personas|config)\//;
/** …and rebuilds the Mac app (Settings → Updates then offers it) when it touched what the app bundles. */
export const APP_REBUILD_RE = /^(app\/|src\/node\/|src\/cli)/;

export { devAcceptance };

/** Register alfred's own checkout as repo `alfred` (main calls this at boot; propose on first use). */
export function ensureSelfRepo(deps: Pick<ModuleDeps, 'store' | 'repoRoot' | 'extra'>): void {
  if (!deps.store.getRepo(SELF_REPO)) deps.store.upsertRepo({ name: SELF_REPO, paths: { local: powersRoot(deps as ModuleDeps) } });
}

function propose(deps: ModuleDeps, a: any): ToolResult {
  const title = String(a.title ?? '').trim();
  const spec = String(a.spec ?? '').trim();
  if (!title || !spec) return { ok: false, output: 'propose needs title and spec' };
  const area = a.area === undefined || a.area === null || a.area === '' ? undefined : String(a.area);
  if (area && !(AREAS as readonly string[]).includes(area)) return { ok: false, output: `area must be ${AREAS.join('|')}` };
  ensureSelfRepo(deps);
  const body = `${spec}\n\n(alfred self-change${area ? `, area ${area}` : ''}: work on your branch in the worktree; do not deploy — Quinn reviews and deploys.)`;
  const { goal } = createGoalWithRoot(deps.store, {
    title,
    body,
    spec: body,
    persona: 'coder',
    acceptance: devAcceptance(area),
    repo: SELF_REPO,
  });
  // The dev gate given above is the Auto gate (it grows with the diff), not checks Quinn chose.
  deps.store.setGoalMeta(goal.id, { checks: undefined, ...(a.review === true ? { peerReview: true } : {}) });
  return { ok: true, output: `started goal ${goal.slug}: review it in Goals → Changes, then deploy` };
}

function status(deps: ModuleDeps, ref: string): ToolResult {
  const goal = resolveGoal(deps.store, ref);
  if (!goal) return { ok: false, output: `no such goal: ${ref}` };
  const tasks = deps.store.listTasks(goal.id);
  const root = tasks.find((t) => !t.parentTaskId) ?? tasks[0];
  const branches = pushedBranches(deps.store, goal.id);
  const out = [`${goal.slug} [${goal.status}] ${goal.title}`];
  if (root) out.push(`root task: ${root.status}${root.reason ? ` — ${root.reason.slice(0, 200)}` : ''}`);
  out.push(branches.length ? `pushed: ${branches.map((b) => `${b.branch}@${b.sha.slice(0, 8)}`).join(', ')}` : 'pushed: nothing yet');
  return { ok: true, output: out.join('\n') };
}

// ---- SB (approval integrity): a deploy approval names the exact commits; the merge lands exactly those.

export interface DeployPin {
  branch: string;
  sha: string;
  base: string;
  baseSha: string;
}

/** The goal's branch head and its base head, read from the hub refs (not from `pushed` events). */
export async function deployPin(deps: ModuleDeps, goal: { id: string; meta?: Record<string, any> }): Promise<DeployPin | null> {
  const repo = resolveRepo(deps.store, goal);
  const branch = pushedBranches(deps.store, goal.id)[0]?.branch;
  if (!repo || !branch) return null;
  const base = await resolveBase(deps.repoHub, repo.name, repo);
  if (!base) return null;
  const [sha, baseSha] = await Promise.all([deps.repoHub.headSha(repo.name, branch), deps.repoHub.headSha(repo.name, base)]);
  return sha && baseSha ? { branch, sha, base, baseSha } : null;
}

export function deployDetail(slug: string, pin: DeployPin | null): string {
  return pin ? `deploy:${slug} ${pin.branch}@${pin.sha} onto ${pin.base}@${pin.baseSha}` : `deploy:${slug}`;
}
// ---- end SB

/** Exported for tests of the post-approval sequence (merge → build-web → Mac app → restart); the tool gates it. */
export async function deploy(deps: ModuleDeps, goalId: string, pin?: DeployPin | null): Promise<ToolResult> {
  const steps: string[] = [];
  const changes = await selfApi(deps, 'GET', `/goals/${encodeURIComponent(goalId)}/changes`);
  const files: string[] = changes.ok ? (changes.body?.files ?? []).map((f: any) => String(f.path)) : [];

  const merge = await selfApi(deps, 'POST', `/goals/${encodeURIComponent(goalId)}/merge`, {
    confirm: true,
    ...(pin ? { branch: pin.branch, sha: pin.sha, into: pin.base, baseSha: pin.baseSha } : {}), // SB: exactly what was approved
  });
  if (!merge.ok) {
    steps.push(`merge: failed (${apiError(merge)})`);
    return { ok: false, output: steps.join('\n') };
  }
  steps.push(`merge: ok → ${merge.body?.into ?? 'base'} ${String(merge.body?.sha ?? '').slice(0, 8)}`);
  return applyLanded(deps, files, merge.body?.localUpdated, steps);
}

/**
 * ALF-7 — undo a deploy: revert the goal's merge on the base branch (a new commit; history is kept,
 * so a rollback is itself reversible), then rebuild/restart exactly as a deploy would.
 */
export async function rollback(deps: ModuleDeps, goalId: string, merged?: string): Promise<ToolResult> {
  const steps: string[] = [];
  const rev = await selfApi(deps, 'POST', `/goals/${encodeURIComponent(goalId)}/revert`, { confirm: true, ...(merged ? { sha: merged } : {}) });
  if (!rev.ok) {
    steps.push(`revert: failed (${apiError(rev)})`);
    return { ok: false, output: steps.join('\n') };
  }
  steps.push(`revert: ok → ${rev.body?.into ?? 'base'} ${String(rev.body?.sha ?? '').slice(0, 8)} (reverts ${String(rev.body?.reverted ?? '').slice(0, 8)})`);
  const files: string[] = Array.isArray(rev.body?.files) ? rev.body.files.map(String) : [];
  return applyLanded(deps, files, rev.body?.localUpdated, steps);
}

/** After a merge or revert landed on the base: build the web, rebuild the Mac app, restart — as the diff needs. */
async function applyLanded(deps: ModuleDeps, files: string[], localUpdated: unknown, steps: string[]): Promise<ToolResult> {
  const say = (ok: boolean) => ({ ok, output: steps.join('\n') });
  // The server runs from its checkout: if that didn't move, a build/restart would ship the old code.
  if (localUpdated === false) {
    steps.push(`local checkout: not updated (dirty or not on the base branch) — not rebuilding or restarting; clean it, then: git -C ${powersRoot(deps)} pull`);
    return say(false);
  }

  const build = await selfApi(deps, 'POST', '/ops/alfred/build-web', { confirm: true, by: 'agent' });
  if (!build.ok) {
    steps.push(`build-web: failed (${apiError(build)})${build.body?.output ? `\n${String(build.body.output).slice(-1500)}` : ''}`);
    return say(false);
  }
  steps.push('build-web: ok');

  const needRestart = files.some((f) => RESTART_RE.test(f));
  if (files.some((f) => APP_REBUILD_RE.test(f))) {
    const app = await selfApi(deps, 'POST', '/ops/app/build', { confirm: true, by: 'agent' });
    if (!app.ok && app.status !== 409) {
      steps.push(`mac-app: build failed to start (${apiError(app)})`);
      return say(false);
    }
    steps.push(app.ok ? 'mac-app: rebuilding (the app offers it under Settings → Updates)' : 'mac-app: a build was already running');
    // A restart kills the build (same service cgroup): wait for it first.
    if (needRestart) {
      const pollMs = Number(deps.extra?.appBuildPollMs ?? 5000);
      const end = Date.now() + 35 * 60_000;
      for (;;) {
        const st = await selfApi(deps, 'GET', '/ops/app/build');
        if (!st.ok || !st.body?.running) {
          steps.push(st.ok && st.body?.ok === false ? 'mac-app: build failed (see Builds → Mac app)' : 'mac-app: built');
          break;
        }
        if (Date.now() > end) {
          steps.push('mac-app: still building after 35 min; restarting anyway');
          break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  if (!needRestart) {
    steps.push('restart: not needed (no src/, personas/ or config/ changes)');
    return say(true);
  }
  const restart = await selfApi(deps, 'POST', '/ops/services/alfred/restart', { confirm: true, by: 'agent' });
  steps.push(restart.ok ? 'restart: alfred is restarting' : `restart: failed (${apiError(restart)})`);
  return say(restart.ok);
}

/** The goal's latest merge that has not been reverted yet. */
export function lastMerge(deps: Pick<ModuleDeps, 'store'>, goalId: string): string | null {
  return landedMerges(deps.store, goalId).pop()?.sha ?? null;
}

/**
 * `POST /goals/:id/rollback {confirm:true}` — Quinn's Roll back button: a goal on alfred is reverted and
 * rebuilt/restarted like a deploy; any other goal just gets its merge reverted in the hub.
 */
export function devRouter(deps: ModuleDeps): express.Router {
  const r = express.Router();
  r.post('/goals/:id/rollback', async (req, res) => {
    try {
      const goal = resolveGoal(deps.store, req.params.id);
      if (!goal) return void res.status(404).json({ error: 'no such goal' });
      if (req.body?.confirm !== true) return void res.status(400).json({ error: 'confirm: true required' });
      const merged = lastMerge(deps, goal.id);
      if (!merged) return void res.status(409).json({ error: 'nothing to roll back' });
      if (!isSelfRepo(deps.store, goal.meta?.repo)) {
        const rev = await selfApi(deps, 'POST', `/goals/${encodeURIComponent(goal.id)}/revert`, { confirm: true, sha: merged });
        return void res.status(rev.ok ? 200 : rev.status || 500).json(rev.ok ? { ok: true, output: `revert: ok → ${rev.body?.into} ${String(rev.body?.sha ?? '').slice(0, 8)}` } : { error: apiError(rev) });
      }
      const out = await rollback(deps, goal.id, merged);
      res.status(out.ok ? 200 : 500).json(out.ok ? { ok: true, output: out.output } : { error: out.output });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  return r;
}

export function alfredDevTool(deps: ModuleDeps): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'alfred_dev',
      description:
        'Change alfred itself. propose{title,spec,area,review?}: coder goal on a branch (review=coder-lg must approve). status, review (run coder-lg), deploy, rollback {goal}; deploy/rollback need approval and rebuild/restart as needed.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['propose', 'status', 'review', 'deploy', 'rollback'] },
          review: { type: 'boolean' },
          title: { type: 'string' },
          spec: { type: 'string' },
          area: { type: 'string', enum: [...AREAS] },
          goal: { type: 'string', description: 'goal id or slug' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const a = args ?? {};
      const op = String(a.op ?? '');
      try {
        if (op === 'propose') return propose(deps, a);
        if (op === 'status') return status(deps, String(a.goal ?? ''));
        if (op === 'deploy') {
          const goal = resolveGoal(deps.store, String(a.goal ?? ''));
          if (!goal) return { ok: false, output: `no such goal: ${a.goal ?? ''}` };
          if (!isSelfRepo(deps.store, goal.meta?.repo)) return { ok: false, output: `${goal.slug} is not an alfred change (repo ${goal.meta?.repo ?? 'none'})` };
          // SB: the detail names the hub's branch head + base head; the merge lands exactly those, and a
          // moved base or new commits mean a different detail — a fresh OK.
          const pin = await deployPin(deps, goal);
          // ALF-7: a goal that opted into peer review lands only a commit coder-lg approved.
          const blocked = pin ? peerReviewBlocks(deps, goal, pin.sha) : null;
          if (blocked) return { ok: false, output: `${blocked}\n(Quinn can still review and Merge it himself in Goals → Changes.)` };
          return await gated({ deps, tool: ctx }, 'deploy', deployDetail(goal.slug, pin), async () =>
            pin ? deploy(deps, goal.id, pin) : { ok: false, output: `nothing to deploy: ${goal.slug} has no branch in the hub yet` },
          );
        }
        if (op === 'review') {
          const goal = resolveGoal(deps.store, String(a.goal ?? ''));
          if (!goal) return { ok: false, output: `no such goal: ${a.goal ?? ''}` };
          const r = await runPeerReview(deps, goal);
          const top = r.findings.filter((f) => f.severity !== 'minor').slice(0, 8).map((f) => `- [${f.severity}] ${f.file ?? '(change)'}: ${f.what.split('\n')[0]}`);
          return { ok: true, output: [`peer review of ${r.sha.slice(0, 8)}: ${r.verdict} (checks ${r.checksOk ? 'pass' : 'fail'})`, ...top].join('\n') };
        }
        if (op === 'rollback') {
          const goal = resolveGoal(deps.store, String(a.goal ?? ''));
          if (!goal) return { ok: false, output: `no such goal: ${a.goal ?? ''}` };
          if (!isSelfRepo(deps.store, goal.meta?.repo)) return { ok: false, output: `${goal.slug} is not an alfred change (repo ${goal.meta?.repo ?? 'none'})` };
          const merged = lastMerge(deps, goal.id);
          if (!merged) return { ok: false, output: `nothing to roll back: ${goal.slug} has no deployed merge` };
          // Same action as deploy (always Quinn's), pinned to the exact merge commit being reverted.
          return await gated({ deps, tool: ctx }, 'deploy', `rollback:${goal.slug} ${merged}`, async () => rollback(deps, goal.id, merged));
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
