// ALF-7 — a goal is active while coder-lg reviews it (and only then), and transcripts carry the model's
// thinking separately plus each tool call's input next to its output.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { RepoHub } from '../../src/git/hub.js';
import { createReviewModule } from '../../src/review/index.js';
import { runPeerReview } from '../../src/review/peer.js';
import { openaiLLM, splitThink } from '../../src/runtime/openai.js';
import type { ModuleDeps } from '../../src/modules.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

describe('thinking is kept apart from the answer', () => {
  it('splits <think> blocks and a leading "…</think>" whose opening tag the template emitted', () => {
    expect(splitThink('<think>plan it</think>Done.')).toEqual({ content: 'Done.', thinking: 'plan it' });
    expect(splitThink('I should read the file first.\n</think>\n\nReading it now.')).toEqual({ content: 'Reading it now.', thinking: 'I should read the file first.' });
    expect(splitThink('Just an answer.')).toEqual({ content: 'Just an answer.', thinking: '' });
  });

  it('the adapter returns llama-server reasoning_content as thinking, never as content', async () => {
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'tail</think>The answer.', reasoning_content: 'Server-side reasoning.' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const llm = openaiLLM({ baseUrl: `http://127.0.0.1:${(srv.address() as any).port}`, model: 'm' });
      const r = await llm.chat({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] } as any);
      expect(r.content).toBe('The answer.');
      expect(r.thinking).toBe('Server-side reasoning.\n\ntail');
    } finally {
      srv.close();
    }
  });
});

describe('goal status while coder-lg reviews', () => {
  it('is active during the review, returns to what its tasks say after, and does not re-trigger itself', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alf7-status-'));
    const src = join(root, 'src');
    mkdirSync(src);
    git(src, 'init', '-q');
    writeFileSync(join(src, 'app.js'), 'v1\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'init');
    const hub = new RepoHub({ root: join(root, 'hub') });
    await hub.ensure('proj', src);
    const store = openStore(':memory:');
    store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
    const bin = join(root, 'py');
    writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\nsleep 1\nprintf '%s\\n' '{"ok":true,"checksOk":true,"findings":[],"reviewed":["app.js"]}'\n`);
    chmodSync(bin, 0o755);
    const deps = {
      store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: join(root, 'work'),
      nodes: {} as any, repoHub: hub, deckState: { url: null }, extra: { lgPython: bin }, modules: {}, personas: new Map(),
    } as ModuleDeps;

    // a goal whose only task is done, with a pushed branch, opted into peer review
    const g = store.createGoal({ title: 'G', acceptance: [{ name: 'a', cmd: 'true' }], meta: { repo: 'proj', peerReview: true } } as any);
    const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const wt = join(root, 'wt');
    git(root, 'clone', '-q', hub.barePath('proj'), wt);
    git(wt, 'checkout', '-q', '-b', 'alfred/g/1');
    writeFileSync(join(wt, 'app.js'), 'v2\n');
    git(wt, 'commit', '-qam', 'v2');
    git(wt, 'push', '-q', 'origin', 'alfred/g/1');
    store.appendEvent(g.id, t.id, 'pushed', { branch: 'alfred/g/1', sha: git(wt, 'rev-parse', 'HEAD') });
    store.claim(t.id, 'w', 60_000);
    store.transition(t.id, 'verifying', { by: 'w' });

    createReviewModule(deps); // installs the done → review trigger
    store._markDone(t.id, 'w'); // goal → done → the review starts
    const end = Date.now() + 5000;
    while (store.getGoal(g.id)!.status !== 'active' && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(store.getGoal(g.id)!.status).toBe('active'); // being reviewed
    while (!store.events(g.id).some((e) => e.kind === 'peer_review') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));
    expect(store.getGoal(g.id)!.status).toBe('done'); // back to what its tasks say
    expect(store.events(g.id).filter((e) => e.kind === 'peer_review_started')).toHaveLength(1); // no review loop
    expect(store.events(g.id).filter((e) => e.kind === 'goal_status').map((e) => e.data)).toEqual([
      { status: 'done' }, { status: 'active', reason: 'peer review' }, { status: 'done', reason: 'peer review finished' },
    ]);

    // a manual review of a failed goal: active while it runs, failed again after
    const f = store.createGoal({ title: 'F', acceptance: [{ name: 'a', cmd: 'true' }], meta: { repo: 'proj' } } as any);
    const ft = store.createTask({ goalId: f.id, persona: 'coder', title: 'T', spec: 's' });
    store.appendEvent(f.id, ft.id, 'pushed', { branch: 'alfred/g/1', sha: 'x' });
    store.claim(ft.id, 'w', 60_000);
    store.transition(ft.id, 'failed', { reason: 'x' });
    const run = runPeerReview(deps, store.getGoal(f.id)!);
    await new Promise((r) => setTimeout(r, 200));
    expect(store.getGoal(f.id)!.status).toBe('active');
    await run;
    expect(store.getGoal(f.id)!.status).toBe('failed');

    // a restart mid-review leaves it active: the review module repairs that at boot
    store.setGoalActive(f.id, 'peer review');
    createReviewModule(deps);
    expect(store.getGoal(f.id)!.status).toBe('failed');
  });
});
