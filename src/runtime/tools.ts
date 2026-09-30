// P1 — tool registry and built-in tools. Tools never throw; they return
// {ok:false, output} on any error. File paths resolve against ctx.workspace.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PersonaConfigError,
  NodeOfflineError,
  type Tool,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
  type WorkspaceBackend,
} from './contract.js';
import { guardCommand, recordAutoApproval, storeForTask, triageApproval } from '../approvals.js';
import { containedPath, writeFileNoFollow } from '../pathguard.js';
import { sandboxedCommand } from '../sandbox.js';
import { webFetchTool, webSearchTool } from './web.js';

/**
 * P9: park the task when the workspace machine went away mid-call.
 * (The scheduler's node-reconnect watcher re-queues it later.)
 */
export function parkIfNodeOffline(e: any): ToolResult | null {
  if (e instanceof NodeOfflineError) {
    return { ok: false, output: `error: ${e.message}`, park: { status: 'blocked', reason: e.message } };
  }
  return null;
}

const OUTPUT_CAP = 8000;
/** P8: read_file caps — default window and char cap (a deliberate exception to OUTPUT_CAP). */
const READ_DEFAULT_LIMIT = 400;
const READ_CHAR_CAP = 16000;

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

  /** P11 — every registered tool (for GET /api/v1/tools). */
  all(): Tool[] {
    return [...this.tools.values()];
  }

  schemasFor(names: string[]): ToolSchema[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new PersonaConfigError(`unknown tool: ${name}`);
      return tool.schema;
    });
  }
}

/**
 * Resolve p inside the workspace; null when it escapes. For a workspace on this
 * machine the check is on the REAL path (symlinks are followed, then must stay
 * inside realpath(workspace); a dangling link or, for writes, a symlink as the
 * final component is refused). A node workspace only gets the lexical check here —
 * the node enforces its own roots with the same symlink-safe guard.
 */
function inside(ctx: ToolContext, p: unknown, write = false): string | null {
  if (typeof p !== 'string') return null;
  const ws = path.resolve(ctx.workspace);
  const abs = path.resolve(ws, p);
  if (!(abs === ws || abs.startsWith(ws + path.sep))) return null;
  if (ctx.backend && ctx.backend.node !== 'local') return abs;
  return containedPath([ws], abs, { write });
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
      return parkIfNodeOffline(e) ?? { ok: false, output: `error: ${e?.message ?? String(e)}` };
    }
  };
}

/** P9: read a workspace file through the backend when the workspace lives on a node. */
async function readText(abs: string, ctx: ToolContext): Promise<string> {
  if (ctx.backend) return await ctx.backend.readFile(abs);
  return readFileSync(abs, 'utf8');
}

