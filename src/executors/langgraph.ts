// P2 §3 — `langgraph_code`: runs the constrained LangGraph coder sidecar.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModelRegistry } from '../models.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface SidecarResult {
  ok: boolean;
  iterations: number;
  testOutput: string;
  filesChanged: string[];
}

export function langgraphTool(o?: {
  python?: string; /* <repo>/sidecar/.venv/bin/python */
  baseUrl?: string;
  model?: string;
  /** P7: when present, the 'coder' role's endpoint is resolved per call. */
  models?: ModelRegistry;
  defaultTimeoutMin?: number; /* 45 */
}): Tool {
  const python = o?.python ?? join(REPO_ROOT, 'sidecar', '.venv', 'bin', 'python');
  const defaultTimeoutMin = o?.defaultTimeoutMin ?? 45;

  return {
    kind: 'exec',
    schema: {
      name: 'langgraph_code',
      description:
        'Constrained coding agent (LangGraph sidecar): edits files in the workspace with ' +
        'read_file/write_file/list_dir only (no shell), then runs this task\'s acceptance ' +
        'checks; retries with the failure output until they pass or maxIterations is reached.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to implement/fix in the workspace.' },
          maxIterations: { type: 'integer', description: 'Max test runs (default 6).' },
        },
        required: ['task'],
      },
    },
    run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const task = String(args?.task ?? '');
      const maxIterations = Math.max(1, Math.floor(Number(args?.maxIterations ?? 6)) || 6);
      const cmds = (ctx.acceptance ?? []).map(c => c.cmd).filter(Boolean);
      if (cmds.length === 0) return Promise.resolve({ ok: false, output: 'no acceptance checks to test against' });
      const testCmd = cmds.join(' && ');
      const timeoutMs = defaultTimeoutMin * 60_000;
      const spec = o?.models?.resolve('coder');
      const baseUrl = spec?.baseUrl ?? o?.baseUrl ?? 'http://127.0.0.1:1110';
      const model = spec?.model ?? o?.model ?? 'qwen3.8-flash-next';

      return new Promise<ToolResult>(resolve => {
        const child = spawn(
          python,
          ['-m', 'langgraph_coder'],
          {
            cwd: ctx.workspace,
            env: { ...process.env, PYTHONPATH: join(REPO_ROOT, 'sidecar') },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true, // own process group; kill the group on abort/timeout
          },
        );
        child.stdin.end(JSON.stringify({
          task, workspace: ctx.workspace, testCmd, maxIterations, baseUrl, model,
        }));

        let stdout = '';
        let stderrTail = '';
        let settled = false;
        const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          kill();
          resolve({ ok: false, output: `langgraph_code timed out after ${defaultTimeoutMin} min\n${stderrTail}` });
        }, timeoutMs);
        const onAbort = () => {
          if (settled) return;
          settled = true;
          kill();
          clearTimeout(timer);
          resolve({ ok: false, output: 'cancelled' });
        };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        let errBuf = '';
        child.stderr.on('data', (d: Buffer) => {
          errBuf += d.toString();
          let nl: number;
          while ((nl = errBuf.indexOf('\n')) >= 0) {
            const line = errBuf.slice(0, nl).trim();
            errBuf = errBuf.slice(nl + 1);
            if (!line) continue;
            stderrTail = (stderrTail + line + '\n').slice(-8000);
            try {
              const p = JSON.parse(line);
              if (typeof p?.progress === 'string') ctx.progress('langgraph: ' + p.progress);
            } catch { /* non-JSON stderr is allowed and ignored */ }
          }
        });

        child.on('error', e => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolve({ ok: false, output: `failed to start sidecar (${python}): ${e.message}` });
        });

        child.on('close', code => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          const tail = (stderrTail + (errBuf || '')).slice(-2000);
          const lastLine = stdout.trimEnd().split('\n').filter(Boolean).pop() ?? '';
          let r: SidecarResult | null = null;
          try {
            const p = JSON.parse(lastLine);
            if (p && typeof p === 'object' && typeof p.ok === 'boolean') {
              r = {
                ok: p.ok,
                iterations: Number(p.iterations) || 0,
                testOutput: String(p.testOutput ?? ''),
                filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged.map(String) : [],
              };
            }
          } catch { /* fall through */ }
          if (!r) {
            resolve({ ok: false, output: `sidecar produced no final JSON (exit=${code})\n${tail}` });
            return;
          }
          const output = [
            `ok=${r.ok} iterations=${r.iterations}`,
            `filesChanged: ${r.filesChanged.length ? r.filesChanged.join(', ') : '(none)'}`,
            `testOutput:\n${r.testOutput}`.slice(0, 5000),
          ].join('\n').slice(0, 8000);
          resolve({ ok: r.ok, output });
        });
      });
    },
  };
}
