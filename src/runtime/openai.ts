// OpenAI-compatible chat-completions client + FIFO concurrency limiter.
import type { LLM, LLMMessage, LLMRequest, LLMResponse, ToolCall } from './contract.js';

export interface OpenaiOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Per-request timeout. Default 15 minutes. */
  timeoutMs?: number;
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** Remove every <think>…</think> block and trim. */
function stripThink(s: string): string {
  return s.replace(/<think[\s\S]*?<\/think>/g, '').trim();
}

function parseArgs(raw: unknown): any {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

function toWire(m: LLMMessage): WireMessage {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content };
    case 'assistant': {
      const out: WireMessage = { role: 'assistant', content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      return out;
    }
    case 'tool': {
      const out: WireMessage = { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.name) out.name = m.name;
      return out;
    }
  }
}

export function openaiLLM(o: OpenaiOptions): LLM {
  return {
    async chat(req: LLMRequest): Promise<LLMResponse> {
      const signals: AbortSignal[] = [AbortSignal.timeout(o.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
      if (req.signal) signals.push(req.signal);
      const signal = AbortSignal.any(signals);

      const body: Record<string, unknown> = {
        model: o.model,
        messages: [{ role: 'system', content: req.system } as WireMessage, ...req.messages.map(toWire)],
      };
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      if (req.maxTokens != null) body.max_tokens = req.maxTokens;
      if (o.temperature != null) body.temperature = o.temperature;

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`;

      const res = await fetch(`${o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);

      const json: any = JSON.parse(text);
      const msg: any = json.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        args: parseArgs(tc.function?.arguments),
      }));
      const usage: any = json.usage ?? {};
      return {
        content: stripThink(String(msg.content ?? '')),
        toolCalls,
        usage: {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
        },
      };
    },
  };
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

interface QueueEntry {
  resolve: () => void;
  reject: (err: unknown) => void;
  onAbort: () => void;
}

/** FIFO semaphore around llm.chat: at most maxConcurrent in flight. */
export function limitLLM(llm: LLM, maxConcurrent: number): LLM & { active(): number; queued(): number } {
  let activeCount = 0;
  const queue: QueueEntry[] = [];

  const pump = (): void => {
    while (activeCount < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      activeCount++;
      entry.resolve();
    }
  };

  return {
    async chat(req: LLMRequest): Promise<LLMResponse> {
      if (req.signal?.aborted) throw abortError();

      let onAbort!: () => void;
      await new Promise<void>((resolve, reject) => {
        onAbort = () => {
          const i = queue.indexOf(entry);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(abortError());
          }
          // Already dequeued (running): the underlying call owns cancellation.
        };
        const entry: QueueEntry = { resolve, reject, onAbort };
        queue.push(entry);
        req.signal?.addEventListener('abort', onAbort, { once: true });
        pump();
      });

      try {
        return await llm.chat(req);
      } finally {
        req.signal?.removeEventListener('abort', onAbort);
        activeCount--;
        pump();
      }
    },
    active: () => activeCount,
    queued: () => queue.length,
  };
}
