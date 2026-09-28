// P16 §4 — the chat tool set. Errors are results, never throws.
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { AcceptanceCheck, TaskStatus } from '../types.js';
import { createGoalWithRoot, resolveGoal } from '../ops.js';
import type { ModuleDeps } from '../modules.js';
import { gated } from '../powers/gate.js';

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

function fmtCounts(counts: Partial<Record<TaskStatus, number>>): string {
  const parts = Object.entries(counts).filter(([, n]) => n && n > 0).map(([k, n]) => `${n} ${k}`);
  return parts.join(', ');
}

function goalsTool(deps: ModuleDeps): Tool {
  return {
    kind: 'read',
    schema: {
      name: 'goals',
      description: 'Goals: op list|get. list: newest first (optional status filter). get: ref = id or slug.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'get'] },
          ref: { type: 'string', description: 'goal id or slug (get)' },
          status: { type: 'string', enum: ['active', 'done', 'failed'], description: 'filter (list)' },
        },
        required: ['op'],
      },
    },
    async run(args: any): Promise<ToolResult> {
      const { store } = deps;
      const op = String(args?.op ?? '');
      if (op === 'list') {
        let goals = store.listGoals().slice().sort((a, b) => b.createdAt - a.createdAt);
        if (args?.status) goals = goals.filter((g) => g.status === args.status);
        if (!goals.length) return { ok: true, output: 'no goals' };
        const lines = goals.slice(0, 20).map((g) => {
          const counts: Partial<Record<TaskStatus, number>> = {};
          for (const t of store.listTasks(g.id)) counts[t.status] = (counts[t.status] ?? 0) + 1;
          const c = fmtCounts(counts);
          return `${g.slug} [${g.status}] ${g.title}${c ? ` — ${c}` : ''}`;
        });
        return { ok: true, output: lines.join('\n') };
      }
      if (op === 'get') {
        const goal = resolveGoal(store, String(args?.ref ?? ''));
        if (!goal) return { ok: false, output: `no such goal: ${args?.ref ?? ''}` };
        const out = [`${goal.slug} [${goal.status}] ${goal.title}`];
        if (goal.body) out.push('', cap(goal.body, 1500));
        for (const t of store.listTasks(goal.id)) {
          const detail = t.reason || t.result || '';
          out.push(`${t.id.slice(0, 8)} [${t.status}] ${t.persona} ${t.title}${detail ? ` — ${cap(detail, 200)}` : ''}`);
        }
        return { ok: true, output: out.join('\n') };
      }
      return { ok: false, output: `unknown op: ${op}` };
    },
  };
}

function startGoalTool(deps: ModuleDeps): Tool {
  return {
    kind: 'write',
    schema: {
      name: 'start_goal',
      description: 'Start real work as a goal. persona: coder|researcher|alfred (default alfred). item = board key to link.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          spec: { type: 'string', description: 'what the root task should do' },
          persona: { type: 'string' },
          acceptance: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, cmd: { type: 'string' } }, required: ['name', 'cmd'] },
          },
          repo: { type: 'string', description: 'absolute path of the git repo' },
          node: { type: 'string', description: 'run on this node' },
          item: { type: 'string', description: 'board item key to link, e.g. ALF-3' },
        },
        required: ['title', 'spec'],
      },
    },
    async run(args: any, ctx?: ToolContext): Promise<ToolResult> {
      const { store } = deps;
      const persona = String(args?.persona ?? 'alfred');
      if (deps.personas && deps.personas.size > 0 && !deps.personas.has(persona)) {
        return { ok: false, output: `unknown persona: ${persona}` };
      }
      const start = () => startGoal(deps, args, persona);
      // Acceptance commands run as shell on the Spark (or the node); a node or an unregistered repo
      // points the work somewhere new. Those need Quinn's OK, shown verbatim.
      const acceptance = Array.isArray(args?.acceptance) ? (args.acceptance as any[]) : [];
      const repo = args?.repo ? String(args.repo) : '';
      const node = args?.node ? String(args.node) : '';
      const knownRepo = !repo || !!store.getRepo(repo) || store.listRepos().some((r) => Object.values(r.paths ?? {}).includes(repo));
      if (!acceptance.length && !node && knownRepo) return start();
      const parts = [`start_goal "${String(args?.title ?? '')}" persona=${persona}`];
      if (repo) parts.push(`repo=${repo}${knownRepo ? '' : ' (new)'}`);
      if (node) parts.push(`node=${node}`);
      for (const c of acceptance) parts.push(`acceptance ${String(c?.name ?? '')}: ${String(c?.cmd ?? '')}`);
      if (!ctx) return { ok: false, output: `needs Quinn’s OK: start_goal: ${parts.join('\n')}` };
      return gated({ deps, tool: ctx }, 'start_goal', parts.join('\n'), start);
    },
  };
}

async function startGoal(deps: ModuleDeps, args: any, persona: string): Promise<ToolResult> {
  const { store } = deps;
  let goal;
  try {
    ({ goal } = createGoalWithRoot(store, {
      title: String(args?.title ?? ''),
      body: String(args?.spec ?? ''),
      spec: String(args?.spec ?? ''),
      persona,
      acceptance: Array.isArray(args?.acceptance) ? args.acceptance as AcceptanceCheck[] : undefined,
      repo: args?.repo ? String(args.repo) : undefined,
    }));
  } catch (e: any) {
    return { ok: false, output: e?.message ?? String(e) };
  }
  if (args?.node) store.setGoalMeta(goal.id, { node: String(args.node) });
  if (args?.item) {
    const board = (deps.modules.board as any)?.board;
    if (board) {
      try {
        board.linkGoal(String(args.item), goal.id);
      } catch (e: any) {
        return { ok: false, output: `started goal ${goal.slug} (${persona}) but linking item ${args.item} failed: ${e?.message ?? e}` };
      }
    }
  }
  return { ok: true, output: `started goal ${goal.slug} (${persona})` };
}

function approvalsTool(deps: ModuleDeps): Tool {
  return {
    kind: 'read',
    schema: {
      name: 'approvals',
      description: 'Pending human approvals (list). Only Quinn decides them — in the Inbox, on Slack, or by replying "yes" in chat.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list'] },
        },
        required: ['op'],
      },
    },
    async run(args: any): Promise<ToolResult> {
      const { store } = deps;
      const op = String(args?.op ?? 'list');
      if (op === 'list') {
        const rows = store.approvals({ status: 'pending' });
        if (!rows.length) return { ok: true, output: 'no pending approvals' };
        return { ok: true, output: rows.map((a) => `${a.id} ${a.action} — ${cap(a.detail, 200)} (${a.taskId.startsWith('chat:') ? 'chat' : `task ${a.taskId.slice(0, 8)}`})`).join('\n') };
      }
      return { ok: false, output: `only Quinn can ${op} approvals: ask him to decide it in the Inbox or on Slack` };
    },
  };
}

/**
 * The chat tool set: the board module's tool (when present) + goals / start_goal / approvals,
 * + the P21 powers tools (platform, connectors, alfred_dev) and comms tools (contacts, message, call)
 * when those modules are loaded. Read per turn: powers and comms are built after chat.
 */
export function chatTools(deps: ModuleDeps): Tool[] {
  const boardTools = deps.modules.board?.tools ?? [];
  const powerTools = deps.modules.powers?.tools ?? [];
  const commsTools = deps.modules.comms?.tools ?? [];
  return [...boardTools, goalsTool(deps), startGoalTool(deps), approvalsTool(deps), ...powerTools, ...commsTools];
}
