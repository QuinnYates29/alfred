// Local Jev backend (llama-server /v1/decision). NEVER the real network: fetch is always a stub.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import { DEFAULT_JEV_POLICY, loadJevPolicy } from '../../src/jev/policy.js';
import { localJevClient, toDecisionField, toJevAnswer, LOCAL_STATE_CHAR_CAP } from '../../src/jev/local.js';
import { askRisk } from '../../src/jev/risk.js';
import { createJevModule } from '../../src/jev/index.js';
import type { JevQuestion } from '../../src/jev/client.js';

const POL = { ...DEFAULT_JEV_POLICY, backend: 'local' as const };

const decision = (fields: Record<string, any>) =>
  new Response(
    JSON.stringify({ object: 'decision', results: [{ decision: {}, fields }], usage: { prompt_tokens: 80, context_tokens: 20 } }),
    { status: 200 },
  );

function fakeFetch(handler: (body: any) => Response) {
  const calls: { url: string; body: any }[] = [];
  const fn = async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return handler(body);
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

const NOUL: JevQuestion = { type: 'noul', instructions: 'Is it risky?', criteria: { true: 'could break prod', false: 'harmless' } };
const CHOICE: JevQuestion = { type: 'choice', instructions: 'Scope?', criteria: { read_only: 'reads only', deploy: null } };
const SCORE: JevQuestion = { type: 'score', instructions: 'Risk level?', criteria: ['low', 'medium', 'high'] };

describe('local Jev backend — mapping', () => {
  it('maps each question type to one constrained decision field', () => {
    expect(toDecisionField(NOUL)).toMatchObject({ type: 'boolean' });
    expect(String(toDecisionField(NOUL).description)).toContain('could break prod');
    expect(toDecisionField(CHOICE)).toMatchObject({ type: 'enum', choices: ['read_only', 'deploy'] });
    expect(String(toDecisionField(CHOICE).description)).toContain('read_only: reads only');
    expect(toDecisionField(SCORE)).toMatchObject({ type: 'enum', choices: ['low', 'medium', 'high'] });
  });

  it('turns decision probabilities into Jev answers (noul = P(true), score = expected level)', () => {
    expect(toJevAnswer(NOUL, { value: false, probability: 0.8, probabilities: { true: 0.2, false: 0.8 } })).toEqual({ type: 'noul', noul: 0.2 });
    expect(toJevAnswer(NOUL, { value: false, probability: 0.8 })!.noul).toBeCloseTo(0.2);
    const c = toJevAnswer(CHOICE, { value: 'deploy', probability: 0.9, probabilities: { read_only: 0.1, deploy: 0.9 } })!;
    expect(c).toMatchObject({ type: 'choice', choice: 'deploy', confidence: 0.9 });
    const s = toJevAnswer(SCORE, { value: 'medium', probability: 0.5, probabilities: { low: 0.25, medium: 0.5, high: 0.25 } })!;
    expect(s).toMatchObject({ type: 'score', legend: 'medium', score: 1 });
  });

  it('refuses NaN scores (JSON null) instead of reading them as 0', () => {
    expect(toJevAnswer(NOUL, { value: true, probability: null })).toBeNull();
    expect(toJevAnswer(CHOICE, { value: 'deploy', probability: null, probabilities: { read_only: null, deploy: null } })).toBeNull();
    // a null inside the map drops the map, the chosen probability still counts
    expect(toJevAnswer(NOUL, { value: true, probability: 0.7, probabilities: { true: null, false: 0.3 } })).toEqual({ type: 'noul', noul: 0.7 });
  });
});

describe('local Jev backend — client', () => {
  it('posts one /v1/decision call with redacted, capped state and returns Jev-shaped answers', async () => {
    const f = fakeFetch(() =>
      decision({
        risky: { value: true, probability: 0.9, probabilities: { true: 0.9, false: 0.1 } },
        scope: { value: 'deploy', probability: 0.7, probabilities: { read_only: 0.3, deploy: 0.7 } },
      }),
    );
    const records: any[] = [];
    const c = localJevClient('http://127.0.0.1:1110', { SECRET_TOKEN: 'sk-supersecretvalue123' }, POL, f.fn, { onCall: (r) => records.push(r) })!;
    const big = 'x'.repeat(LOCAL_STATE_CHAR_CAP * 2) + ' sk-supersecretvalue123';
    const out = await c.ask(big, { risky: NOUL, scope: CHOICE }, 'risk');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://127.0.0.1:1110/v1/decision');
    const ctx = f.calls[0].body.contexts[0] as string;
    expect(ctx.length).toBeLessThanOrEqual(LOCAL_STATE_CHAR_CAP);
    expect(ctx).not.toContain('sk-supersecretvalue123');
    expect(Object.keys(f.calls[0].body.schema)).toEqual(['risky', 'scope']);
    expect(out!.answers.risky.noul).toBe(0.9);
    expect(out!.answers.scope.choice).toBe('deploy');
    expect(out!.usage.input_tokens).toBe(100);
    expect(records[0]).toMatchObject({ ok: true, use: 'risk', backend: 'local' });
  });

  it('fails open: HTTP error, bad body, missing field, NaN answer, throw', async () => {
    const cases: (() => Response)[] = [
      () => new Response('{"error":"decision-seqs not set"}', { status: 400 }),
      () => new Response('not json', { status: 200 }),
      () => decision({}),
      () => decision({ risky: { value: true, probability: null } }),
      () => {
        throw new Error('ECONNREFUSED');
      },
    ];
    for (const h of cases) {
      const c = localJevClient('http://127.0.0.1:1110', {}, POL, fakeFetch(h).fn)!;
      expect(await c.ask('state', { risky: NOUL }, 'tool')).toBeNull();
    }
  });

  it('is null for a bad URL or when disabled, and rejects invalid questions without calling', async () => {
    expect(localJevClient('ftp://x', {}, POL)).toBeNull();
    expect(localJevClient('not a url', {}, POL)).toBeNull();
    expect(localJevClient('http://127.0.0.1:1110', {}, { ...POL, enabled: false })).toBeNull();
    const f = fakeFetch(() => decision({}));
    const c = localJevClient('http://127.0.0.1:1110', {}, POL, f.fn)!;
    expect(await c.ask('s', { q: { type: 'score', instructions: 'x', criteria: ['one'] } as any }, 'tool')).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('drives the approval risk annotation end to end', async () => {
    const f = fakeFetch(() =>
      decision({
        scope: { value: 'publishes_or_deploys', probability: 0.93 },
        injection: { value: false, probability: 0.95, probabilities: { true: 0.05, false: 0.95 } },
        risk: { value: 'high', probability: 0.8, probabilities: { low: 0.05, medium: 0.15, high: 0.8 } },
      }),
    );
    const c = localJevClient('http://127.0.0.1:1110', {}, POL, f.fn)!;
    const r = await askRisk(c, { action: 'shell', detail: 'npm publish --access public' });
    expect(r).not.toBeNull();
    expect(r!.escalate).toBe(true);
  });
});

describe('local Jev backend — policy + module', () => {
  let root: string;
  let store: Store;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jev-local-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    store = openStore(join(root, 'a.db'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const deps = (fetchFn: typeof fetch): ModuleDeps =>
    ({ store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root, extra: { repoRoot: root, fetch: fetchFn } }) as any;

  it('defaults to the hosted backend; config/jev.yaml selects local', async () => {
    const f = fakeFetch(() => decision({ ok: { value: true, probability: 0.99 } }));
    expect(loadJevPolicy(deps(f.fn)).backend).toBe('typesafe');
    // hosted + no key = no client (unchanged behaviour)
    expect((createJevModule(deps(f.fn)) as any).client()).toBeNull();
    writeFileSync(join(root, 'config', 'jev.yaml'), 'backend: local\nlocalUrl: http://127.0.0.1:1111\nlocalTimeoutMs: 5000\n');
    const p = loadJevPolicy(deps(f.fn));
    expect(p).toMatchObject({ backend: 'local', localUrl: 'http://127.0.0.1:1111', localTimeoutMs: 5000 });
    const m: any = createJevModule(deps(f.fn));
    const out = await m.client().ask('x', { ok: { type: 'noul', instructions: 'ok?' } }, 'health');
    expect(out.answers.ok.noul).toBe(0.99);
    expect(f.calls[0].url).toBe('http://127.0.0.1:1111/v1/decision');
    const ev = store.events('').filter((e) => e.kind === 'jev');
    expect(ev[0].data).toMatchObject({ ok: true, backend: 'local' });
  });

  it('ignores an unknown backend value', () => {
    writeFileSync(join(root, 'config', 'jev.yaml'), 'backend: gpt\n');
    expect(loadJevPolicy(deps(fakeFetch(() => decision({})).fn)).backend).toBe('typesafe');
  });
});
