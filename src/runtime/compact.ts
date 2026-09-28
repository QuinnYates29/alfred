// P8 — deterministic context compaction. No LLM call: when the estimate of
// the pending request exceeds the persona's context budget, old messages are
// dropped and replaced by ONE mechanical digest of the tool calls they held.
import type { LLMMessage, ToolSchema } from './contract.js';
import { estimateTokens } from './tokens.js';

export const DIGEST_HEADER = '## Compacted history';

/** estimateTokens(system) + estimateTokens(JSON of tool schemas) + estimateTokens(JSON of messages). */
export function estimateRequest(system: string, tools: ToolSchema[], messages: LLMMessage[]): number {
  return (
    estimateTokens(system) +
    estimateTokens(JSON.stringify(tools)) +
    estimateTokens(JSON.stringify(messages))
  );
}

/**
 * Tokens left for the message JSON so that system + tools + messages fit in `budget`.
 * Tool schemas are reserved content-only (no outer `[]` framing).
 */
export function messageBudget(budget: number, system: string, tools: ToolSchema[]): number {
  const overhead = estimateTokens(system) + estimateTokens(JSON.stringify(tools).slice(1, -1));
  return Math.max(64, Math.floor(budget - overhead));
}

export function nudgeMessage(pct: number): string {
  return (
    `Context at ${pct}% of budget. Delegate remaining reading/implementation to a subagent ` +
    `(spawn_subagent) and keep only summaries here.`
  );
}

function argsPreview(args: any): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  if (typeof s !== 'string') s = String(args);
  return s.length > 100 ? s.slice(0, 100) : s;
}

const omittedLine = (n: number) => `(… ${n} earlier steps omitted)`;

/** Split messages after the brief into groups; an assistant message never splits from its tool results. */
function groupsOf(messages: LLMMessage[]): LLMMessage[][] {
  const groups: LLMMessage[][] = [];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') groups.push([m]);
    else if (m.role === 'tool' && groups.length > 0) groups[groups.length - 1].push(m);
    else groups.push([m]);
  }
  return groups;
}

/** One digest line per tool call of a dropped assistant message. */
function digestLines(dropped: LLMMessage[], isError: (id: string) => boolean): string[] {
  const lines: string[] = [];
  for (const m of dropped) {
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    for (const tc of m.toolCalls) {
      const out =
        dropped
          .find((d) => d.role === 'tool' && d.toolCallId === tc.id)
          ?.content.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160) ?? '';
      // A note is what the agent chose to remember: keep it whole, not a 100-char preview.
      if (tc.name === 'note' && typeof tc.args?.text === 'string') {
        lines.push(`- NOTE: ${tc.args.text.trim().slice(0, 2000)}`);
        continue;
      }
      lines.push(`- ${tc.name}(${argsPreview(tc.args)}) → ${isError(tc.id) ? 'FAILED' : 'ok'}: ${out}`);
    }
  }
  return lines;
}

/** Digest the dropped middle; if over `digestCapTokens`, drop its oldest lines with a marker. */
function buildDigest(dropped: LLMMessage[], isError: (id: string) => boolean, digestCapTokens: number): string {
  const lines = digestLines(dropped, isError);
  let omitted = 0;
  const render = () =>
    [
      DIGEST_HEADER,
      ...(omitted > 0 ? [omittedLine(omitted)] : []),
      ...lines,
    ].join('\n');
  while (lines.length > 0 && estimateTokens(render()) > digestCapTokens) {
    // drop the oldest tool-call line first; notes go last
    const i = lines.findIndex((l) => !l.startsWith('- NOTE: '));
    lines.splice(i >= 0 ? i : 0, 1);
    omitted += 1;
  }
  return render();
}

export interface CompactionResult {
  messages: LLMMessage[];
  /** Digest text to append to the task notes ('' when nothing was dropped). */
  digest: string;
  /** Number of dropped messages (not counting the digest message itself). */
  dropped: number;
}

/**
 * Compact `messages` so estimateRequest(system, tools, out) <= budget when
 * feasible. Keeps messages[0] (the task brief) and the newest groups that fit
 * in 50 % of the budget; the middle becomes one `## Compacted history` user
 * message. `isError` reports whether a tool call failed (for the digest).
 */
export function compactMessages(
  system: string,
  tools: ToolSchema[],
  messages: LLMMessage[],
  budget: number,
  isError: (id: string) => boolean = () => false,
): CompactionResult {
  const winBudget = messageBudget(budget, system, tools);
  if (estimateRequest(system, tools, messages) <= budget) {
    return { messages, digest: '', dropped: 0 };
  }

  if (messages.length <= 1) return { messages, digest: '', dropped: 0 };
  const groups = groupsOf(messages);
  const brief = messages[0];
  const briefEst = estimateTokens(JSON.stringify(brief));
  const digestCap = Math.max(1, Math.floor(0.25 * winBudget));
  // Soft target: the kept tail stays under 50 % of the request budget, while
  // brief + digest + tail must fit the message window (winBudget).
  const tailCap = Math.floor(0.5 * budget);

  let keptStart = groups.length;
  let keptEst = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const gEst = estimateTokens(JSON.stringify(groups[i]));
    if (keptEst + gEst > tailCap) break;
    const digestEst = estimateTokens(JSON.stringify(buildDigest(groups.slice(0, i).flat(), isError, digestCap)));
    if (briefEst + keptEst + gEst + digestEst > winBudget) break;
    keptStart = i;
    keptEst += gEst;
  }

  let kept = groups.slice(keptStart);
  let dropped = groups.slice(0, keptStart).flat();
  let digest = buildDigest(dropped, isError, digestCap);

  // Authoritative pass: guarantee the invariant with the real estimator.
  let out: LLMMessage[] = [brief, { role: 'user', content: digest }, ...kept.flat()];
  while (kept.length > 0 && estimateRequest(system, tools, out) > budget) {
    const g = kept.shift()!;
    keptEst -= estimateTokens(JSON.stringify(g));
    dropped = [...dropped, ...g];
    digest = buildDigest(dropped, isError, digestCap);
    out = [brief, { role: 'user', content: digest }, ...kept.flat()];
  }
  return { messages: out, digest, dropped: dropped.length };
}
