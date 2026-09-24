// P2 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { langgraphTool } from '../../../src/executors/langgraph.js';
import type { ToolContext } from '../../../src/runtime/contract.js';

/** A scripted OpenAI-compatible server. Each request consumes the next reply. */
async function fakeOpenAI(replies: any[]) {
  let i = 0;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => {
      const msg = replies[Math.min(i++, replies.length - 1)];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close(), count: () => i };
}

const tc = (name: string, args: any) => ({ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function lgCtx(ws: string, acceptance = [{ name: 'answer', cmd: 'grep -q 42 answer.txt' }]) {
  const progressed: string[] = [];
  const c: ToolContext = { taskId: 't', goalId: 'g', workspace: ws, persona: 'coder-lg', signal: new AbortController().signal, acceptance, progress: m => progressed.push(m) };
  return { c, progressed };
}

describe('langgraph_code sidecar', () => {
  it('edits via constrained tools, runs the acceptance test, and reports success', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'alfred-lg-'));
    const f = await fakeOpenAI([
      { tool_calls: [tc('write_file', { path: 'answer.txt', content: 'the answer is 42\n' })] },
      { content: 'Wrote the answer.' },
    ]);
    try {
      const { c, progressed } = lgCtx(ws);
      const r = await langgraphTool({ baseUrl: f.url, model: 'm' }).run({ task: 'write the answer' }, c);
      expect(r.ok).toBe(true);
      expect(readFileSync(join(ws, 'answer.txt'), 'utf8')).toContain('42');
      expect(r.output).toContain('answer.txt');
      expect(progressed.length).toBeGreaterThan(0);
    } finally { f.close(); }
  }, 60_000);

  it('gives up after maxIterations when the tests keep failing, and cannot escape the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'alfred-lg-'));
    const escape = join(tmpdir(), `alfred-lg-escape-${Date.now()}.txt`);
    const f = await fakeOpenAI([
      { tool_calls: [tc('write_file', { path: escape, content: 'x' })] },
      { content: 'done' },
      { content: 'still done' },
    ]);
    try {
      const { c } = lgCtx(ws);
      const r = await langgraphTool({ baseUrl: f.url, model: 'm' }).run({ task: 'x', maxIterations: 2 }, c);
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/iterations[^0-9]*2/);
      expect(existsSync(escape)).toBe(false);
    } finally { f.close(); }
  }, 60_000);

  it('refuses to run without acceptance checks', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'alfred-lg-'));
    const { c } = lgCtx(ws, []);
    const r = await langgraphTool({ baseUrl: 'http://127.0.0.1:9', model: 'm' }).run({ task: 'x' }, c);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no acceptance checks/);
  });
});
