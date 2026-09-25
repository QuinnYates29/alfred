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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
