// P0 notifier fan-out + loud-failure wiring.
import type { Notice, Sink, TaskStatus } from './types.js';
import type { Store } from './store.js';

export class Notifier {
  private readonly sinks: Sink[];
  private readonly timeoutMs: number;

  constructor(sinks: Sink[], opts?: { timeoutMs?: number }) {
    this.sinks = sinks;
    this.timeoutMs = opts?.timeoutMs ?? 10_000;
  }

  async notify(n: Notice): Promise<{ sink: string; ok: boolean; error?: string }[]> {
    return Promise.all(this.sinks.map((sink) => this.sendOne(sink, n)));
  }

  private sendOne(sink: Sink, n: Notice): Promise<{ sink: string; ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ sink: sink.name, ok: false, error: `timed out after ${this.timeoutMs}ms` });
      }, this.timeoutMs);
      // Don't let a leaked timer keep the process alive.
      if (typeof (timer as any).unref === 'function') (timer as any).unref();

      Promise.resolve()
        .then(() => sink.send(n))
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ sink: sink.name, ok: true });
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            sink: sink.name,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    });
  }
}

const FAILURE_TARGETS: readonly TaskStatus[] = ['failed', 'stopped', 'blocked'];

export function wireLoudFailures(store: Store, notifier: Notifier): () => void {
  return store.onEvent((e) => {
    if (e.kind === 'transition') {
      const data = e.data as { from: TaskStatus; to: TaskStatus; reason: string | null; by: string | null };
      let level: Notice['level'] | null = null;
      if (FAILURE_TARGETS.includes(data.to)) level = 'failure';
      else if (data.to === 'needs_claude') level = 'warn';
      if (!level) return;

      const task = e.taskId ? store.getTask(e.taskId) : undefined;
      const title = task ? task.title : store.getGoal(e.goalId)?.title ?? e.goalId;
      void notifier.notify({
        level,
        goalId: e.goalId,
        taskId: e.taskId ?? undefined,
        title,
        body: data.reason ?? '',
      });
    } else if (e.kind === 'goal_status') {
      const data = e.data as { status: string };
      if (data.status !== 'failed') return;
      const goal = store.getGoal(e.goalId);
      void notifier.notify({
        level: 'failure',
        goalId: e.goalId,
        title: goal?.title ?? e.goalId,
        body: 'goal failed: not every task finished done',
      });
    }
  });
}
