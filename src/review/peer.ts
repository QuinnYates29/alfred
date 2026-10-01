// ALF-7 — optional peer review of a goal's branch by a second, deterministic agent: the coder-lg
// LangGraph sidecar in review mode (sidecar/langgraph_coder/review.py). Opt in per goal with
// `meta.peerReview: true`: it runs when the goal is done, or on demand. For a goal on alfred,
// `alfred_dev deploy` then needs an `approve` for exactly the commit it lands; Quinn's own Merge
// is never blocked by it.
//
// The model only fills a rubric (read-only tools, temperature 0, fixed file order); the verdict is
// computed here: checks + findings + a fixed list of safety rails that always need Quinn's own eyes.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModuleDeps } from '../modules.js';
import type { Goal } from '../types.js';
import { git } from './git.js';
import { resolveRepo, resolveBase, pushedBranches, DIFF_CAP } from './changes.js';
import { HttpError } from './land.js';
import { runSidecar } from '../executors/langgraph.js';
import { linkSelfDeps } from '../workspace.js';
import { isSelfRepo } from '../ops.js';

export type Severity = 'blocker' | 'major' | 'minor';
export interface Finding {
  file: string | null;
  severity: Severity;
  line: number | null;
  what: string;
}
export type Verdict = 'approve' | 'changes_requested' | 'needs_human' | 'error';

export interface PeerReview {
  sha: string;
  branch: string;
  base: string;
  verdict: Verdict;
  checksOk: boolean;
  findings: Finding[];
  reviewed: string[];
  error?: string;
}

/**
 * The harness's own safety rails: sandbox, approvals and their gates, Jev's approval policy, the hub
 * and landing, workspaces, this reviewer, the acceptance tests. A change touching one is never
 * approved by an agent — it waits for Quinn's own review and Merge.
 */
export const GUARDRAIL_RE =
  /^(src\/sandbox\.ts|src\/approvals\.ts|src\/powers\/(gate|dev)\.ts|src\/jev\/(triage|policy)\.ts|src\/git\/|src\/review\/(land|peer)\.ts|src\/workspace\.ts|src\/executors\/langgraph\.ts|sidecar\/langgraph_coder\/|config\/(powers|jev)\.yaml|test\/acceptance\/)/;

export function guardrailFindings(files: string[]): Finding[] {
  return files
    .filter((f) => GUARDRAIL_RE.test(f))
    .map((f) => ({ file: f, severity: 'major' as const, line: null, what: 'touches a safety rail of the harness: needs Quinn’s own review and Merge' }));
}

/** Decided in code, never by the model. */
export function verdictOf(ran: boolean, checksOk: boolean, findings: Finding[], files: string[]): Verdict {
  if (!ran) return 'error';
  if (files.some((f) => GUARDRAIL_RE.test(f))) return 'needs_human';
  if (!checksOk || findings.some((f) => f.severity === 'blocker' || f.severity === 'major')) return 'changes_requested';
  return 'approve';
}

/** The latest peer review recorded for this goal (optionally: of exactly `sha`). */
export function latestPeerReview(deps: Pick<ModuleDeps, 'store'>, goalId: string, sha?: string): PeerReview | null {
  let last: PeerReview | null = null;
  for (const e of deps.store.events(goalId)) {
    if (e.kind === 'peer_review' && (!sha || e.data?.sha === sha)) last = e.data as PeerReview;
  }
  return last;
}

const inflight = new Map<string, Promise<PeerReview>>();

/** Review the goal's branch head. One at a time per goal (a second call joins the first). */
export function runPeerReview(deps: ModuleDeps, goal: Goal): Promise<PeerReview> {
  const cur = inflight.get(goal.id);
  if (cur) return cur;
  const p = doReview(deps, goal).finally(() => inflight.delete(goal.id));
  inflight.set(goal.id, p);
  return p;
}

