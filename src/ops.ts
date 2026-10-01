// P4 §1 — operations shared by the API, the CLI and the Claude door.
import type { AcceptanceCheck, Budget, Goal, Task, TaskStatus } from './types.js';
import type { Store } from './store.js';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CreateGoalWithRootInput {
  title: string;
  body?: string;
  /** Default 'alfred'. */
  persona?: string;
  /** Default: the goal's body. */
  spec?: string;
  acceptance?: AcceptanceCheck[];
  /** Absolute path of the git repo the goal works on; lands in goal.meta.repo. */
  repo?: string;
  budget?: Partial<Budget>;
  /** P7: model name or role for every task of this goal (goal.meta.model). */
  model?: string;
}

/**
 * Goals with no acceptance checks and no repo (research, questions, "look into X") would always
 * fail: the gate refuses to mark a check-less task done. They get this check instead — the
 * deliverable is a report: the runtime writes the finish summary to REPORT.md, and it must be
 * substantial. Checks still decide; code goals (repo) keep needing real checks.
 */
export const REPORT_CHECK: AcceptanceCheck = { name: 'report', cmd: 'test "$(wc -c < REPORT.md)" -ge 200' };
export const REPORT_SPEC_NOTE =
  'Deliverable: a report. When done, call finish with the COMPLETE report as the summary (it is saved to ' +
  'REPORT.md and is what Quinn reads; at least a few paragraphs, with sources).';

export function isReportCheck(c: AcceptanceCheck): boolean {
  return c.name === REPORT_CHECK.name && c.cmd === REPORT_CHECK.cmd;
}

// ---- alfred working on itself (ALF-7) ----

/** The repo name of alfred's own checkout. Registered at boot, so a board item or goal can just say `alfred`. */
export const SELF_REPO = 'alfred';

/** The deps are the server's, mounted read-only: build with them (`build:web` would `npm install`). */
export const BUILD_WEB_CHECK: AcceptanceCheck = { name: 'build-web', cmd: 'npm run build:web:local', timeoutMs: 600_000 };
/** The running server's own checkout (this file is <root>/src/ops.ts). */
export const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The UI-test runner always comes from the server's checkout (mounted read-only in the sandbox), never from
 * the agent's workspace: it works on a branch of any age, and an agent can't change what judges its UI.
 */
export const UI_RUNNER = join(SERVER_ROOT, 'scripts', 'ui-test.mts');
/**
 * Boots a throwaway copy of alfred from the workspace (temp DB, random port, a model that never acts) and
 * drives every page in headless Chromium at desktop and phone width: fails on page errors; the screenshots
 * become a goal output.
 */
export const UI_SMOKE_CHECK: AcceptanceCheck = { name: 'ui-smoke', cmd: `npx tsx '${UI_RUNNER}' --smoke`, timeoutMs: 600_000 };

/** The done-gate for a change to alfred itself: both suites + typecheck (+ the web build for area `web`). */
export function devAcceptance(area?: string): AcceptanceCheck[] {
  return [
    ...(area === 'web' ? [BUILD_WEB_CHECK] : []),
    // p18 drives the Electron Mac app: it needs a display and the app's deps, so it runs on the Mac, not here.
    { name: 'tests', cmd: "npx vitest run test/acceptance/ test/unit/ --exclude 'test/acceptance/p18/**'", timeoutMs: 1_200_000 },
    { name: 'typecheck', cmd: 'npx tsc --noEmit -p tsconfig.src.json', timeoutMs: 600_000 },
  ];
}

/**
 * Auto checks (goals on alfred unless set to custom): nobody has to know the right checks before the work
 * exists. The gate starts from the dev gate and adds what the change turns out to need — touching web/ adds
 * the web build (first) and the UI smoke test (last). Callers pass `devAcceptance()` as the base, so goals
 * made before Auto existed get today's gate too.
 */
export function autoChecks(base: AcceptanceCheck[], changed: string[]): AcceptanceCheck[] {
  if (!changed.some((f) => f.startsWith('web/'))) return base;
  const has = (n: string) => base.some((c) => c.name === n);
  return [...(has(BUILD_WEB_CHECK.name) ? [] : [BUILD_WEB_CHECK]), ...base, ...(has(UI_SMOKE_CHECK.name) ? [] : [UI_SMOKE_CHECK])];
}

/** Does this goal's gate grow with its diff (autoChecks)? Goals on alfred, unless Quinn set custom checks. */
export function usesAutoChecks(store: Partial<Pick<Store, 'getRepo'>>, goal: { meta?: Record<string, any> } | undefined): boolean {
  return !!goal && isSelfRepo(store, goal.meta?.repo) && goal.meta?.checks !== 'custom';
}

/** Validate checks from the API/UI: 1–12 of {name, cmd, timeoutMs?}. */
export function parseChecks(v: unknown): AcceptanceCheck[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) throw new Error('checks: give 1–12 checks, or "auto"');
  return v.map((c: any, i) => {
    const name = typeof c?.name === 'string' ? c.name.trim() : '';
    const cmd = typeof c?.cmd === 'string' ? c.cmd.trim() : '';
    if (!name || name.length > 40 || !cmd || cmd.length > 2000) throw new Error(`check ${i + 1}: needs a name (≤ 40) and a command`);
    const t = Number(c.timeoutMs);
    return { name, cmd, ...(Number.isFinite(t) && t > 0 ? { timeoutMs: Math.min(t, 3_600_000) } : {}) };
  });
}

