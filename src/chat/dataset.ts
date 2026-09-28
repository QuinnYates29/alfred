// Chat dataset — every assistant turn, every 👍/👎 and every finished goal as JSONL,
// so Quinn can optimise prompts / models / fine-tunes later. Files live in
// ALFRED_DATASET_DIR (default ~/.alfred/datasets), dirs 0700 and files 0600.
// NOTHING here ever throws into a caller: recording must not break a reply.
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { LLMMessage } from '../runtime/contract.js';
import { mkdirPrivate, writePrivateFileAtomic } from '../secure-fs.js';

export const DATASET_KINDS = ['chat', 'feedback', 'goals'] as const;
export type DatasetKind = (typeof DATASET_KINDS)[number];

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

/**
 * The dataset dir, resolved per call (tests may set env.ALFRED_DATASET_DIR).
 * A vitest run without an explicit dir records nowhere — tests must not pollute the real home.
 */
export function datasetDir(env: Record<string, string | undefined> = process.env): string | null {
  const d = String(env?.ALFRED_DATASET_DIR ?? '').trim();
  if (d) return expandHome(d);
  if (process.env.VITEST) return null;
  return path.join(homedir(), '.alfred', 'datasets');
}

const monthKey = (ts: number) => new Date(ts).toISOString().slice(0, 7);

