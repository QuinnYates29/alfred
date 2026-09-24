// Focused unit coverage the acceptance suite doesn't exercise: real cross-process-style
// concurrency on a file-backed store. better-sqlite3 is synchronous, so calling claim()
// twice in a row from the same event loop can never actually race — a buggy
// read-then-write (not wrapped in BEGIN IMMEDIATE) would still "pass" a sequential test.
// These tests use real OS worker threads, each with its own Database connection to the
// same file, to prove the lock actually serializes concurrent claims.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';

function runClaimNextWorker(dbPath: string, workerId: string, leaseMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./helpers/claimnext-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      workerData: { dbPath, workerId, leaseMs },
    });
    w.on('message', (msg: string[]) => {
      resolve(msg);
      void w.terminate();
    });
    w.on('error', reject);
  });
}

describe('cross-connection concurrency on a file-backed store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alfred-conc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('never double-claims a single task under a same-instant race (claim)', async () => {
    const dbPath = join(dir, 'single.db');
    const seed = openStore(dbPath);
    const g = seed.createGoal({ title: 'race' });
    const t = seed.createTask({ goalId: g.id, persona: 'coder', title: 'contested' });
    seed.close();

    const [ra, rb] = await Promise.all([
      new Promise<boolean>((resolve, reject) => {
        const w = new Worker(new URL('./helpers/claim-once-worker.ts', import.meta.url), {
          execArgv: ['--import', 'tsx'],
          workerData: { dbPath, taskId: t.id, workerId: 'w-a', leaseMs: 60_000 },
        });
        w.on('message', (m: boolean) => {
          resolve(m);
          void w.terminate();
        });
        w.on('error', reject);
      }),
      new Promise<boolean>((resolve, reject) => {
        const w = new Worker(new URL('./helpers/claim-once-worker.ts', import.meta.url), {
          execArgv: ['--import', 'tsx'],
          workerData: { dbPath, taskId: t.id, workerId: 'w-b', leaseMs: 60_000 },
        });
        w.on('message', (m: boolean) => {
          resolve(m);
          void w.terminate();
        });
        w.on('error', reject);
      }),
    ]);

    // Exactly one of the two concurrent claimants may win.
    expect([ra, rb].filter(Boolean)).toHaveLength(1);

    const verify = openStore(dbPath);
    const final = verify.getTask(t.id)!;
    expect(final.status).toBe('running');
    expect(final.attempt).toBe(1); // claimed exactly once, not twice
    verify.close();
  }, 20_000);

  it('hands out every task exactly once under concurrent claimNext from four worker threads', async () => {
    const dbPath = join(dir, 'fanout.db');
    const seed = openStore(dbPath);
    const g = seed.createGoal({ title: 'fanout' });
    const N = 60;
    for (let i = 0; i < N; i++) {
      seed.createTask({ goalId: g.id, persona: 'coder', title: `task-${i}` });
    }
    seed.close();

    const WORKERS = 4;
    const batches = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) => runClaimNextWorker(dbPath, `w${i}`, 60_000)),
    );
    const all = batches.flat();

    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N); // no task id claimed by more than one worker

    const verify = openStore(dbPath);
    for (const id of all) {
      expect(verify.getTask(id)!.status).toBe('running');
    }
    verify.close();
  }, 20_000);
});
