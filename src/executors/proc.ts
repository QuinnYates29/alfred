// P2 — shared process helper for the coding executors.
// Spawns a command in its own process group (detached) so that on timeout or
// abort we can SIGKILL the whole group, taking background children with it.
import { spawn } from 'node:child_process';

export interface RunProcOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Wall-clock cap in ms. 0/undefined = no timeout. */
  timeoutMs?: number;
  /** Abort signal; on abort we kill the process group. */
  signal?: AbortSignal;
  /** Poll interval in ms for onTick (progress). Default 15000. */
  tickMs?: number;
  /** Called every tickMs while the process is alive (for progress reporting). */
  onTick?: (stream: { stdoutLen: number; stderrLen: number }) => void;
}

export interface RunProcResult {
  /** Exit code, or null when killed by us / spawn failed. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Non-empty when the process could not be spawned at all. */
  spawnError?: string;
}

/** Per-stream capture cap so a chatty process can't blow memory; tails are kept. */
const STREAM_CAP = 1_000_000;

export function runProc(o: RunProcOptions): Promise<RunProcResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(o.cmd, o.args, {
        cwd: o.cwd,
        env: { ...process.env, ...(o.env ?? {}) },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        spawnError: String(err?.message ?? err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let tick: NodeJS.Timeout | null = null;

    const killGroup = () => {
      if (child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (tick) clearInterval(tick);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    };

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, spawnError });
    };

    const onAbort = () => {
      cancelled = true;
      killGroup();
    };

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > STREAM_CAP) stdout = stdout.slice(-STREAM_CAP);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > STREAM_CAP) stderr = stderr.slice(-STREAM_CAP);
    });

    child.on('error', (err: any) => {
      // Spawn-level failure (e.g. ENOENT): fires instead of 'close'.
      if (!settled) {
        stderr += (stderr ? '\n' : '') + String(err?.message ?? err);
      }
      finish(null, String(err?.message ?? err));
    });

    child.on('close', (code) => finish(code));

    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (o.timeoutMs && o.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, o.timeoutMs);
    }

    if (o.onTick) {
      tick = setInterval(() => {
        if (!settled) o.onTick?.({ stdoutLen: stdout.length, stderrLen: stderr.length });
      }, o.tickMs ?? 15_000);
    }
  });
}

/** Tail of s capped at n chars. */
export function tail(s: string, n: number): string {
  return s.length > n ? s.slice(-n) : s;
}

/** Clamp a requested timeout (minutes) into [0.001, max], falling back to dflt. */
export function clampTimeoutMin(v: unknown, dflt: number, max: number): number {
  const x = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
  return Math.min(x, max);
}
