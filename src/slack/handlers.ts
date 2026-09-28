// P20 — Slack event handlers: block_actions buttons, /alfred slash commands,
// events_api (DMs and app_mention). Handlers never throw; failures land in ctx.setError.
import type { Store } from '../store.js';
import { PARKED } from '../types.js';
import type { SlackApi } from './slackApi.js';
import type { ChatLike } from './threadMap.js';

export interface HandlerCtx {
  store: Store;
  getBoard(): { createItem(i: { title: string }, by: string): { key: string; title: string } } | undefined;
  getChat(): ChatLike | undefined;
  threads: { resolve(key: string): string };
  slackApi: SlackApi | undefined;
  postUrl(url: string, body: any): Promise<void>;
  enqueue(fn: () => Promise<void>): void;
  setError(msg: string): void;
}

type Payload = Record<string, any>;

function userName(payload: Payload): string {
  return payload.user?.username ?? payload.user?.id ?? 'someone';
}

/** `interactive` envelope: block_actions Approve/Deny buttons. */
export function handleInteractive(ctx: HandlerCtx, payload: Payload): void {
  try {
    if (payload.type !== 'block_actions') return;
    const action = (payload.actions ?? []).find(
      (a: Payload) => a.action_id === 'approve' || a.action_id === 'deny',
    );
    if (!action) return;
    const decision = action.action_id === 'approve' ? 'approved' : 'denied';
    const approvalId = String(action.value ?? '');
    const who = `slack:${userName(payload)}`;
    const responseUrl = payload.response_url;
    ctx.enqueue(async () => {
      try {
        const a = ctx.store.approvals().find((x) => x.id === approvalId);
        if (!a) throw new Error(`no such approval: ${approvalId}`);
        if (a.status !== 'pending') throw new Error(`approval ${approvalId} is already ${a.status}`);
        ctx.store.decideApproval(approvalId, decision, who);
        if (responseUrl) {
          const verb = decision === 'approved' ? 'Approved' : 'Denied';
          await ctx.postUrl(responseUrl, {
            replace_original: true,
            text: `${decision === 'approved' ? '✅' : '❌'} ${verb} by ${userName(payload)}: ${a.detail}`,
          });
        }
      } catch (e) {
        if (responseUrl) {
          await ctx.postUrl(responseUrl, {
            replace_original: false,
            text: `⚠ ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
    });
  } catch (e) {
    ctx.setError(`slack interactive: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `slash_commands` envelope for /alfred. Returns the immediate ack payload. */
export function handleSlash(ctx: HandlerCtx, payload: Payload): Payload {
  try {
    const text = String(payload.text ?? '').trim();
    const lower = text.toLowerCase();
    if (lower === 'status') return { text: statusText(ctx.store) };
    if (lower === 'inbox') return { text: inboxText(ctx.store) };
    if (/^add(\s|$)/.test(lower)) {
      const title = text.slice(4).trim();
      const board = ctx.getBoard();
      if (!board) return { text: 'board is not available' };
      if (!title) return { text: 'usage: /alfred add <title>' };
      const item = board.createItem({ title }, `slack:${payload.user_name ?? payload.user_id ?? 'someone'}`);
      return { text: `Added ${item.key}: ${item.title}` };
    }
    const chat = ctx.getChat();
    if (!chat) return { text: 'chat is not available' };
    const key = `slack:${payload.user_id ?? payload.user_name ?? 'someone'}`;
    const responseUrl = payload.response_url;
    ctx.enqueue(async () => {
      const threadId = ctx.threads.resolve(key);
      const reply = await (chat as any).send(threadId, text);
      if (responseUrl) await ctx.postUrl(responseUrl, { text: reply.content });
    });
    return { text: 'On it…' };
  } catch (e) {
    ctx.setError(`slack slash: ${e instanceof Error ? e.message : String(e)}`);
    return { text: '⚠ something went wrong' };
  }
}

/** `events_api` envelope: DMs and app_mention go to the chat engine, replied in-thread. */
export function handleEvent(ctx: HandlerCtx, event: Payload): void {
  try {
    const type = event?.type;
    let text: string | undefined;
    if (type === 'app_mention') {
      text = String(event.text ?? '').replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
    } else if (
      type === 'message' &&
      event.channel_type === 'im' &&
      !event.bot_id &&
      !event.subtype
    ) {
      text = String(event.text ?? '').trim();
    } else {
      return;
    }
    const channel = event.channel;
    const root = event.thread_ts ?? event.ts;
    const key = `slack:${channel}:${root}`;
    ctx.enqueue(async () => {
      const chat = ctx.getChat();
      if (!chat || !ctx.slackApi) return;
      const threadId = ctx.threads.resolve(key);
      const reply = await (chat as any).send(threadId, text);
      await ctx.slackApi.postMessage({ channel, thread_ts: root, text: reply.content });
    });
  } catch (e) {
    ctx.setError(`slack event: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function statusText(store: Store): string {
  const goals = store.listGoals().filter((g) => g.status === 'active');
  const counts = { running: 0, queued: 0, parked: 0 };
  for (const g of store.listGoals()) {
    for (const t of store.listTasks(g.id)) {
      if (t.status === 'running') counts.running++;
      else if (t.status === 'queued') counts.queued++;
      else if ((PARKED as readonly string[]).includes(t.status)) counts.parked++;
    }
  }
  const lines = goals.length
    ? goals.map((g) => `${g.slug} [${g.status}] ${g.title}`)
    : ['No active goals.'];
  lines.push(`Tasks: ${counts.running} running · ${counts.queued} queued · ${counts.parked} parked`);
  return lines.join('\n');
}

function inboxText(store: Store): string {
  const lines: string[] = [];
  for (const a of store.approvals({ status: 'pending' })) {
    lines.push(`${a.id.slice(0, 8)} ${a.action}: ${a.detail}`);
  }
  for (const g of store.listGoals()) {
    for (const t of store.listTasks(g.id)) {
      if ((PARKED as readonly string[]).includes(t.status)) {
        lines.push(`${t.id.slice(0, 8)} [${t.status}] ${t.title}${t.reason ? ` — ${t.reason}` : ''}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : 'Inbox zero.';
}
