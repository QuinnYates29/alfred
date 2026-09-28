// P21a §4 — self-development: agents change alfred itself, safely.
// propose → a coder goal in a worktree of repo `alfred` (never in place);
// Quinn reviews it in Goals → Changes; deploy (gated) merges, rebuilds, restarts.
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import type { AcceptanceCheck } from '../types.js';
import { createGoalWithRoot, resolveGoal } from '../ops.js';
import { pushedBranches } from '../review/changes.js';
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

async function deploy(deps: ModuleDeps, goalId: string): Promise<ToolResult> {
  const steps: string[] = [];
  const say = (ok: boolean) => ({ ok, output: steps.join('\n') });
  const changes = await selfApi(deps, 'GET', `/goals/${encodeURIComponent(goalId)}/changes`);
  const files: string[] = changes.ok ? (changes.body?.files ?? []).map((f: any) => String(f.path)) : [];

  const merge = await selfApi(deps, 'POST', `/goals/${encodeURIComponent(goalId)}/merge`, { confirm: true });
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
          confirm: { type: 'boolean', description: 'chat only, after Quinn agreed' },
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
          // Bound to the pushed branch heads: new commits after approval need a fresh OK.
          const heads = pushedBranches(deps.store, goal.id).map((b) => `${b.branch}@${b.sha}`).join(',');
          return await gated(
            { deps, tool: ctx, confirm: a.confirm === true },
            'deploy',
            `deploy:${goal.slug}`,
            () => deploy(deps, goal.id),
            { bind: heads, ...(heads ? { info: heads } : {}) },
          );
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
