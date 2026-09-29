// J2 §2 — the done-gate reviewer. Called from src/runtime/agent.ts doFinish() before a task
// moves to `verifying`: does the deliverable actually do what the spec asked?
//
// SEAM: agent.ts does not know about Jev. The jev module installs a hook here at start()
// (registerReviewHook); tests replace it with setJevForTests(fn). With no hook — or a hook that
// throws or returns null — the finish behaves exactly as it did before (fail-open).
import type { Task } from '../types.js';
import type { Store } from '../store.js';
import type { JevClient, JevQuestion } from './client.js';
import type { JevPolicy, JevMode } from './policy.js';

export interface RecentCall {
  name: string;
  args: string;
  ok: boolean;
  output: string;
}

export interface ReviewInput {
  task: Task;
  /** The finish summary — for report goals this IS the deliverable. */
  summary: string;
  /** The last tool calls of this run, oldest first. */
  recent?: RecentCall[];
}

export interface JevReviewEvent {
  mode: JevMode;
  addresses: number | null;
  complete: number | null;
  quality: number | null;
  failureMode: string | null;
  confidence: number | null;
  ms: number;
  verdict: 'pass' | 'reject';
}

export interface ReviewDecision {
  event: JevReviewEvent;
  /** True only in `enforce` mode, under the per-task rejection budget: do not transition. */
  blocked: boolean;
  feedback: string;
}

export type ReviewHook = (input: ReviewInput) => Promise<ReviewDecision | null>;

let hook: ReviewHook | null = null;

/** Install (or clear with null) the done-gate hook. The jev module owns this in production. */
export function registerReviewHook(h: ReviewHook | null): void {
  hook = h;
}

/**
 * TEST SEAM: set the done-gate hook directly (null restores "no Jev").
 * The acceptance unit tests use this instead of booting the module.
 */
export function setJevForTests(h: ReviewHook | null): void {
  hook = h;
}

export function hasReviewHook(): boolean {
  return hook !== null;
}

/** The only entry point agent.ts uses: never throws, never blocks a finish by accident. */
export async function reviewFinish(input: ReviewInput): Promise<ReviewDecision | null> {
  if (!hook) return null;
  try {
    return (await hook(input)) ?? null;
  } catch {
    return null;
  }
}

// ---- the prompt ----

const round2 = (n: number) => Math.round(n * 100) / 100;

const callLine = (c: RecentCall) =>
  `${c.name}(${(c.args ?? '').slice(0, 120)}) → ${c.ok ? 'ok' : 'FAILED'}: ${(c.output ?? '').slice(0, 300).replace(/\s+/g, ' ')}`;

export function buildReviewState(input: ReviewInput) {
  return {
    spec: (input.task.spec ?? '').slice(0, 6000),
    deliverable: (input.summary ?? '').slice(0, 24000),
    recent_work: (input.recent ?? []).slice(-8).map(callLine).join('\n'),
    checks: (input.task.acceptance ?? []).map((c) => c.name).join(', '),
  };
}

export const FAILURE_MODES: Record<string, string | null> = {
  none: 'nothing is wrong with it',
  incomplete: 'parts the spec asked for are missing',
  off_topic: 'it is about something other than what the spec asked for',
  plan_not_result: 'it describes what will be done instead of delivering it',
  unsupported_claims: 'it asserts things it did not verify',
  wrong_format: 'the content is right but the format/shape is wrong',
};

export const QUALITY_LEVELS = ['unusable', 'weak', 'acceptable', 'good', 'excellent'];

export function buildReviewQuestions(): Record<string, JevQuestion> {
  return {
    addresses_spec: {
      type: 'noul',
      instructions: 'Does `deliverable` do what `spec` asks, as opposed to describing a plan or partial work?',
    },
    complete: {
      type: 'noul',
      instructions:
        "Is `deliverable` complete and self-contained (no placeholders, TODOs, 'I will…', or missing sections the spec asked for)?",
    },
    quality: {
      type: 'score',
      criteria: QUALITY_LEVELS,
      instructions: 'How useful is `deliverable` for the person who wrote `spec`?',
    },
    failure_mode: {
      type: 'choice',
      criteria: FAILURE_MODES,
      instructions: 'What is most wrong with `deliverable`, if anything?',
    },
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? round2(n) : null;
};

/** The mode that applies to this task: report goals use `report`, everything else `code`. */
export function reviewModeFor(policy: JevPolicy, task: Task): JevMode {
  const report = (task.acceptance ?? []).some((c) => c.name === 'report' && c.cmd === 'test "$(wc -c < REPORT.md)" -ge 200');
  return report ? policy.review.report : policy.review.code;
}

export interface MakeReviewHook {
  client: () => JevClient | null;
  policy: () => JevPolicy;
  store: Store;
}

/** The production hook: asks Jev, records the `review` event, decides pass/reject. */
export function makeReviewHook({ client, policy, store }: MakeReviewHook): ReviewHook {
  return async ({ task, summary, recent }) => {
    const jev = client();
    if (!jev) return null;
    const pol = policy();
    const mode = reviewModeFor(pol, task);
    if (mode === 'off') return null;
    const res = await jev.ask(buildReviewState({ task, summary, recent }), buildReviewQuestions(), 'review', {
      goalId: task.goalId,
    });
    if (!res) return null;
    const a = res.answers ?? {};
    const addresses = num(a.addresses_spec?.noul);
    const complete = num(a.complete?.noul);
    const quality = num(a.quality?.score);
    const failureMode = typeof a.failure_mode?.choice === 'string' ? a.failure_mode.choice : null;
    const lows = [addresses, complete].filter((x): x is number => x !== null);
    const confidence = lows.length ? round2(Math.min(...lows)) : null;
    const weak = addresses !== null && addresses < pol.review.rejectBelow;
    const notComplete = complete !== null && complete < pol.review.rejectBelow;
    const reject = weak || notComplete;
    let blocked = false;
    if (reject && mode === 'enforce') {
      let prior = 0;
      try {
        prior = store
          .events(task.goalId)
          .filter((e) => e.kind === 'review' && e.taskId === task.id && e.data?.verdict === 'reject').length;
      } catch {
        prior = 0;
      }
      blocked = prior < pol.review.maxRejections;
    }
    const feedback =
      `Reviewer (Jev) rejected the deliverable: failure_mode=${failureMode ?? 'unknown'}, ` +
      `addresses_spec=${addresses ?? 'n/a'}, complete=${complete ?? 'n/a'}. ` +
      'Fix what is missing, then call finish again.';
    const event: JevReviewEvent = {
      mode,
      addresses,
      complete,
      quality,
      failureMode,
      confidence,
      ms: res.ms,
      verdict: reject ? 'reject' : 'pass',
    };
    try {
      store.appendEvent(task.goalId, task.id, 'review', event);
      if (mode === 'advisory') {
        store.appendNote(
          task.id,
          `Review (Jev): quality ${quality ?? '?'}/${QUALITY_LEVELS.length - 1}, failure_mode ${failureMode ?? 'none'}`,
        );
      }
    } catch {
      /* the event log must never break a finish */
    }
    return { event, blocked, feedback };
  };
}
