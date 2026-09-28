// P3 §4 — the Claude door: an MCP server over stdio that lets Claude pick up
// parked tasks, work them, and pass them back through the done-gate.
// Run: ALFRED_DB=<path> [ALFRED_WORK_ROOT=<dir>] npx tsx src/door/server.ts
//
// stdout is the MCP channel: never write anything else there — logs go to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openStore, type Store } from '../store.js';
import { workspaceFor } from '../workspace.js';
import { defaultRunner, verifyAndComplete } from '../gate.js';
import { createGoalWithRoot, goalSummary, resolveGoal, retryTask } from '../ops.js';
import { PARKED, TERMINAL, type AcceptanceCheck, type Task } from '../types.js';

const LEASE_MS = 4 * 60 * 60 * 1000; // claude holds a task for 4 h per claim

const json = (v: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
});
const fail = (msg: string) => ({
  content: [{ type: 'text' as const, text: msg }],
  isError: true,
});

/** Wrap a handler so a throw becomes an MCP error result — the server never dies. */
const guard =
  <A>(fn: (args: A) => unknown | Promise<unknown>) =>
  async (args: A) => {
    try {
      const r = await fn(args);
      return r as ReturnType<typeof json>;
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

const checkSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

export function buildDoor(store: Store, workRoot?: string): McpServer {
  const server = new McpServer({ name: 'alfred', version: '1.0.0' });

  const wsFor = (task: Task) => workspaceFor(store, task, { root: workRoot });
  const mustTask = (taskId: string): Task => {
    const t = store.getTask(taskId);
    if (!t) throw new Error(`no such task: ${taskId}`);
    return t;
  };
  const recentEvents = (goalId: string) => store.events(goalId).slice(-30);

  server.registerTool(
    'alfred_status',
    { title: 'alfred_status', description: 'Goals with task counts, parked tasks, pending approvals.', inputSchema: {} },
    guard(() => {
      const goals = store.listGoals().map((g) => {
        const { counts } = goalSummary(store, g.id) ?? { counts: {} };
        return { id: g.id, slug: g.slug, title: g.title, status: g.status, counts };
      });
      const parked = store
        .listGoals()
        .flatMap((g) => store.listTasks(g.id))
        .filter((t) => (PARKED as readonly string[]).includes(t.status))
        .map((t) => ({ taskId: t.id, title: t.title, status: t.status, reason: t.reason }));
      return json({ goals, parked, approvals: store.approvals({ status: 'pending' }) });
    }),
  );

  server.registerTool(
    'alfred_goal',
    {
      title: 'alfred_goal',
      description: 'One goal by id or slug: goal, its tasks, last 30 events.',
      inputSchema: { goal: z.string().describe('goal id or slug') },
    },
    guard(({ goal }) => {
      const g = resolveGoal(store, goal);
      if (!g) throw new Error(`no such goal: ${goal}`);
      return json({ goal: g, tasks: store.listTasks(g.id), events: recentEvents(g.id) });
    }),
  );

  server.registerTool(
    'alfred_claim',
    {
      title: 'alfred_claim',
      description: 'Take a parked (needs_claude/blocked) or queued task as worker "claude", 4h lease. Returns task, workspace, acceptance, notes, events.',
      inputSchema: { taskId: z.string() },
    },
    guard(({ taskId }) => {
      const t = mustTask(taskId);
      if ((TERMINAL as readonly string[]).includes(t.status)) {
        throw new Error(
          `task ${taskId} is ${t.status} (terminal); call alfred_retry first to get a fresh queued task`,
        );
      }
      if (t.status === 'running') throw new Error(`task ${taskId} is already running (lease: ${t.leaseOwner})`);
      if (t.status !== 'queued') store.transition(taskId, 'queued', { by: 'claude' });
      if (!store.claim(taskId, 'claude', LEASE_MS)) throw new Error(`claim failed for ${taskId} (raced?)`);
      const task = mustTask(taskId);
      const workspace = wsFor(task);
      return json({ task, workspace, acceptance: task.acceptance, notes: task.notes, events: recentEvents(task.goalId) });
    }),
  );

  server.registerTool(
    'alfred_note',
    {
      title: 'alfred_note',
      description: 'Append a note to a task (survives retry and handback).',
      inputSchema: { taskId: z.string(), text: z.string() },
    },
    guard(({ taskId, text }) => {
      mustTask(taskId);
      store.appendNote(taskId, text);
      return json({ ok: true, taskId });
    }),
  );

  server.registerTool(
    'alfred_complete',
    {
      title: 'alfred_complete',
      description: 'Finish a task you hold: runs the acceptance gate. {ok, results}; on failure the task stays yours (running).',
      inputSchema: { taskId: z.string(), summary: z.string() },
    },
    guard(async ({ taskId, summary }) => {
      const t = mustTask(taskId);
      if (t.status !== 'running') throw new Error(`task ${taskId} is ${t.status}; claim it first`);
      if (summary?.trim()) store.appendNote(taskId, `claude: ${summary.trim()}`);
      store.transition(taskId, 'verifying', { by: 'claude' });
      const workspace = wsFor(t);
      const { ok, results } = await verifyAndComplete(store, taskId, {
        by: 'claude',
        runner: (check: AcceptanceCheck) => defaultRunner({ ...check, cwd: check.cwd ?? workspace }, { workspace }),
      });
      return json({ ok, results });
    }),
  );

  server.registerTool(
    'alfred_release',
    {
      title: 'alfred_release',
      description: 'Hand a running task back to the Qwen agents (→ queued) with a note.',
      inputSchema: { taskId: z.string(), note: z.string() },
    },
    guard(({ taskId, note }) => {
      const t = mustTask(taskId);
      if (t.status !== 'running') throw new Error(`task ${taskId} is ${t.status}; only running tasks can be released`);
      if (note?.trim()) store.appendNote(taskId, note.trim());
      store.transition(taskId, 'queued', { reason: note?.trim() || 'released by claude', by: 'claude' });
      return json({ ok: true, taskId, status: 'queued' });
    }),
  );

  server.registerTool(
    'alfred_fail',
    {
      title: 'alfred_fail',
      description: 'Fail a task with a reason.',
      inputSchema: { taskId: z.string(), reason: z.string() },
    },
    guard(({ taskId, reason }) => {
      mustTask(taskId);
      const t = store.transition(taskId, 'failed', { reason, by: 'claude' });
      return json({ ok: true, taskId: t.id, status: t.status });
    }),
  );

  server.registerTool(
    'alfred_retry',
    {
      title: 'alfred_retry',
      description: 'Clone a terminal (done/failed/stopped) task into a fresh queued one, notes and all.',
      inputSchema: { taskId: z.string(), note: z.string().optional() },
    },
    guard(({ taskId, note }) => {
      const clone = retryTask(store, taskId, note);
      return json({ ok: true, taskId: clone.id, from: taskId });
    }),
  );

  server.registerTool(
    'alfred_create_goal',
    {
      title: 'alfred_create_goal',
      description: 'Create a goal with one root task.',
      inputSchema: {
        title: z.string(),
        body: z.string().optional(),
        persona: z.string().optional(),
        spec: z.string().optional(),
        acceptance: z.array(checkSchema).optional(),
        repo: z.string().optional(),
      },
    },
    guard(({ title, body, persona, spec, acceptance, repo }) => {
      const { goal, task } = createGoalWithRoot(store, { title, body, persona, spec, acceptance, repo });
      return json({ ok: true, goal, taskId: task.id });
    }),
  );

  server.registerTool(
    'alfred_approve',
    {
      title: 'alfred_approve',
      description: 'Decide a pending approval (a blocked task goes back to queued).',
      inputSchema: { approvalId: z.string(), decision: z.enum(['approved', 'denied']) },
    },
    guard(({ approvalId, decision }) => {
      const a = store.decideApproval(approvalId, decision, 'claude');
      return json({ ok: true, approval: a });
    }),
  );

  return server;
}

// ---- entry point (only when run directly, not when imported by tests) ----
const entry = process.argv[1] ?? '';
if (entry.endsWith('server.ts') || entry.endsWith('server.js')) {
  const dbPath = process.env.ALFRED_DB;
  if (!dbPath) {
    process.stderr.write('alfred-door: ALFRED_DB (path to the sqlite db) is required\n');
    process.exit(1);
  }
  const store = openStore(dbPath);
  const server = buildDoor(store, process.env.ALFRED_WORK_ROOT);
  server
    .connect(new StdioServerTransport())
    .then(() => process.stderr.write(`alfred-door connected (db: ${dbPath})\n`))
    .catch((e) => {
      process.stderr.write(`alfred-door failed to start: ${e instanceof Error ? e.stack : e}\n`);
      process.exit(1);
    });
}
