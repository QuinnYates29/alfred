// P14 §2 — live statistics: host, GPU, Qwen slots, token usage, task/goal counts.
import * as os from 'node:os';
import type { Store } from '../store.js';
import type { OpsCtx } from './exec.js';

const GB = 1024 * 1024; // df -k blocks (1 KiB) per GB

function num(v: string, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface HostStat {
  hostname: string;
  uptimeS: number;
  load: [number, number, number];
  cpus: number;
  mem: { totalMb: number; usedMb: number };
  disk: { path: string; totalGb: number; usedGb: number } | null;
}

async function hostStat(ctx: OpsCtx): Promise<HostStat> {
  const total = os.totalmem();
  const used = total - os.freemem();
  let disk: HostStat['disk'] = null;
  try {
    const r = await ctx.exec('df', ['-k', '/']);
    if (r.code === 0) {
      const lines = r.stdout.trim().split('\n');
      const cols = (lines[1] ?? '').split(/\s+/);
      if (cols.length >= 6) {
        disk = {
          path: '/',
          totalGb: Math.round((num(cols[1], 0) / GB) * 10) / 10,
          usedGb: Math.round((num(cols[2], 0) / GB) * 10) / 10,
        };
      }
    }
  } catch {
    disk = null;
  }
  const load = os.loadavg();
  return {
    hostname: os.hostname(),
    uptimeS: Math.round(os.uptime()),
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpus: os.cpus().length,
    mem: { totalMb: Math.round(total / 1048576), usedMb: Math.round(used / 1048576) },
    disk,
  };
}

export interface GpuStat {
  name: string;
  utilPct: number;
  smMhz: number;
  tempC: number;
  powerW: number;
  memUsedMb: number | null;
}

async function gpuStat(ctx: OpsCtx): Promise<GpuStat | null> {
  try {
    const r = await ctx.exec('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,clocks.sm,temperature.gpu,power.draw,memory.used',
      '--format=csv,noheader,nounits',
    ]);
    if (r.code !== 0) return null;
    const line = r.stdout.split('\n')[0]?.trim();
    if (!line) return null;
    const f = line.split(',').map((s) => s.trim());
    const mem = Number(f[5]);
    return {
      name: f[0] ?? '',
      utilPct: num(f[1], 0),
      smMhz: num(f[2], 0),
      tempC: num(f[3], 0),
      powerW: num(f[4], 0),
      memUsedMb: Number.isFinite(mem) ? mem : null,
    };
  } catch {
    return null;
  }
}

export interface QwenStat {
  ok: true;
  url: string;
  slots: { id: number; processing: boolean; nCtx: number; promptTokens: number }[];
  busy: number;
  total: number;
}

