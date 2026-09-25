// P1 — tool registry and built-in tools. Tools never throw; they return
// {ok:false, output} on any error. File paths resolve against ctx.workspace.
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PersonaConfigError,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from './contract.js';
import { guardCommand, storeForTask } from '../approvals.js';

const OUTPUT_CAP = 8000;

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const name = tool.schema.name;
    if (this.tools.has(name)) throw new Error(`duplicate tool: ${name}`);
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemasFor(names: string[]): ToolSchema[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new PersonaConfigError(`unknown tool: ${name}`);
      return tool.schema;
    });
  }
}

/** Resolve p inside workspace; null when it escapes the workspace. */
function inside(workspace: string, p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, p);
  return abs === ws || abs.startsWith(ws + path.sep) ? abs : null;
}

function outside(p: unknown): ToolResult {
  return { ok: false, output: `path outside workspace: ${String(p)}` };
}

/** Keep the tail of text and append `suffix`; total length ≤ OUTPUT_CAP. */
function tailWithSuffix(text: string, suffix: string): string {
  const sep = text.endsWith('\n') || text === '' ? '' : '\n';
  const room = Math.max(0, OUTPUT_CAP - suffix.length - sep.length);
  return text.slice(Math.max(0, text.length - room)) + sep + suffix;
}

function truncate(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  const marker = '\n[truncated]';
  return text.slice(0, OUTPUT_CAP - marker.length) + marker;
}

function schema(name: string, description: string, props: Record<string, unknown>, required: string[] = []): ToolSchema {
  return { name, description, parameters: { type: 'object', properties: props, required } };
}

function safe(fn: (args: any, ctx: ToolContext) => ToolResult | Promise<ToolResult>) {
  return async (args: any, ctx: ToolContext): Promise<ToolResult> => {
    try {
      return await fn(args ?? {}, ctx);
    } catch (e: any) {
      return { ok: false, output: `error: ${e?.message ?? String(e)}` };
    }
  };
}

function runShell(args: any, ctx: ToolContext): Promise<ToolResult> {
  const cmd = String(args?.cmd ?? '');
  const requested = Number(args?.timeoutSec);
  const timeoutSec = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 600) : 120;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['-c', cmd], { cwd: ctx.workspace, detached: true });
    } catch (e: any) {
      resolve({ ok: false, output: tailWithSuffix('', `exit=-1 spawn failed: ${e?.message ?? e}`) });
      return;
    }
    let out = '';
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > OUTPUT_CAP * 2) out = out.slice(-OUTPUT_CAP); // bound memory
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutSec * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: tailWithSuffix(out, `exit=-1 spawn error: ${e.message}`) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const suffix = timedOut ? `exit=-1 timed out after ${timeoutSec}s` : `exit=${code}`;
      resolve({ ok: !timedOut && code === 0, output: tailWithSuffix(out, suffix) });
    });
  });
}

function control(name: string, description: string, props: Record<string, unknown>, required: string[] = []): Tool {
  return {
    schema: schema(name, description, props, required),
    kind: 'control',
    async run() {
      return { ok: true, output: '' };
    },
  };
}

/** `approvals: false` disables the P3 guard (used by tests that exercise the raw shell). */
export function builtinTools(o?: { approvals?: boolean }): Tool[] {
  const opts = o ?? {};
  return [
    {
      schema: schema('read_file', 'Read a UTF-8 text file inside the workspace.', {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
      }, ['path']),
      kind: 'read',
      run: safe((args, ctx) => {
        const abs = inside(ctx.workspace, args.path);
        if (!abs) return outside(args.path);
        return { ok: true, output: truncate(readFileSync(abs, 'utf8')) };
      }),
    },
    {
      schema: schema('write_file', 'Write a UTF-8 text file inside the workspace, creating parent dirs.', {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'Full file content.' },
      }, ['path', 'content']),
      kind: 'write',
      run: safe((args, ctx) => {
        const abs = inside(ctx.workspace, args.path);
        if (!abs) return outside(args.path);
        mkdirSync(path.dirname(abs), { recursive: true });
        const content = String(args.content ?? '');
        writeFileSync(abs, content, 'utf8');
        return { ok: true, output: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${args.path}` };
      }),
    },
    {
      schema: schema('list_dir', 'List entries of a directory inside the workspace (default: workspace root).', {
        path: { type: 'string', description: 'Directory path, relative to the workspace.' },
      }),
      kind: 'read',
      run: safe((args, ctx) => {
        const abs = inside(ctx.workspace, args.path ?? '.');
        if (!abs) return outside(args.path);
        const entries = readdirSync(abs, { withFileTypes: true })
          .map((e) => `${e.name}${statSync(path.join(abs, e.name)).isDirectory() ? '/' : ''}`)
          .sort();
        return { ok: true, output: truncate(entries.join('\n')) };
      }),
    },
    {
      schema: schema('run_shell', 'Run a bash command in the workspace; returns output tail and exit code.', {
        cmd: { type: 'string', description: 'Command for bash -c.' },
        timeoutSec: { type: 'number', description: 'Timeout in seconds (default 120, max 600).' },
      }, ['cmd']),
      kind: 'exec',
      run: async (args, ctx) => {
        try {
          const cmd = String(args?.cmd ?? '');
          if (opts.approvals !== false) {
            const guard = guardCommand(cmd);
            if (guard) {
              const store = storeForTask(ctx.taskId);
              if (!store) {
                return {
                  ok: false,
                  output: `blocked by guard '${guard}': no store bound to this task — ask Claude`,
                };
              }
              // One approved command buys exactly one run.
              if (!store.consumeApproval(ctx.taskId, cmd)) {
                store.requestApproval(ctx.taskId, guard, cmd);
                const reason = `approval needed: ${guard}: ${cmd}`;
                return { ok: false, output: reason, park: { status: 'blocked', reason } };
              }
            }
          }
          return await runShell({ ...args, cmd }, ctx);
        } catch (e: any) {
          return { ok: false, output: `error: ${e?.message ?? String(e)}` };
        }
      },
    },
    {
      schema: schema('note', 'Record a short note for later turns and retries.', {
        text: { type: 'string', description: 'The note text.' },
      }, ['text']),
      kind: 'write',
      run: safe((args, ctx) => {
        ctx.progress(String(args.text ?? ''));
        return { ok: true, output: 'noted' };
      }),
    },
    control('finish', 'Declare the task complete; acceptance checks decide.', {
      summary: { type: 'string', description: 'What was accomplished.' },
    }, ['summary']),
    control('give_up', 'Abandon the task with a concrete reason.', {
      reason: { type: 'string', description: 'Why the task cannot be completed.' },
    }, ['reason']),
    control('ask_claude', 'Pause and ask Claude for help on something hard.', {
      reason: { type: 'string', description: 'Why you are stuck.' },
      question: { type: 'string', description: 'The question to answer.' },
    }, ['reason', 'question']),
    control('spawn_subagent', 'Spawn a child task run by another persona.', {
      persona: { type: 'string', description: 'Child persona name.' },
      title: { type: 'string', description: 'Short child task title.' },
      spec: { type: 'string', description: 'What the child must do.' },
      acceptance: {
        type: 'array',
        description: 'Checks: [{name, cmd}].',
        items: { type: 'object', properties: { name: { type: 'string' }, cmd: { type: 'string' } } },
      },
      budget: { type: 'object', description: 'Optional budget overrides.' },
      model: { type: 'string', description: 'Optional model name or role for the child (default: the child persona\'s model).' },
    }, ['persona', 'title', 'spec']),
    control('wait_subtasks', 'Wait until all spawned child tasks are terminal or parked.', {}),
  ];
}
