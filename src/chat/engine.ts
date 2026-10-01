// P16 §3 — the chat engine: one LLM tool-loop per send, one reply at a time per thread.
import { answerFromChat, QUESTIONS_THREAD } from '../questions.js';
import { createHash } from 'node:crypto';
import type { LLM, LLMMessage, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { chatSystemPrompt } from './prompt.js';
import { chatTools } from './tools.js';
import { chatAsks } from '../powers/gate.js';
import { denyReason, toolCaps } from '../runtime/caps.js';
import { recordTurn } from './dataset.js';
import type { ChatAction, ChatMessage, ChatStore, Thread } from './store.js';

export class ChatBusyError extends Error {
  constructor(threadId: string) {
    super(`chat thread is busy: ${threadId}`);
    this.name = 'ChatBusyError';
  }
}

const MAX_LLM_CALLS = 6;
const HISTORY = 20;
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const safeJson = (v: any) => {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return String(v);
  }
};

export function stateSnapshot(deps: ModuleDeps): string {
  const { store } = deps;
  const active = store.listGoals().filter((g) => g.status === 'active').length;
  const taskCounts: Record<string, number> = {};
  for (const r of store.raw().prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as any[]) {
    taskCounts[r.status] = r.n;
  }
  const parked = (taskCounts.blocked ?? 0) + (taskCounts.needs_claude ?? 0);
  const pending = store.approvals({ status: 'pending' }).length;
  const lines = [
    '## Live state',
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `goals active: ${active}; tasks running: ${taskCounts.running ?? 0}, queued: ${taskCounts.queued ?? 0}, parked: ${parked}; approvals pending: ${pending}`,
  ];
  const board = (deps.modules.board as any)?.board;
  if (board) {
    const byKind: Record<string, number> = {};
    for (const it of board.listItems({ limit: 500 })) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
    const parts = ['backlog', 'todo', 'doing', 'review', 'done']
      .map((k) => `${k} ${byKind[k] ?? 0}`)
      .join(', ');
    lines.push(`board: ${parts}`);
  }
  return lines.join('\n');
}

/** Where an in-flight turn is. Emitted as `chat_progress { threadId, phase, tool?, turn? }` (system event). */
export type ChatPhase = 'thinking' | 'tool' | 'done' | 'error';
/** An in-flight turn, as returned by `pending()` and `GET /chat/threads/:id`. */
export interface ChatPending {
  since: number;
  phase: 'thinking' | 'tool';
  tool?: string;
  turn?: number;
}

/** A thread whose last message is an unanswered user message this recent gets the interrupted note on startup. */
export const INTERRUPTED_WINDOW_MS = 15 * 60_000;
export const INTERRUPTED_REPLY =
  "⚠ My reply was interrupted by a restart, so it never arrived. I didn't re-run it (I may have been part-way through an action) — please say it again.";

/** One short line for the user: no stack traces, no multi-KB error bodies. */
export function errorReply(e: any): string {
  const first = String(e?.message ?? e ?? 'unknown error').split('\n').find((l) => l.trim())?.trim() ?? 'unknown error';
  return `⚠ Sorry, I couldn't finish that reply: ${cap(first, 300)}. Try again?`;
}

export class ChatEngine {
  private inflight = new Map<string, ChatPending>();
  /** Turns abandoned by stop(): they already got the interrupted note and must not write or run tools. */
  private abandoned = new Set<string>();
  private stopped = false;

  constructor(private deps: ModuleDeps, private cs: ChatStore) {}

  createThread(title?: string, o?: { private?: boolean }): Thread {
    return this.cs.createThread(title, o);
  }

  getThread(id: string): Thread | undefined {
    return this.cs.getThread(id);
  }

  /** The thread's stored messages (the approval gate reads Quinn's own replies from here). */
  threadMessages(threadId: string): ChatMessage[] {
    return this.cs.messages(threadId);
  }

  busy(threadId: string): boolean {
    return this.inflight.has(threadId);
  }

