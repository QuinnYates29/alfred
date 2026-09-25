// P1 — the agent loop. One task, one worker: claim → prompt → loop → outcome.
// Every exit path is a task transition; runTask itself never rejects for
// agent-level failures (tool errors, budgets, stalls, llm errors).
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
import { DEFAULT_CONTEXT_WINDOW } from '../models.js';
import { compactMessages, estimateRequest, nudgeMessage } from './compact.js';

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

function isAbortError(e: unknown): boolean {
  return (e as { name?: string })?.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  const startedAt = Date.now();
  let turns = 0;
  let tokensUsed = 0;
  let idle = 0;
  let lastText = '';
  let lastErrKey: string | null = null;
  let errStreak = 0;
  let lastEventAt = Date.now();

  const record = (kind: string, data: any) => {
    lastEventAt = Date.now();
    o.store.appendEvent(task!.goalId, taskId, kind, data);
  };

  const heartbeat = () => {
    try {
      o.store.heartbeat(taskId, o.workerId, leaseMs);
    } catch {
      // Lease lost (e.g. reclaimed) — we keep running; tests observe status only.
    }
  };

  /** Stops with a reason, keeping the last assistant words in notes. */
  const stopWith = (reason: string): StopOutcome => {
    if (lastText.trim()) o.store.appendNote(taskId, lastText);
    o.store.transition(taskId, 'stopped', { reason, by: o.workerId });
    return { kind: 'stopped', reason };
  };

  // Stall watchdog: no event for this task in wd.stallMs → abort the in-flight call.
  let stallAbort: (() => void) | null = null;
  const watchdogTimer = setInterval(() => {
    if (Date.now() - lastEventAt >= wd.stallMs) stallAbort?.();
  }, Math.max(25, Math.min(1000, Math.floor(wd.stallMs / 3))));

  try {
    return await loop();
  } finally {
    clearInterval(watchdogTimer);
    // P10: one last best-effort publish on every exit path.
    await publishWork().catch(() => {});
  }

  async function loop(): Promise<Task> {
    for (;;) {
      // Budget / abort checks, in precedence order.
      if (o.signal?.aborted) {
        stopWith('cancelled');
        return o.store.getTask(taskId)!;
      }
      if (turns >= task!.budget.turns) {
        stopWith(`turn budget exhausted (${turns})`);
        return o.store.getTask(taskId)!;
      }
      if (tokensUsed >= task!.budget.tokens) {
        stopWith('token budget exhausted');
        return o.store.getTask(taskId)!;
      }
      if (Date.now() - startedAt >= task!.budget.wallClockMs) {
        stopWith('wall clock exceeded');
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
          if (c.digest) o.store.appendNote(taskId, c.digest);
          est = estimateRequest(persona.system, schemas, messages);
          record('compacted', { before, after: est, dropped: c.dropped });
        }
      }
      if (!nudged && persona.canSpawn.length > 0 && est > budget * 0.5) {
        nudged = true;
        messages.push({ role: 'user', content: nudgeMessage(Math.round((est / budget) * 100)) });
      }

      // One LLM call, abortable by o.signal / wall clock / stall watchdog.
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

      let resp: LLMResponse | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          resp = await llmForCall().chat({
            system: persona.system,
            messages,
            tools: schemas,
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
          if (attempt < 2) await sleep(RETRY_BACKOFF_MS[attempt]);
        }
      }
      clearTimeout(wallTimer);
      stallAbort = null;
      call.dispose();

      if (!resp) {
        if (abortReason) {
          stopWith(abortReason);
          return o.store.getTask(taskId)!;
        }
        const msg = `llm error: ${(lastError as Error)?.message ?? String(lastError)}`;
        if (lastText.trim()) o.store.appendNote(taskId, lastText);
        o.store.transition(taskId, 'failed', { reason: msg, by: o.workerId });
        return o.store.getTask(taskId)!;
      }

      turns += 1;
      tokensUsed += resp.usage.promptTokens + resp.usage.completionTokens;
      if (resp.content) lastText = resp.content;
      heartbeat();
      record('turn', {
        turn: turns,
        tools: resp.toolCalls.map((c) => c.name),
        usage: resp.usage,
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
        // Every tool call gets its own abort scope so `park` can outlive a signal.
        const scope = linkAbort(o.signal);
        let result: ToolResult;
        let control:
          | { kind: 'return'; task: Task }
          | { kind: 'park'; status: 'blocked' | 'needs_claude'; reason: string }
          | null = null;

        if (!toolSet.has(c.name)) {
          result = { ok: false, output: `unknown tool: ${c.name}` };
        } else if (c.name === 'finish') {
          result = await doFinish(c);
          if (result.ok) control = { kind: 'return', task: o.store.getTask(taskId)! };
        } else if (c.name === 'give_up') {
          const reason = String(c.args?.reason ?? 'no reason given');
          o.store.transition(taskId, 'failed', { reason, by: o.workerId });
          control = { kind: 'return', task: o.store.getTask(taskId)! };
          result = { ok: true, output: '' };
        } else if (c.name === 'ask_claude') {
          const reason = String(c.args?.reason ?? 'asked Claude');
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

        scope.dispose();
        if (result.park && !control) {
          o.store.transition(taskId, result.park.status, { reason: result.park.reason, by: o.workerId });
          control = { kind: 'park', status: result.park.status, reason: result.park.reason };
        }
        if (!result.ok) failedCalls.add(c.id);
        record('tool', { name: c.name, ok: result.ok });

        if (control) return control.kind === 'park' ? parkedResult(control.reason) : control.task;

        messages.push({ role: 'tool', content: result.output, toolCallId: c.id, name: c.name });

        if (!result.ok) {
          const key = `${c.name}:${result.output}`;
          errStreak = key === lastErrKey ? errStreak + 1 : 1;
          lastErrKey = key;
          if (errStreak >= wd.maxRepeatedErrors) {
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
    const cur = o.store.getTask(taskId)!;
    if (cur.status !== 'blocked' && cur.status !== 'needs_claude') {
      o.store.transition(taskId, 'stopped', { reason: `parked: ${reason}`, by: o.workerId });
    }
    return o.store.getTask(taskId)!;
  }

  async function doFinish(c: ToolCall): Promise<ToolResult> {
    // P8: the compact result a parent sees via wait_subtasks.
    o.store.setResult(taskId, String(c.args?.summary ?? '').trim().slice(0, 2000));
    o.store.transition(taskId, 'verifying', { by: o.workerId });
    const runner: CheckRunner = backend
      ? async (check: AcceptanceCheck) => {
          const t0 = Date.now();
          const r = await backend.exec(check.cmd, {
            cwd: check.cwd ?? workspace,
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
      : (check: AcceptanceCheck) => (o.runner ?? defaultRunner)({ ...check, cwd: check.cwd ?? workspace });
    let v: { ok: boolean; results: import('../types.js').CheckResult[] };
    try {
      v = await verifyAndComplete(o.store, taskId, { runner, by: o.workerId });
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
    // Gate put us back to 'running' with no live lease; re-establish ownership
    // (a failed heartbeat just means the lease expired — we still own it logically).
    heartbeat();
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
      heartbeat();
      await sleep(pollMs);
    }
  }
}
