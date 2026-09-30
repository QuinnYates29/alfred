// J2 §5 — jev_decide: fast batch decisions for agents (classify / filter / score MANY items in
// one ~0.3 s call). 40 items per request, up to 4 requests in flight. Never throws; a batch that
// fails shows `?` for its items and the tool still returns ok with a note.
import type { ModuleDeps } from '../modules.js';
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { JevClient, JevQuestion } from './client.js';
import { cutMiddle } from './client.js';

export const BATCH = 40;
export const PARALLEL = 4;
export const MAX_ITEMS = 500;
const ITEM_CAP = 2000;

const preview = (v: unknown): string => {
  const s = typeof v === 'string' ? v : safeJson(v);
  return s.replace(/\s+/g, ' ').trim().slice(0, 80);
};

const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const itemText = (v: unknown): string => (typeof v === 'string' ? v : safeJson(v)).slice(0, ITEM_CAP);

export interface DecideArgs {
  items: unknown[];
  question: string;
  type: 'noul' | 'choice' | 'score';
  options?: string[];
  levels?: string[];
  context?: string;
  threshold?: number;
}

/** Validate the tool arguments. Returns an error string, or null when usable. */
export function decideArgsError(a: any): string | null {
  if (!Array.isArray(a?.items) || a.items.length < 1) return 'items must be a non-empty array (1..500)';
  if (a.items.length > MAX_ITEMS) return `too many items (${a.items.length} > ${MAX_ITEMS})`;
  if (typeof a?.question !== 'string' || !a.question.trim()) return 'question is required';
  if (!['noul', 'choice', 'score'].includes(a?.type)) return `type must be noul, choice or score (got ${String(a?.type)})`;
  if (a.type === 'choice') {
    if (!Array.isArray(a.options) || a.options.length < 2 || a.options.length > 50) return 'choice needs options (2..50)';
    if (!a.options.every((s: unknown) => typeof s === 'string' && s.trim())) return 'options must be non-empty strings';
  }
  if (a.type === 'score') {
    if (!Array.isArray(a.levels) || a.levels.length < 2 || a.levels.length > 10) return 'score needs levels (2..10)';
    if (!a.levels.every((s: unknown) => typeof s === 'string' && s.trim())) return 'levels must be non-empty strings';
  }
  if (a.context !== undefined && typeof a.context !== 'string') return 'context must be a string';
  if (a.threshold !== undefined && !Number.isFinite(Number(a.threshold))) return 'threshold must be a number';
  return null;
}

function questionsFor(args: DecideArgs, slice: unknown[], offset: number): Record<string, JevQuestion> {
  const q = `${args.question.trim()} — for \`item\``;
  const out: Record<string, JevQuestion> = {};
  slice.forEach((item, j) => {
    const instructions = { question: q, item: itemText(item) };
    const key = `i${offset + j}`;
    if (args.type === 'choice') {
      const criteria: Record<string, string | null> = {};
      for (const o of args.options ?? []) criteria[o] = null;
      out[key] = { type: 'choice', instructions, criteria };
    } else if (args.type === 'score') {
      out[key] = { type: 'score', instructions, criteria: [...(args.levels ?? [])] };
    } else {
      out[key] = { type: 'noul', instructions };
    }
  });
  return out;
}

const fmt = (type: string, ans: any): string | null => {
  if (!ans) return null;
  if (type === 'choice') {
    if (typeof ans.choice !== 'string') return null;
    const c = Number(ans.confidence ?? ans.probabilities?.[ans.choice] ?? NaN);
    return `${ans.choice} (conf ${Number.isFinite(c) ? c.toFixed(2) : '?'})`;
  }
  if (type === 'score') {
    const s = Number(ans.score);
    return Number.isFinite(s) ? `score ${s}` : null;
  }
  const p = Number(ans.noul);
  if (!Number.isFinite(p)) return null;
  return `${p >= 0.5 ? 'yes' : 'no'} ${p.toFixed(2)}`;
};