function runShell(args: any, ctx: ToolContext): Promise<ToolResult> {
  const cmd = String(args?.cmd ?? '');
  const requested = Number(args?.timeoutSec);
  const timeoutSec = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 600) : 120;
  if (ctx.backend) {
    return ctx.backend
      .exec(cmd, { cwd: ctx.workspace, workspace: ctx.workspace, timeoutMs: timeoutSec * 1000, signal: ctx.signal })
      .then((r) => {
        const suffix = r.timedOut ? `exit=-1 timed out after ${timeoutSec}s` : `exit=${r.exitCode}`;
        return { ok: !r.timedOut && r.exitCode === 0, output: tailWithSuffix(r.output ?? '', suffix) };
      });
  }
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const sc = sandboxedCommand('bash', ['-c', cmd], { workspace: ctx.workspace });
      child = spawn(sc.file, sc.args, { cwd: sc.cwd, env: sc.env, detached: true });
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
      schema: schema(
        'read_file',
        'Read a window of a UTF-8 text file inside the workspace (paged: offset/limit, default 400 lines).',
        {
          path: { type: 'string', description: 'File path, relative to the workspace.' },
          offset: { type: 'number', description: 'First line to read (1-based). Default 1.' },
          limit: { type: 'number', description: 'Max lines to read (default 400).' },
        },
        ['path'],
      ),
      kind: 'read',
      run: safe(async (args, ctx) => {
        const abs = inside(ctx, args.path);
        if (!abs) return outside(args.path);
        const text = await readText(abs, ctx);
        const lines = text.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // trailing newline, not an empty line
        const total = lines.length;
        const rawOff = Number(args.offset);
        const start = Number.isFinite(rawOff) && rawOff >= 1 ? Math.floor(rawOff) : 1;
        const rawLim = Number(args.limit);
        const limit = Number.isFinite(rawLim) && rawLim >= 1 ? Math.floor(rawLim) : READ_DEFAULT_LIMIT;
        const from = Math.min(start, total + 1);
        const to = Math.min(from + limit - 1, total); // inclusive; < from when past EOF
        const shown = to >= from ? lines.slice(from - 1, to).join('\n') : '';
        const more = to < total;
        let header = `[${String(args.path)} lines ${total === 0 ? 0 : from}-${to} of ${total}]`;
        if (more) header += ` (more: offset=${to})`;
        const budget = Math.max(0, READ_CHAR_CAP - header.length - 1);
        let body = shown;
        if (shown.length > budget) {
          // Char cap bites: cut at the last whole line so no partial line misleads.
          body = shown.slice(0, budget);
          const nl = body.lastIndexOf('\n');
          if (nl > 0) body = body.slice(0, nl);
          const lastLine = from + body.split('\n').length - 1;
          header = `[${String(args.path)} lines ${from}-${lastLine} of ${total}] (more: offset=${lastLine})`;
        }
        return { ok: true, output: `${header}\n${body}` };
      }),
    },
    {
      schema: schema('write_file', 'Write a UTF-8 text file inside the workspace, creating parent dirs.', {
        path: { type: 'string', description: 'File path, relative to the workspace.' },
        content: { type: 'string', description: 'Full file content.' },
      }, ['path', 'content']),
      kind: 'write',
      run: safe(async (args, ctx) => {
        const abs = inside(ctx, args.path, true);
        if (!abs) return outside(args.path);
        const content = String(args.content ?? '');
        if (ctx.backend) await ctx.backend.writeFile(abs, content);
        else writeFileNoFollow(abs, content);
        return { ok: true, output: `wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${args.path}` };
      }),
    },
    {
      schema: schema('list_dir', 'List entries of a directory inside the workspace (default: workspace root).', {
        path: { type: 'string', description: 'Directory path, relative to the workspace.' },
      }),
      kind: 'read',
      run: safe(async (args, ctx) => {
        const abs = inside(ctx, args.path ?? '.');
        if (!abs) return outside(args.path);
        let entries: string[];
        if (ctx.backend) {
          entries = (await ctx.backend.listDir(abs)).map((e) => `${e.name}${e.dir ? '/' : ''}`);
        } else {
          entries = readdirSync(abs, { withFileTypes: true }).map((e) => {
            let dir = e.isDirectory();
            try {
              dir = statSync(path.join(abs, e.name)).isDirectory();
            } catch {
              /* dangling symlink */
            }
            return `${e.name}${dir ? '/' : ''}`;
          });
        }
        entries.sort();
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
                // The guard flagged it; Jev may clear it (safe AND what was asked), else Quinn decides.
                const t = await triageApproval({ taskId: ctx.taskId, action: guard, detail: cmd });
                if (t?.approve) {
                  recordAutoApproval(store, ctx.taskId, guard, cmd, t.line);
                  return await runShell({ ...args, cmd }, ctx);
                }
                store.requestApproval(ctx.taskId, guard, cmd, t?.line);
                const reason = `approval needed: ${guard}: ${cmd}`;
                return { ok: false, output: reason, park: { status: 'blocked', reason } };
              }
            }
          }
          return await runShell({ ...args, cmd }, ctx);
        } catch (e: any) {
          return parkIfNodeOffline(e) ?? { ok: false, output: `error: ${e?.message ?? String(e)}` };
        }
      },
    },
    {
      schema: schema('note', 'Record a short note for later turns and retries.', {
        text: { type: 'string', description: 'The note text.' },
      }, ['text']),
      kind: 'write',
      run: safe((args, ctx) => {
        const text = String(args.text ?? '').trim();
        if (!text) return { ok: false, output: 'text is required' };
        ctx.progress(text.slice(0, 500));
        // Persist it: task notes survive compaction and seed every retry ("Notes from previous attempts").
        storeForTask(ctx.taskId)?.appendNote(ctx.taskId, `NOTE: ${text.slice(0, 4000)}`);
        return { ok: true, output: 'noted (saved to the task notes)' };
      }),
    },
    {
      schema: schema(
        'output',
        'Publish a deliverable to the goal page (Quinn reads it there). Use for reports, summaries, tables, drafts. Same name = update.',
        {
          name: { type: 'string', description: 'Output name (shown as a tab), no "/". Same name updates the same output.' },
          content: { type: 'string', description: 'The deliverable content.' },
          kind: {
            type: 'string',
            enum: ['markdown', 'text', 'json', 'csv', 'html-code'],
            description: 'Content kind (default markdown).',
          },
        },
        ['name', 'content'],
      ),
      kind: 'write',
      run: safe((args, ctx) => {
        const store = storeForTask(ctx.taskId);
        const task = store?.getTask(ctx.taskId);
        if (!store || !task) return { ok: false, output: 'output is for goal tasks; in chat, answer directly' };
        const row = store.putOutput({
          goalId: task.goalId,
          taskId: ctx.taskId,
          name: String(args.name ?? ''),
          kind: args.kind == null ? undefined : String(args.kind),
          content: String(args.content ?? ''),
        });
        return { ok: true, output: `published "${row.name}" (${String(args.content ?? '').length} chars) — visible on the goal page` };
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
    webSearchTool(),
    webFetchTool(),
  ];
}
