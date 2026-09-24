import { describe, it, expect } from 'vitest';
import { limitLLM, openaiLLM } from '../../src/runtime/openai.js';
import type { LLM, LLMRequest, LLMResponse } from '../../src/runtime/contract.js';

const ok: LLMResponse = { content: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
const req = (signal?: AbortSignal): LLMRequest => ({ system: '', messages: [], tools: [], signal });

describe('limitLLM', () => {
  it('runs queued call whose signal aborts as AbortError, others proceed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow: LLM = {
      async chat() {
        calls++;
        if (calls <= 2) await gate;
        return ok;
      },
    };
    const lim = limitLLM(slow, 2);
    const p1 = lim.chat(req());
    const p2 = lim.chat(req());
    const ac = new AbortController();
    const p3 = lim.chat(req(ac.signal));
    expect(lim.active()).toBe(2);
    expect(lim.queued()).toBe(1);
    ac.abort();
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' });
    expect(lim.queued()).toBe(0);
    release();
    await Promise.all([p1, p2]);
    expect(lim.active()).toBe(0);
  });

  it('rejects immediately when signal already aborted', async () => {
    const lim = limitLLM({ chat: async () => ok }, 2);
    const ac = new AbortController();
    ac.abort();
    await expect(lim.chat(req(ac.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(lim.active()).toBe(0);
    expect(lim.queued()).toBe(0);
  });

  it('FIFO order', async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const llm: LLM = {
      async chat(r: any) {
        if (first) { first = false; await gate; }
        order.push(r.tag);
        return ok;
      },
    };
    const lim = limitLLM(llm, 1);
    const ps = [0, 1, 2].map((tag) => lim.chat({ ...req(), tag } as LLMRequest & { tag: number }));
    release();
    await Promise.all(ps);
    expect(order).toEqual([0, 1, 2]);
  });
});

describe('openaiLLM request building', () => {
  it('omits tools when empty, keeps max_tokens/temperature', async () => {
    let captured: any;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init: any) => {
      captured = { url: _u, body: JSON.parse(init.body), headers: init.headers };
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const llm = openaiLLM({ baseUrl: 'http://x/v1', model: 'm', apiKey: 'k', temperature: 0.2 });
      const r = await llm.chat({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 50 });
      expect(captured.url).toBe('http://x/v1/chat/completions');
      expect(captured.headers.authorization).toBe('Bearer k');
      expect('tools' in captured.body).toBe(false);
      expect(captured.body.max_tokens).toBe(50);
      expect(captured.body.temperature).toBe(0.2);
      expect(r.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
    } finally {
      globalThis.fetch = orig;
    }
  });
});
