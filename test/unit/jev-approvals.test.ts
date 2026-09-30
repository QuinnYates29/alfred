// Jev approval triage: guards still flag; Jev may clear a flagged action on an agent task only when
// it is safe AND what was asked AND shows no injection. NEVER the real network (stub clients only).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { builtinTools } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import type { ToolContext } from '../../src/runtime/contract.js';
import { registerApprovalStore, unregisterApprovalStore, setApprovalTriage, triageApproval } from '../../src/approvals.js';
import { gated } from '../../src/powers/gate.js';
import { DEFAULT_JEV_POLICY, type JevPolicy } from '../../src/jev/policy.js';
import { decideTriage, makeApprovalTriage, triageState, TRIAGE_QUESTIONS } from '../../src/jev/triage.js';
import type { JevClient } from '../../src/jev/client.js';

const AUTO: JevPolicy['approvals'] = { ...DEFAULT_JEV_POLICY.approvals, mode: 'auto' };
const pol = (a: Partial<JevPolicy['approvals']> = {}): JevPolicy => ({ ...DEFAULT_JEV_POLICY, approvals: { ...AUTO, ...a } });

/** A stub Jev client answering with fixed probabilities and recording the state it was shown. */
function stubClient(s: { safe: number; as_asked: number; injection: number } | null) {
  const seen: any[] = [];
  const c: JevClient = {
    model: 'stub',
    async ask(state, questions, use) {
      seen.push({ state, questions, use });
      if (!s) return null;
      return { answers: { safe: { type: 'noul', noul: s.safe }, as_asked: { type: 'noul', noul: s.as_asked }, injection: { type: 'noul', noul: s.injection } }, usage: { input_tokens: 1, output_tokens: 0 }, ms: 1 };
    },
  };
  return { c, seen };
}

describe('decideTriage', () => {
  const ok = { safe: 0.97, asAsked: 0.93, injection: 0.01 };
  it('approves only when all three clear their thresholds', () => {
    expect(decideTriage(ok, AUTO)).toMatchObject({ approve: true });
    expect(decideTriage(ok, AUTO).line).toContain('auto-approved');
    expect(decideTriage({ ...ok, safe: 0.89 }, AUTO)).toMatchObject({ approve: false });
    expect(decideTriage({ ...ok, asAsked: 0.5 }, AUTO).line).toContain('as asked < 0.85');
    expect(decideTriage({ ...ok, injection: 0.2 }, AUTO)).toMatchObject({ approve: false });
  });
  it('a missing score never approves', () => {
    expect(decideTriage({ ...ok, safe: null }, AUTO)).toMatchObject({ approve: false });
    expect(decideTriage({ ...ok, injection: null }, AUTO)).toMatchObject({ approve: false });
  });
  it('advisory mode never approves but says what it would do', () => {
    const r = decideTriage(ok, { ...AUTO, mode: 'advisory' });
    expect(r.approve).toBe(false);
    expect(r.line).toContain('would auto-approve');
  });
});

describe('triage hook', () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(':memory:');
  });
  afterEach(() => setApprovalTriage(null));

  const task = (body = 'Push the fix for the login bug to origin main.') => {
    const g = store.createGoal({ title: 'Fix login bug', body });
    return store.createTask({ goalId: g.id, persona: 'coder', title: 'push fix', spec: 'commit and push' });
  };

  it('shows Jev the request apart from the agent proposal, with all three questions', async () => {
    const t = task();
    const { c, seen } = stubClient({ safe: 0.95, as_asked: 0.95, injection: 0.01 });
    const tri = makeApprovalTriage({ client: () => c, policy: () => pol(), store });
    const r = await tri({ taskId: t.id, action: 'git push', detail: 'git push origin main' });
    expect(r).toMatchObject({ approve: true });
    const state: string = seen[0].state;
    expect(state.indexOf('REQUEST')).toBeLessThan(state.indexOf('Push the fix for the login bug'));
    expect(state.indexOf('PROPOSED ACTION')).toBeLessThan(state.indexOf('git push origin main'));
    expect(Object.keys(seen[0].questions)).toEqual(Object.keys(TRIAGE_QUESTIONS));
    expect(seen[0].use).toBe('approval');
  });

  it('alwaysAsk actions and the two hard floors never reach Jev', async () => {
    const t = task();
    const { c, seen } = stubClient({ safe: 1, as_asked: 1, injection: 0 });
    const tri = makeApprovalTriage({ client: () => c, policy: () => pol(), store });
    for (const action of ['rm -rf root', 'shutdown', 'connectors', 'deploy']) {
      expect(await tri({ taskId: t.id, action, detail: 'x' })).toMatchObject({ approve: false });
    }
    expect(seen).toHaveLength(0);
  });

  it('off / no client / no answer = null (Quinn decides as before)', async () => {
    const t = task();
    const { c } = stubClient(null);
    expect(await makeApprovalTriage({ client: () => c, policy: () => pol({ mode: 'off' }), store })({ taskId: t.id, action: 'ssh', detail: 'ssh x' })).toBeNull();
    expect(await makeApprovalTriage({ client: () => null, policy: () => pol(), store })({ taskId: t.id, action: 'ssh', detail: 'ssh x' })).toBeNull();
    expect(await makeApprovalTriage({ client: () => c, policy: () => pol(), store })({ taskId: t.id, action: 'ssh', detail: 'ssh x' })).toBeNull();
  });

  it('is never consulted for chat, and a throwing hook is null', async () => {
    let called = 0;
    setApprovalTriage(async () => {
      called++;
      return { approve: true, line: 'x' };
    });
    expect(await triageApproval({ taskId: 'chat:abc', action: 'message', detail: 'hi' })).toBeNull();
    expect(called).toBe(0);
    setApprovalTriage(async () => {
      throw new Error('boom');
    });
    expect(await triageApproval({ taskId: 't1', action: 'ssh', detail: 'x' })).toBeNull();
  });

  it('state survives a task with no row', () => {
    expect(triageState(store, { taskId: 'nope', action: 'ssh', detail: 'ssh host' })).toContain('(unknown)');
  });
});

