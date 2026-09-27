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
    return { verb: 'extra', value: String(v) };
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