  /** The in-flight turn of a thread, if any. */
  pending(threadId: string): ChatPending | undefined {
    const p = this.inflight.get(threadId);
    return p && { ...p };
  }

  private resolveLlm(): LLM {
    const d = this.deps;
    const llm = d.extra?.llm ?? d.models?.llm('planner') ?? d.llm;
    if (!llm) throw new Error('no LLM configured');
    return llm;
  }

  /** The ModelSpec behind the model chat runs on (for the dataset record); null when there's no registry. */
  private modelSpec(): { name: string; model: string; baseUrl: string } {
    try {
      const s = this.deps.models?.resolve?.('planner');
      if (s) return { name: s.name, model: s.model, baseUrl: s.baseUrl };
    } catch {
      /* fall through */
    }
    return { name: 'test', model: 'test', baseUrl: '' };
  }

  /** Private threads only ever run on a model served on the Spark itself. `extra.llm` counts as local. */
  private localModel(): { llm: LLM; spec: { name: string; model: string; baseUrl: string } } | undefined {
    const d = this.deps;
    if (d.extra?.llm) return { llm: d.extra.llm, spec: this.modelSpec() };
    const reg = d.models;
    if (!reg) return d.llm ? { llm: d.llm, spec: this.modelSpec() } : undefined;
    const local = (baseUrl: string) => {
      try {
        const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
        return host === '127.0.0.1' || host === 'localhost' || host === '::1';
      } catch {
        return false;
      }
    };
    try {
      const planner = reg.resolve('planner');
      if (planner && local(planner.baseUrl)) return { llm: reg.llm('planner'), spec: { name: planner.name, model: planner.model, baseUrl: planner.baseUrl } };
      const first = reg.list().find((m) => local(m.baseUrl));
      if (first) return { llm: reg.llm(first.name), spec: { name: first.name, model: first.model, baseUrl: first.baseUrl } };
    } catch {
      return undefined;
    }
    return undefined;
  }

  static PRIVATE_REPLY = '⚠ Private mode needs a local model on the Spark; none is configured.';
  static PRIVATE_SYSTEM_LINE = 'Private conversation: you have no tools; answer from your own knowledge.';
  static PRIVATE_TOOL_REPLY = 'tools are off in private mode';

  /** Record + emit progress. Never throws: a progress event must not break a turn.
   *  Private threads emit phase + threadId ONLY — never a tool name, never content. */
  private progress(threadId: string, phase: ChatPhase, o: { tool?: string; turn?: number } = {}): void {
    const clean = this.cs.getThread(threadId)?.private ? {} : o;
    if (phase === 'thinking' || phase === 'tool') {
      const cur = this.inflight.get(threadId);
      if (cur) this.inflight.set(threadId, { since: cur.since, phase, ...clean });
    }
    try {
      this.deps.store.appendEvent('', null, 'chat_progress', { threadId, phase, ...clean });
    } catch {
      /* store closed during shutdown */
    }
  }

  async send(threadId: string, text: string, o?: { by?: string; source?: string }): Promise<ChatMessage> {
    if (this.stopped) throw new Error('chat is shutting down');
    if (!this.cs.getThread(threadId)) throw new Error(`no such thread: ${threadId}`);
    if (this.inflight.has(threadId)) throw new ChatBusyError(threadId);
    this.inflight.set(threadId, { since: Date.now(), phase: 'thinking', turn: 1 });
    let phase: ChatPhase = 'error';
    try {
      this.cs.addMessage({ threadId, role: 'user', content: text });
      this.progress(threadId, 'thinking', { turn: 1 });
      // ALF-7: in "Agent questions", a yes / no reply answers the oldest open agent question.
      // (Only that thread awaits here: every other turn starts exactly as before.)
      if (this.cs.getThread(threadId)?.title === QUESTIONS_THREAD) {
        const answered = await answerFromChat(this.deps, this.cs, threadId, text);
        if (answered) {
          phase = 'done';
          return answered;
        }
      }
      const { message, ok } = await this.runTurn(threadId, o?.source);
      if (ok) phase = 'done';
      return message;
    } finally {
      this.inflight.delete(threadId);
      // stop() already emitted the terminal phase for an abandoned turn.
      if (!this.abandoned.delete(threadId)) this.progress(threadId, phase);
    }
  }

