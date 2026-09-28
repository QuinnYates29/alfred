// P21a — the approval gate for mutating agent tools, and the powers.yaml policy.
//
// Reading is free; changing the platform needs Quinn's OK. A gated call runs when:
//   1. the task (or chat thread, as pseudo task `chat:<threadId>`) holds an approved request for
//      exactly this detail — decided by Quinn in the dashboard Inbox or on Slack (spent once), or
//   2. config/powers.yaml pre-approves it (autoApprove), or
//   3. it comes from chat, the same thread asked for exactly this detail earlier, and Quinn's own
//      latest message in that thread — written after the ask — is a plain "yes" (spent once).
// Nothing the model says counts: there is no confirm argument, and tool outputs, goal results or
// board text can't approve anything because only USER messages stored by the chat engine are read.
// Otherwise a goal task requests an approval and parks `blocked` (like run_shell's guard), and a
// chat call records an ask + an approval row (Inbox/Slack) and answers "needs Quinn's OK".
// Every gated call is logged as a `power` system event.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';

export interface AutoApproveRule {
  action: string;
  /** Exact detail strings, or prefixes ending in '*'. Absent = every detail of the action. */
  detail?: string | string[];
  /** For message/call: contact names or numbers that are pre-approved. */
  to?: string[];
}

export interface PowersPolicy {
  autoApprove: AutoApproveRule[];
}

export interface GateCtx {
  deps: ModuleDeps;
  tool: ToolContext;
}

export interface GateOpts {
  /** A fingerprint of what was asked for (e.g. a connector's config). An approval spent on a
   *  different fingerprint than the one it was requested with is refused and re-requested. */
  bind?: string;
  /** What Quinn needs to see to decide (a diff, a spec, a config): stored on the approval row
   *  (Inbox + Slack card) and appended to the task's notes when it parks. */
  info?: string;
  /** For policy rules with `to` (message/call). */
  to?: string;
  /** What the `power` event log records instead of `detail` (e.g. a message without its text).
   *  The approval itself still carries the full detail for Quinn to read. */
  logDetail?: string;
}

/** `<root>`: tests pass a temp root in extra.repoRoot. */
export function powersRoot(deps: ModuleDeps): string {
  return (deps.extra?.repoRoot as string | undefined) ?? deps.repoRoot;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** config/powers.yaml, read fresh. Missing or broken = nothing is pre-approved (fail closed). */
export function loadPolicy(deps: ModuleDeps): PowersPolicy {
  const path = join(powersRoot(deps), 'config', 'powers.yaml');
  if (!existsSync(path)) return { autoApprove: [] };
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as any;
    const list = Array.isArray(raw?.autoApprove) ? raw.autoApprove : [];
    return {
      autoApprove: list
        .filter((r: any) => r && typeof r.action === 'string' && r.action)
        .map((r: any) => ({
          action: r.action,
          ...(r.detail !== undefined ? { detail: Array.isArray(r.detail) ? r.detail.map(String) : String(r.detail) } : {}),
          ...(Array.isArray(r.to) ? { to: r.to.map(String) } : {}),
        })),
    };
  } catch (e: any) {
    console.error(`[powers] ignoring config/powers.yaml: ${e?.message ?? e}`);
    return { autoApprove: [] };
  }
}

function detailMatches(pattern: string, detail: string): boolean {
  return pattern.endsWith('*') ? detail.startsWith(pattern.slice(0, -1)) : pattern === detail;
}

export function autoApproved(policy: PowersPolicy, action: string, detail: string, to?: string): boolean {
  return policy.autoApprove.some((r) => {
    if (r.action !== action) return false;
    if (r.to && !(to !== undefined && r.to.includes(to))) return false;
    if (r.detail === undefined) return true;
    const pats = Array.isArray(r.detail) ? r.detail : [r.detail];
    return pats.some((p) => detailMatches(p, detail));
  });
}

/** taskId + detail → the fingerprint the approval was requested with (in-memory; a restart fails closed). */
const requested = new Map<string, string>();

