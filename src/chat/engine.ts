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

export class ChatEngine {
  private busyThreads = new Set<string>();

  constructor(private deps: ModuleDeps, private cs: ChatStore) {}

  createThread(title?: string): Thread {
    return this.cs.createThread(title);
  }

  getThread(id: string): Thread | undefined {
    return this.cs.getThread(id);
  }

  busy(threadId: string): boolean {
    return this.busyThreads.has(threadId);
  }

  private resolveLlm(): LLM {
    const d = this.deps;
    const llm = d.extra?.llm ?? d.models?.llm('planner') ?? d.llm;
    if (!llm) throw new Error('no LLM configured');
    return llm;
  }

  async send(threadId: string, text: string, _o?: { by?: string }): Promise<ChatMessage> {
    if (!this.cs.getThread(threadId)) throw new Error(`no such thread: ${threadId}`);
    if (this.busyThreads.has(threadId)) throw new ChatBusyError(threadId);
    this.busyThreads.add(threadId);
    try {
      this.cs.addMessage({ threadId, role: 'user', content: text });
      return await this.runTurn(threadId);
    } finally {
      this.busyThreads.delete(threadId);
    }
  }

  private async runTurn(threadId: string): Promise<ChatMessage> {
    const tools = chatTools(this.deps);
    const byName = new Map(tools.map((t) => [t.schema.name, t]));
    const system = `${chatSystemPrompt(this.deps)}\n\n${stateSnapshot(this.deps)}`;
    const messages: LLMMessage[] = this.cs
      .messages(threadId, { limit: HISTORY })
      .map((m) => ({ role: m.role, content: m.content }));
    const actions: ChatAction[] = [];
    const ctx: ToolContext = {
      taskId: `chat:${threadId}`,
      goalId: '',
      workspace: this.deps.workRoot ?? '',
      persona: 'chat',
      signal: new AbortController().signal,
      acceptance: [],
      progress: () => {},
    };

    let reply = '';
    let lastText = '';
    try {
      const llm = this.resolveLlm();
      for (let i = 0; i < MAX_LLM_CALLS; i++) {
        const resp = await llm.chat({ system, messages: [...messages], tools: tools.map((t) => t.schema), maxTokens: 2048 });
        if (resp.content) lastText = resp.content;
        const calls = resp.toolCalls ?? [];
        if (calls.length === 0) {
          reply = resp.content || '(no reply)';
          break;
        }
        messages.push({ role: 'assistant', content: resp.content, toolCalls: calls });
        for (const c of calls) {
          let result: ToolResult;
          const tool = byName.get(c.name);
          if (!tool) {
            result = { ok: false, output: `unknown tool: ${c.name}` };
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
      reply = `⚠ ${e?.message ?? String(e)}`;
    }
    return this.cs.addMessage({ threadId, role: 'assistant', content: reply, actions });
  }
}
