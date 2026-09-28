// D1 — one syntax that starts an agent run from a single prompt, everywhere:
//   !<persona> <prompt>   (the @ is optional; unknown words are part of the prompt)
//   ! <prompt>            → persona alfred
// `!!` at the start is NOT a dispatch (the Mac quick bar uses it as a priority marker).
import type { Store } from './store.js';
import type { Goal, Task } from './types.js';
import type { Persona } from './runtime/contract.js';
import { createGoalWithRoot } from './ops.js';

export const DISPATCH_SYNTAX = '!<persona> <prompt>';

export interface ParsedDispatch {
  persona: string;
  prompt: string;
}

/**
 * Parse `!<persona> <prompt>`. `personas` are the known names (matched case-insensitively;
 * the known spelling is returned). A word counts as a persona only when it is known and is
 * followed by more text; otherwise the whole text after `!` is the prompt for alfred.
 * Returns null when the text does not start with a single `!` or nothing is left as a prompt.
 */
export function parseDispatch(text: string, personas: string[]): ParsedDispatch | null {
  const t = String(text ?? '').trim();
  if (!/^!(?!!)/.test(t)) return null;
  const rest = t.slice(1).trim();
  if (!rest) return null;
  const known = new Map<string, string>();
  for (const p of personas) known.set(String(p).toLowerCase(), String(p));
  const m = /^@?([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s+([\s\S]*))?$/.exec(rest);
  if (m) {
    const canonical = known.get(m[1].toLowerCase());
    const prompt = (m[2] ?? '').trim();
    if (canonical && prompt) return { persona: canonical, prompt };
  }
  return { persona: 'alfred', prompt: rest };
}

/** Goal title from a prompt: first non-empty line, whitespace collapsed, ≤ 80 chars + `…`. */
export function titleFor(prompt: string): string {
  const line = String(prompt ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l);
  const flat = (line ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= 80) return flat;
  const head = flat.slice(0, 80);
  const sp = head.lastIndexOf(' ');
  return `${(sp > 0 ? head.slice(0, sp) : head).trimEnd()}…`;
}

export interface DispatchInput {
  prompt: string;
  /** Default 'alfred'. Must be a known persona. */
  persona?: string;
  repo?: string;
  node?: string;
  /** Where the dispatch came from: dashboard|mac-quick|cli|slack|… */
  source: string;
}

/** Create a goal + root task straight from a prompt. No acceptance checks are ever set here. */
export function dispatchPrompt(
  store: Store,
  personas: Map<string, Persona>,
  input: DispatchInput,
): { goal: Goal; task: Task; persona: string } {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt is required');
  const persona = input.persona ?? 'alfred';
  if (!personas.has(persona)) throw new Error(`unknown persona: ${persona}`);
  const { goal, task } = createGoalWithRoot(store, {
    title: titleFor(prompt),
    body: prompt,
    spec: prompt,
    persona,
    repo: input.repo,
  });
  const meta: Record<string, any> = { source: input.source };
  if (input.node && input.node !== 'local') meta.node = input.node;
  const updated = store.setGoalMeta(goal.id, meta);
  return { goal: updated ?? goal, task, persona };
}
