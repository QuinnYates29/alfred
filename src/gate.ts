// P0 done-gate. The only path that may complete a task.
import { spawn } from 'node:child_process';
import type { AcceptanceCheck, CheckResult, CheckRunner } from './types.js';
import { IllegalTransitionError } from './types.js';
import type { Store } from './store.js';
import { sandboxedCommand } from './sandbox.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4000;

/**
 * Runs a check with `bash -c` in its own process group so a timeout kills the whole tree.
 * Sandboxed (src/sandbox.ts) with `o.workspace` (default: the check's cwd) as the only
 * writable dir, and always with a scrubbed env.
 */
export const defaultRunner = (check: AcceptanceCheck, o?: { workspace?: string }): Promise<CheckResult> =>
  new Promise<CheckResult>((resolve) => {
    const start = Date.now();
    const timeoutMs = check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let buf = '';
    let timedOut = false;
    let settled = false;

    const cwd = check.cwd ?? process.cwd();
    const sc = sandboxedCommand('bash', ['-c', check.cmd], { workspace: o?.workspace ?? cwd, cwd });
    const child = spawn(sc.file, sc.args, {
      cwd: sc.cwd,
      env: sc.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const append = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      // Bound memory while streaming; final truncation happens on finish.
      if (buf.length > OUTPUT_TAIL * 4) {
        buf = buf.slice(-OUTPUT_TAIL * 2);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // process already gone
        }
      }
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: check.name,
        ok: !timedOut && exitCode === 0,
        exitCode,
        output: buf.slice(-OUTPUT_TAIL),
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });

export async function verifyAndComplete(
  store: Store,
  taskId: string,
  opts?: { runner?: CheckRunner; by?: string; /** ALF-7: run these instead of task.acceptance (Auto checks). */ checks?: AcceptanceCheck[] },
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  if (task.status !== 'verifying') {
    throw new IllegalTransitionError(`task ${taskId} is not verifying (status: ${task.status})`);
  }

  const checks = opts?.checks ?? task.acceptance;
  if (checks.length === 0) {
    store.transition(taskId, 'failed', {
      reason: 'no acceptance checks: refusing to mark done',
      by: opts?.by,
    });
    return { ok: false, results: [] };
  }

  const runner = opts?.runner ?? defaultRunner;
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runner(check));
  }

  store.appendEvent(task.goalId, taskId, 'verify', { results });

  const ok = results.every((r) => r.ok);
  if (ok) {
    store._markDone(taskId, opts?.by);
  } else {
    const failing = results.filter((r) => !r.ok);
    for (const f of failing) {
      store.appendNote(taskId, `[${f.name}] ${f.output}`);
    }
    store.transition(taskId, 'running', {
      reason: `acceptance failed: ${failing.map((r) => r.name).join(', ')}`,
      by: opts?.by,
    });
  }

  return { ok, results };
}