  private async runTurn(threadId: string, source?: string): Promise<{ message: ChatMessage; ok: boolean }> {
    const actions: ChatAction[] = [];
    const ctrl = new AbortController();
    const gone = () => this.abandoned.has(threadId);
    const isPrivate = !!this.cs.getThread(threadId)?.private;
    let reply = '';
    let ok = true;
    let errText = '';
    let lastText = '';
    const turnStart = Date.now();
    let llmCalls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let finalMessages: LLMMessage[] = [];
    let system = '';
    let deniedNames = new Set<string>();
    let model = { name: 'unknown', model: 'unknown', baseUrl: '' };
    try {
      let llm: LLM;
      if (isPrivate) {
        // Private: local model only, and NO tools at all (no web/Slack/Jira/goals/connectors).
        const local = this.localModel();
        if (!local) {
          return { ok: true, message: this.cs.addMessage({ threadId, role: 'assistant', content: ChatEngine.PRIVATE_REPLY }) };
        }
        llm = local.llm;
        model = local.spec;
      } else {
        llm = this.resolveLlm();
        model = this.modelSpec();
      }
      // Per-model deny (config/models.yaml) for the model chat runs on: not offered, and refused below.
      const denied = isPrivate ? new Set<string>() : this.deps.models?.denied('planner') ?? new Set<string>();
      // By name or by capability class (`class:exec` blocks every command-running tool).
      const blocked = (t: { schema: { name: string }; caps?: any }) => !!denyReason(denied, t.schema.name, toolCaps(t.schema.name, t));
      const all = isPrivate ? [] : chatTools(this.deps);
      deniedNames = new Set(all.filter(blocked).map((t) => t.schema.name));
      const tools = all.filter((t) => !deniedNames.has(t.schema.name));
      const byName = new Map(tools.map((t) => [t.schema.name, t]));
      system = `${chatSystemPrompt(this.deps)}\n\n${stateSnapshot(this.deps)}`;
      if (isPrivate) system += `\n\n${ChatEngine.PRIVATE_SYSTEM_LINE}`;
      const messages: LLMMessage[] = this.cs
        .messages(threadId, { limit: HISTORY })
        .map((m) => ({ role: m.role, content: m.content }));
      const ctx: ToolContext = {
        taskId: `chat:${threadId}`,
        goalId: '',
        workspace: this.deps.workRoot ?? '',
        persona: 'chat',
        signal: ctrl.signal,
        acceptance: [],
        progress: () => {},
      };
      for (let i = 0; i < MAX_LLM_CALLS && !gone(); i++) {
        if (i > 0) this.progress(threadId, 'thinking', { turn: i + 1 });
        finalMessages = [...messages];
        llmCalls++;
        const resp = await llm.chat({ system, messages: [...messages], tools: tools.map((t) => t.schema), maxTokens: 2048 });
        promptTokens += Number(resp.usage?.promptTokens) || 0;
        completionTokens += Number(resp.usage?.completionTokens) || 0;
        if (resp.content) lastText = resp.content;
        const calls = resp.toolCalls ?? [];
        if (calls.length === 0) {
          reply = resp.content || '(no reply)';
          break;
        }
        messages.push({ role: 'assistant', content: resp.content, toolCalls: calls });
        for (const c of calls) {
          // Never start a tool (it may send a text) after a restart abandoned this turn.
          if (gone()) break;
          this.progress(threadId, 'tool', { tool: c.name, turn: i + 1 });
          let result: ToolResult;
          const tool = byName.get(c.name);
          if (isPrivate) {
            result = { ok: false, output: ChatEngine.PRIVATE_TOOL_REPLY };
          } else if (!tool) {
            result = { ok: false, output: deniedNames.has(c.name) || denied.has(c.name) ? `tool ${c.name} is not allowed on this model` : `unknown tool: ${c.name}` };
          } else {
            try {
              result = await tool.run(c.args ?? {}, ctx);
            } catch (e: any) {
              result = { ok: false, output: `error: ${e?.message ?? String(e)}` };
            }
          }
          const output = String(result?.output ?? '');
          actions.push({ name: c.name, args: cap(safeJson(c.args), 120), ok: !!result?.ok, output: cap(output, 300) });
          messages.push({ role: 'tool', content: output, toolCallId: c.id, name: c.name });
        }
        if (i === MAX_LLM_CALLS - 1) {
          reply = `I stopped after ${MAX_LLM_CALLS} steps; ask me to continue.${lastText ? ` ${lastText}` : ''}`;
        }
      }
    } catch (e: any) {
      reply = errorReply(e);
      ok = false;
      errText = String(e?.message ?? e ?? 'unknown error').slice(0, 500);
    }
    if (gone()) {
      ctrl.abort();
      // stop() already stored the interrupted note; the store may be closed by now.
      const now = Date.now();
      return { ok: false, message: { id: '', threadId, role: 'assistant', content: INTERRUPTED_REPLY, actions, createdAt: now } };
    }
    // What a "yes" would approve, verbatim from the gate — not the model's paraphrase of it.
    const asked = chatAsks(threadId, turnStart);
    if (asked.length) {
      const lines = asked.map((a) => `- ${a.action}: ${a.detail}`);
      reply += `\n\n**Needs your OK** — reply "yes" to run ${asked.length === 1 ? 'this' : 'all of these'}, or decide in the Inbox:\n${lines.join('\n')}`;
    }
    const message = this.cs.addMessage({ threadId, role: 'assistant', content: reply, actions });
    // Training/eval record — never for a private thread, and never throws into the reply.
    if (!isPrivate) {
      try {
        recordTurn(this.deps.env, {
          id: message.id,
          ts: Date.now(),
          threadId,
          source: source ?? 'api',
          model,
          system,
          messages: finalMessages,
          reply,
          actions,
          llmCalls,
          usage: { promptTokens, completionTokens },
          latencyMs: Date.now() - turnStart,
          ok,
          ...(ok ? {} : { error: errText }),
          deniedTools: [...deniedNames],
        });
      } catch {
        /* the reply is done; recording can never matter more */
      }
    }
    return { ok, message };
  }

