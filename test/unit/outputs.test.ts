// O1 — first-class goal outputs: store, the `output` agent tool, report-goal auto-publish, API routes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, OUTPUT_MAX_BYTES, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { allTools } from '../../src/runtime/alltools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { runTask } from '../../src/runtime/agent.js';
import { scriptedLLM, call } from '../../src/runtime/testing.js';
import { createGoalWithRoot } from '../../src/ops.js';
import { createApp } from '../../src/server/app.js';
import type { Persona } from '../../src/runtime/contract.js';
import type { ToolContext } from '../../src/runtime/contract.js';

let store: Store;
let reg: ToolRegistry;
let personas: Map<string, Persona>;
let ws: string;

beforeEach(() => {
  store = openStore(':memory:');
  reg = new ToolRegistry();
  for (const t of allTools()) reg.register(t);
  personas = loadPersonas('personas', reg);
  // The orchestrator adds `output` to personas in their yaml; tests opt the researcher in locally.
  const r = personas.get('researcher')!;
  if (!r.tools.includes('output')) personas.set('researcher', { ...r, tools: [...r.tools, 'output'] });
  ws = mkdtempSync(join(tmpdir(), 'alfred-outputs-'));
});
const opts = (llm: any) => ({ store, llm, personas, registry: reg, workerId: 'w', workspaceFor: () => ws, pollMs: 20 });
const ctx = (taskId: string): ToolContext => ({
  taskId, goalId: 'g-none', workspace: ws, persona: 'chat',
  signal: new AbortController().signal, acceptance: [], progress: () => {},
});

describe('store: put / upsert / list / get / delete', () => {
  it('put returns the row (kind defaults to markdown, bytes counted)', () => {
    const g = store.createGoal({ title: 'g' });
    const row = store.putOutput({ goalId: g.id, name: 'Report', content: '# hello' });
    expect(row.id).toBeTruthy();
    expect(row.goalId).toBe(g.id);
    expect(row.kind).toBe('markdown');
    expect(row.bytes).toBe(7);
    expect(row.content).toBe('# hello');
    expect(row.createdAt).toBe(row.updatedAt);
  });

  it('list omits content and is newest first; get includes content', () => {
    const g = store.createGoal({ title: 'g' });
    const a = store.putOutput({ goalId: g.id, name: 'A', kind: 'text', content: 'aaa' });
    store.putOutput({ goalId: g.id, name: 'B', kind: 'json', content: '{}' });
    const list = store.outputs(g.id);
    expect(list.map((o) => o.name)).toEqual(['B', 'A']);
    expect(list.every((o) => o.content === undefined)).toBe(true);
    expect(store.getOutput(a.id)!.content).toBe('aaa');
    expect(store.getOutput('nope')).toBeUndefined();
  });

  it('same name upserts: same id and createdAt, new content', () => {
    const g = store.createGoal({ title: 'g' });
    const first = store.putOutput({ goalId: g.id, name: 'Report', content: 'v1' });
    const second = store.putOutput({ goalId: g.id, name: 'Report', kind: 'csv', content: 'a,b' });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.outputs(g.id)).toHaveLength(1);
    expect(store.getOutput(first.id)!.content).toBe('a,b');
    expect(store.getOutput(first.id)!.kind).toBe('csv');
  });

  it('delete removes the row; deleting twice returns false', () => {
    const g = store.createGoal({ title: 'g' });
    const row = store.putOutput({ goalId: g.id, name: 'X', content: 'x' });
    expect(store.deleteOutput(row.id)).toBe(true);
    expect(store.deleteOutput(row.id)).toBe(false);
    expect(store.outputs(g.id)).toEqual([]);
  });

  it('validates name, kind and size', () => {
    const g = store.createGoal({ title: 'g' });
    expect(() => store.putOutput({ goalId: g.id, name: '', content: 'x' })).toThrow();
    expect(() => store.putOutput({ goalId: g.id, name: 'a'.repeat(121), content: 'x' })).toThrow();
    expect(() => store.putOutput({ goalId: g.id, name: 'a/b', content: 'x' })).toThrow();
    expect(() => store.putOutput({ goalId: g.id, name: 'a\nb', content: 'x' })).toThrow();
    expect(() => store.putOutput({ goalId: g.id, name: 'ok', kind: 'pdf', content: 'x' })).toThrow(/kind/);
    expect(() => store.putOutput({ goalId: g.id, name: 'ok', content: 'x'.repeat(OUTPUT_MAX_BYTES + 1) })).toThrow(/output too large/);
    // names are trimmed; exactly 512 KB is fine
    expect(store.putOutput({ goalId: g.id, name: '  padded  ', content: 'x'.repeat(OUTPUT_MAX_BYTES) }).name).toBe('padded');
    expect(() => store.putOutput({ goalId: 'no-such-goal', name: 'ok', content: 'x' })).toThrow(/no such goal/);
  });

  it('emits an `output` event with metadata but never the content', () => {
    const g = store.createGoal({ title: 'g' });
    const row = store.putOutput({ goalId: g.id, taskId: 't-1', name: 'Report', kind: 'markdown', content: 'SECRET-CONTENT' });
    const evs = store.events(g.id).filter((e) => e.kind === 'output');
    expect(evs).toHaveLength(1);
    expect(evs[0].data).toMatchObject({ id: row.id, name: 'Report', kind: 'markdown', bytes: 14, taskId: 't-1' });
    expect(JSON.stringify(evs[0])).not.toContain('SECRET-CONTENT');
  });

  it('deleteGoal removes the goal’s outputs', () => {
    const g = store.createGoal({ title: 'g' });
    const row = store.putOutput({ goalId: g.id, name: 'X', content: 'x' });
    store.deleteGoal(g.id);
    expect(store.outputs(g.id)).toEqual([]);
    expect(store.getOutput(row.id)).toBeUndefined();
  });
});

