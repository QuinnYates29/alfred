// P4 §2 — automations: cron-scheduled goals, from SQLite and from markdown files.
// Cron parser ported (read-only) from ~/repos/ai-task-dashboard/server/src/automations.ts.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { AcceptanceCheck } from './types.js';
import type { AutomationRow, Store } from './store.js';
import { createGoalWithRoot } from './ops.js';

export interface AutomationTemplate {
  title: string;
  body?: string;
  persona?: string;
  spec?: string;
  acceptance?: AcceptanceCheck[];
  repo?: string;
}

export interface Automation {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  template: AutomationTemplate;
  source: 'db' | 'file';
  lastRunAt: number | null;
  lastGoalId: string | null;
  lastStatus: 'fired' | 'skipped' | null;
  lastNote: string | null;
}

// ── cron ─────────────────────────────────────────────────────────────────────
// Standard 5 fields: minute hour day-of-month month day-of-week (0 = Sunday).
// Supports *, lists, ranges and steps, evaluated in local time.

interface CronField {
  values: Set<number>;
  restricted: boolean;
}

function parseField(field: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  let restricted = field !== '*';
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[3] ? Number(m[3]) : 1;
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[1]);
      hi = m[2] !== undefined ? Number(m[2]) : m[3] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size ? { values, restricted } : null;
}

const FIELD_RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function parseCron(expr: string): CronField[] | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => parseField(p, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
  return fields.every(Boolean) ? (fields as CronField[]) : null;
}

export function validCron(expr: string): boolean {
  return !!parseCron(String(expr ?? ''));
}

export function cronMatches(expr: string, d: Date): boolean {
  const f = parseCron(String(expr ?? ''));
  if (!f) return false;
  const [min, hr, dom, mon, dow] = f;
  // Standard cron semantics: when both day fields are restricted, either may
  // match; when only one is, it must.
  const dayOk =
    dom.restricted && dow.restricted
      ? dom.values.has(d.getDate()) || dow.values.has(d.getDay())
      : (!dom.restricted || dom.values.has(d.getDate())) &&
        (!dow.restricted || dow.values.has(d.getDay()));
  return min.values.has(d.getMinutes()) && hr.values.has(d.getHours()) && mon.values.has(d.getMonth() + 1) && dayOk;
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Split `---`-fenced frontmatter from the markdown body (the body may itself contain ---). */
function splitFrontmatter(text: string): { fm: string; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return { fm: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
      }
    }
  }
  return { fm: '', body: text };
}

function rowToAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    enabled: r.enabled === 1,
    template: JSON.parse(r.template || '{}'),
    source: 'db',
    lastRunAt: r.lastRunAt,
    lastGoalId: r.lastGoalId,
    lastStatus: (r.lastStatus as Automation['lastStatus']) ?? null,
    lastNote: r.lastNote,
  };
}

interface FileState {
  automation: Automation;
}

export class Automations {
  private files = new Map<string, FileState>();