function appendLine(dir: string, base: string, rec: Record<string, unknown>): void {
  try {
    mkdirPrivate(dir);
    const file = path.join(dir, `${base}-${monthKey(Number(rec.ts) || Date.now())}.jsonl`);
    appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600); // appendFileSync keeps an existing file's mode — force ours
  } catch {
    /* disk full, read-only fs, closed dir — never break a reply */
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Store a system prompt once, by hash; return the hash. '' on failure (never throws). */
function savePrompt(dir: string, system: string): string {
  const h = sha256(system);
  try {
    const sub = path.join(dir, 'prompts');
    const file = path.join(sub, `${h}.txt`);
    if (!existsSync(file)) {
      mkdirPrivate(sub);
      writePrivateFileAtomic(file, system);
    }
  } catch {
    /* the record still carries the sha */
  }
  return h;
}

export interface DatasetTurn {
  id: string;
  threadId: string;
  source: string;
  model: { name: string; model: string; baseUrl: string };
  /** The system prompt of this call — stored once under prompts/<sha256>.txt. */
  system: string;
  /** The exact LLMMessage[] of the FINAL model call (tool calls + tool results included). */
  messages: LLMMessage[];
  reply: string;
  actions: unknown[];
  llmCalls: number;
  usage: { promptTokens: number; completionTokens: number };
  latencyMs: number;
  ok: boolean;
  error?: string;
  deniedTools: string[];
  ts?: number;
}

/** One line per assistant reply. Never throws. */
export function recordTurn(env: Record<string, string | undefined> | undefined, input: DatasetTurn): void {
  try {
    const dir = datasetDir(env);
    if (!dir) return;
    const { system, ...rest } = input;
    const rec = { v: 1, type: 'turn', ts: input.ts ?? Date.now(), ...rest, systemSha: system ? savePrompt(dir, system) : '' };
    appendLine(dir, 'chat', rec);
  } catch {
    /* never throws into the turn */
  }
}

export interface DatasetFeedback {
  threadId: string;
  messageId: string;
  rating: 'up' | 'down' | null;
  note?: string;
  correction?: string;
  ts?: number;
}

/** Latest entry per messageId wins when reading (null rating = cleared). Never throws. */
export function recordFeedback(env: Record<string, string | undefined> | undefined, input: DatasetFeedback): void {
  try {
    const dir = datasetDir(env);
    if (!dir) return;
    appendLine(dir, 'feedback', { v: 1, type: 'feedback', ts: input.ts ?? Date.now(), ...input });
  } catch {
    /* ignore */
  }
}

/** Written on goal_status done/failed. Never throws. */
export function recordGoal(env: Record<string, string | undefined> | undefined, rec: Record<string, unknown>): void {
  try {
    const dir = datasetDir(env);
    if (!dir) return;
    appendLine(dir, 'goals', { v: 1, type: 'goal', ts: Date.now(), ...rec });
  } catch {
    /* ignore */
  }
}

function filesIn(dir: string, kind: DatasetKind): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${kind}-`) && f.endsWith('.jsonl'))
      .sort() // YYYY-MM keys sort chronologically
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Parse a file's lines; `keepNulls` keeps records whose rating was cleared (stats needs them). */
function readLines(file: string, keepNulls: boolean): any[] {
  try {
    const out: any[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o === 'object' && (keepNulls || o.rating != null)) out.push(o);
      } catch {
        /* skip a broken line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Newest per messageId wins. */
function dedupeByMessage(rows: any[]): any[] {
  const by = new Map<string, any>();
  for (const r of rows) by.set(r.messageId, r); // files are chronological; later lines overwrite
  return [...by.values()];
}

/**
 * Read recorded lines, oldest first. `since` = ts >= since (ms). `limit` = the last N.
 * Feedback returns the LATEST entry per message; cleared (rating null) ones are dropped.
 */
export function readRecords(
  env: Record<string, string | undefined> | undefined,
  kind: DatasetKind,
  o: { since?: number; limit?: number } = {},
): any[] {
  try {
    const dir = datasetDir(env);
    if (!dir) return [];
    let recs: any[] = [];
    // keep every line here: turn/goal records have no rating, and a cleared (null) rating must
    // still win the per-message dedupe before it is dropped
    for (const f of filesIn(dir, kind)) recs = recs.concat(readLines(f, true));
    if (Number.isFinite(o.since)) recs = recs.filter((r) => Number(r.ts) >= (o.since as number));
    if (kind === 'feedback') recs = dedupeByMessage(recs).filter((r) => r.rating != null);
    if (o.limit && recs.length > o.limit) recs = recs.slice(recs.length - o.limit);
    return recs;
  } catch {
    return [];
  }
}

/** Rewrite the chat + feedback files without this thread's lines (atomic: tmp + rename). */
export function purgeThread(env: Record<string, string | undefined> | undefined, threadId: string): void {
  try {
    const dir = datasetDir(env);
    if (!dir) return;
    for (const kind of ['chat', 'feedback'] as const) {
      for (const f of filesIn(dir, kind)) {
        const lines = readFileSync(f, 'utf8').split('\n');
        const kept = lines.filter((line) => {
          if (!line.trim()) return false;
          try {
            return JSON.parse(line)?.threadId !== threadId;
          } catch {
            return true; // never destroy what we cannot read
          }
        });
        writePrivateFileAtomic(f, kept.length ? `${kept.join('\n')}\n` : '');
      }
    }
  } catch {
    /* ignore */
  }
}

export interface DatasetStats {
  turns: number;
  feedback: { up: number; down: number };
  byModel: Record<string, { turns: number; up: number; down: number; avgLatencyMs: number }>;
  bytes: number;
}

/** Turn + feedback totals per model. Never throws; zeros when there is no dataset. */
export function stats(env: Record<string, string | undefined> | undefined = process.env): DatasetStats {
  const out: DatasetStats = { turns: 0, feedback: { up: 0, down: 0 }, byModel: {}, bytes: 0 };
  try {
    const dir = datasetDir(env);
    if (!dir) return out;
    const modelOf = new Map<string, string>();
    const latSum = new Map<string, number>();
    for (const f of filesIn(dir, 'chat')) {
      for (const r of readLines(f, true)) {
        out.turns++;
        const name = r?.model?.name ?? 'unknown';
        const b = (out.byModel[name] ??= { turns: 0, up: 0, down: 0, avgLatencyMs: 0 });
        b.turns++;
        latSum.set(name, (latSum.get(name) ?? 0) + (Number(r.latencyMs) || 0));
        modelOf.set(r.id, name);
      }
    }
    let fb: any[] = [];
    for (const f of filesIn(dir, 'feedback')) fb = fb.concat(readLines(f, true));
    for (const r of dedupeByMessage(fb)) {
      if (r.rating !== 'up' && r.rating !== 'down') continue;
      const rating = r.rating as 'up' | 'down';
      out.feedback[rating]++;
      const name = modelOf.get(r.messageId);
      if (name && out.byModel[name]) out.byModel[name][rating]++;
    }
    for (const [name, b] of Object.entries(out.byModel)) {
      b.avgLatencyMs = b.turns ? Math.round((latSum.get(name) ?? 0) / b.turns) : 0;
    }
    out.bytes = dirBytes(dir);
  } catch {
    /* zeros stand */
  }
  return out;
}

function dirBytes(dir: string): number {
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) bytes += statSync(p).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* 0 */
  }
  return bytes;
}
