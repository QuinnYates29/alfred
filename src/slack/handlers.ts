// P20 — Slack event handlers: block_actions buttons, /alfred slash commands,
// events_api (DMs and app_mention). Handlers never throw; failures land in ctx.setError.
import type { Store } from '../store.js';
import { PARKED } from '../types.js';
import type { SlackApi } from './slackApi.js';
import type { ChatLike } from './threadMap.js';
import { actionsFooter, toMrkdwn } from './format.js';
import { slackEscape } from '../notify/sinks.js';
import { parseDispatch } from '../dispatch.js';
import { approvalBlocks } from '../notify/sinks.js';

export interface HandlerCtx {
  store: Store;
  getBoard(): { createItem(i: { title: string }, by: string): { key: string; title: string } } | undefined;
  getChat(): ChatLike | undefined;
  threads: { resolve(key: string): string; reset(key: string): string };
  slackApi: SlackApi | undefined;
  postUrl(url: string, body: any): Promise<void>;
  enqueue(fn: () => Promise<void>): void;
  /** Serial per key (one Slack conversation), parallel across keys. Falls back to enqueue. */
  enqueueFor?(key: string, fn: () => Promise<void>): void;
  setError(msg: string): void;
  /** Slack user ids allowed to use the bot (SLACK_ALLOWED_USERS). Everyone else is refused. */
  allowedUsers: ReadonlySet<string>;
  /** D1 — known persona names (for the `!<persona> <prompt>` syntax). */
  personaNames?(): string[];
  /** D1 — start an agent run from dispatch text; throws on bad input. */
  dispatch?(text: string): { goalId: string; slug: string; title: string; persona: string };
  /** D1 — call onDone once when the goal finishes (status 'done' | 'failed'). */
  follow?(goalId: string, onDone: (status: string, summary: string) => void): void;
  /** Public dashboard base URL, for goal deep links (deps.dashboardUrl). */
  dashboardUrl?: string;
}

/** Approvals from Slack gate texting, calls and deploys: only allow-listed users may act. */
function allowed(ctx: HandlerCtx, userId: string | undefined): boolean {
  return !!userId && ctx.allowedUsers.has(userId);
}

const refusal = (userId: string | undefined) =>
  `⛔ not authorized. To allow this Slack user, add ${userId ?? '<unknown>'} to SLACK_ALLOWED_USERS in ~/.config/alfred.env and restart alfred.`;

/** D1 — the "run started" line (plus a dashboard deep link when we know the URL). */
function startedLine(ctx: HandlerCtx, r: { goalId: string; title: string; persona: string }): string {
  const base = `:rocket: Started *${r.persona}* → ${r.title}`;
  return ctx.dashboardUrl ? `${base}\n${ctx.dashboardUrl}/#/goal/${r.goalId}` : base;
}

/** D1 — the finish line, posted where the run started. */
function doneLine(status: string, title: string, summary: string): string {
  const head = status === 'done' ? `:white_check_mark: done — ${title}` : `:x: failed — ${title}`;
  return `${head}\n${toMrkdwn(summary)}`;
}

