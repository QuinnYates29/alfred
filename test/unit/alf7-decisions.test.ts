// ALF-7 — the decision layer (/v1/decision) around the coder-lg review: first "does this need a careful
// review?" (lean towards yes), last "done? safe?" (decides the verdict, marks a failed goal done, notifies).
// Plus Quinn's status override and agents' yes/no questions (ask_quinn, answered by the decision layer,
// Inbox/Slack, or a free-text reply in chat). The decision layer is faked: answers by `use`.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { RepoHub } from '../../src/git/hub.js';
import { createReviewModule } from '../../src/review/index.js';
import { runPeerReview, SKIP_REVIEW_BELOW } from '../../src/review/peer.js';
import { createApp } from '../../src/server/app.js';
import { registerApprovalStore } from '../../src/approvals.js';
import { askQuinnTool, answerFromChat, QUESTIONS_THREAD } from '../../src/questions.js';
import { openChatStore } from '../../src/chat/store.js';
import { chatTools } from '../../src/chat/tools.js';
import type { ModuleDeps } from '../../src/modules.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string, store: Store, hub: RepoHub, deps: ModuleDeps;
let answers: Record<string, any>; // use → answers
let asked: { use: string; state: any }[];
let notified: any[];

function fakeSidecar(result: object): string {
  const bin = join(root, `py-${Math.random().toString(36).slice(2)}`);
  writeFileSync(bin, `#!/bin/sh\ncat > '${join(root, 'request.json')}'\nprintf '%s\\n' '${JSON.stringify(result)}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A goal on `proj` whose (failed) task pushed a branch changing `files`. */
function failedGoalWithBranch(files: Record<string, string>) {
  const g = store.createGoal({ title: 'Graph view', body: 'add a graph view', acceptance: [{ name: 'tests', cmd: 'npm test' }], meta: { repo: 'proj' } } as any);
  const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's' });
  const wt = join(root, `wt-${g.id.slice(0, 6)}`);
  git(root, 'clone', '-q', hub.barePath('proj'), wt);
  git(wt, 'checkout', '-q', '-b', `alfred/g/${g.id.slice(0, 8)}`);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(wt, p, '..'), { recursive: true });
    writeFileSync(join(wt, p), c);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  git(wt, 'push', '-q', 'origin', 'HEAD');
  store.appendEvent(g.id, t.id, 'pushed', { branch: `alfred/g/${g.id.slice(0, 8)}`, sha: git(wt, 'rev-parse', 'HEAD') });
  store.claim(t.id, 'w', 60_000);
  store.transition(t.id, 'failed', { reason: 'p18 needs a display' });
  return store.getGoal(g.id)!;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'alf7-dec-'));
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(join(src, 'app.js'), 'v1\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  hub = new RepoHub({ root: join(root, 'hub') });
  await hub.ensure('proj', src);
  store = openStore(':memory:');
  registerApprovalStore(store);
  store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
  answers = {};
  asked = [];
  notified = [];
  const client = { ask: async (state: any, _q: any, use: string) => { asked.push({ use, state }); return answers[use] === undefined ? null : { answers: answers[use], usage: { input_tokens: 1, output_tokens: 0 }, ms: 1 }; } };
  deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: join(root, 'work'),
    nodes: {} as any, repoHub: hub, deckState: { url: null }, extra: {}, personas: new Map(),
    modules: { jev: { client: () => client, tools: [{ schema: { name: 'jev_decide' } }] } as any },
    notifier: { notify: async (n: any) => { notified.push(n); return []; } } as any,
  } as ModuleDeps;
});

describe('the decision steps around the coder-lg review', () => {
  it('first step: the line-by-line review is skipped only when confidently safe', async () => {
    const g1 = failedGoalWithBranch({ 'app.js': 'v2\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [], reviewed: [] });
    answers['review-gate'] = { issues: { type: 'noul', noul: SKIP_REVIEW_BELOW / 2 } };
    await runPeerReview(deps, g1);
    expect(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')).reviewFiles).toBe(false);

    const g2 = failedGoalWithBranch({ 'app.js': 'v3\n' });
    answers['review-gate'] = { issues: { type: 'noul', noul: 0.15 } }; // a little doubt → review
    await runPeerReview(deps, g2);
    expect(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')).reviewFiles).toBe(true);

    const g3 = failedGoalWithBranch({ 'app.js': 'v4\n' });
    delete answers['review-gate']; // no answer → review
    await runPeerReview(deps, g3);
    expect(JSON.parse(readFileSync(join(root, 'request.json'), 'utf8')).reviewFiles).toBe(true);
  });

  it('last step: a "failed" goal whose checks really passed is judged safe and done, marked done, and Quinn is told', async () => {
    const g = failedGoalWithBranch({ 'app.js': 'v2\n' });
    // the graph-view case: checks pass, but the line reviewer produced no usable verdicts
    deps.extra.lgPython = fakeSidecar({
      ok: true, checksOk: true, reviewed: ['app.js'],
      findings: [{ file: 'app.js', severity: 'major', line: null, what: 'reviewer gave no usable verdict for this file' }, { file: null, severity: 'major', line: null, what: 'reviewer gave no usable scope verdict' }],
    });
    answers['review-gate'] = { issues: { type: 'noul', noul: 0.4 } };
    answers['review-done'] = { done: { type: 'noul', noul: 0.94 }, safe: { type: 'noul', noul: 0.92 } };
    const r = await runPeerReview(deps, g);
    expect(r.verdict).toBe('approve');
    expect(r.markedDone).toBe(true);
    expect(r.decision).toMatchObject({ gate: { review: true }, final: { pDone: 0.94, pSafe: 0.92 } });
    expect(store.getGoal(g.id)!.status).toBe('done');
    expect(store.events(g.id).filter((e) => e.kind === 'goal_status').pop()!.data).toMatchObject({ status: 'done', by: 'coder-lg review' });
    expect(asked.find((a) => a.use === 'review-done')!.state).toMatchObject({ checks: 'all passed' });
    expect(notified.at(-1)).toMatchObject({ level: 'info', goalId: g.id });
    expect(notified.at(-1).title).toMatch(/approve — marked done/);
    expect(store.getOutput(store.outputs(g.id).find((o) => o.name === 'Peer review')!.id)!.content).toMatch(/Decision, last:\*\* P\(done\) 0\.94/);
  });

  it('the last step never overrides failing checks, and a doubtful "done" is changes requested', async () => {
    const a = failedGoalWithBranch({ 'app.js': 'v2\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: false, checksOutput: '1 failed', findings: [], reviewed: [] });
    answers['review-done'] = { done: { type: 'noul', noul: 0.99 }, safe: { type: 'noul', noul: 0.99 } };
    expect((await runPeerReview(deps, a)).verdict).toBe('changes_requested');
    expect(store.getGoal(a.id)!.status).toBe('failed');

    const b = failedGoalWithBranch({ 'app.js': 'v3\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [], reviewed: [] });
    answers['review-done'] = { done: { type: 'noul', noul: 0.55 }, safe: { type: 'noul', noul: 0.97 } };
    expect((await runPeerReview(deps, b)).verdict).toBe('changes_requested');
    expect(notified.at(-1).level).toBe('warn');
  });

  it('marking done does not set off another review, and Quinn can override the status any time', async () => {
    createReviewModule(deps);
    const g = failedGoalWithBranch({ 'app.js': 'v2\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [], reviewed: [] });
    answers['review-done'] = { done: { type: 'noul', noul: 0.95 }, safe: { type: 'noul', noul: 0.95 } };
    await runPeerReview(deps, g);
    await new Promise((r) => setTimeout(r, 100));
    expect(store.events(g.id).filter((e) => e.kind === 'peer_review_started')).toHaveLength(1);

    const srv: any = await new Promise((r) => { const s = createApp({ store }).listen(0, '127.0.0.1', () => r(s)); });
    try {
      const url = `http://127.0.0.1:${srv.address().port}/api/v1/goals/${g.id}`;
      const res = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'failed', reason: 'not happy with it' }) });
      expect((await res.json()).goal.status).toBe('failed');
      expect(store.events(g.id).filter((e) => e.kind === 'goal_status').pop()!.data).toEqual({ status: 'failed', reason: 'not happy with it', by: 'quinn' });
      expect((await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'weird' }) })).status).toBe(400);
    } finally {
      srv.close();
    }
  });
});