describe('the `output` agent tool', () => {
  it('publishes from a goal task and tells the model it is visible', async () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 's' });
    const llm = scriptedLLM([
      { toolCalls: [call('output', { name: 'Findings', content: '# hello world', kind: 'markdown' })] },
      { toolCalls: [call('give_up', { reason: 'done' })] },
    ]);
    const end = await runTask(t.id, opts(llm));
    expect(end.status).toBe('failed'); // give_up: the task itself failed — the output still stands
    const list = store.outputs(g.id);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Findings');
    expect(store.getOutput(list[0].id)!.content).toBe('# hello world');
    const toolMsgs = llm.requests[1].messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.at(-1)!.content).toContain('published "Findings" (13 chars)');
  });

  it('refuses in chat (chat:<thread> has no goal) and does not throw', async () => {
    const tool = reg.get('output')!;
    const res = await tool.run({ name: 'X', content: 'y' }, ctx('chat:some-thread'));
    expect(res.ok).toBe(false);
    expect(res.output).toContain('output is for goal tasks; in chat, answer directly');
  });

  it('returns {ok:false} (never throws) on a validation error', async () => {
    const g = store.createGoal({ title: 'g' });
    const t = store.createTask({ goalId: g.id, persona: 'researcher', title: 'R', spec: 's' });
    const res = await reg.get('output')!.run({ name: 'a/b', content: 'y' }, ctx(t.id));
    expect(res.ok).toBe(false);
    expect(res.output).toContain('error');
  });
});

describe('report goals publish their report automatically', () => {
  it('a report goal finishing with a long summary gets a `Report` output', async () => {
    const report = 'Jev is TypeSafe\'s System One model. '.repeat(10);
    const { goal, task } = createGoalWithRoot(store, { title: 'Research X', spec: 'research X', persona: 'researcher' });
    const end = await runTask(task.id, opts(scriptedLLM([{ toolCalls: [call('finish', { summary: report })] }])));
    expect(end.status).toBe('done');
    expect(readFileSync(join(ws, 'REPORT.md'), 'utf8').trim()).toBe(report.trim());
    const list = store.outputs(goal.id);
    expect(list.map((o) => [o.name, o.kind])).toEqual([['Report', 'markdown']]);
    expect(store.getOutput(list[0].id)!.content).toBe(report.trim());
  });
});

describe('API routes', () => {
  let srv: any;
  let base: string;
  beforeEach(async () => {
    srv = await new Promise((r) => { const s = createApp({ store }).listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${srv.address().port}/api/v1`;
  });
  afterEach(() => srv?.close());

  it('list / get / raw (content-type + disposition) / delete; detail + list summaries carry outputs', async () => {
    const g = store.createGoal({ title: 'g' });
    const row = store.putOutput({ goalId: g.id, name: 'We"ird', kind: 'csv', content: 'a,b\n1,2' });

    const list = await (await fetch(`${base}/goals/${g.id}/outputs`)).json();
    expect(list).toHaveLength(1);
    expect(list[0].content).toBeUndefined();

    const full = await (await fetch(`${base}/goals/${g.id}/outputs/${row.id}`)).json();
    expect(full.content).toBe('a,b\n1,2');

    const raw = await fetch(`${base}/goals/${g.id}/outputs/${row.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(raw.headers.get('content-disposition')).toBe('attachment; filename="We_ird.csv"');
    expect(await raw.text()).toBe('a,b\n1,2');

    const detail = await (await fetch(`${base}/goals/${g.id}`)).json();
    expect(detail.outputs).toHaveLength(1);
    expect(detail.outputs[0].name).toBe('We"ird');

    const summaries = await (await fetch(`${base}/goals`)).json();
    expect(summaries.find((x: any) => x.id === g.id).outputs).toBe(1);

    const del = await (await fetch(`${base}/goals/${g.id}/outputs/${row.id}`, { method: 'DELETE' })).json();
    expect(del.ok).toBe(true);
    expect(await (await fetch(`${base}/goals/${g.id}/outputs`)).json()).toEqual([]);
  });

  it('404s for unknown goals/outputs and never leaks another goal’s output', async () => {
    const g = store.createGoal({ title: 'g' });
    const other = store.createGoal({ title: 'other' });
    const row = store.putOutput({ goalId: g.id, name: 'X', content: 'x' });
    expect((await fetch(`${base}/goals/nope/outputs`)).status).toBe(404);
    expect((await fetch(`${base}/goals/${g.id}/outputs/nope`)).status).toBe(404);
    for (const p of ['', '/raw', undefined]) {
      const url = `${base}/goals/${other.id}/outputs/${row.id}${p ?? ''}`;
      expect((await fetch(url)).status).toBe(404);
    }
    expect((await fetch(`${base}/goals/${other.id}/outputs/${row.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(store.getOutput(row.id)).toBeTruthy();
  });
});
