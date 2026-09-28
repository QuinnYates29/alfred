// Goal dataset records — one line in goals-YYYY-MM.jsonl per finished goal (done/failed),
// so the eval set covers whole runs, not just chat turns. Goals marked `meta.private`
// are never recorded. Started from the chat module; returns the unsubscribe.
import type { ModuleDeps } from './modules.js';
import { recordGoal } from './chat/dataset.js';

const SPEC_CAP = 20_000;

export function startGoalDataset(deps: ModuleDeps): () => void {
  return deps.store.onEvent((e) => {
    try {
      if (e.kind !== 'goal_status') return;
      const status = e.data?.status;
      if (status !== 'done' && status !== 'failed') return;
      const goal = deps.store.getGoal(e.goalId);
      if (!goal || goal.meta?.private === true) return;
      const tasks = deps.store.listTasks(goal.id).map((t) => {
        const u = deps.store.taskUsage(t.id);
        return {
          id: t.id,
          persona: t.persona,
          status: t.status,
          ...(t.result ? { result: t.result } : {}),
          ...(t.reason ? { reason: t.reason } : {}),
          usage: { promptTokens: u.promptTokens, completionTokens: u.completionTokens, turns: u.turns },
        };
      });
      recordGoal(deps.env, {
        goalId: goal.id,
        title: goal.title,
        spec: String(goal.body ?? '').slice(0, SPEC_CAP),
        status,
        personas: [...new Set(tasks.map((t) => t.persona))],
        tasks,
        durationMs: Math.max(0, goal.updatedAt - goal.createdAt),
        source: goal.meta?.source ?? null,
      });
    } catch {
      /* recording must never break event handling */
    }
  });
}
