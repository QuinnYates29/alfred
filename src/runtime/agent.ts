// P1 — the agent loop. One task, one worker: claim → prompt → loop → outcome.
// Every exit path is a task transition; runTask itself never rejects for
// agent-level failures (tool errors, budgets, stalls, llm errors).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_WATCHDOG,
  NodeOfflineError,
  type LLMMessage,
  type LLMResponse,
  type Persona,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type WatchdogConfig,
  type WorkspaceBackend,
} from './contract.js';
import { verifyAndComplete, defaultRunner } from '../gate.js';
import { isReportCheck, autoChecks, usesAutoChecks, devAcceptance } from '../ops.js';
import { publishUiRun } from '../uitest.js';
import { execFileSync } from 'node:child_process';
import type { Store } from '../store.js';
import {
  PARKED,
  TERMINAL,
  type AcceptanceCheck,
  type CheckRunner,
  type Task,
} from '../types.js';
import type { ToolRegistry } from './tools.js';
import { parkIfNodeOffline } from './tools.js';
import type { ModelRegistry } from '../models.js';
import { DEFAULT_CONTEXT_WINDOW, queuedForSlot } from '../models.js';
import { denyReason, toolCaps } from './caps.js';
import { compactMessages, estimateRequest, nudgeMessage } from './compact.js';
import { reviewFinish } from '../jev/review.js';

export interface RunOpts {
  store: Store;
  llm: import('./contract.js').LLM;
  /** P7: when present, every call resolves its LLM per call from the registry (role switches apply on the next turn). `llm` stays the fallback. */
  models?: ModelRegistry;
  personas: Map<string, Persona>;
  registry: ToolRegistry;
  workerId: string;
  /** Optional now (P9): when absent the runtime resolves the workspace itself (nodes-aware). */
  workspaceFor?: (t: Task) => string;
  /** P9: the NodeHub; with `workRoot` it replaces `workspaceFor`. */
  nodes?: import('../node/hub.js').NodeHub;
  /** P9: base directory for local workspaces when `workspaceFor` is absent. */
  workRoot?: string;
  /** P10: the Spark repo hub. With `workRoot` (and no `workspaceFor`) the runtime resolves via
   * resolveWorkspace and publishes finished work: commit + `git push spark HEAD:<branch>`. */
  hub?: import('../git/hub.js').RepoHub;
  watchdog?: Partial<WatchdogConfig>;
  runner?: CheckRunner;
  leaseMs?: number;
  pollMs?: number;
  /** Starts a spawned child. Default: runTask(child) without awaiting. The scheduler passes a no-op. */
  spawnRunner?: (childTaskId: string) => void;
  signal?: AbortSignal;
}

const CONTROL_TOOLS = new Set(['finish', 'give_up', 'ask_claude', 'spawn_subagent', 'wait_subtasks']);
const RETRY_BACKOFF_MS = [1000, 4000];
/** A model server that is down (crash + systemd restart ≈ 15 s + model load) gets this long before the task fails. */
export const TRANSIENT_LLM_WINDOW_MS = 5 * 60_000;
const TRANSIENT_BACKOFF_MS = [2000, 5000, 10_000, 20_000, 30_000];
/** Turns-left thresholds at which the agent is told to wrap up (each once). */
const WRAP_UP_AT = [10, 3];
/** Longest a single LLM call (slot wait + generation) counts as alive before the stall watchdog may fire. */
export const LLM_CALL_MAX_MS = 40 * 60_000;
const WAIT_NOTE_EVERY_MS = 3 * 60_000;

