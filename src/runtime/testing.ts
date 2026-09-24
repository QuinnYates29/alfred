// Test doubles for the runtime. Written by the orchestrator.
import type { LLM, LLMRequest, LLMResponse, ToolCall } from './contract.js';

export type Step = Partial<LLMResponse> | ((req: LLMRequest) => Partial<LLMResponse> | Promise<Partial<LLMResponse>>);

let callSeq = 0;
/** Shorthand for one tool call in a scripted step. */
export function call(name: string, args: any = {}): ToolCall {
  return { id: `call_${++callSeq}`, name, args };
}

/**
 * A scripted LLM: each chat() consumes the next step. Records every request.
 * Running out of steps throws, so a test that loops forever fails fast.
 */
export function scriptedLLM(steps: Step[]): LLM & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let i = 0;
  return {
    requests,
    async chat(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      if (i >= steps.length) throw new Error(`scriptedLLM: out of steps after ${steps.length}`);
      const s = steps[i++];
      const r = typeof s === 'function' ? await s(req) : s;
      return {
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        usage: r.usage ?? { promptTokens: 100, completionTokens: 20 },
      };
    },
  };
}

/** An LLM whose calls never resolve until aborted: a hung model. */
export function hungLLM(): LLM {
  return {
    chat: (req) =>
      new Promise((_, reject) => {
        const err = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (req.signal?.aborted) return err();
        req.signal?.addEventListener('abort', err, { once: true });
      }),
  };
}
