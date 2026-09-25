// P8 unit tests — compaction math, paged reads, usage accounting.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactMessages,
  estimateRequest,
  messageBudget,
  nudgeMessage,
  DIGEST_HEADER,
} from '../../src/runtime/compact.js';
import { estimateTokens } from '../../src/runtime/tokens.js';
import type { LLMMessage } from '../../src/runtime/contract.js';
import { ToolRegistry, builtinTools } from '../../src/runtime/tools.js';
import { openStore } from '../../src/store.js';

const reg = new ToolRegistry();
for (const t of builtinTools()) reg.register(t);

const turn = (i: number): LLMMessage[] => [
  { role: 'assistant', content: `step ${i}`, toolCalls: [{ id: `c${i}`, name: 'read_file', args: { path: `f${i}.txt` } }] },
  { role: 'tool', content: 'x'.repeat(600), toolCallId: `c${i}`, name: 'read_file' },
];

describe('compact', () => {
  it('estimateRequest sums system, tools and messages', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'hi' }];
    expect(estimateRequest('sys', [], msgs)).toBe(
      estimateTokens('sys') + estimateTokens('[]') + estimateTokens(JSON.stringify(msgs)),
    );
  });

  it('messageBudget reserves system+tools from the budget', () => {
    expect(messageBudget(1000, 'sys', [])).toBe(1000 - estimateTokens('sys'));
  });

  it('does not touch messages under budget', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'brief' }, ...turn(1)];
    const r = compactMessages('s', [], msgs, 10000);
    expect(r.messages).toBe(msgs);
    expect(r.dropped).toBe(0);
  });

  it('keeps the brief and the newest turn, digests the middle, never splits a tool result', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'BRIEF-TASK' }, ...turn(1), ...turn(2), ...turn(3)];
    const budget = estimateRequest('s', [], msgs) - 10; // force compaction
    const r = compactMessages('s', [], msgs, budget, (id) => id === 'c1');
    expect(estimateRequest('s', [], r.messages)).toBeLessThanOrEqual(budget);
    expect(r.messages[0].content).toContain('BRIEF-TASK');
    const digest = r.messages[1];
    expect(digest.role).toBe('user');
    expect(digest.content.startsWith(DIGEST_HEADER)).toBe(true);
    expect(digest.content).toContain('- read_file({"path":"f1.txt"}) → FAILED:');
    expect(digest.content).toContain('- read_file({"path":"f2.txt"}) → ok:');
    // newest turn survived in full — assistant + its tool result together
    const last = r.messages.at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.toolCallId).toBe('c3');
    expect(r.messages.some((m) => m.role === 'assistant' && m.content === 'step 3')).toBe(true);
  });

  it('trims the oldest digest lines with an omitted marker when over 25 % of the window', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'b' }];
    for (let i = 1; i <= 40; i++) msgs.push(...turn(i));
    const budget = 900;
    const r = compactMessages('s', [], msgs, budget);
    const digest = r.messages.find((m) => m.content.startsWith(DIGEST_HEADER))!;
    expect(estimateTokens(digest.content)).toBeLessThanOrEqual(
      Math.floor(0.25 * messageBudget(budget, 's', [])),
    );
    expect(digest.content).toMatch(/earlier steps omitted/);
  });

  it('nudgeMessage carries the percentage and the delegation sentence', () => {
    expect(nudgeMessage(57)).toMatch(/^Context at 57% of budget\./);
    expect(nudgeMessage(57)).toContain('Delegate remaining reading/implementation to a subagent');
  });
});

describe('paged read_file', () => {
  const ws = mkdtempSync(join(tmpdir(), 'alfred-p8u-'));
  const ctx: any = {
    taskId: 't', goalId: 'g', workspace: ws, persona: 'coder',
    signal: new AbortController().signal, acceptance: [], progress: () => {},
  };

  it('offset past EOF is ok with an empty body and no continuation hint', async () => {
    writeFileSync(join(ws, 'x.txt'), 'a\nb\nc');
    const r = await reg.get('read_file')!.run({ path: 'x.txt', offset: 99 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('(more:');
  });

  it('caps output at 16000 chars with a whole-line cut and continuation hint', async () => {
    writeFileSync(join(ws, 'wide.txt'), Array.from({ length: 500 }, () => 'w'.repeat(100)).join('\n'));
    const r = await reg.get('read_file')!.run({ path: 'wide.txt' }, ctx);
    expect(r.output.length).toBeLessThanOrEqual(16000);
    expect(r.output).toMatch(/\(more: offset=\d+\)/);
    const body = r.output.slice(r.output.indexOf('\n') + 1);
    for (const line of body.split('\n')) expect(line).toBe('w'.repeat(100));
  });
});

describe('store result + usage', () => {
  it('setResult stores the finish summary', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'r' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [] });
    expect(store.getTask(t.id)!.result).toBeNull();
    store.setResult(t.id, 'summary text');
    expect(store.getTask(t.id)!.result).toBe('summary text');
    store.close();
  });

  it('taskUsage counts compacted events', () => {
    const store = openStore(':memory:');
    const g = store.createGoal({ title: 'u' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [] });
    store.appendEvent(g.id, t.id, 'turn', { usage: { promptTokens: 10, completionTokens: 1 } });
    store.appendEvent(g.id, t.id, 'compacted', { before: 9, after: 3, dropped: 4 });
    expect(store.taskUsage(t.id)).toMatchObject({ promptTokens: 10, completionTokens: 1, turns: 1, compactions: 1, peakPromptTokens: 10 });
    expect(store.goalUsage(g.id).compactions).toBe(1);
    store.close();
  });
});
