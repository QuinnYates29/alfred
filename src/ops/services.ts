// P14 §3 — systemd units + the Mission Deck, list & control.
import type { OpsCtx } from './exec.js';

export interface ServiceInfo {
  name: string;
  unit: string | null;
  controllable: string[];
  active: string;
  sub: string;
  since: number | null;
  pid: number | null;
  memMb: number | null;
  url?: string;
}

interface UnitDef {
  name: string;
  unit: string | null;
  controllable: string[];
  url?: string;
}

export const SERVICES: UnitDef[] = [
  { name: 'alfred', unit: 'alfred.service', controllable: ['restart'] },
  { name: 'qwen-server', unit: 'qwen-server.service', controllable: ['start', 'stop', 'restart'] },
];

const SHOW_PROPS = '--property=ActiveState,SubState,ActiveEnterTimestampMonotonic,ExecMainStartTimestamp,MainPID,MemoryCurrent';

async function unitState(ctx: OpsCtx, unit: string): Promise<Omit<ServiceInfo, 'name' | 'controllable' | 'url'>> {
  const base = { active: 'unknown', sub: 'unknown', since: null as number | null, pid: null as number | null, memMb: null as number | null };
  try {
    const r = await ctx.exec('systemctl', ['--user', 'show', unit, SHOW_PROPS]);
    if (r.code !== 0) return base;
    const kv: Record<string, string> = {};
    for (const line of r.stdout.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    const pid = Number(kv.MainPID);
    const mem = Number(kv.MemoryCurrent);
    const ts = kv.ExecMainStartTimestamp ? Date.parse(kv.ExecMainStartTimestamp) : NaN;
    return {
      active: kv.ActiveState || 'unknown',
      sub: kv.SubState || 'unknown',
      since: Number.isFinite(ts) ? ts : null,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      memMb: Number.isFinite(mem) ? Math.round(mem / 1048576) : null,
    };
  } catch {
    return base;
  }
}

export async function listServices(ctx: OpsCtx, deckUrl?: string | null): Promise<ServiceInfo[]> {
  const out: ServiceInfo[] = [];
  for (const s of SERVICES) {
    const st = await unitState(ctx, s.unit!);
    out.push({ name: s.name, unit: s.unit, controllable: s.controllable, ...st });
  }
  out.push({
    name: 'deck',
    unit: null,
    controllable: [],
    active: deckUrl ? 'active' : 'inactive',
    sub: deckUrl ? 'running' : '',
    since: null,
    pid: null,
    memMb: null,
    url: deckUrl ?? undefined,
  });
  return out;
}