  /** Shutdown: every in-flight turn is abandoned and gets the interrupted note now (never re-run). */
  stop(): void {
    this.stopped = true;
    for (const threadId of [...this.inflight.keys()]) {
      this.abandoned.add(threadId);
      this.inflight.delete(threadId);
      try {
        this.cs.addMessage({ threadId, role: 'assistant', content: INTERRUPTED_REPLY });
      } catch {
        /* never block shutdown */
      }
      this.progress(threadId, 'error');
    }
  }

  /**
   * Startup: a thread whose last message is a user message from the last 15 minutes (a turn that died with
   * the previous process) gets the interrupted note. Older unanswered ones are left alone. Returns the thread ids.
   */
  recoverInterrupted(now = Date.now()): string[] {
    const out: string[] = [];
    for (const t of this.cs.listThreads()) {
      if (t.updatedAt < now - INTERRUPTED_WINDOW_MS) break; // most recently updated first
      if (this.inflight.has(t.id)) continue;
      const last = this.cs.lastMessage(t.id);
      if (!last || last.role !== 'user' || last.createdAt < now - INTERRUPTED_WINDOW_MS) continue;
      this.cs.addMessage({ threadId: t.id, role: 'assistant', content: INTERRUPTED_REPLY });
      this.progress(t.id, 'error');
      out.push(t.id);
    }
    return out;
  }
}
