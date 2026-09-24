// P1 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ToolRegistry, builtinTools } from '../../../src/runtime/tools.js';
import { loadPersonas, promptCost } from '../../../src/runtime/personas.js';
import { estimateTokens } from '../../../src/runtime/tokens.js';
import { openaiLLM, limitLLM } from '../../../src/runtime/openai.js';
import { PersonaBudgetError, PersonaConfigError, type LLM } from '../../../src/runtime/contract.js';

function registry() {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

describe('context budget', () => {
  it('estimates tokens conservatively', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('ships the four v1 personas, each within its own budget and within 6000 tokens', () => {
    const reg = registry();
    const ps = loadPersonas('personas', reg);
    for (const name of ['alfred', 'coder', 'researcher', 'coder-lg']) {
      const p = ps.get(name);
      expect(p, name).toBeDefined();
      expect(p!.promptBudgetTokens).toBeLessThanOrEqual(6000);
      expect(promptCost(p!, reg)).toBeLessThanOrEqual(p!.promptBudgetTokens);
      expect(p!.system).toMatch(/give_up/);
      expect(p!.system).toMatch(/ask_claude/);
    }
    expect(ps.get('alfred')!.canSpawn).toEqual(expect.arrayContaining(['coder', 'researcher']));
  });

  it('refuses a persona whose prompt plus tools exceed its budget, naming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(dir, 'chatty.yaml'), [
      'name: chatty', 'description: too much', 'promptBudgetTokens: 500', 'canSpawn: []',
      'tools: [read_file, write_file, run_shell, finish, give_up, ask_claude]',
      'system: |', '  ' + 'You are extremely verbose. '.repeat(200),
    ].join('\n'));
    expect(() => loadPersonas(dir, registry())).toThrow(PersonaBudgetError);
    expect(() => loadPersonas(dir, registry())).toThrow(/chatty/);
  });

  it('refuses unknown tools and dangling canSpawn', () => {
    const d1 = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(d1, 'x.yaml'), 'name: x\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: []\ntools: [teleport]\nsystem: hi give_up ask_claude\n');
    expect(() => loadPersonas(d1, registry())).toThrow(PersonaConfigError);
    const d2 = mkdtempSync(join(tmpdir(), 'alfred-p-'));
    writeFileSync(join(d2, 'y.yaml'), 'name: y\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: [ghost]\ntools: [spawn_subagent, finish]\nsystem: hi give_up ask_claude\n');
    expect(() => loadPersonas(d2, registry())).toThrow(PersonaConfigError);
  });
});

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
