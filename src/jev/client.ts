// J2 §1 — the Jev client. One call shape: state + typed questions → calibrated answers.
// FAIL-OPEN by contract: no key / disabled / over the daily cap / invalid questions / timeout /
// HTTP error / unparsable body ⇒ `ask` resolves null and the caller behaves as if Jev were off.
// Nothing here throws, and the API key is never logged or put in an event.
import { envRedactor } from '../redact.js';
import type { ModuleDeps } from '../modules.js';
import type { JevPolicy } from './policy.js';
import { redactSecrets } from './redline.js';

export const JEVS_API_URL = 'https://api.typesafe.ai/v1/systemone';
/** Chars of state we send at most (the API allows 32k tokens of state; this is well inside it). */
export const STATE_CHAR_CAP = 60_000;
/** $ per million INPUT tokens (output is free). */
export const JEVS_USD_PER_MTOK = 0.042;
const CUT = '…[cut]…';
const MODELS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type JevInstructions = string | Record<string, any>;

export interface JevNoulQuestion {
  type: 'noul';
  instructions: JevInstructions;
  criteria?: { true?: string | null; false?: string | null };
}
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: JevInstructions;
  criteria: Record<string, string | null>;
}
export interface JevScoreQuestion {
  type: 'score';
  instructions: JevInstructions;
  criteria: string[];
}
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score' | string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
  score?: number;
  legend?: string;
}

export interface JevAskResult {
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  ms: number;
}

export interface JevCallRecord {
  use: string;
  ok: boolean;
  ms: number;
  inTokens: number;
  outTokens: number;
  [k: string]: any;
}

export interface JevClientOptions {
  /** Per-call accounting (the module wires this to the store's `jev` events). */
  onCall?: (r: JevCallRecord) => void;
  /** Tokens already used in the accounting window; over policy.dailyTokenCap the call is skipped. */
  tokensToday?: () => number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface JevClient {
  readonly model: string;
  ask(
    state: unknown,
    questions: Record<string, JevQuestion>,
    use: string,
    o?: { goalId?: string },
  ): Promise<JevAskResult | null>;
}

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Walk every string through the credential-shape redactor (structure kept). */
export function scrubStrings(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(scrubStrings);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubStrings(x);
    return out;
  }
  return v;
}