/** Does a goal's `meta.repo` name alfred's own repo (by name, or by its registered path)? */
export function isSelfRepo(store: Partial<Pick<Store, 'getRepo'>>, ref: unknown): boolean {
  if (typeof ref !== 'string' || !ref) return false;
  if (ref === SELF_REPO) return true;
  const self = store.getRepo?.(SELF_REPO);
  return !!self && Object.values(self.paths).includes(ref);
}

/**
 * A goal's repo must resolve when it runs: a registered name, a registered path, or an absolute path
 * (auto-registered on first run). Anything else used to fail only inside the scheduler (ALF-7).
 */
export function checkRepo(store: Store, ref: string): void {
  if (store.getRepo(ref) || isAbsolute(ref) || store.listRepos().some((r) => Object.values(r.paths).includes(ref))) return;
  throw new Error(`unknown repo: ${ref} (register it under System → Repos, or give an absolute path)`);
}

/**
 * alfred's own checkout runs the server: its goals work only in a sandbox (an isolated clone of the hub),
 * never in a worktree sharing the live checkout's .git and never in place. Landing needs Quinn (deploy/Merge).
 */
export function checkSelfMeta(store: Store, meta: Record<string, any>): void {
  if (isSelfRepo(store, meta.repo) && (meta.inPlace === true || meta.mode === 'repo')) {
    throw new Error(`repo ${SELF_REPO} is the running server's checkout: its goals work in a sandbox clone only (no worktree, never in place)`);
  }
}

/** Create a goal plus its single root task in one call. */
export function createGoalWithRoot(
  store: Store,
  input: CreateGoalWithRootInput,
): { goal: Goal; task: Task } {
  if (!input.title || !input.title.trim()) throw new Error('title is required');
  if (input.repo) checkRepo(store, input.repo);
  const body = input.body ?? '';
  const reportGoal = !(input.acceptance ?? []).length && !input.repo;
  // A change to alfred without checks would be refused at the gate anyway: give it the dev gate.
  const acceptance = reportGoal
    ? [REPORT_CHECK]
    : (input.acceptance ?? []).length || !isSelfRepo(store, input.repo)
      ? input.acceptance ?? []
      : devAcceptance();
  const goal = store.createGoal({
    title: input.title,
    body,
    acceptance,
    budget: input.budget,
    meta: {
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(isSelfRepo(store, input.repo) ? { mode: 'sandbox', ...((input.acceptance ?? []).length ? { checks: 'custom' } : {}) } : {}),
    },
  });
  const task = store.createTask({
    goalId: goal.id,
    persona: input.persona ?? 'alfred',
    title: input.title,
    spec: reportGoal ? `${input.spec ?? body}\n\n${REPORT_SPEC_NOTE}` : input.spec ?? body,
    acceptance,
  });
  return { goal, task };
}

/**
 * Clone a failed/stopped task as a fresh queued one (the `alfred_retry`
 * semantics): same goal/parent/persona/spec/acceptance; notes carry over,
 * plus the optional new note.
 */
export function retryTask(store: Store, taskId: string, note?: string): Task {
  const src = store.getTask(taskId);
  if (!src) throw new Error(`no such task: ${taskId}`);
  if (src.status !== 'failed' && src.status !== 'stopped') {
    throw new Error(`retry needs a failed or stopped task (this one is ${src.status})`);
  }
  const fresh = store.createTask({
    goalId: src.goalId,
    parentTaskId: src.parentTaskId,
    persona: src.persona,
    title: src.title,
    spec: src.spec,
    // A check-less task on alfred itself (made before the dev gate defaulted) retries with it.
    acceptance: src.acceptance.length || !isSelfRepo(store, store.getGoal(src.goalId)?.meta?.repo) ? src.acceptance : devAcceptance(),
    budget: src.budget,
  });
  if (src.notes && src.notes.trim()) store.appendNote(fresh.id, src.notes.trimEnd());
  const extra = [src.reason ? `retry of ${taskId} (${src.status}: ${src.reason})` : `retry of ${taskId}`, note]
    .filter((s): s is string => !!s && !!s.trim())
    .join(' — ');
  if (extra) store.appendNote(fresh.id, extra);
  // ALF-7: a retry on a repo continues the previous attempt's branch (workspace.ts workspaceKey).
  if (!src.parentTaskId && store.getGoal(src.goalId)?.meta?.repo) {
    store.appendNote(fresh.id, 'This retry continues on the previous attempt\'s branch: its committed work is already in your workspace. Start with `git log --oneline -5` and `git status`; build on it, do not redo it.');
  }
  return store.getTask(fresh.id)!;
}

export interface GoalSummary extends Goal {
  counts: Partial<Record<TaskStatus, number>>;
  /** O1: how many outputs this goal has (names/content not included). */
  outputs: number;
}

/** Goal plus task counts by status. */
export function goalSummary(store: Store, goalId: string): GoalSummary | undefined {
  const goal = store.getGoal(goalId);
  if (!goal) return undefined;
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const t of store.listTasks(goalId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { ...goal, counts, outputs: store.outputs(goalId).length };
}

/** A goal by id or slug; undefined when neither matches. (from P3b, used by the Claude door) */
export function resolveGoal(store: Store, ref: string): Goal | undefined {
  return store.getGoal(ref) ?? store.listGoals().find((g) => g.slug === ref);
}
