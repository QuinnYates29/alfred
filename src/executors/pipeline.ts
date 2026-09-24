// P2 — orchestrator pipeline executor (tool `pipeline_run`).
// Writes a task file + per-call config (base config with pipeline.verify.command
// set from the task's acceptance checks), runs `<bin> <mode> ...` in the
// workspace in its own process group, and judges the run from
// `<ws>/.pipeline-runs/*/state.json`.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import { clampTimeoutMin, runProc, tail } from './proc.js';

const OUTPUT_CAP = 8000;

const DEFAULT_BASE_CONFIG = new URL('../../config/pipeline-qwen.yaml', import.meta.url).pathname;

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

interface ChunkOutcome {
  chunk?: { id?: string };
  status?: string;
  kill_reason?: string;
}

/** Newest state.json under `<ws>/.pipeline-runs/` run dirs, by mtime, or null. */
function newestState(ws: string): { dir: string; data: any } | null {
  const root = join(ws, '.pipeline-runs');
  if (!existsSync(root)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  let best: { dir: string; mtime: number } | null = null;
  for (const name of dirs) {
    const dir = join(root, name);
    const st = join(dir, 'state.json');
    if (!existsSync(st)) continue;
    try {
      const m = statSync(st).mtimeMs;
      if (!best || m > best.mtime) best = { dir, mtime: m };
    } catch {
      /* ignore */
    }
  }
  if (!best) return null;
  try {
    return { dir: best.dir, data: JSON.parse(readFileSync(join(best.dir, 'state.json'), 'utf8')) };
  } catch {
    return null;
  }
}

/** Total size of all events.jsonl under `<ws>/.pipeline-runs/`, plus the last event kind seen. */
function eventsScan(ws: string): { size: number; lastKind: string } {
  const root = join(ws, '.pipeline-runs');
  let size = 0;
  let lastKind = '';
  if (!existsSync(root)) return { size, lastKind };
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { size, lastKind };
  }
  for (const name of dirs) {
    const f = join(root, name, 'events.jsonl');
    try {
      size += statSync(f).size;
      const lines = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const kind = JSON.parse(last)?.kind;
        if (typeof kind === 'string' && kind) lastKind = kind;
      }
    } catch {
      /* file may not exist yet / be mid-write */
    }
  }
  return { size, lastKind };
}