const probOf = (type: string, ans: any): number | null => {
  if (!ans) return null;
  const v = type === 'noul' ? ans.noul : type === 'score' ? ans.score : ans.confidence ?? ans.probabilities?.[ans.choice ?? ''];
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One question for the bulk path (asked about each item on its own). */
function singleQuestion(args: DecideArgs): JevQuestion {
  const instructions = args.question.trim();
  if (args.type === 'choice') {
    const criteria: Record<string, string | null> = {};
    for (const o of args.options ?? []) criteria[o] = null;
    return { type: 'choice', instructions, criteria };
  }
  if (args.type === 'score') return { type: 'score', instructions, criteria: [...(args.levels ?? [])] };
  return { type: 'noul', instructions };
}

/** Bulk chunks: <= BULK_ITEMS items and ~BULK_CHARS of item text (~6k tokens, ~15 s of cold prefill). */
export const BULK_ITEMS = 64;
export const BULK_CHARS = 24_000;

export function bulkChunks(texts: string[]): { offset: number; slice: string[] }[] {
  const out: { offset: number; slice: string[] }[] = [];
  let cur: string[] = [];
  let chars = 0;
  let start = 0;
  texts.forEach((t, i) => {
    if (cur.length && (cur.length >= BULK_ITEMS || chars + t.length > BULK_CHARS)) {
      out.push({ offset: start, slice: cur });
      cur = [];
      chars = 0;
      start = i;
    }
    cur.push(t);
    chars += t.length;
  });
  if (cur.length) out.push({ offset: start, slice: cur });
  return out;
}

/** Local backend: every item is its own context, scored in batched passes (no packing, nothing cut). */
async function runEach(
  jev: JevClient,
  args: DecideArgs,
  items: unknown[],
  context: string,
  threshold: number | null,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const q = singleQuestion(args);
  const answers = new Map<number, any>();
  let calls = 0;
  let ms = 0;
  let failed = 0;
  for (const { offset, slice } of bulkChunks(items.map(itemText))) {
    calls += 1;
    const r = await jev.askEach!(context, slice, q, 'tool', { goalId: ctx?.goalId ?? '' });
    if (!r) {
      failed += 1;
      continue;
    }
    ms += r.ms;
    r.answers.forEach((a, j) => {
      if (a) answers.set(offset + j, a);
    });
  }
  return report(args, items, answers, threshold, calls, ms, failed);
}

function report(args: DecideArgs, items: unknown[], answers: Map<number, any>, threshold: number | null, calls: number, ms: number, failed: number): ToolResult {
  const rows = items.map((item, i) => ({ i, ans: answers.get(i) ?? null, value: probOf(args.type, answers.get(i) ?? null) }));
  let kept = rows;
  if (threshold !== null) {
    kept = rows
      .filter((r) => r.value !== null && (r.value as number) >= threshold)
      .sort((a, b) => (b.value as number) - (a.value as number));
  }
  const lines = kept.map((r) => `#${r.i} ${fmt(args.type, r.ans) ?? '?'} — ${preview(items[r.i])}`);
  const totals = `${kept.length}/${items.length} items, ${calls} calls, ${ms} ms`;
  const note = failed ? `\n(${failed} of ${calls} batches got no answer — those items show ?)` : '';
  return { ok: true, output: cutMiddle([...lines, `${totals}${note}`].join('\n'), 16000) };
}

/** The jev_decide implementation, shared by the module tool and the allTools() stub. */
export async function runDecide(
  get: () => JevClient | null,
  raw: any,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const err = decideArgsError(raw);
  if (err) return { ok: false, output: `jev_decide: ${err}` };
  const jev = get();
  if (!jev) return { ok: false, output: 'Jev is not configured (config/jev.yaml backend: local, or TYPESAFE_API_KEY for the hosted API)' };
  const args = raw as DecideArgs;
  const threshold = args.threshold !== undefined ? Number(args.threshold) : null;
  const items = args.items;
  const state = { context: (args.context ?? '').slice(0, 4000), items: [] as unknown[] };

  if (typeof jev.askEach === 'function') return runEach(jev, args, items, state.context, threshold, ctx);

  const chunks: { offset: number; slice: unknown[] }[] = [];
  for (let off = 0; off < items.length; off += BATCH) chunks.push({ offset: off, slice: items.slice(off, off + BATCH) });

  const answers = new Map<number, any>();
  let calls = 0;
  let ms = 0;
  let failed = 0;

  for (let g = 0; g < chunks.length; g += PARALLEL) {
    const group = chunks.slice(g, g + PARALLEL);
    const results = await Promise.all(
      group.map(async ({ offset, slice }) => {
        state.items = slice;
        calls += 1;
        const r = await jev.ask({ context: state.context, items: slice }, questionsFor(args, slice, offset), 'tool', {
          goalId: ctx?.goalId ?? '',
        });
        return { offset, r };
      }),
    );
    for (const { offset, r } of results) {
      if (!r) {
        failed += 1;
        continue;
      }
      ms += r.ms;
      for (const [key, ans] of Object.entries(r.answers)) {
        const idx = Number(key.slice(1));
        if (Number.isInteger(idx)) answers.set(idx, ans);
      }
    }
  }

  return report(args, items, answers, threshold, calls, ms, failed);
}

export const JEVA_DESCRIPTION =
  'Fast batch decisions (≈0.3 s, cheap): classify, filter or score MANY items at once with one question. Use instead of reading items one by one.';

export function jevTool(deps: ModuleDeps): Tool {
  return {
    kind: 'read',
    caps: ['network'],
    schema: {
      name: 'jev_decide',
      description: JEVA_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          items: { type: 'array', description: `The items to decide on (1..${MAX_ITEMS}). Strings or objects.` },
          question: { type: 'string', description: 'One question asked about every item.' },
          type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'yes/no probability, pick one option, or score on ordered levels.' },
          options: { type: 'array', description: 'choice only: 2..50 option names.' },
          levels: { type: 'array', description: 'score only: 2..10 ordered level names.' },
          context: { type: 'string', description: 'Shared background for the question (≤ 4000 chars).' },
          threshold: { type: 'number', description: 'noul only: return only items with p ≥ threshold (sorted by p).' },
        },
        required: ['items', 'question', 'type'],
      },
    },
    run: (args, ctx) => runDecide(() => (deps.modules?.jev as any)?.client?.() ?? null, args, ctx),
  };
}