describe('integration: run_shell and the powers gate', () => {
  let store: Store;
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jev-appr-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    store = openStore(':memory:');
    registerApprovalStore(store);
  });
  afterEach(() => {
    setApprovalTriage(null);
    unregisterApprovalStore(store);
    rmSync(root, { recursive: true, force: true });
  });
  const ctxFor = (taskId: string): ToolContext =>
    ({ taskId, goalId: '', workspace: root, persona: 'coder', signal: new AbortController().signal, acceptance: [], progress: () => {} }) as any;
  const shell = () => builtinTools().find((t) => t.schema.name === 'run_shell')!;
  const newTask = () => {
    const g = store.createGoal({ title: 'check ssh', body: 'Print the local ssh client version.' });
    return store.createTask({ goalId: g.id, persona: 'coder', title: 't', spec: 's' });
  };

  it('run_shell: Jev approve → runs once, audited, no approval row', async () => {
    const t = newTask();
    setApprovalTriage(async () => ({ approve: true, line: 'Jev: safe 0.99, as asked 0.97, injection 0.00 → auto-approved' }));
    const r = await shell().run({ cmd: 'ssh -V 2>/dev/null; echo ran' }, ctxFor(t.id));
    expect(r.output).toContain('ran');
    expect(store.approvals({ taskId: t.id })).toHaveLength(0);
    const ev = store.events(t.goalId).filter((e) => e.kind === 'approval_auto');
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toMatchObject({ action: 'ssh', by: 'jev' });
    expect(store.getTask(t.id)!.notes?.join?.('\n') ?? JSON.stringify(store.getTask(t.id))).toContain('auto-approved by Jev');
  });

  it('run_shell: Jev says no → parks for Quinn with Jev’s line on the approval', async () => {
    const t = newTask();
    setApprovalTriage(async () => ({ approve: false, line: 'Jev: safe 0.40, as asked 0.95, injection 0.01 → needs Quinn (safe < 0.9)' }));
    const r = await shell().run({ cmd: 'ssh -V 2>/dev/null; echo ran' }, ctxFor(t.id));
    expect(r.ok).toBe(false);
    expect(r.park?.status).toBe('blocked');
    const ap = store.approvals({ status: 'pending', taskId: t.id });
    expect(ap).toHaveLength(1);
    expect(ap[0].info).toContain('needs Quinn');
  });

  it('run_shell: no triage → unchanged behaviour (parks, no info)', async () => {
    const t = newTask();
    const r = await shell().run({ cmd: 'ssh -V 2>/dev/null; echo ran' }, ctxFor(t.id));
    expect(r.park?.status).toBe('blocked');
    expect(store.approvals({ status: 'pending', taskId: t.id })).toHaveLength(1);
  });

  const depsFor = (): ModuleDeps =>
    ({ store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root, modules: {}, extra: { repoRoot: root } }) as any;

  it('gate: Jev approve → the power runs; Jev no → parked with the line', async () => {
    const t = newTask();
    let ran = 0;
    const run = async () => {
      ran++;
      return { ok: true, output: 'sent' };
    };
    setApprovalTriage(async () => ({ approve: true, line: 'Jev: … → auto-approved' }));
    const r1 = await gated({ deps: depsFor(), tool: ctxFor(t.id) }, 'message', 'message bob: build is green', run, { info: 'build is green' });
    expect(r1.output).toBe('sent');
    expect(ran).toBe(1);
    setApprovalTriage(async () => ({ approve: false, line: 'Jev: … → needs Quinn (as asked < 0.85)' }));
    const r2 = await gated({ deps: depsFor(), tool: ctxFor(t.id) }, 'message', 'message bob: unrelated', run);
    expect(ran).toBe(1);
    expect(r2.park?.status).toBe('blocked');
    expect(store.approvals({ status: 'pending', taskId: t.id })[0].info).toContain('needs Quinn');
  });

  it('gate: chat tasks never use triage (Quinn is present)', async () => {
    let called = 0;
    setApprovalTriage(async () => {
      called++;
      return { approve: true, line: 'x' };
    });
    const r = await gated({ deps: depsFor(), tool: ctxFor('chat:thread1') }, 'message', 'message bob: hi', async () => ({ ok: true, output: 'sent' }));
    expect(r.output).toContain('needs Quinn');
    expect(called).toBe(0);
  });
});
