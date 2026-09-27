// P18 acceptance — written by the orchestrator. Do not edit to make it pass.
// Run under a display: `xvfb-run -a npx vitest run test/acceptance/p18/`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { startAlfred, type Alfred } from '../../../src/main.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

const require = createRequire(import.meta.url);
const APP = resolve('app');
const quick = require(join(APP, 'src/quick.cjs'));
const notify = require(join(APP, 'src/notify.cjs'));
const tray = require(join(APP, 'src/tray.cjs'));

describe('pure modules', () => {
  it('parses the quick-add grammar', () => {
    expect(quick.parseQuick('')).toEqual({ kind: 'none' });
    expect(quick.parseQuick('! fix the flaky test')).toMatchObject({ kind: 'goal', title: 'fix the flaky test' });
    expect(quick.parseQuick('? what is running')).toMatchObject({ kind: 'ask', text: 'what is running' });
    const it1 = quick.parseQuick('Renew passport #home #admin !! @2026-10-02');
    expect(it1).toMatchObject({ kind: 'item', title: 'Renew passport', labels: ['home', 'admin'], priority: 'high', due: '2026-10-02' });
    expect(quick.parseQuick('pay rent !!!').priority).toBe('urgent');
    const today = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(quick.parseQuick('call mom @today').due).toBe(iso(today));
    const tm = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    expect(quick.parseQuick('call dad @tomorrow')).toMatchObject({ title: 'call dad', due: iso(tm) });
  });

  it('decides notifications from events and settings', () => {
    const settings = { notify: { failures: true, approvals: true, done: false, chat: true } };
    const ctx = { settings, goalTitle: () => 'The goal', taskTitle: () => 'The task', windowFocused: false };
    const tr = (to: string, reason = 'boom') => ({ id: 1, goalId: 'g1', taskId: 't1', ts: 0, kind: 'transition', data: { from: 'running', to, reason } });
    expect(notify.decide(tr('failed'), ctx)).toMatchObject({ title: 'Failed: The task', body: 'boom', url: '/goal/g1' });
    expect(notify.decide(tr('needs_claude'), ctx).title).toBe('Needs Claude: The task');
    expect(notify.decide(tr('running'), ctx)).toBeNull();
    const ap = notify.decide({ id: 2, goalId: 'g1', taskId: 't1', ts: 0, kind: 'approval_requested', data: { approvalId: 'a1', action: 'git push', detail: 'git push origin main' } }, ctx);
    expect(ap).toMatchObject({ title: 'Approval needed: git push', body: 'git push origin main', approvalId: 'a1', actions: ['Approve', 'Deny'], url: '/inbox' });
    const done = { id: 3, goalId: 'g1', taskId: null, ts: 0, kind: 'goal_status', data: { status: 'done' } };
    expect(notify.decide(done, ctx)).toBeNull();
    expect(notify.decide(done, { ...ctx, settings: { notify: { ...settings.notify, done: true } } }).title).toBe('Done: The goal');
    expect(notify.decide(tr('failed'), { ...ctx, settings: { notify: { ...settings.notify, failures: false } } })).toBeNull();
    const chat = { id: 4, goalId: '', taskId: null, ts: 0, kind: 'chat_message', data: { threadId: 'th1', message: { role: 'assistant', content: 'x'.repeat(400) } } };
    const c = notify.decide(chat, ctx);
    expect(c.url).toBe('/chat/th1');
    expect(c.body.length).toBeLessThanOrEqual(200);
    expect(notify.decide(chat, { ...ctx, windowFocused: true })).toBeNull();
  });

  it('builds the tray menu from state', () => {
    const menu = tray.buildMenu({ live: true, running: 2, parked: 1, attention: 3, stats: { gpu: { utilPct: 40 }, qwen: { ok: true, busy: 1, total: 3 } },
      approvals: [{ id: 'a1', action: 'git push', detail: 'git push origin main' }], attentionGoals: [{ id: 'g', title: 'Broken goal' }], paused: false, node: null });
    const labels = JSON.stringify(menu);
    expect(labels).toContain('2 running');
    expect(labels).toContain('1 parked');
    expect(labels).toContain('GPU 40%');
    expect(labels).toContain('Qwen 1/3');
    expect(labels).toContain('Open Alfred');
    expect(labels).toContain('Quick add');
    expect(labels).toContain('Approve');
    expect(labels).toContain('Broken goal');
    expect(labels).toContain('Quit Alfred');
    const offline = JSON.stringify(tray.buildMenu({ live: false, running: 0, parked: 0, attention: 0, stats: null, approvals: [], attentionGoals: [], paused: false, node: null }));
    expect(offline).toContain('Offline');
    expect(offline).not.toContain('Approvals');
  });
});

