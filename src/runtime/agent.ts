// P1 — the agent loop. One task, one worker: claim → prompt → loop → outcome.
// Every exit path is a task transition; runTask itself never rejects for
// agent-level failures (tool errors, budgets, stalls, llm errors).
import {
  DEFAULT_WATCHDOG,
  type LLMMessage,
  type LLMResponse,
  type Persona,
  type ToolCall,
  type ToolContext,
  type ToolResult,
  type WatchdogConfig,
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

export interface RunOpts {
  store: Store;
  llm: import('./contract.js').LLM;
  personas: Map<string, Persona>;
  registry: ToolRegistry;
  workerId: string;
  workspaceFor: (t: Task) => string;
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

  const persona = o.personas.get(task.persona);
  if (!persona) throw new Error(`no such persona: ${task.persona}`);
  const workspace = o.workspaceFor(task);
  const schemas = o.registry.schemasFor(persona.tools);
  const toolSet = new Set(persona.tools);

  const messages: LLMMessage[] = [{ role: 'user', content: buildFirstMessage(task) }];

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
          resp = await o.llm.chat({
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
          };
          try {
            result = await tool.run(c.args ?? {}, ctx);
          } catch (e: any) {
            result = { ok: false, output: `error: ${e?.message ?? String(e)}` };
          }
          if (result.park) {
            o.store.transition(taskId, result.park.status, { reason: result.park.reason, by: o.workerId });
            control = { kind: 'park', status: result.park.status, reason: result.park.reason };
          }
        }

        scope.dispose();
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
    o.store.transition(taskId, 'verifying', { by: o.workerId });
    const runner: CheckRunner = (check: AcceptanceCheck) =>
      (o.runner ?? defaultRunner)({ ...check, cwd: check.cwd ?? workspace });
    const v = await verifyAndComplete(o.store, taskId, { runner, by: o.workerId });
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
        const lines = kids.map((k) => `${k.title}: ${k.status} — ${k.reason ?? ''}`.trimEnd());
        for (const k of kids) {
          if (k.notes.trim()) lines.push(`[${k.title}] notes tail:`, k.notes.slice(-1000));
        }
        return { ok: true, output: kids.length ? lines.join('\n') : 'no children' };
      }
      heartbeat();
      await sleep(pollMs);
    }
  }
}
