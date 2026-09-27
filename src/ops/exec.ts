// P14 — exec/spawn/fetch injection helpers. Tests inject fakes through deps.extra;
// production falls back to the real node builtins.
import { execFile, spawn } from 'node:child_process';
import type { ModuleDeps } from '../modules.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  o?: { cwd?: string; timeoutMs?: number },
) => Promise<ExecResult>;

export type SpawnDetachedFn = (
  cmd: string,
  args: string[],
  o?: { cwd?: string; delayMs?: number },
) => void;

export interface OpsCtx {
  exec: ExecFn;
  spawnDetached: SpawnDetachedFn;
  fetch: typeof fetch;
  qwenUrl: string;
  qwenEnvPath: string;
  dispatchDir: string;
  backupDir: string;
  repoRoot: string;
}

const realExec: ExecFn = (cmd, args, o) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: o?.cwd, timeout: o?.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as any).code === 'number'
            ? (err as any).code
            : (err as any).killed
              ? 124
              : 1
          : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

const realSpawnDetached: SpawnDetachedFn = (cmd, args, o) => {
  setTimeout(() => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', cwd: o?.cwd });
      child.on('error', () => {});
      child.unref();
    } catch {
      /* best effort */
    }
  }, o?.delayMs ?? 0);
};

/** qwenUrl: extra.qwenUrl ?? env.QWEN_URL ?? first model's baseUrl ?? default. Read lazily. */
function defaultQwenUrl(deps: ModuleDeps): string {
  const fromModels = (() => {
    try {
      return deps.models?.list?.()?.[0]?.baseUrl as string | undefined;
    } catch {
      return undefined;
    }
  })();
  return deps.env?.QWEN_URL ?? fromModels ?? 'http://127.0.0.1:1110';
}

export function makeCtx(deps: ModuleDeps): OpsCtx {
  const home = process.env.HOME ?? '';
  const extra: Record<string, any> = deps.extra ?? {};
  const env: Record<string, string | undefined> = deps.env ?? {};
  return {
    exec: (extra.exec as ExecFn | undefined) ?? realExec,
    spawnDetached: (extra.spawnDetached as SpawnDetachedFn | undefined) ?? realSpawnDetached,
    fetch: (extra.fetch as typeof fetch | undefined) ?? globalThis.fetch,
    get qwenUrl() {
      return (extra.qwenUrl as string | undefined) ?? defaultQwenUrl(deps);
    },
    qwenEnvPath: (extra.qwenEnvPath as string | undefined) ?? env.QWEN_ENV_FILE ?? `${home}/.config/qwen-server.env`,
    dispatchDir: (extra.dispatchDir as string | undefined) ?? `${deps.repoRoot}/.dispatch`,
    backupDir: (extra.backupDir as string | undefined) ?? `${deps.repoRoot}/.alfred-backup`,
    repoRoot: deps.repoRoot,
  };
}

/** stdout+stderr, tail limited to `max` chars. */
export function tail2(text: string, max = 4000): string {
  return text.length <= max ? text : text.slice(-max);
}
