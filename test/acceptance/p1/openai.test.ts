// P1 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { openaiLLM, limitLLM } from '../../../src/runtime/openai.js';
import type { LLM } from '../../../src/runtime/contract.js';

describe('openai client', () => {
  it('speaks the chat-completions tool protocol and strips think blocks', async () => {
    const bodies: any[] = [];
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', c => (b += c));
      req.on('end', () => {
        bodies.push(JSON.parse(b));
        if (bodies.length === 2) { res.writeHead(500); res.end('boom'); return; }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<think>secret plan</think>Doing it.',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"x"}' } },
              { id: 'c2', type: 'function', function: { name: 'note', arguments: '{not json' } },
            ] } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }));
      });
    });
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    try {
      const llm = openaiLLM({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' });
      const r = await llm.chat({
        system: 'SYS',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'p1', name: 'note', args: { text: 't' } }] },
          { role: 'tool', content: 'noted', toolCallId: 'p1', name: 'note' },
        ],
        tools: [{ name: 'note', description: 'd', parameters: { type: 'object', properties: {} } }],
      });
      expect(r.content).toBe('Doing it.');
      expect(r.toolCalls[0]).toMatchObject({ id: 'c1', name: 'write_file', args: { path: 'a.txt', content: 'x' } });
      expect(r.toolCalls[1].args).toEqual({ __raw: '{not json' });
      expect(r.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
      const sent = bodies[0];
      expect(sent.model).toBe('m');
      expect(sent.messages[0]).toMatchObject({ role: 'system', content: 'SYS' });
      expect(sent.messages[2].tool_calls[0].function.name).toBe('note');
      expect(sent.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'p1' });
      expect(sent.tools[0]).toMatchObject({ type: 'function', function: { name: 'note' } });
      await expect(llm.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(/500/);
    } finally {
      srv.close();
    }
  });

  it('limitLLM caps concurrent calls', async () => {
    let inFlight = 0, peak = 0;
    const slow: LLM = {
      async chat() {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 30));
        inFlight--;
        return { content: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0 } };
      },
    };
    const lim = limitLLM(slow, 2);
    await Promise.all(Array.from({ length: 7 }, () => lim.chat({ system: '', messages: [], tools: [] })));
    expect(peak).toBe(2);
    expect(lim.active()).toBe(0);
  });
});