/** An LLM that fails tasks titled FAIL, asks approval for PUSH, and idles otherwise. */
function llm(): LLM {
  return {
    async chat(req: LLMRequest) {
      const first = req.messages[0]?.content ?? '';
      const u = { promptTokens: 1, completionTokens: 1 };
      if (first.includes('APP-FAIL')) return { content: '', toolCalls: [{ id: 'g', name: 'give_up', args: { reason: 'cannot reach the widget' } }], usage: u };
      if (first.includes('APP-PUSH')) {
        const done = req.messages.some(m => m.role === 'tool');
        return done ? { content: '', toolCalls: [{ id: 'f', name: 'finish', args: { summary: 'ok' } }], usage: u }
          : { content: '', toolCalls: [{ id: 's', name: 'run_shell', args: { cmd: 'git push origin main 2>/dev/null; true' } }], usage: u };
      }
      await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
      return { content: '', toolCalls: [], usage: u };
    },
  };
}

let alfred: Alfred;
let app: ElectronApplication;
let cfg: string;

beforeAll(async () => {
  if (!existsSync('web/dist/index.html')) execSync('npm run build:web', { stdio: 'inherit' });
  const base = mkdtempSync(join(tmpdir(), 'alfred-app-'));
  alfred = await startAlfred({ dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, token: 'app-token', env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: llm(), gitRoot: join(base, 'git') });
  cfg = join(base, 'appcfg');
  require('node:fs').mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify({ url: alfred.url, token: 'app-token', notify: { failures: true, approvals: true, done: true, chat: true } }));
  app = await electron.launch({
    executablePath: join(APP, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', APP],
    env: { ...process.env, ALFRED_APP_TEST: '1', ALFRED_APP_CONFIG_DIR: cfg },
  });
}, 120_000);

afterAll(async () => { await app?.close().catch(() => {}); await alfred?.stop(); });

const log = () => (existsSync(join(cfg, 'notifications.log')) ? readFileSync(join(cfg, 'notifications.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); }
}
const api = (path: string, body?: any) => fetch(alfred.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer app-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());

describe('the app', () => {
  it('opens the dashboard in the main window', async () => {
    const win = await app.firstWindow();
    await win.getByText('Board').first().waitFor({ timeout: 20_000 });
    expect(win.url()).toContain(alfred.url.replace('http://', ''));
  }, 60_000);

  it('notifies a failure within 5 s and acts on an approval', async () => {
    await new Promise(r => setTimeout(r, 1500)); // let the event stream connect
    await api('/api/v1/goals', { title: 'APP-FAIL goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const t0 = Date.now();
    const failed = await until(() => log().find((n: any) => n.title === 'Failed: APP-FAIL goal'), 8000);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(failed.body).toContain('cannot reach the widget');

    const { task } = await api('/api/v1/goals', { title: 'APP-PUSH goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const ap = await until(() => log().find((n: any) => n.approvalId), 10_000);
    expect(ap.actions).toEqual(['Approve', 'Deny']);
    await app.evaluate(async ({ ipcMain }, id) => {
      // the handler registered by the app for test:notificationAction
      const h = (ipcMain as any)._invokeHandlers?.get?.('test:notificationAction');
      if (!h) throw new Error('no test:notificationAction handler');
      await h({}, id, 'Approve');
    }, ap.approvalId);
    await until(async () => alfred.store.getTask(task.id)!.status === 'done', 10_000);
  }, 60_000);

  it('quick-adds items and goals and exposes the tray menu', async () => {
    const r1 = await app.evaluate(async ({ ipcMain }) => (ipcMain as any)._invokeHandlers.get('quick:submit')({}, 'Water plants #home @tomorrow'));
    expect(String(r1)).toMatch(/Created ALF-\d+/);
    const items = await api('/api/v1/items?label=home');
    expect(items[0].title).toBe('Water plants');
    const r2 = await app.evaluate(async ({ ipcMain }) => (ipcMain as any)._invokeHandlers.get('quick:submit')({}, '! research standing desks'));
    expect(String(r2)).toContain('Started goal');
    expect(alfred.store.listGoals().some(g => g.title === 'research standing desks')).toBe(true);
    const menu = await until(() => app.evaluate(async ({ ipcMain }) => (ipcMain as any)._invokeHandlers.get('test:trayMenu')({})), 20_000);
    expect(JSON.stringify(menu)).toContain('Open Alfred');
    expect(JSON.stringify(menu)).toMatch(/\d+ running/);
  }, 60_000);
});