/** D1 — dispatch + follow, replying via postUrl (slash commands). */
function dispatchAndReport(ctx: HandlerCtx, text: string, responseUrl: string | undefined): Payload {
  if (!ctx.dispatch) return { text: 'dispatch is not available' };
  let out: { goalId: string; slug: string; title: string; persona: string };
  try {
    out = ctx.dispatch(text);
  } catch (e) {
    return { text: `⚠ ${e instanceof Error ? e.message : String(e)}` };
  }
  const ack = startedLine(ctx, out);
  ctx.follow?.(out.goalId, (status, summary) => {
    if (!responseUrl) return;
    ctx.enqueue(async () => { await ctx.postUrl(responseUrl, { text: doneLine(status, out.title, summary) }); });
  });
  return { text: ack };
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
    if (!allowed(ctx, payload.user?.id)) {
      if (payload.response_url) {
        const url = payload.response_url;
        ctx.enqueue(() => ctx.postUrl(url, { replace_original: false, text: refusal(payload.user?.id) }));
      }
      return;
    }
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
            text: `${decision === 'approved' ? '✅' : '❌'} ${verb} by ${userName(payload)}: ${slackEscape(a.detail)}`,
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

/** Slack is external: a private chat thread must never answer there. */
const PRIVATE_SLACK_REPLY = 'This conversation is private — continue it in the dashboard.';
const threadIsPrivate = (chat: unknown, threadId: string): boolean => {
  try {
    return !!(chat as any)?.getThread?.(threadId)?.private;
  } catch {
    return false;
  }
};

/** `slash_commands` envelope for /alfred. Returns the immediate ack payload. */
export function handleSlash(ctx: HandlerCtx, payload: Payload): Payload {
  try {
    if (!allowed(ctx, payload.user_id)) return { text: refusal(payload.user_id) };
    const text = String(payload.text ?? '').trim();
    const lower = text.toLowerCase();
    if (lower === 'status') return { text: statusText(ctx.store) };
    if (lower === 'inbox') return { text: inboxText(ctx.store) };
    // Every pending approval as its own card with Approve/Deny (the originals may be far up the channel).
    if (lower === 'approvals' || lower === 'approve') {
      const pending = ctx.store.approvals({ status: 'pending' });
      if (!pending.length) return { text: 'No approvals pending.' };
      const channel = payload.channel_id;
      ctx.enqueue(async () => {
        for (const a of pending) {
          const task = a.taskId && !String(a.taskId).startsWith('chat:') ? ctx.store.getTask(a.taskId) : undefined;
          const title = `Approval needed: ${a.action}${task ? ` — ${task.title}` : ''}`;
          await ctx.slackApi?.postMessage({ channel, text: title, blocks: approvalBlocks({ title, body: a.detail, info: a.info ?? undefined, approvalId: a.id }) });
        }
      });
      return { text: `${pending.length} pending approval${pending.length === 1 ? '' : 's'} — posting them with buttons…` };
    }
    if (/^add(\s|$)/.test(lower)) {
      const title = text.slice(4).trim();
      const board = ctx.getBoard();
      if (!board) return { text: 'board is not available' };
      if (!title) return { text: 'usage: /alfred add <title>' };
      const item = board.createItem({ title }, `slack:${payload.user_name ?? payload.user_id ?? 'someone'}`);
      return { text: `Added ${item.key}: ${item.title}` };
    }
    // D1 — `/alfred run [persona] <prompt>` is the same as `!<persona> <prompt>`.
    if (/^run(\s|$)/.test(lower)) {
      const arg = text.slice(4).trim();
      if (!arg) return { text: 'usage: /alfred run [persona] <prompt>' };
      const names = ctx.personaNames?.() ?? [];
      const parsed = parseDispatch(`!${arg}`, names);
      if (!parsed) return { text: 'usage: /alfred run [persona] <prompt>' };
      return dispatchAndReport(ctx, `!${parsed.persona} ${parsed.prompt}`, payload.response_url);
    }
    const chat = ctx.getChat();
    if (!chat) return { text: 'chat is not available' };
    const key = `slack:${payload.user_id ?? payload.user_name ?? 'someone'}`;
    const responseUrl = payload.response_url;
    ctx.enqueue(async () => {
      const threadId = ctx.threads.resolve(key);
      if (threadIsPrivate(chat, threadId)) {
        if (responseUrl) await ctx.postUrl(responseUrl, { text: PRIVATE_SLACK_REPLY });
        return;
      }
      const reply = await (chat as any).send(threadId, text, { source: 'slack' });
      if (responseUrl) await ctx.postUrl(responseUrl, { text: `${toMrkdwn(String(reply?.content ?? ''))}${actionsFooter(reply?.actions)}` });
    });
    return { text: 'On it…' };
  } catch (e) {
    ctx.setError(`slack slash: ${e instanceof Error ? e.message : String(e)}`);
    return { text: '⚠ something went wrong' };
  }
}

/**
 * `events_api` envelope — Slack as a second chat window:
 * - a DM is ONE continuous conversation with alfred (like the dashboard chat), answered where it
 *   was asked (top level, or inside the Slack thread if the message was in one); "new chat" starts over;
 * - an @mention in a channel is a conversation per Slack thread, answered in that thread.
 * A "thinking…" placeholder is posted right away and replaced by the reply (chat.update).
 */
export function handleEvent(ctx: HandlerCtx, event: Payload): void {
  try {
    const type = event?.type;
    let text: string | undefined;
    const dm = type === 'message' && event.channel_type === 'im';
    if (type === 'app_mention') {
      text = String(event.text ?? '').replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
    } else if (dm && !event.bot_id && !event.subtype) {
      text = String(event.text ?? '').trim();
    } else {
      return;
    }
    const channel = event.channel;
    const root = event.thread_ts ?? event.ts;
    if (!allowed(ctx, event.user)) {
      ctx.enqueue(async () => { await ctx.slackApi?.postMessage({ channel, thread_ts: root, text: refusal(event.user) }); });
      return;
    }
    const key = dm ? `slack:dm:${channel}` : `slack:${channel}:${root}`;
    const where = dm && !event.thread_ts ? {} : { thread_ts: root };
    if (dm && /^(new chat|new conversation|start over|reset)$/i.test(text)) {
      ctx.threads.reset(key);
      ctx.enqueue(async () => { await ctx.slackApi?.postMessage({ channel, ...where, text: 'Started a new conversation.' }); });
      return;
    }
    // D1 — `!<persona> <prompt>` starts an agent run instead of chatting.
    if (ctx.personaNames && ctx.dispatch && parseDispatch(text, ctx.personaNames())) {
      ctx.enqueue(async () => {
        let out: { goalId: string; slug: string; title: string; persona: string };
        try {
          out = ctx.dispatch!(text);
        } catch (e) {
          await ctx.slackApi?.postMessage({ channel, ...where, text: `⚠ ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
        await ctx.slackApi?.postMessage({ channel, ...where, text: startedLine(ctx, out) });
        ctx.follow?.(out.goalId, (status, summary) => {
          ctx.enqueue(async () => {
            await ctx.slackApi?.postMessage({ channel, ...where, text: doneLine(status, out.title, summary) });
          });
        });
      });
      return;
    }
    const run = async () => {
      const chat = ctx.getChat();
      if (!chat || !ctx.slackApi) return;
      const api = ctx.slackApi;
      const threadId = ctx.threads.resolve(key);
      // A private thread never answers on Slack (external) and the engine is not called.
      if (threadIsPrivate(chat, threadId)) {
        await api.postMessage({ channel, ...where, text: PRIVATE_SLACK_REPLY });
        return;
      }
      const placeholder = await api.postMessage({ channel, ...where, text: '_:hourglass_flowing_sand: thinking…_' });
      const deliver = async (body: string) => {
        if (placeholder && (await api.update({ channel, ts: placeholder, text: body }))) return;
        await api.postMessage({ channel, ...where, text: body });
      };
      let unsub: (() => void) | null = null;
      try {
        // live progress in the placeholder ("using contacts…"), like the dashboard's thinking bubble;
        // throttled — Slack allows ~1 chat.update per second
        let last = 0;
        let settled = false;
        let inflight: Promise<unknown> = Promise.resolve();
        if (placeholder && typeof ctx.store.onEvent === 'function') {
          unsub = ctx.store.onEvent((ev: any) => {
            if (settled || ev.kind !== 'chat_progress' || ev.data?.threadId !== threadId || ev.data?.phase !== 'tool') return;
            const t = Date.now();
            if (t - last < 1500) return;
            last = t;
            inflight = api.update({ channel, ts: placeholder, text: `_:hourglass_flowing_sand: using ${ev.data.tool}…_` });
          });
        }
        const reply = await (chat as any).send(threadId, text, { source: 'slack' });
        settled = true;
        await inflight.catch(() => {}); // a progress update must not land after the reply
        await deliver(`${toMrkdwn(String(reply?.content ?? '')) || '_(no reply)_'}${actionsFooter(reply?.actions)}`);
      } catch (e) {
        await deliver(`:warning: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        unsub?.();
      }
    };
    // turns of different conversations run side by side; one conversation stays in order
    if (ctx.enqueueFor) ctx.enqueueFor(key, run);
    else ctx.enqueue(run);
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
