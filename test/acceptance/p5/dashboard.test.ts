// P5 acceptance — written by the orchestrator. Do not edit to make it pass.
// Requires `npm run build:web` first (the test builds it if web/dist is missing).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startAlfred, type Alfred } from '../../../src/main.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');

/** Waits until released, then gives up with a reason. Lets the test control when a failure happens. */
function gatedLLM() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const llm: LLM = {
    async chat(req: LLMRequest) {
      const first = req.messages[0]?.content ?? '';
      if (first.includes('UI-FAIL')) {
        await gate;
        return { content: '', toolCalls: [{ id: 'g1', name: 'give_up', args: { reason: 'the widget API was removed upstream' } }], usage: { promptTokens: 1, completionTokens: 1 } };
      }
      if (first.includes('UI-PUSH')) {
        const already = req.messages.some(m => m.role === 'tool');
        return already
          ? { content: '', toolCalls: [{ id: 'f', name: 'finish', args: { summary: 'ok' } }], usage: { promptTokens: 1, completionTokens: 1 } }
          : { content: '', toolCalls: [{ id: 's', name: 'run_shell', args: { cmd: 'git push origin main 2>/dev/null; touch pushed.txt' } }], usage: { promptTokens: 1, completionTokens: 1 } };
      }
      // Anything else idles slowly, so it stays running until stopped.
      await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
      return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  return { llm, release };
}

let alfred: Alfred;
let browser: Browser;
let page: Page;
const gated = gatedLLM();

beforeAll(async () => {
  if (!existsSync('web/dist/index.html')) execSync('npm run build:web', { stdio: 'inherit' });
  const base = mkdtempSync(join(tmpdir(), 'alfred-ui-'));
  alfred = await startAlfred({
    dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: gated.llm,
  });
  browser = await chromium.launch({ executablePath: EXE });
  page = await browser.newPage();
}, 180_000);

afterAll(async () => { await browser?.close(); await alfred?.stop(); });

const api = (path: string, body?: any) => fetch(alfred.url + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

describe('dashboard', () => {
  it('creates a goal from the form and lists it', async () => {
    await page.goto(alfred.url + '/#/');
    await page.getByRole('button', { name: /new goal/i }).click();
    await page.getByLabel(/title/i).fill('UI-IDLE goal from the form');
    await page.getByLabel(/spec/i).fill('just wait');
    await page.getByRole('button', { name: /create/i }).click();
    await expect.poll(() => alfred.store.listGoals().some(g => g.title === 'UI-IDLE goal from the form'), { timeout: 5000 }).toBe(true);
    await page.goto(alfred.url + '/#/');
    await page.getByText('UI-IDLE goal from the form').first().waitFor({ timeout: 5000 });
  }, 30_000);

  it('shows a red failure card within 5 s of a failure, live, plus the global banner', async () => {
    const { goal } = await api('/api/goals', { title: 'UI-FAIL goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    await page.goto(`${alfred.url}/#/goal/${goal.id}`);
    await page.getByText('UI-FAIL goal').first().waitFor({ timeout: 5000 });
    const t0 = Date.now();
    gated.release();
    const card = page.getByTestId('failure-card').first();
    await card.waitFor({ timeout: 5000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await card.textContent()).toContain('the widget API was removed upstream');
    await page.getByTestId('alert-banner').waitFor({ timeout: 5000 });
  }, 30_000);

  it('approves a guarded command from the approvals view', async () => {
    const { task } = await api('/api/goals', { title: 'UI-PUSH goal', persona: 'coder', spec: 's', acceptance: [{ name: 'p', cmd: 'test -f pushed.txt' }] });
    await expect.poll(() => alfred.store.approvals({ status: 'pending' }).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const [ap] = alfred.store.approvals({ status: 'pending' });
    await page.goto(`${alfred.url}/#/approvals`);
    await page.getByTestId(`approve-${ap.id}`).click();
    await expect.poll(() => alfred.store.getTask(task.id)!.status, { timeout: 10_000 }).toBe('done');
  }, 30_000);

  it('stops a running task from the goal view', async () => {
    const { goal, task } = await api('/api/goals', { title: 'UI-IDLE to stop', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    await expect.poll(() => alfred.store.getTask(task.id)!.status, { timeout: 5000 }).toBe('running');
    await page.goto(`${alfred.url}/#/goal/${goal.id}`);
    await page.getByRole('button', { name: /^stop$/i }).first().click();
    await expect.poll(() => alfred.store.getTask(task.id)!.status, { timeout: 5000 }).toBe('stopped');
  }, 30_000);

  it('has personas and deck views', async () => {
    await page.goto(`${alfred.url}/#/personas`);
    await page.getByText('coder-lg').first().waitFor({ timeout: 5000 });
    await page.goto(`${alfred.url}/#/models`);
    await page.getByText('qwen-local').first().waitFor({ timeout: 5000 });
    await page.goto(`${alfred.url}/#/deck`);
    await page.getByText(/deck not running/i).waitFor({ timeout: 5000 });
  }, 30_000);
});