/** Connection-level failures (server restarting / overloaded), not model or request errors. */
export function isTransientLlmError(e: unknown): boolean {
  const m = `${(e as any)?.message ?? ''} ${(e as any)?.cause?.code ?? ''} ${(e as any)?.code ?? ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|UND_ERR_SOCKET|other side closed|\b50[234]\b|Loading model/i.test(m);
}

export function wrapUpMessage(left: number, total: number): string {
  return (
    `⚠ ${left} turn${left === 1 ? '' : 's'} left of ${total}. Stop gathering. Write the deliverable the spec asks for now ` +
    `(from what your notes already hold — do not re-read material you summarised) and call finish; ` +
    `or call give_up naming exactly what is still missing.`
  );
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((r) => {
    if (signal.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      r();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function isAbortError(e: unknown): boolean {
  return (e as { name?: string })?.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Head of text plus a marker when cut (transcript events stay small). */
function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return String(v);
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function buildFirstMessage(task: Task): string {
  const parts = [
    `Title: ${task.title}`,
    '',
    'Spec:',
    task.spec || '(none)',
    '',
    'Acceptance checks (all must pass for finish):',
    ...(task.acceptance.length
      ? task.acceptance.map((c) => `- ${c.name}: ${c.cmd}`)
      : ['- (none — finish will fail the gate)']),
  ];
  if (task.notes.trim()) {
    parts.push('', '## Notes from previous attempts', task.notes);
  }
  return parts.join('\n');
}

/** Merges an external signal plus a per-call controller; returns the signal and a dispose fn. */
function linkAbort(external: AbortSignal | undefined): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (external?.aborted) ac.abort();
  external?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ac.signal,
    dispose: () => {
      external?.removeEventListener('abort', onAbort);
      ac.abort();
    },
  };
}

interface StopOutcome {
  kind: 'stopped' | 'failed';
  reason: string;
}

export async function runTask(taskId: string, o: RunOpts): Promise<Task> {
  const leaseMs = o.leaseMs ?? 5 * 60 * 1000;
  const pollMs = o.pollMs ?? 1000;
  const wd: WatchdogConfig = { ...DEFAULT_WATCHDOG, ...(o.watchdog ?? {}) };

  let task = o.store.getTask(taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);

  // 1. Claim.
  if (task.status === 'queued') {
    if (!o.store.claim(taskId, o.workerId, leaseMs)) {
      throw new Error(`task ${taskId} could not be claimed (status: ${o.store.getTask(taskId)?.status})`);
    }
    task = o.store.getTask(taskId)!;
  } else if (task.status === 'running') {
    if (task.leaseOwner !== o.workerId) {
      throw new Error(`task ${taskId} is running but leased to ${task.leaseOwner ?? 'nobody'}`);
    }
  } else {
    throw new Error(`task ${taskId} is ${task.status}; only queued or self-leased running tasks can run`);
  }

  // P12: run ownership. We own the task only while its row still carries the attempt we claimed
  // and our lease — or it sits in `verifying` right after our own finish (the transition into
  // verifying clears the lease by design). Losing ownership stops the run: abort in-flight work,
  // no further writes to the task, resolve with the current row.
  const claimedAttempt = task.attempt;
  let lostOwnership = false;
  const inFlightDisposers = new Set<() => void>();
  const ownsTask = (): boolean => {
    const t = o.store.getTask(taskId);
    if (!t || t.attempt !== claimedAttempt) return false;
    if (t.status === 'verifying') return true; // our gate; the lease is intentionally cleared here
    return t.leaseOwner === o.workerId;
  };
  const declareLost = () => {
    if (lostOwnership) return;
    lostOwnership = true;
    for (const dispose of [...inFlightDisposers]) {
      try {
        dispose();
      } catch {
        // best effort — aborting in-flight work
      }
    }
  };
  /** True when this run may no longer write to the task (and in-flight work has been aborted). */
  const ownershipLost = (): boolean => {
    if (lostOwnership) return true;
    if (ownsTask()) return false;
    declareLost();
    return true;
  };

  const personaOpt = o.personas.get(task.persona);
  if (!personaOpt) throw new Error(`no such persona: ${task.persona}`);
  const persona: Persona = personaOpt;

  // P9: resolve where this task's workspace lives (possibly on an alfred-node).
  let workspace: string;
  let backend: WorkspaceBackend | undefined;
  /** P10: publishing info from resolveWorkspace (set only on hub-managed workspaces). */
  let wsBranch: string | undefined;
  let wsRemote: string | undefined;
  if (o.workspaceFor) {
    workspace = o.workspaceFor(task);
    o.store.appendEvent(task.goalId, taskId, 'workspace', { path: workspace, node: 'local' });
  } else {
    try {
      const { resolveWorkspace } = await import('../workspace.js');
      const ws = await resolveWorkspace(o.store, task, {
        ...(o.workRoot ? { root: o.workRoot } : {}),
        ...(o.nodes ? { nodes: o.nodes } : {}),
        ...(o.hub ? { hub: o.hub } : {}),
      });
      workspace = ws.path;
      backend = ws.backend;
      wsBranch = ws.branch;
      wsRemote = ws.remote;
      // P15: where this run works, so review/file-browse can find it later.
      o.store.appendEvent(task.goalId, taskId, 'workspace', {
        path: ws.path,
        node: ws.backend?.node ?? 'local',
        ...(ws.branch ? { branch: ws.branch } : {}),
      });
    } catch (e) {
      if (e instanceof NodeOfflineError) {
        o.store.transition(taskId, 'blocked', { reason: e.message, by: o.workerId });
        return o.store.getTask(taskId)!;
      }
      throw e;
    }
  }

  /**
   * P10: commit + push the workspace to the Spark hub. Best-effort: emits
   * `pushed` {branch, sha} or `push_failed` {error} and never throws.
   */
  let publishInflight: Promise<void> | null = null;
  let lastPublishedSha: string | null = null;
  /** ALF-7: files this attempt changed against the base it started from (committed or not, incl. new files). */
  const changedFiles = async (): Promise<string[]> => {
    const cmd =
      'b=$(git rev-parse -q --verify spark/HEAD || git rev-parse -q --verify spark/master || git rev-parse -q --verify spark/main || git rev-parse HEAD); ' +
      'git diff --name-only "$(git merge-base HEAD "$b")"; git ls-files --others --exclude-standard';
    try {
      const out = backend
        ? (await backend.exec(cmd, { cwd: workspace, workspace, timeoutMs: 30_000 })).output
        : execFileSync('bash', ['-c', cmd], { cwd: workspace, encoding: 'utf8', timeout: 30_000 });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };
  /** ALF-7: screenshots a gate check (ui-smoke) left in the workspace → a goal output. Spark workspaces only. */
  const publishUiShots = async (): Promise<void> => {
    if (backend && backend.node !== 'local') return;
    publishUiRun(o.store, task!.goalId, taskId, workspace, 'UI smoke');
  };

  const publishWork = (): Promise<void> => {
    // v1 publishes Spark-side work; node workspaces push themselves via their own git.
    if (!(o.hub && o.workRoot && !o.workspaceFor && backend && wsRemote && wsBranch && backend.node === 'local')) {
      return Promise.resolve();
    }
    if (publishInflight) return publishInflight;
    publishInflight = (async () => {
      try {
        const { shq, be, identityArgs } = await import('../workspace.js');
        const b = backend!;
        const dirty = await b.exec('git status --porcelain', { cwd: workspace, timeoutMs: 30_000 });
        if (dirty.exitCode !== 0) throw new Error(`workspace is not a git repo: ${dirty.output.slice(-300)}`);
        if (dirty.output.trim()) {
          await be(b, workspace, 'git add -A');
          const idn = (await identityArgs(b, workspace)).map(shq).join(' ');
          const commit = await b.exec(
            `git ${idn ? idn + ' ' : ''}commit -m ${shq(`${task.title} (alfred)`)} --allow-empty-message`,
            { cwd: workspace, timeoutMs: 60_000 },
          );
          if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.output.slice(-400)}`);
        }
        const sha = (await b.exec('git rev-parse HEAD', { cwd: workspace, timeoutMs: 15_000 })).output.trim();
        if (!dirty.output.trim() && sha === lastPublishedSha) return;
        await be(b, workspace, `git push spark HEAD:${shq(wsBranch!)}`, 120_000);
        lastPublishedSha = sha;
        record('pushed', { branch: wsBranch, sha });
      } catch (e: any) {
        record('push_failed', { error: e?.message ?? String(e) });
      } finally {
        publishInflight = null;
      }
    })();
    return publishInflight;
  };
  const schemas = o.registry.schemasFor(persona.tools);
  const toolSet = new Set(persona.tools);

  /** P7 model precedence, evaluated per call so role switches take effect immediately. */
  const modelRef = (): string => {
    const gm = o.store.getGoal(task!.goalId)?.meta?.model;
    if (typeof gm === 'string' && gm) return gm;
    const tm = o.store.getTaskModel?.(taskId) ?? null;
    if (tm) return tm;
    return persona.model ?? 'default';
  };
  const llmForCall = () => (o.models ? o.models.llm(modelRef()) : o.llm);
  /**
   * Per-model `deny` (config/models.yaml): only ever narrows the persona's tools; re-read per call.
   * Inherited: a spawned subtask is also bound by every ancestor's model deny, so picking a
   * less-restricted model for a child can't escape a restriction.
   */
  const ancestorRefs = (): string[] => {
    const refs: string[] = [];
    const gm = o.store.getGoal(task!.goalId)?.meta?.model;
    const seen = new Set<string>([taskId]);
    let parentId = task!.parentTaskId ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const p = o.store.getTask(parentId);
      if (!p) break;
      refs.push(typeof gm === 'string' && gm ? gm : o.store.getTaskModel?.(p.id) ?? o.personas.get(p.persona)?.model ?? 'default');
      parentId = p.parentTaskId ?? null;
    }
    return refs;
  };
  const deniedNow = (): Set<string> => {
    if (!o.models) return new Set();
    const out = new Set(o.models.denied(modelRef()));
    for (const ref of ancestorRefs()) for (const d of o.models.denied(ref)) out.add(d);
    return out;
  };
  const blockedBy = (name: string, denied = deniedNow()): string | null =>
    denied.size ? denyReason(denied, name, toolCaps(name, o.registry.get(name))) : null;
  const offeredSchemas = () => {
    const denied = deniedNow();
    return denied.size ? schemas.filter((s) => !blockedBy(s.name, denied)) : schemas;
  };

  /** P8: per-call context budget — persona override, else 60 % of the model's window, capped at 24 k. */
  const contextBudget = (): number => {
    if (typeof persona.contextBudgetTokens === 'number' && persona.contextBudgetTokens > 0) {
      return persona.contextBudgetTokens;
    }
    let cw = DEFAULT_CONTEXT_WINDOW;
    if (o.models) {
      try {
        cw = o.models.resolve(modelRef()).contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      } catch {
        // Unknown model ref: fall back to the default window.
      }
    }
    return Math.min(24000, Math.floor(0.6 * cw));
  };

  const messages: LLMMessage[] = [{ role: 'user', content: buildFirstMessage(task) }];
  /** P8: did a given tool call id fail? (for the compaction digest). */
  const failedCalls = new Set<string>();
  let nudged = false;
  const warnedWrapUp = new Set<number>();

  const startedAt = Date.now();
  let turns = 0;
  let tokensUsed = 0;
  let idle = 0;
  let lastText = '';
  let lastErrKey: string | null = null;
  let errStreak = 0;
  let lastEventAt = Date.now();
  // J2 §2 — the last tool calls of this run (finish excluded), for the done-gate reviewer.
  const recentCalls: { name: string; args: string; ok: boolean; output: string }[] = [];

  const record = (kind: string, data: any) => {
    lastEventAt = Date.now();
    // P12: once ownership is lost we emit nothing more for this task.
    if (lostOwnership) return;
    o.store.appendEvent(task!.goalId, taskId, kind, data);
  };

  /** Extend our lease; if it already expired (or the gate cleared it), re-acquire it. */
  const heartbeat = (): boolean => {
    try {
      if (o.store.heartbeat(taskId, o.workerId, leaseMs)) return true;
      return o.store.reacquire(taskId, o.workerId, claimedAttempt, leaseMs);
    } catch {
      return false;
    }
  };

  /** Stops with a reason, keeping the last assistant words in notes. P12: no-op once the task is not ours. */
  const stopWith = (reason: string): StopOutcome => {
    if (ownershipLost()) return { kind: 'stopped', reason };
    // P12b: a shutdown requeue (running → queued, lease cleared) can race this stop; the task
    // reaching a terminal status first means the stop is moot — no second write.
    const cur = o.store.getTask(taskId);
    if (cur && (TERMINAL as readonly string[]).includes(cur.status)) return { kind: 'stopped', reason };
    if (lastText.trim()) o.store.appendNote(taskId, lastText);
    o.store.transition(taskId, 'stopped', { reason, by: o.workerId });
    return { kind: 'stopped', reason };
  };

  // P12: heartbeat for the whole life of the run — a single LLM call or acceptance check longer
  // than the lease used to let the scheduler reclaim the task mid-flight (soak S1 finding 1).
  const heartbeatTimer = setInterval(() => {
    if (lostOwnership) return;
    if (heartbeat()) return;
    // Heartbeat failed: a cleared lease during our own gate is fine (ownsTask still true);
    // anything else means someone else has the task now.
    if (!ownsTask()) declareLost();
  }, Math.max(25, Math.min(leaseMs / 3, 60_000)));

  // Stall watchdog: no event for this task in wd.stallMs → abort the in-flight call.
  let stallAbort: (() => void) | null = null;
  const watchdogTimer = setInterval(() => {
    if (Date.now() - lastEventAt >= wd.stallMs) stallAbort?.();
  }, Math.max(25, Math.min(1000, Math.floor(wd.stallMs / 3))));

  try {
    return await loop();
  } finally {
    // P12: every timer dies with the run — park, give_up, lost ownership, all paths.
    clearInterval(watchdogTimer);
    clearInterval(heartbeatTimer);
    // P10: one last best-effort publish on every exit path.
    await publishWork().catch(() => {});
  }

  async function loop(): Promise<Task> {
    for (;;) {
      // P12: a run that lost its task stops silently — no writes, no events, just the current row.
      if (lostOwnership) return o.store.getTask(taskId) ?? task!;
      // P12: budget / abort handling writes to the task, so it requires ownership too.
      const needStop = o.signal?.aborted
        ? 'cancelled'
        : turns >= task!.budget.turns
          ? `turn budget exhausted (${turns})`
          : tokensUsed >= task!.budget.tokens
            ? 'token budget exhausted'
            : Date.now() - startedAt >= task!.budget.wallClockMs
              ? 'wall clock exceeded'
              : null;
      if (needStop) {
        if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
        stopWith(needStop);
        return o.store.getTask(taskId)!;
      }

      // P8: keep every request inside the context budget — compact, then nudge once past 50 %.
      const budget = contextBudget();
      let est = estimateRequest(persona.system, schemas, messages);
      if (est > budget) {
        const before = est;
        const c = compactMessages(persona.system, schemas, messages, budget, (id) => failedCalls.has(id));
        if (c.dropped > 0) {
          messages.length = 0;
          messages.push(...c.messages);
          if (c.digest && !lostOwnership) o.store.appendNote(taskId, c.digest);
          est = estimateRequest(persona.system, schemas, messages);
          record('compacted', { before, after: est, dropped: c.dropped });
        }
      }
      if (!nudged && persona.canSpawn.length > 0 && est > budget * 0.5) {
        nudged = true;
        messages.push({ role: 'user', content: nudgeMessage(Math.round((est / budget) * 100)) });
      }

      // Near the turn budget: tell the agent to deliver instead of silently running out (research
      // tasks otherwise keep gathering until "turn budget exhausted" with nothing written).
      const left = task!.budget.turns - turns;
      for (const w of WRAP_UP_AT) {
        if (left <= w && left > 0 && task!.budget.turns > w * 2 && !warnedWrapUp.has(w)) {
          warnedWrapUp.add(w);
          for (const x of WRAP_UP_AT) if (x >= w) warnedWrapUp.add(x);
          messages.push({ role: 'user', content: wrapUpMessage(left, task!.budget.turns) });
          record('progress', { msg: `wrap-up warning: ${left} turns left` });
          break;
        }
      }

      // P12(a): we own the task before every LLM call.
      if (ownershipLost()) return o.store.getTask(taskId) ?? task!;

      // One LLM call, abortable by o.signal / wall clock / stall watchdog / lost ownership.
      let abortReason: string | null = null;
      const call = linkAbort(o.signal);
      if (o.signal?.aborted) abortReason = 'cancelled';
      stallAbort = () => {
        abortReason = abortReason ?? 'stall: no event for this task in ' + wd.stallMs + 'ms';
        call.dispose();
      };
      const remaining = task!.budget.wallClockMs - (Date.now() - startedAt);
      const wallTimer = setTimeout(() => {
        abortReason = abortReason ?? 'wall clock exceeded';
        call.dispose();
      }, Math.max(0, remaining));
      // A call QUEUED for a model slot (3 slots, many agents) is not a stall: keep the watchdog fed while
      // it waits (up to LLM_CALL_MAX_MS) and say so every few minutes (Agents view). Time at the server is.
      const callStart = Date.now();
      let lastWaitNote = callStart;
      const aliveTimer = setInterval(() => {
        const waited = Date.now() - callStart;
        if (waited >= LLM_CALL_MAX_MS) return; // genuinely stuck: let the stall watchdog fire
        // only QUEUED time counts as alive; a request already at the server must still show progress
        if (!queuedForSlot.has(call.signal)) return;
        lastEventAt = Date.now();
        if (Date.now() - lastWaitNote >= WAIT_NOTE_EVERY_MS) {
          lastWaitNote = Date.now();
          record('progress', { msg: `waiting for a free model slot (${Math.round(waited / 60_000)} min)` });
        }
      }, Math.max(25, Math.min(60_000, Math.floor(wd.stallMs / 3))));
      const disposeCall = () => {
        clearTimeout(wallTimer);
        clearInterval(aliveTimer);
        call.dispose();
      };
      inFlightDisposers.add(disposeCall);

      let resp: LLMResponse | null = null;
      let lastError: unknown = null;
      const firstTry = Date.now();
      let transientWaits = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          resp = await llmForCall().chat({
            system: persona.system,
            messages,
            tools: offeredSchemas(),
            maxTokens: persona.maxTokensPerTurn,
            signal: call.signal,
          });
          break;
        } catch (e) {
          if (abortReason ?? (o.signal?.aborted || isAbortError(e))) {
            abortReason = abortReason ?? 'cancelled';
            break;
          }
          lastError = e;
          // The model server is down/restarting: wait it out (bounded) instead of failing the task.
          if (isTransientLlmError(e) && Date.now() - firstTry < TRANSIENT_LLM_WINDOW_MS) {
            const wait = TRANSIENT_BACKOFF_MS[Math.min(transientWaits++, TRANSIENT_BACKOFF_MS.length - 1)];
            record('progress', { msg: `model server unreachable (${String((e as Error)?.message ?? e).slice(0, 80)}); retrying in ${Math.round(wait / 1000)}s` });
            await sleepAbortable(wait, call.signal);
            attempt = -1; // the loop's ++ makes it 0: transient waits don't use up the 3 normal attempts
            if (call.signal.aborted) {
              abortReason = abortReason ?? 'cancelled';
              break;
            }
            continue;
          }
          if (attempt < 2) await sleep(RETRY_BACKOFF_MS[attempt]);
        }
      }
      clearTimeout(wallTimer);
      clearInterval(aliveTimer);
      stallAbort = null;
      call.dispose();
      inFlightDisposers.delete(disposeCall);

      // P12: the heartbeat may have noticed mid-call that the task was reclaimed — stop, no writes.
      if (lostOwnership) return o.store.getTask(taskId) ?? task!;

      if (!resp) {
        if (abortReason) {
          stopWith(abortReason);
          return o.store.getTask(taskId)!;
        }
        if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
        const msg = `llm error: ${(lastError as Error)?.message ?? String(lastError)}`;
        if (lastText.trim()) o.store.appendNote(taskId, lastText);
        o.store.transition(taskId, 'failed', { reason: msg, by: o.workerId });
        return o.store.getTask(taskId)!;
      }

      turns += 1;
      tokensUsed += resp.usage.promptTokens + resp.usage.completionTokens;
      if (resp.content) lastText = resp.content;
      // P12: heartbeat before the turn record; a failed reacquire means the task is gone.
      if (!heartbeat() && ownershipLost()) return o.store.getTask(taskId) ?? task!;
      record('turn', {
        turn: turns,
        tools: resp.toolCalls.map((c) => c.name),
        usage: resp.usage,
        // P15 transcript: what the model said and asked for (capped; never the full context).
        text: capText(resp.content ?? '', 8000),
        ...(resp.thinking ? { thinking: capText(resp.thinking, 12000) } : {}),
        calls: resp.toolCalls.map((c) => ({ name: c.name, args: capText(safeJson(c.args), 4000) })),
      });

      const calls: ToolCall[] = resp.toolCalls;

      if (calls.length === 0) {
        idle += 1;
        messages.push({ role: 'assistant', content: resp.content });
        if (idle >= wd.maxIdleTurns) {
          stopWith('stopped: no progress — ' + idle + ' consecutive turns without a tool call');
          return o.store.getTask(taskId)!;
        }
        messages.push({
          role: 'user',
          content: 'You produced no tool call. Use a tool to make progress, or call finish/give_up/ask_claude.',
        });
        continue;
      }
      idle = 0;
      messages.push({ role: 'assistant', content: resp.content, toolCalls: calls });

      for (const c of calls) {
        // P12: a run that lost the task stops before touching it again.
        if (lostOwnership) return o.store.getTask(taskId) ?? task!;
        // Every tool call gets its own abort scope so `park` can outlive a signal.
        const scope = linkAbort(o.signal);
        inFlightDisposers.add(scope.dispose);
        let result: ToolResult;
        let control:
          | { kind: 'return'; task: Task }
          | { kind: 'park'; status: 'blocked' | 'needs_claude'; reason: string }
          | null = null;

        try {
          if (!toolSet.has(c.name)) {
            result = { ok: false, output: `unknown tool: ${c.name}` };
          } else if (blockedBy(c.name)) {
            result = { ok: false, output: `tool ${c.name} is not allowed on model ${o.models!.resolve(modelRef()).name} (denied: ${blockedBy(c.name)})` };
          } else if (c.name === 'finish') {
            result = await doFinish(c);
            if (result.ok) control = { kind: 'return', task: o.store.getTask(taskId)! };
          } else if (c.name === 'give_up') {
            const reason = String(c.args?.reason ?? 'no reason given');
            // P12(b): the transition below is ours to make only while we own the task.
            if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
            o.store.transition(taskId, 'failed', { reason, by: o.workerId });
            control = { kind: 'return', task: o.store.getTask(taskId)! };
            result = { ok: true, output: '' };
          } else if (c.name === 'ask_claude') {
            const reason = String(c.args?.reason ?? 'asked Claude');
            if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
            o.store.appendNote(taskId, `Question for Claude: ${String(c.args?.question ?? '')}`);
            o.store.transition(taskId, 'needs_claude', { reason, by: o.workerId });
            control = { kind: 'return', task: o.store.getTask(taskId)! };
            result = { ok: true, output: '' };
          } else if (c.name === 'spawn_subagent') {
            result = doSpawn(c);
          } else if (c.name === 'wait_subtasks') {
            result = await doWait(scope.signal);
          } else {
            const tool = o.registry.get(c.name)!;
            const ctx: ToolContext = {
              taskId,
              goalId: task!.goalId,
              workspace,
              persona: persona.name,
              signal: scope.signal,
              acceptance: task!.acceptance,
              progress: (msg: string) => record('progress', { msg }),
              ...(backend ? { backend } : {}),
            };
            try {
              result = await tool.run(c.args ?? {}, ctx);
            } catch (e: any) {
              result = parkIfNodeOffline(e) ?? { ok: false, output: `error: ${e?.message ?? String(e)}` };
            }
          }
        } finally {
          inFlightDisposers.delete(scope.dispose);
          scope.dispose();
        }

        if (result.park && !control) {
          if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
          o.store.transition(taskId, result.park.status, { reason: result.park.reason, by: o.workerId });
          control = { kind: 'park', status: result.park.status, reason: result.park.reason };
        }
        if (!result.ok) failedCalls.add(c.id);
        // In and out together, so the transcript shows each call whole.
        record('tool', { name: c.name, ok: result.ok, args: capText(safeJson(c.args ?? {}), 4000), output: capText(result.output ?? '', 8000) });
        if (c.name !== 'finish') {
          recentCalls.push({ name: c.name, args: safeJson(c.args ?? {}), ok: result.ok, output: result.output ?? '' });
          if (recentCalls.length > 16) recentCalls.shift();
        }

        if (control) return control.kind === 'park' ? parkedResult(control.reason) : control.task;

        messages.push({ role: 'tool', content: result.output, toolCallId: c.id, name: c.name });

        if (!result.ok) {
          const key = `${c.name}:${result.output}`;
          errStreak = key === lastErrKey ? errStreak + 1 : 1;
          lastErrKey = key;
          if (errStreak >= wd.maxRepeatedErrors) {
            if (ownershipLost()) return o.store.getTask(taskId) ?? task!;
            o.store.transition(taskId, 'failed', {
              reason: `repeated error: ${c.name}: ${firstLine(result.output)}`,
              by: o.workerId,
            });
            return o.store.getTask(taskId)!;
          }
        } else {
          lastErrKey = null;
          errStreak = 0;
        }
      }
    }
  }

  /** Ends the loop after a park, keeping the task parked. */
  function parkedResult(reason: string): Task {
    if (lostOwnership) return o.store.getTask(taskId) ?? task!;
    const cur = o.store.getTask(taskId)!;
    if (cur.status !== 'blocked' && cur.status !== 'needs_claude') {
      o.store.transition(taskId, 'stopped', { reason: `parked: ${reason}`, by: o.workerId });
    }
    return o.store.getTask(taskId)!;
  }

  async function doFinish(c: ToolCall): Promise<ToolResult> {
    // P8: the compact result a parent sees via wait_subtasks.
    const summary = String(c.args?.summary ?? '').trim();
    o.store.setResult(taskId, summary.slice(0, 2000));
    // J2 §2 — done-gate review before the task moves to verifying. Fail-open: with no hook
    // (Jev off/unavailable) this is exactly the old behaviour.
    try {
      const decision = await reviewFinish({ task: task!, summary, recent: recentCalls.slice(-8) });
      if (decision?.blocked) return { ok: false, output: decision.feedback };
    } catch {
      /* the reviewer must never break a finish */
    }
    // Report goals (no checks, no repo): the summary IS the deliverable — saved where the check looks.
    if (task!.acceptance.some(isReportCheck)) {
      try {
        if (backend) await backend.writeFile(path.join(workspace, 'REPORT.md'), `${summary}\n`);
        else writeFileSync(path.join(workspace, 'REPORT.md'), `${summary}\n`);
        if (summary.length > 2000) o.store.appendNote(taskId, `REPORT (full, ${summary.length} chars) saved to REPORT.md`);
      } catch {
        /* the check will fail and say so */
      }
      try {
        // O1: publish the report as a first-class goal output too.
        o.store.putOutput({ goalId: task!.goalId, taskId, name: 'Report', kind: 'markdown', content: summary });
      } catch {
        /* best effort — never fail the task over the output */
      }
    }
    o.store.transition(taskId, 'verifying', { by: o.workerId });
    const runner: CheckRunner = backend
      ? async (check: AcceptanceCheck) => {
          const t0 = Date.now();
          const r = await backend.exec(check.cmd, {
            cwd: check.cwd ?? workspace,
            workspace, // sandbox: only the task workspace is writable, whatever cwd the check names
            timeoutMs: check.timeoutMs ?? 10 * 60 * 1000,
          });
          return {
            name: check.name,
            ok: !r.timedOut && r.exitCode === 0,
            exitCode: r.exitCode,
            output: (r.output ?? '').slice(-4000),
            durationMs: Date.now() - t0,
            timedOut: r.timedOut,
          };
        }
      : (check: AcceptanceCheck) =>
          o.runner
            ? o.runner({ ...check, cwd: check.cwd ?? workspace })
            : defaultRunner({ ...check, cwd: check.cwd ?? workspace }, { workspace });
    // ALF-7: Auto checks — the gate grows with what this change actually touched.
    let checks: AcceptanceCheck[] | undefined;
    if (usesAutoChecks(o.store, o.store.getGoal(task!.goalId))) {
      checks = autoChecks(devAcceptance(), await changedFiles());
      record('progress', { msg: `auto checks: ${checks.map((c) => c.name).join(', ')}` });
    }
    let v: { ok: boolean; results: import('../types.js').CheckResult[] };
    try {
      v = await verifyAndComplete(o.store, taskId, { runner, by: o.workerId, ...(checks ? { checks } : {}) });
      await publishUiShots();
    } catch (e) {
      if (e instanceof NodeOfflineError) {
        // The gate could not reach the node: back to running (legal from verifying),
        // then the park machinery moves us to blocked.
        o.store.transition(taskId, 'running', { by: o.workerId });
        return { ok: false, output: `error: ${e.message}`, park: { status: 'blocked', reason: e.message } };
      }
      throw e;
    }
    // P10: publish on every finish attempt (best-effort, never fails the task).
    await publishWork();
    if (v.ok) return { ok: true, output: 'done' };
    const after = o.store.getTask(taskId)!;
    if (after.status === 'failed') return { ok: true, output: '' };
    // Gate put us back to 'running' with no live lease; re-establish ownership.
    // P12: heartbeat() now re-acquires an expired/cleared lease we still logically own
    // (same attempt, no live lease by someone else). If that fails, the task is gone —
    // return a non-ok result without any further writes.
    if (!heartbeat()) {
      lostOwnership = true;
      return { ok: false, output: 'ownership lost: task was reclaimed' };
    }
    const detail = v.results
      .filter((r) => !r.ok)
      .map((r) => `${r.name}: ${r.timedOut ? 'timed out' : `exit=${r.exitCode}`}\n${r.output.slice(-2000)}`)
      .join('\n\n');
    return { ok: false, output: `acceptance failed:\n${detail}` };
  }

  function doSpawn(c: ToolCall): ToolResult {
    const a = c.args ?? {};
    if (!persona.canSpawn.includes(String(a.persona))) {
      return { ok: false, output: `persona ${persona.name} cannot spawn ${String(a.persona)}` };
    }
    try {
      const child = o.store.createTask({
        goalId: task!.goalId,
        parentTaskId: taskId,
        persona: String(a.persona),
        title: String(a.title ?? 'subtask'),
        spec: String(a.spec ?? ''),
        acceptance: Array.isArray(a.acceptance) ? a.acceptance : [],
        budget: a.budget && typeof a.budget === 'object' ? a.budget : undefined,
        model: a.model ? String(a.model) : undefined,
      });
      const start = (childId: string) =>
        runTask(childId, { ...o, workerId: `${o.workerId}/${childId.slice(0, 8)}` }).catch(() => {});
      if (o.spawnRunner) o.spawnRunner(child.id);
      else start(child.id);
      return { ok: true, output: `spawned ${child.id}` };
    } catch (e: any) {
      return { ok: false, output: `error: ${e?.message ?? String(e)}` };
    }
  }

  async function doWait(signal: AbortSignal): Promise<ToolResult> {
    // Soak finding (2026-09-25): a parent blocked here recorded no events, so its stall watchdog
    // killed it while its children were busy. Mirror child liveness: when any child has a new event,
    // record a (throttled) progress event for the parent. A stuck child is stopped by its own watchdog.
    let seenEventId = o.store.events(task!.goalId).at(-1)?.id ?? 0;
    let lastMirror = 0;
    for (;;) {
      if (signal.aborted) return { ok: false, output: 'wait aborted' };
      const kids = o.store.children(taskId);
      if (kids.every((k) => (TERMINAL as readonly string[]).includes(k.status) || (PARKED as readonly string[]).includes(k.status))) {
        if (kids.length === 0) return { ok: true, output: 'no children' };
        // P8: compact child results — title, status and result/reason only. Never notes or transcripts.
        const lines = kids.map((k) => {
          const detail = (k.result ?? k.reason ?? '').replace(/\s+/g, ' ').trim();
          return `${k.title} [${k.status}] ${detail}`.trimEnd().slice(0, 600);
        });
        lines.push('(details: alfred_goal / task notes)');
        return { ok: true, output: lines.join('\n') };
      }
      const kidIds = new Set(kids.map((k) => k.id));
      const fresh = o.store.events(task!.goalId, { sinceId: seenEventId });
      if (fresh.length) seenEventId = fresh[fresh.length - 1].id;
      if (fresh.some((e) => e.taskId && kidIds.has(e.taskId)) && Date.now() - lastMirror >= Math.min(30_000, wd.stallMs / 3)) {
        lastMirror = Date.now();
        record('progress', { msg: `waiting on ${kids.length} subtask(s); children active` });
      }
      heartbeat();
      await sleep(pollMs);
    }
  }
}
