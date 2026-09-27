// P15 — a small promisified git. Rejects with the combined output tail.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() || e?.message || String(e);
    throw new Error(`git ${args.join(' ')} failed: ${out.slice(-800)}`);
  }
}

/** git that never throws: returns the exit code and the output tail. */
export async function gitTry(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; tail: string }> {
  try {
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout, tail: '' };
  } catch (e: any) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim() || e?.message || String(e);
    return { ok: false, stdout: e?.stdout ?? '', tail: out.slice(-800) } ;
  }
}
