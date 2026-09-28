// P16 §3 — the chat engine: one LLM tool-loop per send, one reply at a time per thread.
import type { LLM, LLMMessage, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { chatSystemPrompt } from './prompt.js';
import { chatTools } from './tools.js';
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

  createThread(title?: string): Thread {
    return this.cs.createThread(title);
  }

  getThread(id: string): Thread | undefined {
    return this.cs.getThread(id);
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

  /** Record + emit progress. Never throws: a progress event must not break a turn. */
  private progress(threadId: string, phase: ChatPhase, o: { tool?: string; turn?: number } = {}): void {
    if (phase === 'thinking' || phase === 'tool') {
      const cur = this.inflight.get(threadId);
      if (cur) this.inflight.set(threadId, { since: cur.since, phase, ...o });
    }
    try {
      this.deps.store.appendEvent('', null, 'chat_progress', { threadId, phase, ...o });
    } catch {
      /* store closed during shutdown */
    }
  }

  async send(threadId: string, text: string, _o?: { by?: string }): Promise<ChatMessage> {
    if (this.stopped) throw new Error('chat is shutting down');
    if (!this.cs.getThread(threadId)) throw new Error(`no such thread: ${threadId}`);
    if (this.inflight.has(threadId)) throw new ChatBusyError(threadId);
    this.inflight.set(threadId, { since: Date.now(), phase: 'thinking', turn: 1 });
    let phase: ChatPhase = 'error';
    try {
      this.cs.addMessage({ threadId, role: 'user', content: text });
      this.progress(threadId, 'thinking', { turn: 1 });
      const { message, ok } = await this.runTurn(threadId);
      if (ok) phase = 'done';
      return message;
    } finally {
      this.inflight.delete(threadId);
      // stop() already emitted the terminal phase for an abandoned turn.
      if (!this.abandoned.delete(threadId)) this.progress(threadId, phase);
    }
  }

  private async runTurn(threadId: string): Promise<{ message: ChatMessage; ok: boolean }> {
    const actions: ChatAction[] = [];
    const ctrl = new AbortController();
    const gone = () => this.abandoned.has(threadId);
    let reply = '';
    let ok = true;
    let lastText = '';
    try {
      // Per-model deny (config/models.yaml) for the model chat runs on: not offered, and refused below.
      const denied = this.deps.models?.denied('planner') ?? new Set<string>();
      const tools = chatTools(this.deps).filter((t) => !denied.has(t.schema.name));
      const byName = new Map(tools.map((t) => [t.schema.name, t]));
      const system = `${chatSystemPrompt(this.deps)}\n\n${stateSnapshot(this.deps)}`;
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
      const llm = this.resolveLlm();
      for (let i = 0; i < MAX_LLM_CALLS && !gone(); i++) {
        if (i > 0) this.progress(threadId, 'thinking', { turn: i + 1 });
        const resp = await llm.chat({ system, messages: [...messages], tools: tools.map((t) => t.schema), maxTokens: 2048 });
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
          if (!tool) {
            result = { ok: false, output: denied.has(c.name) ? `tool ${c.name} is not allowed on this model` : `unknown tool: ${c.name}` };
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
    }
    if (gone()) {
      ctrl.abort();
      // stop() already stored the interrupted note; the store may be closed by now.
      const now = Date.now();
      return { ok: false, message: { id: '', threadId, role: 'assistant', content: INTERRUPTED_REPLY, actions, createdAt: now } };
    }
    return { ok, message: this.cs.addMessage({ threadId, role: 'assistant', content: reply, actions }) };
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