describe('agents ask Quinn yes/no questions', () => {
  const ctxFor = (taskId: string, goalId: string) => ({ taskId, goalId, workspace: root, persona: 'coder', signal: new AbortController().signal, acceptance: [], progress: () => {} });

  it('the decision layer answers when it is sure', async () => {
    const g = store.createGoal({ title: 'G' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 'update the README too' });
    answers.question = { answer: { type: 'choice', choice: 'yes', probabilities: { yes: 0.95, no: 0.03, ask_quinn: 0.02 } } };
    const r = await askQuinnTool(deps).run({ question: 'Should I update the README too?' }, ctxFor(t.id, g.id));
    expect(r.output).toMatch(/^YES — answered by the decision layer/);
    expect(r.park).toBeUndefined();
    expect(store.approvals({ status: 'pending' })).toHaveLength(0);
    expect(store.events(g.id).some((e) => e.kind === 'question_auto')).toBe(true);
  });

  it('otherwise Quinn is asked (Inbox / Slack / chat), a chat reply answers it, and the task resumes with the answer', async () => {
    const g = store.createGoal({ title: 'Graph view' });
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's' });
    store.claim(t.id, 'w', 60_000);
    answers.question = { answer: { type: 'choice', choice: 'ask_quinn', probabilities: { yes: 0.3, no: 0.2, ask_quinn: 0.5 } } };
    const tool = askQuinnTool(deps);
    const q = 'Should the graph be the default view?';
    const r = await tool.run({ question: q }, ctxFor(t.id, g.id));
    expect(r.park).toMatchObject({ status: 'blocked' });
    store.transition(t.id, 'blocked', { reason: r.park!.reason });
    expect(store.approvals({ status: 'pending' })).toMatchObject([{ action: 'question', detail: `Q: ${q}` }]);
    const cs = openChatStore(store);
    const thread = cs.listThreads().find((x) => x.title === QUESTIONS_THREAD)!;
    expect(cs.messages(thread.id).at(-1)!.content).toContain(q);

    // Quinn replies in that thread in his own words
    answers['question-reply'] = { answer: { type: 'choice', choice: 'no', probabilities: { yes: 0.05, no: 0.9, unclear: 0.05 } } };
    expect(await answerFromChat(deps, cs, thread.id, 'nah, keep the list as default')).not.toBeNull();
    expect(store.getTask(t.id)!.status).toBe('queued');
    expect(store.getTask(t.id)!.notes).toContain(`Quinn answered NO — Q: ${q}`);
    expect((await tool.run({ question: q }, ctxFor(t.id, g.id))).output).toBe(`Quinn answered NO — ${q}`);

    // an unrelated message is left to the normal chat
    store.claim(t.id, 'w', 60_000);
    await tool.run({ question: 'Another one?' }, ctxFor(t.id, g.id));
    answers['question-reply'] = { answer: { type: 'choice', choice: 'unclear', probabilities: { yes: 0.1, no: 0.1, unclear: 0.8 } } };
    expect(await answerFromChat(deps, cs, thread.id, 'what does the graph look like?')).toBeNull();
  });

  it('chat can classify with jev_decide', () => {
    expect(chatTools(deps).map((t) => t.schema.name)).toContain('jev_decide');
  });
});
