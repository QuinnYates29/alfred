// `notify` — reach Quinn on every channel alfred has (Slack channel, Mac notification, …).
// Not gated: it only ever reaches Quinn himself (external messages go through `message`).
// Rate-limited so a looping agent can't flood his phone.
import type { ModuleDeps } from '../modules.js';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 10;

export function notifyTool(deps: ModuleDeps): Tool {
  const sent: number[] = [];
  return {
    kind: 'exec',
    schema: {
      name: 'notify',
      description:
        'Send Quinn a notification on all his channels (Slack channel, Mac notification). For status pings and reminders to him; to text someone else use message.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'short headline' },
          body: { type: 'string', description: 'details (optional)' },
          level: { type: 'string', enum: ['info', 'warn'], description: 'default info' },
        },
        required: ['title'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const title = typeof args?.title === 'string' ? args.title.trim().slice(0, 200) : '';
      if (!title) return { ok: false, output: 'title is required' };
      const body = typeof args?.body === 'string' ? args.body.slice(0, 3000) : '';
      const level = args?.level === 'warn' ? 'warn' : 'info';
      const notifier = deps.notifier;
      if (!notifier) return { ok: false, output: 'notifications are not configured in this runtime' };
      const t = Date.now();
      while (sent.length && t - sent[0] > WINDOW_MS) sent.shift();
      if (sent.length >= MAX_PER_WINDOW) return { ok: false, output: `rate limit: at most ${MAX_PER_WINDOW} notifications per 10 minutes` };
      sent.push(t);
      const goalId = ctx.taskId.startsWith('chat:') ? '' : (deps.store.getTask(ctx.taskId)?.goalId ?? '');
      // the event reaches the dashboard and the Mac app (which shows it as a notification)
      try { deps.store.appendEvent('', null, 'notice', { level, title, body }); } catch { /* never block the send */ }
      const results = await notifier.notify({ level, goalId, taskId: goalId ? ctx.taskId : undefined, title, body });
      // the markdown mirror is bookkeeping, not a channel Quinn sees; the node sink "succeeds"
      // even with no Mac online, so only count it when a node is connected
      const macs = (deps.nodes?.list?.() ?? []).filter((m) => m.caps?.includes('notify'));
      const seen = results
        .filter((r) => r.sink !== 'markdown' && !(r.sink === 'node-notify' && macs.length === 0))
        .map((r) => (r.sink === 'node-notify' ? { ...r, sink: `Mac (${macs.map((m) => m.name).join(', ')})` } : r));
      const ok = seen.filter((r) => r.ok).map((r) => r.sink);
      const bad = seen.filter((r) => !r.ok).map((r) => `${r.sink} (${r.error ?? 'failed'})`);
      if (!ok.length) return { ok: false, output: `only the dashboard/Mac app got it; not delivered elsewhere${bad.length ? `: ${bad.join(', ')}` : ' (no Slack or Mac node configured)'}` };
      return { ok: true, output: `sent via ${ok.join(', ')} (and the Mac app, if it is open)${bad.length ? `; failed: ${bad.join(', ')}` : ''}` };
    },
  };
}
