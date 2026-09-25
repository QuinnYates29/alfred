// P4 §2 — cron automations: DB-persisted plus markdown file automations.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import Database from 'better-sqlite3';
import type { Store } from './store.js';
import type { AcceptanceCheck } from './types.js';
import { createGoalWithRoot } from './ops.js';

export interface Automation {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  template: {
    title: string;
    body?: string;
    persona?: string;
    spec?: string;
    acceptance?: AcceptanceCheck[];
    repo?: string;
  };
  source: 'db' | 'file';
  lastRunAt: number | null;
  lastGoalId: string | null;
  lastStatus: 'fired' | 'skipped' | null;
  lastNote: string | null;
}

function fields(expr: string): string[] {
  return expr.trim().split(/\s+/);
}

export function validCron(expr: string): boolean {
  const f = fields(expr);
  if (f.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  return f.every((part, i) => matchPart(part, ranges[i]) !== null);
}

/** Returns a set of allowed values for `part`, or null when the part is invalid. */
function matchPart(part: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const item of part.split(',')) {
    if (item === '') return null;
    let body = item;
    let step = 1;
    const s = item.split('/');
    if (s.length === 2) {
      body = s[0];
      if (!/^\d+$/.test(s[1])) return null;
      step = Number(s[1]);
      if (step < 1) return null;
    } else if (s.length > 2) {
      return null;
    }
    let a: number;
    let b: number;
    if (body === '*') {
      a = lo;
      b = hi;
    } else if (/^\d+$/.test(body)) {
      a = Number(body);
      b = s.length === 2 ? hi : a;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(body);
      if (!m) return null;
      a = Number(m[1]);
      b = Number(m[2]);
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function cronMatches(expr: string, d: Date): boolean {
  const f = fields(expr);
  if (f.length !== 5) return false;
  const sets = [
    matchPart(f[0], [0, 59]),
    matchPart(f[1], [0, 23]),
    matchPart(f[2], [1, 31]),
    matchPart(f[3], [1, 12]),
    matchPart(f[4], [0, 6]),
  ];
  if (sets.some((s) => s === null)) return false;
  const dom = d.getDate();
  const month = d.getMonth() + 1;
  const hour = d.getHours();
  const min = d.getMinutes();
  const dow = d.getDay();
  if (!sets[0]!.has(min) || !sets[1]!.has(hour) || !sets[3]!.has(month)) return false;
  const domRestricted = f[2] !== '*';
  const dowRestricted = f[4] !== '*';
  const domOk = sets[2]!.has(dom);
  const dowOk = sets[4]!.has(dow);
  // Standard cron: when both dom and dow are restricted, either may fire.
  return domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface AutoRow {
  id: string;
  name: string;
  cron: string;
  enabled: number;
  template: string;
  lastRunAt: number | null;
  lastGoalId: string | null;
  lastStatus: string | null;
  lastNote: string | null;
}

function toAuto(r: AutoRow): Automation {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    enabled: r.enabled === 1,
    template: JSON.parse(r.template),
    source: 'db',
    lastRunAt: r.lastRunAt,
    lastGoalId: r.lastGoalId,
    lastStatus: (r.lastStatus as Automation['lastStatus']) ?? null,
    lastNote: r.lastNote,
  };
}

/** Raw access to the automations table inside the store's sqlite file. */
function table(store: Store): Database.Database {
  const db: Database.Database | undefined = (store as any)._db;
  if (!db) throw new Error('automations need a sqlite Store (openStore)');
  db.exec(`CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    template TEXT NOT NULL, lastRunAt INTEGER, lastGoalId TEXT, lastStatus TEXT, lastNote TEXT)`);
  return db;
}

export class Automations {
  private readonly store: Store;
  private readonly db: Database.Database;
  private readonly dir: string | null;
  private readonly now: () => number;
  private files: Automation[] = [];
  /** minute-key -> ids fired that minute (in-memory guard for file automations). */
  private readonly firedAt = new Map<string, string>();

  constructor(store: Store, o?: { dir?: string; now?: () => number }) {
    this.store = store;
    this.db = table(store);
    this.dir = o?.dir ?? null;
    this.now = o?.now ?? (() => Date.now());
    this.reloadFiles();
  }

  list(): Automation[] {
    const rows = this.db.prepare('SELECT * FROM automations ORDER BY name').all() as AutoRow[];
    return [...rows.map(toAuto), ...this.files];
  }

  upsert(
    a: Partial<Automation> & { name: string; cron: string; template: Automation['template'] },
  ): Automation {
    if (!validCron(a.cron)) throw new Error(`invalid cron expression: ${a.cron}`);
    const existing = a.id
      ? (this.db.prepare('SELECT * FROM automations WHERE id = ?').get(a.id) as AutoRow | undefined)
      : undefined;
    const row: AutoRow = {
      id: existing?.id ?? a.id ?? randomUUID(),
      name: a.name,
      cron: a.cron,
      enabled: (a.enabled ?? existing?.enabled ?? true) ? 1 : 0,
      template: JSON.stringify(a.template ?? existing?.template ?? {}),
      lastRunAt: existing?.lastRunAt ?? null,
      lastGoalId: existing?.lastGoalId ?? null,
      lastStatus: existing?.lastStatus ?? null,
      lastNote: existing?.lastNote ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO automations (id, name, cron, enabled, template, lastRunAt, lastGoalId, lastStatus, lastNote)
         VALUES (@id, @name, @cron, @enabled, @template, @lastRunAt, @lastGoalId, @lastStatus, @lastNote)
         ON CONFLICT(id) DO UPDATE SET name=@name, cron=@cron, enabled=@enabled, template=@template`,
      )
      .run(row);
    return toAuto(row);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM automations WHERE id = ?').run(id).changes > 0;
  }

  setEnabled(id: string, on: boolean): Automation {
    const r = this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as
      | AutoRow
      | undefined;
    if (!r) throw new Error(`no such automation: ${id}`);
    this.db.prepare('UPDATE automations SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
    return toAuto({ ...r, enabled: on ? 1 : 0 });
  }

  reloadFiles(): void {
    this.files = [];
    if (!this.dir || !existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      try {
        this.files.push(this.parseFile(join(this.dir, entry), entry));
      } catch (e: any) {
        console.error(`automation file ${entry}: ${e?.message ?? e}`);
      }
    }
  }

  private parseFile(path: string, entry: string): Automation {
    const text = readFileSync(path, 'utf8');
    let fm: Record<string, any> = {};
    let body = text;
    const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
    if (m) {
      fm = (parse(m[1]) as Record<string, any>) ?? {};
      body = text.slice(m[0].length);
    }
    const name = String(fm.name ?? entry.replace(/\.md$/, ''));
    const cron = String(fm.cron ?? '');
    if (!validCron(cron)) throw new Error(`missing or invalid cron: ${cron}`);
    const acceptance = Array.isArray(fm.acceptance)
      ? fm.acceptance.map((c: any) => ({ name: String(c.name), cmd: String(c.cmd) }))
      : [];
    return {
      id: `file:${entry}`,
      name,
      cron,
      enabled: fm.enabled === undefined ? true : Boolean(fm.enabled),
      template: {
        title: `${name} — ${dayStamp(this.now())}`,
        spec: body.trim(),
        persona: fm.persona ? String(fm.persona) : undefined,
        repo: fm.repo ? String(fm.repo) : undefined,
        acceptance,
      },
      source: 'file',
      lastRunAt: null,
      lastGoalId: null,
      lastStatus: null,
      lastNote: null,
    };
  }

  tick(): Automation[] {
    const d = new Date(this.now());
    const minuteKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${d.getHours()}:${d.getMinutes()}`;
    const fired: Automation[] = [];
    for (const a of this.list()) {
      if (!a.enabled || !cronMatches(a.cron, d)) continue;
      if (this.firedAt.get(a.id) === minuteKey) continue;
      this.firedAt.set(a.id, minuteKey);
      const prev = a.lastGoalId ? this.store.getGoal(a.lastGoalId) : undefined;
      if (prev?.status === 'active') {
        this.record(a.id, { lastRunAt: this.now(), lastStatus: 'skipped', lastNote: 'previous run still active' });
        continue;
      }
      const { goal } = createGoalWithRoot(this.store, a.template);
      this.store.appendEvent(goal.id, null, 'automation_fired', { automation: a.name, source: a.source });
      this.record(a.id, { lastRunAt: this.now(), lastGoalId: goal.id, lastStatus: 'fired', lastNote: null });
      fired.push({
        ...a,
        lastRunAt: this.now(),
        lastGoalId: goal.id,
        lastStatus: 'fired',
        lastNote: null,
      });
    }
    return fired;
  }

  private record(id: string, patch: Partial<AutoRow>): void {
    if (id.startsWith('file:')) return; // file automations are never persisted
    const sets = Object.keys(patch)
      .map((k) => `${k} = @${k}`)
      .join(', ');
    this.db.prepare(`UPDATE automations SET ${sets} WHERE id = @id`).run({ ...patch, id });
  }
}
