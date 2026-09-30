// J2 §1 — Jev policy: config/jev.yaml, read fresh (like powers.yaml / jira.yaml).
// Missing or broken file = the defaults below. Jev is a DECISION layer only: it can add
// caution, never grant it (see powers/gate.ts) and the done-gate only rejects within `enforce`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { powersRoot } from '../powers/gate.js';

export const JEV_MODES = ['off', 'shadow', 'advisory', 'enforce'] as const;
export type JevMode = (typeof JEV_MODES)[number];

export const JEV_BACKENDS = ['typesafe', 'local'] as const;
export type JevBackend = (typeof JEV_BACKENDS)[number];

export interface JevPolicy {
  enabled: boolean;
  /** typesafe = the hosted API (needs TYPESAFE_API_KEY); local = llama-server /v1/decision on the Spark. */
  backend: JevBackend;
  /** Base URL of the local llama-server (served with --decision-seqs). */
  localUrl: string;
  /** Local calls may need a cold prefill (~430 tok/s), so they get their own, longer timeout. */
  localTimeoutMs: number;
  /** Pinned model id — never `jev-latest` for gates. */
  model: string;
  timeoutMs: number;
  /** Daily input-token cap across every use; over it Jev is skipped (fail-open). ~$0.84/day at 20M. */
  dailyTokenCap: number;
  review: {
    /** Report goals (no shell checks): off | shadow | advisory | enforce. */
    report: JevMode;
    /** Goals with shell checks. */
    code: JevMode;
    /** addresses_spec or complete below this = reject (enforce only). */
    rejectBelow: number;
    /** Per task; after that the finish goes through (with the review recorded). */
    maxRejections: number;
  };
  /** Annotate approvals with scope/injection/risk; can only ADD caution. */
  risk: boolean;
  /** web_fetch prompt-injection screen. */
  screenWeb: boolean;
  /** The jev_decide agent tool. */
  tool: boolean;
}

export const DEFAULT_JEV_POLICY: JevPolicy = {
  enabled: true,
  backend: 'typesafe',
  localUrl: 'http://127.0.0.1:1110',
  localTimeoutMs: 20_000,
  model: 'jev-1.13.0',
  timeoutMs: 3000,
  dailyTokenCap: 20_000_000,
  review: { report: 'enforce', code: 'advisory', rejectBelow: 0.35, maxRejections: 2 },
  risk: true,
  screenWeb: true,
  tool: true,
};

export function jevPolicyPath(deps: ModuleDeps): string {
  return join(powersRoot(deps), 'config', 'jev.yaml');
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function num(v: any, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  const base = Number.isFinite(n) ? n : dflt;
  return clamp(base, lo, hi);
}

function mode(v: any, dflt: JevMode): JevMode {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (JEV_MODES as readonly string[]).includes(s) ? (s as JevMode) : dflt;
}

const isBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);

/** config/jev.yaml over the defaults. Never throws: a broken file is the defaults. */
export function loadJevPolicy(deps: ModuleDeps): JevPolicy {
  const path = jevPolicyPath(deps);
  let raw: any = null;
  if (existsSync(path)) {
    try {
      raw = parseYaml(readFileSync(path, 'utf8'));
    } catch (e: any) {
      console.error(`[jev] ignoring ${path}: ${e?.message ?? e}`);
      raw = null;
    }
  }
  const d = DEFAULT_JEV_POLICY;
  if (!raw || typeof raw !== 'object') return { ...d, review: { ...d.review } };
  const rv = raw.review && typeof raw.review === 'object' ? raw.review : {};
  return {
    enabled: isBool(raw.enabled, d.enabled),
    backend: (JEV_BACKENDS as readonly string[]).includes(String(raw.backend ?? '').trim().toLowerCase())
      ? (String(raw.backend).trim().toLowerCase() as JevBackend)
      : d.backend,
    localUrl: typeof raw.localUrl === 'string' && raw.localUrl.trim() ? raw.localUrl.trim() : d.localUrl,
    localTimeoutMs: num(raw.localTimeoutMs, d.localTimeoutMs, 200, 120_000),
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : d.model,
    timeoutMs: num(raw.timeoutMs, d.timeoutMs, 200, 60_000),
    dailyTokenCap: num(raw.dailyTokenCap, d.dailyTokenCap, 0, 1_000_000_000),
    review: {
      report: mode(rv.report, d.review.report),
      code: mode(rv.code, d.review.code),
      rejectBelow: num(rv.rejectBelow, d.review.rejectBelow, 0, 1),
      maxRejections: Math.round(num(rv.maxRejections, d.review.maxRejections, 0, 10)),
    },
    risk: isBool(raw.risk, d.risk),
    screenWeb: isBool(raw.screenWeb, d.screenWeb),
    tool: isBool(raw.tool, d.tool),
  };
}