async function doReview(deps: ModuleDeps, goal: Goal): Promise<PeerReview> {
  const repo = resolveRepo(deps.store, goal);
  const branch = pushedBranches(deps.store, goal.id)[0]?.branch;
  if (!repo || !branch) throw new HttpError(409, 'nothing to review (no pushed branch)');
  const sha = await deps.repoHub.headSha(repo.name, branch);
  const base = await resolveBase(deps.repoHub, repo.name, repo);
  if (!sha || !base) throw new HttpError(409, `branch ${branch} or its base is not in the hub`);

  // A fresh clone at exactly this commit: the review never sees the agent's workspace.
  const ws = join(deps.workRoot, '.peer-review', `${goal.slug}-${sha.slice(0, 8)}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(deps.workRoot, '.peer-review'), { recursive: true });
  deps.store.appendEvent(goal.id, null, 'peer_review_started', { sha, branch, base });
  let out: PeerReview;
  try {
    await git(['clone', '-q', '--', deps.repoHub.barePath(repo.name), ws]);
    await git(['checkout', '-q', '--detach', sha], ws);
    if (isSelfRepo(deps.store, goal.meta?.repo)) linkSelfDeps(ws, repo.paths?.local);
    const files = (await git(['diff', '--name-only', `origin/${base}...${sha}`], ws)).split('\n').map((f) => f.trim()).filter(Boolean);
    const diff = (await git(['diff', `origin/${base}...${sha}`], ws)).slice(0, DIFF_CAP);
    const cmds = goal.acceptance.map((c) => c.cmd).filter(Boolean);
    const spec = deps.models?.resolve('coder');
    const run = await runSidecar({
      python: (deps.extra?.lgPython as string | undefined) ?? join(deps.repoRoot, 'sidecar', '.venv', 'bin', 'python'),
      workspace: ws,
      request: {
        mode: 'review',
        workspace: ws,
        testCmd: cmds.length ? cmds.join(' && ') : 'true',
        baseUrl: spec?.baseUrl ?? 'http://127.0.0.1:1110',
        model: spec?.model ?? 'qwen3.8-flash-next',
        spec: goal.body || goal.title,
        files,
        diff,
      },
      timeoutMs: Number(deps.extra?.peerReviewTimeoutMs ?? 60 * 60_000),
    });
    const r = run.ok ? run.result : null;
    const ran = !!r && r.ok === true;
    const findings: Finding[] = [...(ran && Array.isArray(r.findings) ? r.findings : []), ...guardrailFindings(files)];
    out = {
      sha,
      branch,
      base,
      verdict: verdictOf(ran, ran && r.checksOk === true, findings, files),
      checksOk: ran && r.checksOk === true,
      findings,
      reviewed: ran && Array.isArray(r.reviewed) ? r.reviewed.map(String) : [],
      ...(ran ? {} : { error: String(r?.error ?? (run.ok ? 'reviewer failed' : `${run.error}: ${run.tail.slice(-500)}`)) }),
    };
    if (ran && !out.checksOk && r.checksOutput) out.findings.unshift({ file: null, severity: 'blocker', line: null, what: `checks failed:\n${String(r.checksOutput).slice(-1500)}` });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
  deps.store.appendEvent(goal.id, null, 'peer_review', out);
  deps.store.putOutput({ goalId: goal.id, name: 'Peer review', kind: 'markdown', content: reportOf(out) });
  return out;
}

const VERDICT_LINE: Record<Verdict, string> = {
  approve: 'approve — checks pass and no blocking findings',
  changes_requested: 'changes requested',
  needs_human: 'needs Quinn — touches a safety rail of the harness (deploy refuses; Merge it yourself if it is right)',
  error: 'error — the review did not run',
};

export function reportOf(r: PeerReview): string {
  const lines = [
    `# Peer review (coder-lg) of \`${r.sha.slice(0, 8)}\` on \`${r.branch}\``,
    '',
    `**Verdict:** ${VERDICT_LINE[r.verdict]}`,
    `**Checks:** ${r.checksOk ? 'pass' : 'fail'} · **Files reviewed:** ${r.reviewed.length}`,
    ...(r.error ? ['', `Error: ${r.error}`] : []),
    '',
  ];
  if (!r.findings.length) lines.push('No findings.');
  for (const s of ['blocker', 'major', 'minor'] as const) {
    const fs = r.findings.filter((f) => f.severity === s);
    if (!fs.length) continue;
    lines.push(`## ${s} (${fs.length})`);
    for (const f of fs) lines.push(`- ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : ''}${f.what.replace(/\n/g, '\n  ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Deploy's question: may an agent land `sha`? (null = yes; else why not) */
export function peerReviewBlocks(deps: Pick<ModuleDeps, 'store'>, goal: Goal, sha: string): string | null {
  if (goal.meta?.peerReview !== true) return null;
  const r = latestPeerReview(deps, goal.id, sha);
  if (!r) return `${goal.slug} wants a peer review of ${sha.slice(0, 8)} first: alfred_dev review`;
  if (r.verdict !== 'approve') {
    const top = r.findings.filter((f) => f.severity !== 'minor').slice(0, 5).map((f) => `- ${f.file ?? '(change)'}: ${f.what.split('\n')[0]}`);
    return `peer review of ${sha.slice(0, 8)}: ${VERDICT_LINE[r.verdict]}${top.length ? `\n${top.join('\n')}` : ''}`;
  }
  return null;
}
