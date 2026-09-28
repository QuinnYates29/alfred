// P21a §4 — self-development: agents change alfred itself, safely.
// propose → a coder goal in a worktree of repo `alfred` (never in place);
// Quinn reviews it in Goals → Changes; deploy (gated) merges, rebuilds, restarts.
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import type { AcceptanceCheck } from '../types.js';
import { createGoalWithRoot, resolveGoal } from '../ops.js';
import { pushedBranches, resolveBase, resolveRepo } from '../review/changes.js';
import { selfApi, apiError } from './api.js';
import { gated, powersRoot } from './gate.js';

const AREAS = ['web', 'server', 'app', 'cli'] as const;
/** A deploy restarts alfred only when the merged diff touched what the running process loaded. */
const RESTART_RE = /^(src|personas|config)\//;

export function devAcceptance(area?: string): AcceptanceCheck[] {
  return [
    ...(area === 'web' ? [{ name: 'build-web', cmd: 'npm run build:web', timeoutMs: 600_000 }] : []),
    { name: 'tests', cmd: 'npx vitest run test/acceptance/ test/unit/', timeoutMs: 1_200_000 },
    { name: 'typecheck', cmd: 'npx tsc --noEmit -p tsconfig.src.json', timeoutMs: 600_000 },
  ];
}

function ensureRepo(deps: ModuleDeps): void {
  if (!deps.store.getRepo('alfred')) deps.store.upsertRepo({ name: 'alfred', paths: { local: powersRoot(deps) } });
}

function propose(deps: ModuleDeps, a: any): ToolResult {
  const title = String(a.title ?? '').trim();
  const spec = String(a.spec ?? '').trim();
  if (!title || !spec) return { ok: false, output: 'propose needs title and spec' };
  const area = a.area === undefined || a.area === null || a.area === '' ? undefined : String(a.area);
  if (area && !(AREAS as readonly string[]).includes(area)) return { ok: false, output: `area must be ${AREAS.join('|')}` };
  ensureRepo(deps);
  const body = `${spec}\n\n(alfred self-change${area ? `, area ${area}` : ''}: work on your branch in the worktree; do not deploy — Quinn reviews and deploys.)`;
  const { goal } = createGoalWithRoot(deps.store, {
    title,
    body,
    spec: body,
    persona: 'coder',
    acceptance: devAcceptance(area),
    repo: 'alfred',
  });
  deps.store.setGoalMeta(goal.id, { mode: 'repo' });
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

async function deploy(deps: ModuleDeps, goalId: string, pin?: DeployPin | null): Promise<ToolResult> {
  const steps: string[] = [];
  const say = (ok: boolean) => ({ ok, output: steps.join('\n') });
  const changes = await selfApi(deps, 'GET', `/goals/${encodeURIComponent(goalId)}/changes`);
  const files: string[] = changes.ok ? (changes.body?.files ?? []).map((f: any) => String(f.path)) : [];

  const merge = await selfApi(deps, 'POST', `/goals/${encodeURIComponent(goalId)}/merge`, {
    confirm: true,
    ...(pin ? { branch: pin.branch, sha: pin.sha, into: pin.base, baseSha: pin.baseSha } : {}), // SB: exactly what was approved
  });
  if (!merge.ok) {
    steps.push(`merge: failed (${apiError(merge)})`);
    return say(false);
  }
  steps.push(`merge: ok → ${merge.body?.into ?? 'base'} ${String(merge.body?.sha ?? '').slice(0, 8)}`);

  const build = await selfApi(deps, 'POST', '/ops/alfred/build-web', { confirm: true, by: 'agent' });
  if (!build.ok) {
    steps.push(`build-web: failed (${apiError(build)})${build.body?.output ? `\n${String(build.body.output).slice(-1500)}` : ''}`);
    return say(false);
  }
  steps.push('build-web: ok');

  if (!files.some((f) => RESTART_RE.test(f))) {
    steps.push('restart: not needed (no src/, personas/ or config/ changes)');
    return say(true);
  }
  const restart = await selfApi(deps, 'POST', '/ops/services/alfred/restart', { confirm: true, by: 'agent' });
  steps.push(restart.ok ? 'restart: alfred is restarting' : `restart: failed (${apiError(restart)})`);
  return say(restart.ok);
}

export function alfredDevTool(deps: ModuleDeps): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'alfred_dev',
      description:
        "Change alfred itself. propose{title,spec,area}: a coder goal on a branch. status{goal}. deploy{goal} (needs approval): merge, rebuild web, restart if server code changed.",
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['propose', 'status', 'deploy'] },
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
          if (goal.meta?.repo !== 'alfred') return { ok: false, output: `${goal.slug} is not an alfred change (repo ${goal.meta?.repo ?? 'none'})` };
          // SB: the detail names the hub's branch head + base head; the merge lands exactly those, and a
          // moved base or new commits mean a different detail — a fresh OK.
          const pin = await deployPin(deps, goal);
          return await gated({ deps, tool: ctx }, 'deploy', deployDetail(goal.slug, pin), async () =>
            pin ? deploy(deps, goal.id, pin) : { ok: false, output: `nothing to deploy: ${goal.slug} has no branch in the hub yet` },
          );
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