/** Keep the head and the tail of an over-long string, with a marker between. */
export function cutMiddle(s: string, max = STATE_CHAR_CAP): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - CUT.length);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${s.slice(0, head)}${CUT}${tail > 0 ? s.slice(s.length - tail) : ''}`;
}

/** Redact + cap the state (strings and objects alike; an over-long object goes as a cut string). */
export function prepareState(state: unknown, red: (v: unknown) => unknown): unknown {
  const redacted = red(state);
  if (typeof redacted === 'string') return cutMiddle(redacted);
  const json = (() => {
    try {
      return JSON.stringify(redacted);
    } catch {
      return String(redacted);
    }
  })();
  if (json.length <= STATE_CHAR_CAP) return redacted;
  return cutMiddle(json);
}

/** Local shape check (types, option/level counts). Returns an error string, or null when valid. */
export function questionError(questions: unknown): string | null {
  if (!isPlainObject(questions)) return 'questions must be an object';
  const ids = Object.keys(questions);
  if (!ids.length) return 'questions is empty';
  for (const id of ids) {
    const q = (questions as Record<string, any>)[id];
    if (!isPlainObject(q)) return `${id}: question must be an object`;
    const ins = q.instructions;
    if (!(typeof ins === 'string' ? ins.trim() : isPlainObject(ins))) return `${id}: instructions must be a string or an object`;
    if (q.type === 'noul') {
      if (q.criteria !== undefined && !isPlainObject(q.criteria)) return `${id}: noul criteria must be an object`;
    } else if (q.type === 'choice') {
      if (!isPlainObject(q.criteria)) return `${id}: choice needs a criteria object`;
      const opts = Object.keys(q.criteria as object);
      if (opts.length < 1 || opts.length > 255) return `${id}: choice needs 1..255 options (got ${opts.length})`;
      for (const [k, v] of Object.entries(q.criteria as Record<string, unknown>)) {
        if (!(v === null || typeof v === 'string')) return `${id}: choice option ${k} must be a string or null`;
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10) {
        return `${id}: score needs 2..10 ordered levels`;
      }
      if (!q.criteria.every((s: unknown) => typeof s === 'string' && s.trim())) return `${id}: score levels must be non-empty strings`;
    } else {
      return `${id}: unknown question type ${String(q.type)}`;
    }
  }
  return null;
}

/** A client, or null when Jev is not usable (no key / disabled). Never throws. */
export function jevClient(
  env: Record<string, string | undefined>,
  policy: Pick<JevPolicy, 'enabled' | 'model' | 'timeoutMs' | 'dailyTokenCap'>,
  fetchImpl: typeof fetch = globalThis.fetch,
  o: JevClientOptions = {},
): JevClient | null {
  const key = env?.TYPESAFE_API_KEY?.trim() ?? '';
  if (!key || policy?.enabled === false) return null;
  if (!MODELS.test(policy.model ?? '')) return null;
  const redEnv = envRedactor(env);
  const red = (v: unknown): unknown => scrubStrings(redEnv(v));
  const now = o.now ?? (() => Date.now());
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;

  const emit = (r: JevCallRecord) => {
    try {
      o.onCall?.(r);
    } catch {
      /* accounting must never break a call */
    }
  };

  return {
    model: policy.model,
    async ask(state, questions, use, call: { goalId?: string } = {}) {
      const t0 = now();
      const meta = { use: String(use ?? 'other'), goalId: call.goalId ?? '' };
      const overCap = (() => {
        try {
          return typeof o.tokensToday === 'function' && o.tokensToday() >= policy.dailyTokenCap;
        } catch {
          return false;
        }
      })();
      if (overCap) {
        emit({ ...meta, ok: false, ms: 0, inTokens: 0, outTokens: 0, skipped: 'daily cap' });
        return null;
      }
      const bad = questionError(questions);
      if (bad) {
        emit({ ...meta, ok: false, ms: now() - t0, inTokens: 0, outTokens: 0, error: bad });
        return null;
      }
      const body = JSON.stringify({
        state: prepareState(state, red),
        model: policy.model,
        questions: red(questions),
      });
      let res: Response;
      try {
        res = await doFetch(JEVS_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(Math.max(100, policy.timeoutMs)),
        });
      } catch (e: any) {
        emit({ ...meta, ok: false, ms: now() - t0, inTokens: 0, outTokens: 0, error: String(e?.name ?? e?.message ?? e).slice(0, 200) });
        return null;
      }
      const raw = await res.text().catch(() => '');
      if (!res.ok) {
        emit({ ...meta, ok: false, ms: now() - t0, inTokens: 0, outTokens: 0, status: res.status, error: raw.slice(0, 300) });
        return null;
      }
      let json: any = null;
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
      if (!isPlainObject(json) || !isPlainObject(json.answers)) {
        emit({ ...meta, ok: false, ms: now() - t0, inTokens: 0, outTokens: 0, error: 'bad response body' });
        return null;
      }
      const usage = isPlainObject(json.usage) ? json.usage : {};
      const inTokens = Number(usage.input_tokens) || 0;
      const outTokens = Number(usage.output_tokens) || 0;
      const ms = now() - t0;
      emit({ ...meta, ok: true, ms, inTokens, outTokens });
      return { answers: json.answers as Record<string, JevAnswer>, usage: { input_tokens: inTokens, output_tokens: outTokens }, ms };
    },
  };
}

// ---- usage accounting (store events, kind='jev') ----

export interface JevUseStats {
  calls: number;
  okCalls: number;
  inTokens: number;
  outTokens: number;
  avgMs: number;
}

export interface JevUsage extends JevUseStats {
  estUsd: number;
  byUse: Record<string, JevUseStats>;
}

const emptyStats = (): JevUseStats => ({ calls: 0, okCalls: 0, inTokens: 0, outTokens: 0, avgMs: 0 });

const add = (s: JevUseStats, ms: number, ok: boolean, i: number, o: number) => {
  s.calls += 1;
  if (ok) {
    s.okCalls += 1;
    s.inTokens += i;
    s.outTokens += o;
    s.avgMs += ms;
  }
};

const finish = (s: JevUseStats): JevUseStats => ({ ...s, avgMs: s.okCalls ? Math.round(s.avgMs / s.okCalls) : 0 });

export const estUsdFor = (inTokens: number) => Math.round(((inTokens / 1_000_000) * JEVS_USD_PER_MTOK) * 10_000) / 10_000;

/** Sum the `jev` events since `sinceMs` — only those rows, via SQL. */
export function jevUsage(deps: ModuleDeps, sinceMs: number): JevUsage {
  const total = emptyStats();
  const byUse: Record<string, JevUseStats> = {};
  try {
    const rows = deps.store
      .raw()
      .prepare(`SELECT ts, data FROM events WHERE kind = 'jev' AND ts >= ?`)
      .all(sinceMs) as { ts: number; data: string }[];
    for (const r of rows) {
      let d: any = null;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      const use = typeof d?.use === 'string' ? d.use : 'other';
      if (!byUse[use]) byUse[use] = emptyStats();
      add(total, Number(d?.ms) || 0, d?.ok === true, Number(d?.inTokens) || 0, Number(d?.outTokens) || 0);
      add(byUse[use], Number(d?.ms) || 0, d?.ok === true, Number(d?.inTokens) || 0, Number(d?.outTokens) || 0);
    }
  } catch {
    /* no store (stub deps) — report zeros */
  }
  const out: JevUsage = { ...finish(total), estUsd: estUsdFor(total.inTokens), byUse: {} };
  for (const [k, v] of Object.entries(byUse)) out.byUse[k] = finish(v);
  return out;
}
