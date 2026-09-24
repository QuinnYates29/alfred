// P4 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../src/store.js';
import { Automations, validCron, cronMatches } from '../../../src/automations.js';

const at = (s: string) => new Date(s);

describe('cron', () => {
  it('validates and matches 5-field expressions', () => {
    expect(validCron('0 9 * * 1-5')).toBe(true);
    expect(validCron('*/15 * * * *')).toBe(true);
    expect(validCron('61 * * * *')).toBe(false);
    expect(validCron('* * *')).toBe(false);
    expect(cronMatches('0 9 * * 1-5', at('2026-09-24T09:00:30'))).toBe(true); // Thursday
    expect(cronMatches('0 9 * * 1-5', at('2026-09-27T09:00:00'))).toBe(false); // Sunday
    expect(cronMatches('*/15 * * * *', at('2026-09-24T10:45:00'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-09-24T10:46:00'))).toBe(false);
    expect(cronMatches('0 0 1,15 * *', at('2026-10-15T00:00:00'))).toBe(true);
  });
});

describe('automations', () => {
  it('fires once per matching minute and skips while the previous goal is active', () => {
    let now = at('2026-09-24T09:00:05').getTime();
    const store = openStore(':memory:', { now: () => now });
    const auto = new Automations(store, { now: () => now });
    const a = auto.upsert({ name: 'Morning check', cron: '0 9 * * *',
      template: { title: 'Morning check', persona: 'researcher', spec: 'check things', acceptance: [{ name: 'ok', cmd: 'true' }] } });
    expect(a.enabled).toBe(true);
    expect(auto.tick().map(x => x.id)).toEqual([a.id]);
    now += 20_000;
    expect(auto.tick()).toEqual([]);
    const fired = auto.list().find(x => x.id === a.id)!;
    expect(fired.lastStatus).toBe('fired');
    const g = store.getGoal(fired.lastGoalId!)!;
    expect(g.status).toBe('active');
    expect(store.listTasks(g.id)[0].persona).toBe('researcher');
    expect(store.events(g.id).some(e => e.kind === 'automation_fired')).toBe(true);

    now = at('2026-09-25T09:00:01').getTime();
    expect(auto.tick()).toEqual([]);
    const skipped = auto.list().find(x => x.id === a.id)!;
    expect(skipped.lastStatus).toBe('skipped');
    expect(skipped.lastNote).toMatch(/still active/);

    auto.setEnabled(a.id, false);
    now = at('2026-09-26T09:00:01').getTime();
    expect(auto.tick()).toEqual([]);
    expect(auto.remove(a.id)).toBe(true);
    expect(auto.list()).toEqual([]);
  });

  it('loads markdown automations from a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-auto-'));
    writeFileSync(join(dir, 'weekly-deps.md'), [
      '---', 'name: Weekly deps audit', 'cron: "0 8 * * 1"', 'persona: coder',
      'acceptance:', '  - name: audit', '    cmd: npm audit --audit-level=high', '---',
      'Run npm audit on the repo and fix high-severity issues.',
    ].join('\n'));
    let now = at('2026-09-28T08:00:00').getTime(); // Monday
    const store = openStore(':memory:', { now: () => now });
    const auto = new Automations(store, { dir, now: () => now });
    auto.reloadFiles();
    const [a] = auto.list();
    expect(a.source).toBe('file');
    expect(a.cron).toBe('0 8 * * 1');
    expect(auto.tick()).toHaveLength(1);
    const g = store.getGoal(auto.list()[0].lastGoalId!)!;
    expect(g.title).toBe('Weekly deps audit — 2026-09-28');
    const t = store.listTasks(g.id)[0];
    expect(t.persona).toBe('coder');
    expect(t.spec).toContain('npm audit');
    expect(t.acceptance[0].cmd).toBe('npm audit --audit-level=high');
  });
});
