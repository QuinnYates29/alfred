// P14 §4 — the Qwen server env file, presets, limits.
import { readFileSync } from 'node:fs';
import type { OpsCtx } from './exec.js';
import { tail2 } from './exec.js';

export const QWEN_PRESETS = ['fast', 'balanced', 'lean', 'min-ram'];
export const QWEN_LIMITS = { slots: [1, 8], ctx: [1024, 262144], offload: [0, 48] } as const;

/** Every `QWEN_*=VALUE` line of the env file; surrounding quotes stripped. */
export function readQwenEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(QWEN_[A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export async function qwenHealth(ctx: OpsCtx): Promise<boolean> {
  try {
    const res = await ctx.fetch(`${ctx.qwenUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns { verb, value } for exactly one setting, or throws Error with the reason. */
export function parseQwenSetting(body: any): { verb: string; value: string } {
  const keys = ['preset', 'slots', 'ctx', 'offload', 'extra'].filter((k) => body[k] !== undefined && body[k] !== null);
  if (keys.length !== 1) throw new Error('exactly one of preset|slots|ctx|offload|extra is required');
  const key = keys[0];
  const v = body[key];
  if (key === 'preset') {
    if (!QWEN_PRESETS.includes(String(v))) throw new Error(`unknown preset: ${v} (use ${QWEN_PRESETS.join('|')})`);
    return { verb: 'preset', value: String(v) };
  }
  if (key === 'extra') {
    return { verb: 'extra', value: validateQwenExtra(v) };
  }
  const [min, max] = QWEN_LIMITS[key as 'slots' | 'ctx' | 'offload'];
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in [${min}, ${max}]`);
  return { verb: key, value: String(n) };
}

export async function runQwenctl(ctx: OpsCtx, verb: string, value: string) {
  const r = await ctx.exec('qwenctl', [verb, value], { timeoutMs: 300_000 });
  return { ok: r.code === 0, output: tail2(`${r.stdout}${r.stderr}`) };
}

/**
 * Characters QWEN_EXTRA may not contain: shell metacharacters, quotes/backslash (systemd's
 * EnvironmentFile and qwenctl's sed rewrite would mangle them), and control chars/newlines.
 */
const EXTRA_FORBIDDEN = /[;|&$`<>\\"'\u0000-\u001f\u007f]/;
const FLAG_RE = /^--?[A-Za-z][A-Za-z0-9_-]*$/;
/** A token that starts a flag (vs a value such as `-1`). */
export const isFlagToken = (t: string) => /^--?[A-Za-z]/.test(t);

/** QWEN_EXTRA → [{flag, value}] rows; throws Error on anything unsafe or not flag-shaped. */
export function parseQwenExtra(text: string): { flag: string; value: string }[] {
  if (EXTRA_FORBIDDEN.test(text)) throw new Error('extra flags may not contain ; | & $ ` < > \\ quotes or newlines');
  const rows: { flag: string; value: string }[] = [];
  for (const tok of text.split(/[ \t]+/).filter(Boolean)) {
    if (isFlagToken(tok)) {
      if (!FLAG_RE.test(tok)) throw new Error(`bad flag: ${tok}`);
      rows.push({ flag: tok, value: '' });
    } else {
      const last = rows[rows.length - 1];
      if (!last) throw new Error(`flags must start with -: ${tok}`);
      last.value = last.value ? `${last.value} ${tok}` : tok;
    }
  }
  return rows;
}

/** Validated, whitespace-normalised QWEN_EXTRA (handed to qwenctl as ONE argv element). */
export function validateQwenExtra(v: unknown): string {
  if (typeof v !== 'string') throw new Error('extra must be a string');
  if (v.length > 1000) throw new Error('extra is too long');
  return parseQwenExtra(v)
    .map((r) => (r.value ? `${r.flag} ${r.value}` : r.flag))
    .join(' ');
}

/** The running llama-server's command line (via its MainPID), or null. */
export async function qwenRunningCmdline(ctx: OpsCtx): Promise<string | null> {
  try {
    const show = await ctx.exec('systemctl', ['--user', 'show', 'qwen-server.service', '--property=MainPID'], { timeoutMs: 5000 });
    const pid = Number(/MainPID=(\d+)/.exec(show.stdout)?.[1] ?? 0);
    if (show.code !== 0 || !pid) return null;
    const ps = await ctx.exec('ps', ['-o', 'args=', '-p', String(pid)], { timeoutMs: 5000 });
    const line = ps.stdout.trim();
    return ps.code === 0 && line ? line : null;
  } catch {
    return null;
  }
}