function record(deps: ModuleDeps, data: Record<string, any>): void {
  try {
    deps.store.appendEvent('', null, 'power', data);
  } catch {
    /* the event log must never break a tool */
  }
}

const capInfo = (s: string) => (s.length > 1500 ? `${s.slice(0, 1500)}… (full text in the approval)` : s);

// ---- chat asks ----

/** An unambiguous "yes": the WHOLE message, short, case-insensitive. Anything else is not consent. */
export const AFFIRMATIVE_RE =
  /^\s*(y|yes|yep|yeah|ok|okay|go|go ahead|do it|send it|confirm(ed)?|approve(d)?|sure|yes please)[\s.!]*$/i;

export function isAffirmative(text: string): boolean {
  return typeof text === 'string' && text.length <= 40 && AFFIRMATIVE_RE.test(text);
}

/** A thread message as the chat store keeps it (only role/content/createdAt/id are read). */
export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface ChatAsk {
  threadId: string;
  action: string;
  detail: string;
  askedAt: number;
  /** Id of the thread's newest message when the ask was made: only messages after it count. */
  afterId: string | null;
  bind?: string;
  /** The approval row shown in the Inbox / on Slack. */
  approvalId?: string;
}

/** threadId + detail → the pending ask. In memory: a restart just asks again. */
const asks = new Map<string, ChatAsk>();
const askKey = (threadId: string, detail: string) => `${threadId}\n${detail}`;

/** Pending asks of a thread made at or after `since` (the chat engine lists them under its reply). */
export function chatAsks(threadId: string, since = 0): ChatAsk[] {
  return [...asks.values()].filter((a) => a.threadId === threadId && a.askedAt >= since);
}

/** Test hook. */
export function clearChatAsks(): void {
  asks.clear();
}

/** The thread's messages as the chat store has them — never anything the model said about them. */
function threadMessages(deps: ModuleDeps, threadId: string): ThreadMessage[] {
  const engine = (deps.modules?.chat as any)?.chat;
  const fn = engine?.threadMessages;
  if (typeof fn !== 'function') return [];
  try {
    return (fn.call(engine, threadId) as ThreadMessage[]) ?? [];
  } catch {
    return [];
  }
}

/** Messages strictly after the ask: after its `afterId` in store order, else created after askedAt. */
function messagesAfter(ask: ChatAsk, all: ThreadMessage[]): ThreadMessage[] {
  if (ask.afterId) {
    const i = all.findIndex((m) => m.id === ask.afterId);
    if (i >= 0) return all.slice(i + 1);
  }
  return all.filter((m) => m.createdAt > ask.askedAt);
}

/** Quinn said yes: his ONE reply since the ask is an unambiguous affirmative. A later message
 *  (e.g. "no" and then a "yes" to something else) voids an older ask. */
function userSaidYes(deps: ModuleDeps, ask: ChatAsk): boolean {
  const after = messagesAfter(ask, threadMessages(deps, ask.threadId)).filter((m) => m.role === 'user');
  return after.length === 1 && isAffirmative(after[0]!.content);
}

function recordAsk(deps: ModuleDeps, threadId: string, action: string, detail: string, o: GateOpts): ChatAsk {
  const all = threadMessages(deps, threadId);
  const ask: ChatAsk = {
    threadId,
    action,
    detail,
    askedAt: Date.now(),
    afterId: all.at(-1)?.id ?? null,
    ...(o.bind !== undefined ? { bind: o.bind } : {}),
  };
  try {
    ask.approvalId = deps.store.requestApproval(`chat:${threadId}`, action, detail, o.info).id;
  } catch {
    /* the Inbox row is a convenience; the in-thread yes still works */
  }
  asks.set(askKey(threadId, detail), ask);
  return ask;
}

