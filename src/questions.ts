// ALF-7 — agents ask Quinn yes/no questions (`ask_quinn`). The decision layer (/v1/decision) answers when
// it is sure; otherwise the question becomes a `question` approval — Inbox, Slack (yes = Approve, no = Deny)
// and the "Agent questions" chat thread — and the task waits. Quinn's free-text replies in that thread are
// classified as yes / no. The answer reaches the agent as a task note ("Quinn answered YES — Q: …").
import type { ModuleDeps } from './modules.js';
import type { Store } from './store.js';
import type { Tool, ToolContext, ToolResult } from './runtime/contract.js';
import { storeForTask } from './approvals.js';
import { openChatStore, type ChatMessage, type ChatStore } from './chat/store.js';

export const QUESTIONS_THREAD = 'Agent questions';
/** The decision layer answers for Quinn only when at least this sure of yes or no. */
export const ANSWER_AT = 0.9;
/** A chat reply counts as yes / no when the decision layer is at least this sure. */
export const REPLY_AT = 0.8;

const decider = (deps: ModuleDeps): { ask: (s: unknown, q: Record<string, any>, use: string, o?: { goalId?: string }) => Promise<{ answers: Record<string, any> } | null> } | null =>
  (deps.modules?.jev as any)?.client?.() ?? null;

/** The choice and how sure, from a decision-layer choice answer. */
function picked(a: any): { choice: string; p: number } | null {
  const choice = typeof a?.choice === 'string' ? a.choice : null;
  if (!choice) return null;
  const p = Number(a?.probabilities?.[choice] ?? a?.confidence);
  return Number.isFinite(p) ? { choice, p } : null;
}

export function questionsThreadId(cs: ChatStore): string {
  return (cs.listThreads().find((t) => t.title === QUESTIONS_THREAD) ?? cs.createThread(QUESTIONS_THREAD)).id;
}

export function askQuinnTool(deps: ModuleDeps): Tool {
  return {
    kind: 'read',
    caps: ['people'],
    schema: {
      name: 'ask_quinn',
      description: "Ask Quinn a yes/no question the spec doesn't settle. Your task may wait; the answer comes as a note.",
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['question'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const store: Store = storeForTask(ctx.taskId) ?? deps.store;
      const question = String(args?.question ?? '').trim().slice(0, 500);
      if (!question) return { ok: false, output: 'question is required' };
      const context = String(args?.context ?? '').trim().slice(0, 2000);
      const detail = `Q: ${question}`;

      // Already answered (this is the re-run after Quinn replied)?
      if (store.findApproval(ctx.taskId, detail, 'approved')) {
        store.consumeApproval(ctx.taskId, detail);
        return { ok: true, output: `Quinn answered YES — ${question}` };
      }
      if (store.findApproval(ctx.taskId, detail, 'denied')) return { ok: true, output: `Quinn answered NO — ${question}` };

      const goal = store.getGoal(ctx.goalId);
      const task = store.getTask(ctx.taskId);
      const d = decider(deps);
      if (d) {
        const out = await d
          .ask(
            { goal: goal?.title ?? '', taskSpec: (task?.spec ?? '').slice(0, 3000), question, context },
            {
              answer: {
                type: 'choice',
                instructions: `Answer this question for Quinn: ${question}`,
                criteria: {
                  yes: 'Clearly yes: given the spec and context, Quinn would say yes.',
                  no: 'Clearly no: given the spec and context, Quinn would say no.',
                  ask_quinn: "Only Quinn can answer: his preference, a permission, a judgement call, or anything irreversible or costly.",
                },
              },
            },
            'question',
            { goalId: ctx.goalId },
          )
          .catch(() => null);
        const a = picked(out?.answers?.answer);
        if (a && (a.choice === 'yes' || a.choice === 'no') && a.p >= ANSWER_AT) {
          store.appendEvent(ctx.goalId, ctx.taskId, 'question_auto', { question, answer: a.choice, p: a.p });
          return { ok: true, output: `${a.choice.toUpperCase()} — answered by the decision layer for Quinn (p=${a.p.toFixed(2)}; he was not asked): ${question}` };
        }
      }

      // Quinn decides: a `question` approval (Inbox + Slack notify on it), echoed into the chat thread.
      store.requestApproval(ctx.taskId, 'question', detail, context || undefined);
      try {
        const cs = openChatStore(store);
        cs.addMessage({
          threadId: questionsThreadId(cs),
          role: 'assistant',
          content: `**${goal?.title ?? 'A goal'}** · ${task?.persona ?? 'agent'} asks:\n\n> ${question}${context ? `\n\n${context}` : ''}\n\nReply **yes** or **no** here, or answer it in the Inbox / Slack.`,
        });
      } catch {
        /* the approval alone is enough to answer it */
      }
      const reason = `waiting for Quinn: ${question}`;
      return { ok: false, output: reason, park: { status: 'blocked', reason } };
    },
  };
}

/**
 * A message Quinn sent in the "Agent questions" thread: if it answers the oldest open question yes or no,
 * record that answer (the task resumes) and reply. Null = not an answer; the chat handles it normally.
 */
export async function answerFromChat(deps: ModuleDeps, cs: ChatStore, threadId: string, text: string): Promise<ChatMessage | null> {
  if (cs.getThread(threadId)?.title !== QUESTIONS_THREAD) return null;
  const open = deps.store.approvals({ status: 'pending' }).filter((a) => a.action === 'question');
  const q = open[0];
  if (!q) return null;
  let answer: 'yes' | 'no' | null = null;
  const d = decider(deps);
  if (d) {
    const out = await d
      .ask(
        { question: q.detail, reply: text },
        { answer: { type: 'choice', instructions: "Is Quinn's reply a yes or a no to the question?", criteria: { yes: 'Yes / agree / go ahead.', no: 'No / disagree / stop.', unclear: 'Neither, or about something else.' } } },
        'question-reply',
        { goalId: q.goalId },
      )
      .catch(() => null);
    const a = picked(out?.answers?.answer);
    if (a && (a.choice === 'yes' || a.choice === 'no') && a.p >= REPLY_AT) answer = a.choice;
  } else if (/^\s*(y|yes|yep|yeah|sure|ok(ay)?|go ahead|do it)\b/i.test(text)) answer = 'yes';
  else if (/^\s*(n|no|nope|don'?t|stop)\b/i.test(text)) answer = 'no';
  if (!answer) return null;
  deps.store.decideApproval(q.id, answer === 'yes' ? 'approved' : 'denied', 'quinn (chat)');
  const more = open.length - 1;
  return cs.addMessage({
    threadId,
    role: 'assistant',
    content: `Got it — **${answer}** to: ${q.detail.replace(/^Q: /, '')}. The agent continues.${more ? `\n\n${more} more question${more === 1 ? '' : 's'} waiting.` : ''}`,
  });
}
