// P13 §7 — the single `board` agent tool. Lean schema; errors never throw.
import type { Tool, ToolContext } from '../runtime/contract.js';
import { openBoard, type Board } from './board.js';
import { storeForTask } from '../approvals.js';

export type BoardResolver = (ctx: ToolContext) => Board | undefined;

const defaultResolve: BoardResolver = (ctx) => {
  const store = storeForTask(ctx.taskId);
  return store ? openBoard(store) : undefined;
};

const line = (i: { key: string; status: string; priority: string; title: string; assignee: string | null; due: string | null }): string =>
  `${i.key} [${i.status}]${i.priority !== 'none' ? ` (${i.priority})` : ''} ${i.title}${i.assignee ? ` @${i.assignee}` : ''}${i.due ? ` due:${i.due}` : ''}`;

export function boardTool(resolve: BoardResolver = defaultResolve): Tool {
  return {
    kind: 'write',
    schema: {
      name: 'board',
      description: "Quinn's shared work board. op: list|get|create|update|comment|done|check.",
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'get', 'create', 'update', 'comment', 'done', 'check'] },
          key: { type: 'string', description: 'item key, e.g. ALF-3' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', description: 'column id, name or kind' },
          priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'] },
          labels: { type: 'array', items: { type: 'string' } },
          assignee: { type: 'string' },
          due: { type: 'string', description: 'YYYY-MM-DD' },
          text: { type: 'string', description: 'comment body; or checklist entry for check' },
          q: { type: 'string', description: 'search (list)' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext) {
      try {
        const board = resolve(ctx);
        if (!board) return { ok: false, output: 'board unavailable: no store for this task' };
        const by = `agent:${ctx.persona}`;
        const op = String(args?.op ?? '');
        const key = String(args?.key ?? '');
        if (op === 'list') {
          const items = board.listItems({
            status: args.status, assignee: args.assignee,
            label: Array.isArray(args.labels) ? args.labels[0] : undefined,
            q: args.q, limit: 40,
          });
          return { ok: true, output: items.length ? items.map(line).join('\n') : 'no items' };
        }
        if (op === 'create') {
          const it = board.createItem(
            { title: args.title, description: args.description, status: args.status, priority: args.priority, labels: args.labels, assignee: args.assignee, due: args.due },
            by,
          );
          return { ok: true, output: `created ${it.key}` };
        }
        if (op === 'get') {
          const it = board.getItem(key);
          if (!it) return { ok: false, output: `no such item: ${key}` };
          const out = [line(it)];
          if (it.description) out.push('', it.description.slice(0, 3000));
          for (const c of it.checklist) out.push(`- [${c.done ? 'x' : ' '}] ${c.text}`);
          const cs = board.comments(it.key).slice(-5);
          if (cs.length) out.push('', ...cs.map((c) => `${c.author}: ${c.body}`));
          return { ok: true, output: out.join('\n') };
        }
        if (op === 'update') {
          const patch: Record<string, any> = {};
          for (const f of ['title', 'description', 'status', 'priority', 'labels', 'assignee', 'due'] as const) {
            if (args[f] !== undefined) patch[f] = args[f];
          }
          const it = board.updateItem(key, patch, by);
          return { ok: true, output: `updated ${it.key}` };
        }
        if (op === 'comment') {
          board.comment(key, by, String(args.text ?? ''));
          return { ok: true, output: `commented on ${board.getItem(key)!.key}` };
        }
        if (op === 'done') {
          const it = board.moveItem(key, { status: 'done' }, by);
          return { ok: true, output: `${it.key} done` };
        }
        if (op === 'check') {
          const it = board.toggleCheck(key, String(args.text ?? ''), undefined, by);
          return { ok: true, output: `checked ${it.key}` };
        }
        return { ok: false, output: `unknown op: ${op}` };
      } catch (e: any) {
        return { ok: false, output: e?.message ?? String(e) };
      }
    },
  };
}