/** Drop the ask and its pending Inbox row (decided on the spot by Quinn's chat yes). */
function spendAsk(deps: ModuleDeps, ask: ChatAsk, by: string): void {
  asks.delete(askKey(ask.threadId, ask.detail));
  const taskId = `chat:${ask.threadId}`;
  try {
    const row = deps.store.findApproval(taskId, ask.detail, 'pending');
    if (row) {
      deps.store.decideApproval(row.id, 'approved', by);
      deps.store.consumeApproval(taskId, ask.detail);
    }
  } catch {
    /* best effort */
  }
}

export async function gated(
  g: GateCtx,
  action: string,
  detail: string,
  run: () => Promise<ToolResult>,
  o: GateOpts = {},
): Promise<ToolResult> {
  const { deps, tool } = g;
  const store = deps.store;
  const taskId = tool.taskId;
  const chat = taskId.startsWith('chat:') && taskId.length > 5;
  const threadId = chat ? taskId.slice(5) : '';
  const base = { action, detail: o.logDetail ?? detail, ...(chat ? { threadId } : { taskId }) };
  const key = `${taskId}\n${detail}`;

  const go = async (extra: Record<string, any>) => {
    record(deps, { ...base, outcome: 'ran', ...extra });
    return run();
  };

  if (chat) {
    const ask = asks.get(askKey(threadId, detail));
    const bindOk = !ask || o.bind === undefined || ask.bind === o.bind;
    // A bound ask (e.g. a connector's exact config) is only honoured while we still know what was
    // asked for; after a restart the row can't prove its content, so it is asked again (fail closed).
    const rowOk = o.bind === undefined || (!!ask && ask.bind === o.bind);
    // Approved in the Inbox / on Slack (a person decided; never the model).
    if (rowOk && store.findApproval(taskId, detail, 'approved')) {
      store.consumeApproval(taskId, detail);
      if (ask) asks.delete(askKey(threadId, detail));
      return go({ approved: true });
    }
    if (ask && bindOk && userSaidYes(deps, ask)) {
      spendAsk(deps, ask, 'chat:quinn');
      return go({ confirmed: true });
    }
    if (autoApproved(loadPolicy(deps), action, detail, o.to)) return go({ auto: true });
    if (ask && !bindOk) {
      // Same name, different content than what was asked about: the old ask (and row) is void.
      asks.delete(askKey(threadId, detail));
      try {
        const row = store.findApproval(taskId, detail, 'pending');
        if (row) store.decideApproval(row.id, 'denied', 'superseded');
      } catch {
        /* ignore */
      }
    }
    recordAsk(deps, threadId, action, detail, o);
    record(deps, { ...base, outcome: 'asked' });
    return {
      ok: false,
      output:
        `needs Quinn’s OK: ${action}: ${detail}${o.info ? `\n${capInfo(o.info)}` : ''}\n` +
        '— tell Quinn exactly what this will do and stop. It runs only if Quinn himself replies "yes" in this chat ' +
        '(or approves it in the Inbox / on Slack); then call again with the same arguments.',
    };
  }

  if (store.consumeApproval(taskId, detail)) {
    const want = requested.get(key);
    requested.delete(key);
    if (o.bind === undefined || want === o.bind) return go({});
    // Approved for something else under the same name: ask again for what is asked now.
  } else if (autoApproved(loadPolicy(deps), action, detail, o.to)) {
    return go({ auto: true });
  }

  try {
    store.requestApproval(taskId, action, detail, o.info);
    if (o.bind !== undefined) requested.set(key, o.bind);
    if (o.info) store.appendNote(taskId, `approval requested — ${detail}: ${capInfo(o.info)}`);
  } catch (e: any) {
    record(deps, { ...base, outcome: 'refused' });
    return { ok: false, output: `approval needed: ${action}: ${detail} — but no task to park (${e?.message ?? e})` };
  }
  record(deps, { ...base, outcome: 'parked' });
  return {
    ok: false,
    output: `approval needed: ${action}: ${detail}`,
    park: { status: 'blocked', reason: `approval needed: ${action}` },
  };
}
