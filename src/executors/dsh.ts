// P2 — DSH headless coding executor (tool `dsh_code`).
// Runs `<bin> --profile headless <prompt>` in the task workspace, in its own
// process group so abort/timeout SIGKILLs the whole group (children included).
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import { sandboxedCommand } from '../sandbox.js';
import { clampTimeoutMin, runProc, tail } from './proc.js';

const OUTPUT_CAP = 8000;

/**
 * Read-only paths DSH needs inside the sandbox besides the defaults: the
 * `~/.local/bin/dsh` wrapper execs the CLI from its checkout. (~/.dsh itself is in
 * sandbox.ts HOME_WRITABLE with its credentials file masked.)
 */
export const DSH_READONLY = [join(homedir(), 'repos', 'deepseek-harness')];

/**
 * git in the workspace for progress/status. Sandboxed too: the workspace's .git is
 * agent-writable, and config such as core.fsmonitor would otherwise run a command
 * as Alfred with the full env.
 */
function git(ws: string, args: string[]): string {
  try {
    const sc = sandboxedCommand('git', args, { workspace: ws });
    const r = spawnSync(sc.file, sc.args, { cwd: sc.cwd, env: sc.env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 20 });
    return r.status === 0 ? String(r.stdout ?? '') : '';
  } catch {
    return '';
  }
}

export function dshTool(o: { bin?: string; defaultTimeoutMin?: number } = {}): Tool {
  const bin = o.bin ?? process.env.ALFRED_DSH_BIN ?? 'dsh';
  const defaultTimeoutMin = o.defaultTimeoutMin ?? 30;

  return {
    kind: 'exec',
    schema: {
      name: 'dsh_code',
      description:
        'Run a focused coding task with DSH headless in the workspace. Best for focused changes; ' +
        'it edits files directly and runs the task\'s acceptance commands itself. Long-running.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What to implement, precisely.' },
          timeoutMin: { type: 'number', description: 'Wall-clock cap in minutes (max 120, default 30).' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      if (!task) return { ok: false, output: 'dsh_code: missing task' };
      const timeoutMs = clampTimeoutMin(args?.timeoutMin, defaultTimeoutMin, 120) * 60_000;

      const cmds = (ctx.acceptance ?? []).map((c) => c.cmd);
      const prompt =
        task +
        '\n\nAcceptance commands (these must pass; run them yourself in this workspace):\n' +
        (cmds.length ? cmds.join('\n') : '(none provided)');

      // Progress: every 20 s, only when something visibly changed.
      let lastErrLen = 0;
      let lastStatus = '';
      const onTick = (s: { stderrLen: number }) => {
        const status = git(ctx.workspace, ['status', '--porcelain']);
        if (s.stderrLen > lastErrLen || status !== lastStatus) {
          ctx.progress(`dsh: running (${s.stderrLen} chars stderr, ${status ? status.trim().split('\n').length : 0} files changed)`);
          lastErrLen = s.stderrLen;
          lastStatus = status;
        }
      };

      const res = await runProc({
        cmd: bin,
        args: ['--profile', 'headless', prompt],
        cwd: ctx.workspace,
        readonly: DSH_READONLY,
        timeoutMs,
        signal: ctx.signal,
        tickMs: 20_000,
        onTick,
      });

      if (res.cancelled) return { ok: false, output: `dsh: cancelled after abort.\nstderr tail: ${tail(res.stderr, 1500)}` };
      if (res.timedOut) return { ok: false, output: `dsh: timed out after ${Math.round(timeoutMs / 60000)} min.\nstderr tail: ${tail(res.stderr, 1500)}` };

      const exit = res.exitCode ?? -1;
      const status = git(ctx.workspace, ['status', '--short']);
      const diffstat = git(ctx.workspace, ['diff', '--stat']);

      const parts = [
        `exit=${exit}`,
        '',
        'stdout:',
        res.stdout.trim() || '(empty)',
        '',
        'stderr (last 1500 chars):',
        tail(res.stderr.trim(), 1500) || '(empty)',
      ];
      if (status) parts.push('', 'git status --short:', status.trim());
      if (diffstat) parts.push('', 'git diff --stat:', diffstat.trim());
      const output = parts.join('\n');

      return { ok: exit === 0, output: output.length > OUTPUT_CAP ? output.slice(-OUTPUT_CAP) : output };
    },
  };
}
