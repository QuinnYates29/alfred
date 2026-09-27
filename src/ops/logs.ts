// P14 §5 — log tails (journalctl for alfred, qwenctl for the Qwen server).
import type { OpsCtx } from './exec.js';

export const LOG_SOURCES = ['alfred', 'qwen-server'] as const;

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export async function getLogs(
  ctx: OpsCtx,
  name: string,
  lines: number,
): Promise<{ name: string; lines: string[] } | { error: string; status: number }> {
  const n = String(lines);
  let r;
  if (name === 'alfred') {
    r = await ctx.exec('journalctl', ['--user', '-u', 'alfred.service', '-n', n, '--no-pager', '-o', 'short-iso']);
  } else if (name === 'qwen-server') {
    r = await ctx.exec('qwenctl', ['logs', n]);
  } else {
    return { error: `unknown log source: ${name}`, status: 404 };
  }
  if (r.code !== 0) return { error: r.stderr.trim() || `log command failed (${r.code})`, status: 500 };
  return { name, lines: splitLines(r.stdout) };
}