export function pipelineTool(
  o: { bin?: string; baseConfig?: string; baseUrl?: string } = {},
): Tool {
  const bin = expandHome(o.bin ?? process.env.ALFRED_PIPELINE_BIN ?? '~/tools/orchestrator/.venv/bin/pipeline');
  const baseConfig = o.baseConfig ?? DEFAULT_BASE_CONFIG;
  const baseUrl = o.baseUrl ?? 'http://127.0.0.1:1110';

  return {
    kind: 'exec',
    schema: {
      name: 'pipeline_run',
      description:
        'Run the multi-agent orchestrator pipeline (planner/workers/verifier/merger) on a multi-part ' +
        'feature in the workspace. Long-running (tens of minutes). mode "solo" = one agent, no chunking.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The feature spec, split-ready.' },
          mode: { type: 'string', enum: ['run', 'solo'], description: 'Pipeline mode (default run).' },
          timeoutMin: { type: 'number', description: 'Wall-clock cap in minutes (max 240, default 90).' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const task = typeof args?.task === 'string' ? args.task.trim() : '';
      if (!task) return { ok: false, output: 'pipeline_run: missing task' };
      const mode = args?.mode === 'solo' ? 'solo' : 'run';
      const timeoutMs = clampTimeoutMin(args?.timeoutMin, 90, 240) * 60_000;
      const ws = ctx.workspace;

      // Task file + per-call config under <ws>/.alfred/
      const dir = join(ws, '.alfred');
      mkdirSync(dir, { recursive: true });
      const ts = Date.now();
      const taskFile = join(dir, `pipeline-task-${ts}.md`);
      const cfgFile = join(dir, `pipeline-${ts}.yaml`);
      writeFileSync(taskFile, task + '\n');

      let cfgText: string;
      try {
        cfgText = readFileSync(baseConfig, 'utf8');
      } catch (err: any) {
        return { ok: false, output: `pipeline_run: cannot read base config ${baseConfig}: ${err?.message ?? err}` };
      }
      const cmds = (ctx.acceptance ?? []).map((c) => c.cmd).filter(Boolean);
      if (cmds.length) {
        try {
          const cfg = parseYaml(cfgText) ?? {};
          cfg.pipeline = cfg.pipeline ?? {};
          cfg.pipeline.verify = cfg.pipeline.verify ?? {};
          cfg.pipeline.verify.command = cmds.join(' && ');
          cfgText = stringifyYaml(cfg);
        } catch (err: any) {
          return { ok: false, output: `pipeline_run: bad base config: ${err?.message ?? err}` };
        }
      }
      writeFileSync(cfgFile, cfgText);

      // Progress: every 15 s if events.jsonl grew.
      let lastSize = -1;
      const onTick = () => {
        const { size, lastKind } = eventsScan(ws);
        if (size !== lastSize) {
          ctx.progress(`pipeline: ${lastKind || 'running'}`);
          lastSize = size;
        }
      };

      const res = await runProc({
        cmd: bin,
        args: [
          mode,
          '--repo', ws,
          '--task-file', taskFile,
          '--config', cfgFile,
          '--orchestrator-url', `${baseUrl}/v1`,
          '--admin-url', baseUrl,
          '--no-load',
        ],
        cwd: ws,
        timeoutMs,
        signal: ctx.signal,
        tickMs: 15_000,
        onTick,
      });

      if (res.cancelled) return { ok: false, output: `pipeline: cancelled after abort.\nstdout tail: ${tail(res.stdout, 1500)}` };
      if (res.timedOut) return { ok: false, output: `pipeline: timed out after ${Math.round(timeoutMs / 60000)} min.\nstdout tail: ${tail(res.stdout, 1500)}` };

      const exit = res.exitCode ?? -1;
      const lines: string[] = [`exit=${exit}`];

      if (mode === 'solo') {
        lines.push('', 'stdout (last 1500 chars):', tail(res.stdout.trim(), 1500) || '(empty)');
        const out = lines.join('\n');
        return { ok: exit === 0, output: out.length > OUTPUT_CAP ? out.slice(-OUTPUT_CAP) : out };
      }

      const state = newestState(ws);
      if (!state) {
        lines.push('', 'no state.json found under .pipeline-runs/', '', 'stdout (last 1500 chars):', tail(res.stdout.trim(), 1500) || '(empty)');
        const out = lines.join('\n');
        return { ok: false, output: out.length > OUTPUT_CAP ? out.slice(-OUTPUT_CAP) : out };
      }

      const outcomes: ChunkOutcome[] = Array.isArray(state.data?.outcomes) ? state.data.outcomes : [];
      let allCompleted = outcomes.length > 0;
      const chunkLines = outcomes.map((oc) => {
        const status = String(oc?.status ?? '?');
        if (status !== 'completed') allCompleted = false;
        const reason = String(oc?.kill_reason ?? '').trim();
        return `${oc?.chunk?.id ?? '?'}: ${status}${reason ? ' ' + reason : ''}`;
      });
      if (chunkLines.length) lines.push('', ...chunkLines);

      const pmv = state.data?.post_merge_verify;
      const pmvOk = !pmv || pmv.ok === true;
      if (pmv) lines.push('', `post_merge_verify: ${pmv.ok ? 'ok' : 'FAILED'}`);

      lines.push('', 'stdout (last 1500 chars):', tail(res.stdout.trim(), 1500) || '(empty)');
      const output = lines.join('\n');
      return {
        ok: exit === 0 && allCompleted && pmvOk,
        output: output.length > OUTPUT_CAP ? output.slice(-OUTPUT_CAP) : output,
      };
    },
  };
}
