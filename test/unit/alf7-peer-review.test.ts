// ALF-7 — optional coder-lg peer review: a fresh clone at the exact commit, the sidecar in review mode,
// a verdict computed in code (safety rails always need Quinn), and deploy's gate on it.
// The sidecar is faked with a script that records its stdin request and prints a canned result.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import { RepoHub } from '../../src/git/hub.js';
import { createReviewModule } from '../../src/review/index.js';
import { runPeerReview, verdictOf, peerReviewBlocks, guardrailFindings, reviewInProgress, type Finding } from '../../src/review/peer.js';
import type { ModuleDeps } from '../../src/modules.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string, store: Store, hub: RepoHub, deps: ModuleDeps;

/** A fake `python`: saves the request, prints `result` (or nothing → "no final JSON"). */
function fakeSidecar(result: object | null): string {
  const bin = join(root, `py-${Math.random().toString(36).slice(2)}`);
  const body = result === null ? 'exit 3' : `printf '%s\\n' '${JSON.stringify(result).replace(/'/g, "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\ncat > '${join(root, 'request.json')}'\necho '{"progress":"fake"}' >&2\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A goal on repo `proj` whose task pushed branch `br` changing `files`. */
function goalWithBranch(files: Record<string, string>, meta: Record<string, any> = {}) {
  const g = store.createGoal({ title: 'Change', body: 'make app print v2', acceptance: [{ name: 'tests', cmd: 'npm test' }], meta: { repo: 'proj', ...meta } } as any);
  const t = store.createTask({ goalId: g.id, persona: 'coder', title: 'T' });
  const wt = join(root, `wt-${g.id.slice(0, 6)}`);
  git(root, 'clone', '-q', hub.barePath(String(g.meta.repo)), wt);
  git(wt, 'checkout', '-q', '-b', `alfred/change/${g.id.slice(0, 8)}`);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(wt, p, '..'), { recursive: true });
    writeFileSync(join(wt, p), c);
  }
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'work');
  git(wt, 'push', '-q', 'origin', 'HEAD');
  const sha = git(wt, 'rev-parse', 'HEAD');
  store.appendEvent(g.id, t.id, 'pushed', { branch: `alfred/change/${g.id.slice(0, 8)}`, sha });
  return { g: store.getGoal(g.id)!, sha };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'alf7-peer-'));
  const src = join(root, 'src');
  mkdirSync(src);
  git(src, 'init', '-q');
  writeFileSync(join(src, 'app.js'), 'v1\n');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'init');
  hub = new RepoHub({ root: join(root, 'hub') });
  await hub.ensure('proj', src);
  store = openStore(':memory:');
  store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
  deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: process.cwd(), personasDir: 'personas', workRoot: join(root, 'work'),
    nodes: {} as any, repoHub: hub, deckState: { url: null }, extra: {}, modules: {}, personas: new Map(),
  } as ModuleDeps;
});

describe('verdict (code, not the model)', () => {
  const f = (severity: Finding['severity']): Finding => ({ file: 'a.ts', severity, line: null, what: 'x' });
  it('approves only passing checks with nothing above minor; safety rails always need Quinn', () => {
    expect(verdictOf(true, true, [f('minor')], ['a.ts'])).toBe('approve');
    expect(verdictOf(true, false, [], ['a.ts'])).toBe('changes_requested');
    expect(verdictOf(true, true, [f('major')], ['a.ts'])).toBe('changes_requested');
    expect(verdictOf(true, true, [], ['src/sandbox.ts'])).toBe('needs_human');
    expect(verdictOf(false, true, [], ['a.ts'])).toBe('error');
    expect(guardrailFindings(['src/jev/triage.ts', 'test/acceptance/p1/x.test.ts', 'src/ops.ts', 'sidecar/langgraph_coder/review.py']).map((x) => x.file))
      .toEqual(['src/jev/triage.ts', 'test/acceptance/p1/x.test.ts', 'sidecar/langgraph_coder/review.py']);
  });
});

describe('runPeerReview', () => {
  it('reviews the exact commit in a fresh clone and records the verdict, an event and an output', async () => {
    const { g, sha } = goalWithBranch({ 'app.js': 'v2\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, checksOutput: 'ok', findings: [{ file: 'app.js', severity: 'minor', line: 1, what: 'nit' }], reviewed: ['app.js'] });
    const r = await runPeerReview(deps, g);
    expect(r).toMatchObject({ sha, verdict: 'approve', checksOk: true, reviewed: ['app.js'] });
    const req = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8'));
    expect(req).toMatchObject({ mode: 'review', files: ['app.js'], testCmd: 'npm test', spec: 'make app print v2' });
    expect(req.diff).toContain('+v2');
    expect(store.events(g.id).find((e) => e.kind === 'peer_review')?.data).toMatchObject({ sha, verdict: 'approve' });
    expect(store.outputs(g.id).map((o) => o.name)).toContain('Peer review');
    expect(readdirSync(join(root, 'work', '.peer-review'))).toEqual([]); // clone removed
    expect(store.events(g.id).find((e) => e.kind === 'peer_review_progress')?.data).toMatchObject({ sha, msg: 'fake' }); // visible while it runs
    expect(reviewInProgress(deps, g.id)).toBeNull(); // done
  });

  it('a change to a safety rail is never approved by the agent; a broken sidecar is an error, not a pass', async () => {
    const a = goalWithBranch({ 'src/sandbox.ts': 'export {}\n' });
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [], reviewed: ['src/sandbox.ts'] });
    expect((await runPeerReview(deps, a.g)).verdict).toBe('needs_human');
    const b = goalWithBranch({ 'app.js': 'v3\n' });
    deps.extra.lgPython = fakeSidecar(null);
    const r = await runPeerReview(deps, b.g);
    expect(r.verdict).toBe('error');
    expect(r.error).toMatch(/no final JSON/);
  });

  it('runs on its own when an opted-in goal is done', async () => {
    createReviewModule(deps);
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: false, checksOutput: '1 failed', findings: [], reviewed: ['app.js'] });
    const off = goalWithBranch({ 'app.js': 'x\n' });
    const on = goalWithBranch({ 'app.js': 'y\n' }, { peerReview: true });
    store.appendEvent(off.g.id, null, 'goal_status', { status: 'done' });
    store.appendEvent(on.g.id, null, 'goal_status', { status: 'done' });
    const end = Date.now() + 5000;
    while (!store.events(on.g.id).some((e) => e.kind === 'peer_review') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const r = store.events(on.g.id).find((e) => e.kind === 'peer_review')!.data;
    expect(r.verdict).toBe('changes_requested');
    expect(r.findings[0]).toMatchObject({ severity: 'blocker' });
    expect(r.findings[0].what).toContain('1 failed');
    expect(store.events(off.g.id).some((e) => e.kind.startsWith('peer_review'))).toBe(false);
  });
});

describe("deploy's gate", () => {
  it('only an opted-in goal is gated, and only an approve of exactly the commit being landed passes', async () => {
    const plain = goalWithBranch({ 'app.js': 'a\n' });
    expect(peerReviewBlocks(deps, plain.g, plain.sha)).toBeNull();

    const { g, sha } = goalWithBranch({ 'app.js': 'b\n' }, { peerReview: true });
    expect(peerReviewBlocks(deps, g, sha)).toMatch(/wants a peer review/);
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [{ file: 'app.js', severity: 'major', line: 2, what: 'drops the error' }], reviewed: ['app.js'] });
    await runPeerReview(deps, g);
    expect(peerReviewBlocks(deps, g, sha)).toMatch(/changes requested[\s\S]*drops the error/);
    deps.extra.lgPython = fakeSidecar({ ok: true, checksOk: true, findings: [], reviewed: ['app.js'] });
    await runPeerReview(deps, g);
    expect(peerReviewBlocks(deps, g, sha)).toBeNull();
    expect(peerReviewBlocks(deps, g, 'f'.repeat(40))).toMatch(/wants a peer review of ffffffff/); // a newer commit needs its own
    expect(existsSync(join(root, 'work', '.peer-review'))).toBe(true);
  });
});

describe('a review in progress, and goals on alfred', () => {
  it('reports its step while it runs; a pre-Auto goal on alfred is reviewed against today\'s dev gate', async () => {
    store.upsertRepo({ name: 'alfred', paths: { local: join(root, 'src') } });
    await hub.ensure('alfred', join(root, 'src'));
    const { g } = goalWithBranch({ 'web/src/x.jsx': 'export {}\n' }, { repo: 'alfred' }); // stored checks: a stale hand-set 'npm test'
    const bin = join(root, 'slow-py');
    writeFileSync(bin, `#!/bin/sh\ncat > '${join(root, 'request.json')}'\necho '{"progress":"review: web/src/x.jsx (1/1)"}' >&2\nsleep 1\nprintf '%s\\n' '{"ok":true,"checksOk":true,"findings":[],"reviewed":["web/src/x.jsx"]}'\n`);
    chmodSync(bin, 0o755);
    deps.extra.lgPython = bin;
    const run = runPeerReview(deps, g);
    const end = Date.now() + 5000;
    while (!reviewInProgress(deps, g.id)?.step && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(reviewInProgress(deps, g.id)).toMatchObject({ step: 'review: web/src/x.jsx (1/1)' });
    await run;
    expect(reviewInProgress(deps, g.id)).toBeNull();
    const req = JSON.parse(readFileSync(join(root, 'request.json'), 'utf8'));
    expect(req.testCmd).toContain("--exclude 'test/acceptance/p18/**'"); // not the stale 'npm test'
    expect(req.testCmd).toContain('npm run build:web:local'); // web/ changed → build first …
    expect(req.testCmd).toMatch(/scripts\/ui-test\.mts' --smoke$/); // … and the server's own UI runner last
    expect(req.testCmd).not.toContain(join(root, 'work')); // never a runner from the reviewed checkout
  });
});