export async function qwenSlots(ctx: OpsCtx): Promise<QwenStat | { ok: false; url: string; error: string }> {
  const url = ctx.qwenUrl;
  try {
    const res = await ctx.fetch(`${url}/slots`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const raw = (await res.json()) as any[];
    const slots = (Array.isArray(raw) ? raw : []).map((s) => ({
      id: Number(s.id),
      processing: Boolean(s.is_processing),
      nCtx: Number(s.n_ctx),
      promptTokens: Number(s.n_prompt_tokens),
    }));
    return { ok: true, url, slots, busy: slots.filter((s) => s.processing).length, total: slots.length };
  } catch (e: any) {
    return { ok: false, url, error: e?.message ?? String(e) };
  }
}

export interface TokenWin {
  prompt: number;
  completion: number;
  turns: number;
}

interface TurnRow {
  ts: number;
  data: string;
  persona: string | null;
}

function turnRows(store: Store): TurnRow[] {
  try {
    return store
      .raw()
      .prepare(
        `SELECT e.ts AS ts, e.data AS data, t.persona AS persona
         FROM events e LEFT JOIN tasks t ON t.id = e.taskId
         WHERE e.kind = 'turn'`,
      )
      .all() as TurnRow[];
  } catch {
    return [];
  }
}

function emptyWin(): TokenWin {
  return { prompt: 0, completion: 0, turns: 0 };
}

function addUsage(win: TokenWin, prompt: number, completion: number): void {
  win.prompt += prompt;
  win.completion += completion;
  win.turns += 1;
}

function tokensStat(store: Store, now: number) {
  const h1 = now - 3600_000;
  const h24 = now - 24 * 3600_000;
  const last1h = emptyWin();
  const last24h = emptyWin();
  const byPersona24h: Record<string, { prompt: number; completion: number }> = {};
  for (const row of turnRows(store)) {
    if (row.ts < h24) continue;
    let d: any;
    try {
      d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }
    const prompt = Number(d?.usage?.promptTokens) || 0;
    const completion = Number(d?.usage?.completionTokens) || 0;
    addUsage(last24h, prompt, completion);
    if (row.ts >= h1) addUsage(last1h, prompt, completion);
    const p = row.persona ?? 'unknown';
    const b = (byPersona24h[p] ??= { prompt: 0, completion: 0 });
    b.prompt += prompt;
    b.completion += completion;
  }
  return { last1h, last24h, byPersona24h };
}

function taskCounts(store: Store, now: number) {
  const counts: Record<string, number> = {};
  try {
    for (const r of store.raw().prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as any[]) {
      counts[r.status] = r.n;
    }
  } catch {
    /* empty */
  }
  let done24h = 0;
  let failed24h = 0;
  const h24 = now - 24 * 3600_000;
  for (const e of store.allEvents()) {
    if (e.kind !== 'transition' || e.ts < h24) continue;
    if (e.data?.to === 'done') done24h++;
    else if (e.data?.to === 'failed') failed24h++;
  }
  return {
    running: counts.running ?? 0,
    queued: counts.queued ?? 0,
    parked: (counts.blocked ?? 0) + (counts.needs_claude ?? 0),
    done24h,
    failed24h,
  };
}

function goalCounts(store: Store) {
  const out = { active: 0, done: 0, failed: 0 };
  try {
    for (const r of store.raw().prepare('SELECT status, COUNT(*) AS n FROM goals GROUP BY status').all() as any[]) {
      if (r.status in out) (out as any)[r.status] = r.n;
    }
  } catch {
    /* empty */
  }
  return out;
}

export async function getStats(store: Store, ctx: OpsCtx) {
  const now = Date.now();
  const [host, gpu, qwen] = await Promise.all([hostStat(ctx), gpuStat(ctx), qwenSlots(ctx)]);
  return {
    ts: now,
    host,
    gpu,
    qwen,
    tokens: tokensStat(store, now),
    tasks: taskCounts(store, now),
    goals: goalCounts(store),
  };
}

export interface HistoryBucket {
  t: number;
  prompt: number;
  completion: number;
  turns: number;
  done: number;
  failed: number;
}

export function getHistory(store: Store, hours: number, bucketSec: number): HistoryBucket[] {
  const now = Date.now();
  const bms = bucketSec * 1000;
  const first = Math.floor((now - hours * 3600_000) / bms) * bms;
  const last = Math.floor(now / bms) * bms;
  const buckets: HistoryBucket[] = [];
  const byT = new Map<number, HistoryBucket>();
  for (let t = first; t <= last; t += bms) {
    const b = { t, prompt: 0, completion: 0, turns: 0, done: 0, failed: 0 };
    buckets.push(b);
    byT.set(t, b);
  }
  const add = (ts: number, field: 'done' | 'failed') => {
    const b = byT.get(Math.floor(ts / bms) * bms);
    if (b) b[field]++;
  };
  for (const row of turnRows(store)) {
    const b = byT.get(Math.floor(row.ts / bms) * bms);
    if (!b) continue;
    let d: any;
    try {
      d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch {
      continue;
    }
    b.prompt += Number(d?.usage?.promptTokens) || 0;
    b.completion += Number(d?.usage?.completionTokens) || 0;
    b.turns += 1;
  }
  for (const e of store.allEvents()) {
    if (e.kind !== 'transition') continue;
    if (e.data?.to === 'done') add(e.ts, 'done');
    else if (e.data?.to === 'failed') add(e.ts, 'failed');
  }
  return buckets;
}
