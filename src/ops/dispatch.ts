// P14 §7 — the Qwen build harness: .dispatch/<name>/status.json + qwen-task.sh launches.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpsCtx } from './exec.js';

export interface DispatchStatus {
  name: string;
  branch: string;
  state: string;
  attempt: number;
  ts: string;
}

export function listDispatch(dispatchDir: string): DispatchStatus[] {
  const out: DispatchStatus[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(dispatchDir);
  } catch {
    return out;
  }
  for (const d of dirs.sort()) {
    try {
      const raw = JSON.parse(readFileSync(join(dispatchDir, d, 'status.json'), 'utf8'));
      out.push({
        name: String(raw.name ?? d),
        branch: String(raw.branch ?? ''),
        state: String(raw.state ?? ''),
        attempt: Number(raw.attempt) || 0,
        ts: typeof raw.ts === 'string' ? raw.ts : String(raw.ts ?? ''),
      });
    } catch {
      /* unparseable / missing → skipped */
    }
  }
  return out;
}

export function getDispatch(
  dispatchDir: string,
  name: string,
): { status: DispatchStatus | null; log: string[]; check: string | null } | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null; // no traversal out of .dispatch/
  const dir = join(dispatchDir, name);
  let statusRaw: any = null;
  try {
    statusRaw = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'));
  } catch {
    /* no/invalid status */
  }
  try {
    if (!readdirSync(dir).includes('status.json') && !existsSync(join(dir, 'run.log'))) return null;
  } catch {
    return null;
  }
  let log: string[] = [];
  try {
    let text = readFileSync(join(dir, 'run.log'), 'utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    log = text.split('\n').slice(-100);
  } catch {
    /* no log */
  }
  let check: string | null = null;
  try {
    let best = -1;
    let bestName = '';
    for (const f of readdirSync(dir)) {
      const m = f.match(/^check(\d+)\.txt$/);
      if (m && Number(m[1]) > best) {
        best = Number(m[1]);
        bestName = f;
      }
    }
    if (best >= 0) check = readFileSync(join(dir, bestName), 'utf8');
  } catch {
    /* no checks */
  }
  const status: DispatchStatus | null = statusRaw
    ? {
        name: String(statusRaw.name ?? name),
        branch: String(statusRaw.branch ?? ''),
        state: String(statusRaw.state ?? ''),
        attempt: Number(statusRaw.attempt) || 0,
        ts: typeof statusRaw.ts === 'string' ? statusRaw.ts : String(statusRaw.ts ?? ''),
      }
    : null;
  return { status, log, check };
}

export interface DispatchLaunch {
  name: string;
  branch: string;
  promptFile: string;
  check: string;
  attempts: number;
  timeoutMin: number;
}

/** Self-contained status for a freshly launched job (also lets the running-limit count it). */
export function initDispatchStatus(dispatchDir: string, name: string, branch: string): void {
  const dir = join(dispatchDir, name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ name, branch, state: 'running', attempt: 1, ts: new Date().toISOString() }),
    );
  } catch {
    /* best effort */
  }
}

export function launchDispatch(
  ctx: OpsCtx,
  body: any,
): { ok: true; name: string } | { error: string; status: number } {
  const confirmRequired = body?.confirm === true;
  if (!confirmRequired) return { error: 'confirm required', status: 400 };
  const name = String(body?.name ?? '');
  const branch = String(body?.branch ?? '');
  const promptFile = String(body?.promptFile ?? '');
  const check = String(body?.check ?? '');
  const attempts = Number(body?.attempts ?? 4);
  const timeoutMin = Number(body?.timeoutMin ?? 60);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { error: 'name must match ^[A-Za-z0-9_-]+$', status: 400 };
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..')) return { error: 'invalid branch', status: 400 };
  if (!/^[A-Za-z0-9._/-]+$/.test(promptFile) || promptFile.includes('..')) {
    return { error: 'invalid promptFile', status: 400 };
  }
  if (!check) return { error: 'check is required', status: 400 };
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) return { error: 'attempts must be 1..20', status: 400 };
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1) return { error: 'timeoutMin must be a positive integer', status: 400 };
  const absPrompt = join(ctx.repoRoot, promptFile);
  if (!existsSync(absPrompt)) return { error: `promptFile not found: ${promptFile}`, status: 400 };
  if (listDispatch(ctx.dispatchDir).filter((s) => s.state === 'running').length >= 3) {
    return { error: 'too many dispatch jobs running (max 3)', status: 409 };
  }
  initDispatchStatus(ctx.dispatchDir, name, branch);
  ctx.spawnDetached(
    'bash',
    [
      join(ctx.repoRoot, 'scripts', 'qwen-task.sh'),
      name,
      branch,
      absPrompt,
      check,
      String(attempts),
      String(timeoutMin),
    ],
    { cwd: ctx.repoRoot },
  );
  return { ok: true, name };
}
