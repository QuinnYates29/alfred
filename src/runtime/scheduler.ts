// P1 — the scheduler: a poll loop that claims queued tasks and runs them,
// bounded by maxWorkers. Children are picked up by the same loop (spawnRunner
// is a no-op), so a parent parked in wait_subtasks holds a worker but never
// blocks its children — model-call concurrency is limitLLM's job.
import type { Persona } from './contract.js';
import { runTask, type RunOpts } from './agent.js';
import type { Store } from '../store.js';
import type { ToolRegistry } from './tools.js';

export interface SchedulerOpts extends Omit<RunOpts, 'workerId' | 'spawnRunner'> {
  maxWorkers: number;
  pollMs?: number;
  idPrefix?: string;
}

export class Scheduler {
  private readonly o: SchedulerOpts;
  private readonly prefix: string;
  private readonly runningMap = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  /** P12b: the worker id this scheduler runs each task with (for requeue ownership). */
  private readonly workers = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(o: SchedulerOpts) {
    this.o = o;
    this.prefix = o.idPrefix ?? `sched-${Math.random().toString(36).slice(2, 8)}`;
  }

  start(): void {
    if (this.stopped) throw new Error('Scheduler is stopped; construct a new one');
    if (this.timer) return;
    const period = Math.max(1, this.o.pollMs ?? 1000);
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, period);
    void this.tick().catch(() => {});
  }

  /**
   * P12b — with `requeue: true` (service shutdown) every running task we own is handed back to
   * the queue instead of being cancelled: note + `running → queued` (lease cleared by the
   * transition), then the run is aborted. Because the lease is gone before the abort lands, the
   * agent's P12 ownership gate keeps the run from writing anything else afterwards.
   * Without the option we keep today's behavior: the run itself ends the task `stopped`.
   */
  async stop(o?: { requeue?: boolean }): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (o?.requeue) {
      for (const taskId of [...this.runningMap.keys()]) {
        try {
          const t = this.o.store.getTask(taskId);
          if (!t || t.status !== 'running' || t.leaseOwner !== this.workers.get(taskId)) continue;
          this.o.store.appendNote(taskId, 'service stopped/restarted: resuming on next start');
          this.o.store.transition(taskId, 'queued', { reason: 'service restart', by: 'scheduler' });
        } catch {
          // The run finished or transitioned first; nothing to hand back.
        }
      }
    }
    for (const ac of this.aborts.values()) ac.abort();
    while (this.runningMap.size > 0) {
      await Promise.allSettled([...this.runningMap.values()]);
    }
  }

  running(): string[] {
    return [...this.runningMap.keys()];
  }

  /** P4 — abort one running task; it ends `stopped` with the reason. False if not running here. */
  cancel(taskId: string, reason = 'stopped by Quinn'): boolean {
    const ac = this.aborts.get(taskId);
    if (!ac) return false;
    void reason; // the agent's abort path records the stop with its own reason text
    ac.abort();
    return true;
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.timer) return;
    try {
      this.o.store.reclaimExpired();
    } catch {
      // Another worker's reclaim raced us; nothing to do.
    }
    while (
      !this.stopped &&
      this.runningMap.size < this.o.maxWorkers &&
      this.timer
    ) {
      const workerId = `${this.prefix}-${this.runningMap.size}`;
      let claimed;
      try {
        claimed = this.o.store.claimNext(workerId, {
          leaseMs: this.o.leaseMs ?? 5 * 60 * 1000,
        });
      } catch {
        return;
      }
      if (!claimed) return;
      this.spawn(claimed.id, workerId);
    }
  }

  private spawn(taskId: string, workerId: string): void {
    const ac = new AbortController();
    this.aborts.set(taskId, ac);
    this.workers.set(taskId, workerId);
    const done = runTask(taskId, {
      ...this.o,
      workerId,
      spawnRunner: () => {},
      signal: ac.signal,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.runningMap.delete(taskId);
        this.aborts.delete(taskId);
      });
    this.runningMap.set(taskId, done);
  }
}
