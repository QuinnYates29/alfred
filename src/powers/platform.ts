// P21a §2 — the `platform` tool: one op-based tool over the ops API (in-process HTTP).
// Reads are free; mutating ops go through the approval gate (action `ops`).
import type { Tool, ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';
import { selfApi, apiError, clip, type ApiResult } from './api.js';
import { gated, sha256 } from './gate.js';
import { capabilityCard } from './card.js';

const READ_OPS = ['capabilities', 'status', 'stats', 'services', 'qwen', 'logs', 'config_list', 'config_get', 'models', 'nodes', 'repos'];
const WRITE_OPS = ['service', 'qwen_set', 'config_set', 'model_role', 'automation', 'automation_delete'];
const QWEN_KEYS = ['preset', 'slots', 'ctx', 'offload'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

/** Stringify small leftovers compactly (no whitespace), capped. */
const brief = (v: unknown) => clip(JSON.stringify(v ?? null), 4000);

function fail(r: ApiResult): ToolResult {
  return { ok: false, output: apiError(r) };
}

// ---- read formatters: compact text, never raw JSON dumps ----

function fmtServices(list: any[]): string {
  return list
    .map((s) => {
      const bits = [`${s.name}: ${s.active}${s.sub ? `/${s.sub}` : ''}`];
      if (s.pid) bits.push(`pid ${s.pid}`);
      if (s.memMb != null) bits.push(`${s.memMb} MB`);
      if (s.url) bits.push(s.url);
      if (s.controllable?.length) bits.push(`actions ${s.controllable.join('|')}`);
      return bits.join(', ');
    })
    .join('\n');
}

function fmtStats(s: any): string {
  const out: string[] = [];
  const h = s.host;
  if (h) {
    const disk = h.disk ? `, disk ${h.disk.usedGb}/${h.disk.totalGb} GB` : '';
    out.push(`host ${h.hostname}: load ${h.load.map((x: number) => x.toFixed(2)).join(' ')}, ${h.cpus} cpus, mem ${h.mem.usedMb}/${h.mem.totalMb} MB${disk}`);
  }
  const g = s.gpu;
  out.push(g ? `GPU ${g.name}: ${g.utilPct}% util, ${g.smMhz} MHz, ${g.tempC} C, ${g.powerW} W${g.memUsedMb != null ? `, ${g.memUsedMb} MB` : ''}` : 'GPU: n/a');
  const q = s.qwen;
  if (q) out.push(q.ok ? `qwen slots: ${q.busy}/${q.total} busy (${q.url})` : `qwen: down (${q.error})`);
  const t = s.tokens;
  if (t) out.push(`tokens 1h: ${t.last1h.prompt}+${t.last1h.completion} (${t.last1h.turns} turns); 24h: ${t.last24h.prompt}+${t.last24h.completion} (${t.last24h.turns} turns)`);
  if (s.tasks) out.push(`tasks: ${s.tasks.running} running, ${s.tasks.queued} queued, ${s.tasks.parked} parked; 24h ${s.tasks.done24h} done, ${s.tasks.failed24h} failed`);
  if (s.goals) out.push(`goals: ${s.goals.active} active, ${s.goals.done} done, ${s.goals.failed} failed`);
  return out.join('\n');
}

function fmtQwen(q: any): string {
  const env = Object.entries(q.env ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return [`health: ${q.health ? 'up' : 'down'}`, `env: ${env || '(none)'}`, `presets: ${(q.presets ?? []).join('|')}`, `limits: ${brief(q.limits)}`].join('\n');
}

function status(deps: ModuleDeps): string {
  const { store } = deps;
  const goals: Record<string, number> = {};
  for (const g of store.listGoals()) goals[g.status] = (goals[g.status] ?? 0) + 1;
  const tasks: Record<string, number> = {};
  for (const r of store.raw().prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as any[]) tasks[r.status] = r.n;
  const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
  const out = [`goals: ${fmt(goals)}`, `tasks: ${fmt(tasks)}`, `approvals pending: ${store.approvals({ status: 'pending' }).length}`];
  const running = deps.scheduler?.running?.() ?? [];
  for (const id of running.slice(0, 10)) {
    const t = store.getTask(id);
    out.push(`running: ${t ? `${t.id.slice(0, 8)} ${t.persona} ${t.title}` : id}`);
  }
  return out.join('\n');
}

async function read(deps: ModuleDeps, op: string, a: any): Promise<ToolResult> {
  const get = (p: string) => selfApi(deps, 'GET', p);
  switch (op) {
    case 'capabilities':
      return { ok: true, output: capabilityCard(deps) };
    case 'status':
      return { ok: true, output: status(deps) };
    case 'stats': {
      const r = await get('/stats');
      return r.ok ? { ok: true, output: fmtStats(r.body) } : fail(r);
    }
    case 'services': {
      const r = await get('/ops/services');
      return r.ok ? { ok: true, output: fmtServices(r.body) } : fail(r);
    }
    case 'qwen': {
      const r = await get('/ops/qwen');
      return r.ok ? { ok: true, output: fmtQwen(r.body) } : fail(r);
    }
    case 'logs': {
      const name = str(a.name) || 'alfred';
      const lines = Math.min(Math.max(Number(a.lines) || 50, 1), 500);
      const r = await get(`/ops/logs/${encodeURIComponent(name)}?lines=${lines}`);
      return r.ok ? { ok: true, output: clip((r.body.lines ?? []).join('\n') || '(empty)') } : fail(r);
    }
    case 'config_list': {
      const r = await get('/ops/config');
      return r.ok ? { ok: true, output: (r.body as any[]).map((f) => `${f.path} (${f.kind}, ${f.size} B)`).join('\n') || 'no config files' } : fail(r);
    }
    case 'config_get': {
      const r = await get(`/ops/config/file?path=${encodeURIComponent(str(a.path))}`);
      return r.ok ? { ok: true, output: clip(`${r.body.path}:\n${r.body.content}`) } : fail(r);
    }
    case 'models': {
      const r = await get('/models');
      if (!r.ok) return fail(r);
      const roles = Object.entries(r.body.roles ?? {}).map(([k, v]) => `${k}=${v}`).join(', ');
      const models = (r.body.models ?? []).map((m: any) => `${m.name}: ${m.model} @ ${m.baseUrl}`).join('\n');
      return { ok: true, output: clip(`roles: ${roles || 'none'}\n${models}`) };
    }
    case 'nodes': {
      const r = await get('/nodes');
      if (!r.ok) return fail(r);
      const list = (r.body as any[]).map((n) => `${n.name}: caps ${(n.caps ?? []).join(',') || 'none'}; roots ${(n.roots ?? []).join(',')}`);
      return { ok: true, output: list.join('\n') || 'no nodes online' };
    }
    case 'repos': {
      const r = await get('/ops/repos');
      if (!r.ok) return fail(r);
      const list = (r.body as any[]).map((x) => {
        const paths = Object.entries(x.paths ?? {}).map(([m, p]) => `${m}:${p}`).join(' ');
        return `${x.name}: ${paths}; ${(x.branches ?? []).length} branches`;
      });
      return { ok: true, output: clip(list.join('\n') || 'no repos') };
    }
  }
  return { ok: false, output: `unknown op: ${op}` };
}

/** detail + the request that runs once it is approved. */
function mutation(op: string, a: any): { detail: string; method: string; path: string; body: any } | string {
  const by = 'agent';
  switch (op) {
    case 'service': {
      const name = str(a.name);
      const action = str(a.action);
      if (!/^[a-z0-9-]+$/.test(name) || !/^(start|stop|restart)$/.test(action)) return 'service needs name and action start|stop|restart';
      return { detail: `service:${name}:${action}`, method: 'POST', path: `/ops/services/${name}/${action}`, body: { confirm: true, by } };
    }
    case 'qwen_set': {
      const keys = QWEN_KEYS.filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
      if (keys.length !== 1) return `qwen_set needs exactly one of ${QWEN_KEYS.join('|')}`;
      const k = keys[0]!;
      const v = str(a[k]);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) return `invalid ${k}: ${v}`;
      return { detail: `qwen:${k}=${v}`, method: 'POST', path: '/ops/qwen', body: { [k]: k === 'preset' ? v : Number(v), confirm: true, by } };
    }
    case 'config_set': {
      const path = str(a.path);
      if (typeof a.content !== 'string') return 'config_set needs path and content';
      // The hash binds the approval to this exact content: an approved change can't be swapped.
      return {
        detail: `config:${path} sha256=${sha256(a.content)}`,
        method: 'PUT',
        path: '/ops/config/file',
        body: { path, content: a.content, confirm: true, by },
      };
    }
    case 'model_role': {
      const role = str(a.role);
      const model = str(a.model);
      if (!role || !model) return 'model_role needs role and model';
      return { detail: `role:${role}=${model}`, method: 'POST', path: '/models/roles', body: { role, model } };
    }
    case 'automation': {
      const name = str(a.name);
      const cron = str(a.cron);
      const title = str(a.title);
      if (!name || !cron || !title) return 'automation needs name, cron and title';
      const template = { title, ...(a.persona ? { persona: str(a.persona) } : {}), ...(a.spec ? { spec: str(a.spec) } : {}) };
      const body = { name, cron, template };
      return { detail: `automation:${name}@${cron} sha256=${sha256(JSON.stringify(body)).slice(0, 16)}`, method: 'POST', path: '/automations', body };
    }
    case 'automation_delete': {
      const id = str(a.id);
      if (!id) return 'automation_delete needs id';
      return { detail: `automation_delete:${id}`, method: 'DELETE', path: `/automations/${encodeURIComponent(id)}`, body: undefined };
    }
  }
  return `unknown op: ${op}`;
}

export function platformTool(deps: ModuleDeps): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'platform',
      description:
        'Run alfred. Reads: capabilities status stats services qwen logs{name,lines} config_list config_get{path} models nodes repos. ' +
        'Changes (need approval): service{name,action} qwen_set{preset|slots|ctx|offload} config_set{path,content} model_role{role,model} automation{name,cron,title,persona,spec} automation_delete{id}.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...READ_OPS, ...WRITE_OPS] },
          name: { type: 'string' },
          action: { type: 'string' },
          lines: { type: 'number' },
          path: { type: 'string' },
          content: { type: 'string' },
          preset: { type: 'string' },
          slots: { type: 'number' },
          ctx: { type: 'number' },
          offload: { type: 'number' },
          role: { type: 'string' },
          model: { type: 'string' },
          cron: { type: 'string' },
          title: { type: 'string' },
          persona: { type: 'string' },
          spec: { type: 'string' },
          id: { type: 'string' },
          confirm: { type: 'boolean', description: 'chat only, after Quinn agreed' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const a = args ?? {};
      const op = str(a.op);
      try {
        if (READ_OPS.includes(op)) return await read(deps, op, a);
        if (!WRITE_OPS.includes(op)) return { ok: false, output: `unknown op: ${op} (reads: ${READ_OPS.join(' ')}; changes: ${WRITE_OPS.join(' ')})` };
        const m = mutation(op, a);
        if (typeof m === 'string') return { ok: false, output: m };
        return await gated({ deps, tool: ctx, confirm: a.confirm === true }, 'ops', m.detail, async () => {
          const r = await selfApi(deps, m.method, m.path, m.body);
          if (!r.ok) return fail(r);
          const out = r.body && typeof r.body === 'object' && typeof r.body.output === 'string' ? r.body.output.trim() : '';
          return { ok: true, output: clip(`done: ${m.detail}${out ? `\n${out}` : ''}`) };
        });
      } catch (e: any) {
        return { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