  constructor(
    private store: Store,
    private o: { dir?: string; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  list(): Automation[] {
    return [...this.store.listAutomationRows().map(rowToAutomation), ...[...this.files.values()].map((f) => f.automation)];
  }

  private find(id: string): Automation | undefined {
    return this.list().find((a) => a.id === id);
  }

  /** Insert or update a DB automation. */
  upsert(a: Partial<Automation> & { name: string; cron: string; template: AutomationTemplate }): Automation {
    if (!a.name || !String(a.name).trim()) throw new Error('automation name is required');
    if (!validCron(a.cron ?? '')) throw new Error(`"${a.cron}" is not a valid 5-field cron expression`);
    if (!a.template || !a.template.title) throw new Error('automation template.title is required');
    const prev = this.store.listAutomationRows().find((r) => r.id === a.id);
    const t = this.now();
    const row: AutomationRow = {
      id: a.id ?? randomUUID(),
      name: String(a.name).trim(),
      cron: String(a.cron).trim(),
      enabled: a.enabled === false ? 0 : 1,
      template: JSON.stringify(a.template),
      lastRunAt: prev?.lastRunAt ?? null,
      lastGoalId: prev?.lastGoalId ?? null,
      lastStatus: prev?.lastStatus ?? null,
      lastNote: prev?.lastNote ?? null,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
    };
    this.store.putAutomationRow(row);
    return rowToAutomation(row);
  }

  remove(id: string): boolean {
    const fileKey = id.startsWith('file:') ? id : `file:${id}`;
    if (this.files.delete(fileKey)) return true;
    return this.store.deleteAutomationRow(id);
  }

  setEnabled(id: string, on: boolean): Automation {
    const a = this.find(id);
    if (!a) throw new Error(`no such automation: ${id}`);
    if (a.source === 'file') {
      a.enabled = on;
      return a;
    }
    return this.upsert({ ...a, enabled: on });
  }

  /** dir/*.md: frontmatter {name, cron, persona, acceptance, repo?, enabled?}; body = spec. Never persisted. */
  reloadFiles(): void {
    this.files = new Map();
    const dir = this.o.dir;
    if (!dir || !existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      const text = readFileSync(join(dir, f), 'utf8');
      const { fm, body: bodyText } = splitFrontmatter(text);
      let parsed: any;
      try {
        parsed = parseYaml(fm) ?? {};
      } catch {
        continue; // a broken file must not take down the others
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const cron = String(parsed.cron ?? '').trim();
      if (!cron || !validCron(cron)) continue;
      const name = String(parsed.name ?? f.replace(/\.md$/, '')).trim();
      const body = bodyText.trim();
      const acceptance = Array.isArray(parsed.acceptance)
        ? (parsed.acceptance as AcceptanceCheck[]).filter((c) => c && c.name && c.cmd)
        : [];
      this.files.set(`file:${f}`, {
        automation: {
          id: `file:${f}`,
          name,
          cron,
          enabled: parsed.enabled !== false,
          template: {
            title: name,
            body,
            persona: parsed.persona ? String(parsed.persona) : undefined,
            spec: body,
            acceptance,
            repo: parsed.repo ? String(parsed.repo) : undefined,
          },
          source: 'file',
          lastRunAt: null,
          lastGoalId: null,
          lastStatus: null,
          lastNote: null,
        },
      });
    }
  }

  /** Fire every enabled automation whose cron matches now(). At most once per matching minute. */
  tick(): Automation[] {
    const t = this.now();
    const minute = Math.floor(t / 60_000);
    const fired: Automation[] = [];
    for (const a of this.list()) {
      if (!a.enabled) continue;
      if (!cronMatches(a.cron, new Date(t))) continue;
      if (a.lastRunAt != null && Math.floor(a.lastRunAt / 60_000) >= minute) continue;

      if (a.lastGoalId) {
        const prevGoal = this.store.getGoal(a.lastGoalId);
        if (prevGoal && prevGoal.status === 'active') {
          this.record(a, t, 'skipped', null, 'previous run still active');
          continue;
        }
      }

      const title = a.source === 'file' ? `${a.name} — ${localDate(t)}` : a.template.title;
      const { goal } = createGoalWithRoot(this.store, {
        title,
        body: a.template.body,
        persona: a.template.persona,
        spec: a.template.spec ?? a.template.body,
        acceptance: a.template.acceptance,
        repo: a.template.repo,
      });
      this.store.appendEvent(goal.id, null, 'automation_fired', { automationId: a.id, name: a.name });
      this.record(a, t, 'fired', goal.id, null);
      fired.push(this.find(a.id)!);
    }
    return fired;
  }

  private record(a: Automation, t: number, status: 'fired' | 'skipped', goalId: string | null, note: string | null) {
    if (a.source === 'file') {
      const st = this.files.get(a.id);
      if (st) Object.assign(st.automation, { lastRunAt: t, lastGoalId: goalId, lastStatus: status, lastNote: note });
      return;
    }
    this.store.putAutomationRow({
      id: a.id,
      name: a.name,
      cron: a.cron,
      enabled: a.enabled ? 1 : 0,
      template: JSON.stringify(a.template),
      lastRunAt: t,
      lastGoalId: goalId,
      lastStatus: status,
      lastNote: note,
      createdAt: this.store.listAutomationRows().find((r) => r.id === a.id)?.createdAt ?? t,
      updatedAt: t,
    });
  }
}
