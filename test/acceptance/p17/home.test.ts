// P17d acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, idleLLM, until, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => {
  h = await boot(idleLLM({
    // the chat engine's system prompt mentions start_goal; reply plainly
    "Quinn's chief of staff": () => ({ content: 'Nothing is on fire.' }),
  }));
}, 180_000);
afterAll(async () => { await h?.close(); });

describe('home', () => {
  it('shows stats tiles, needs-you, due-soon items and recent goals', async () => {
    const { page } = h;
    await h.api('/api/goals', { title: 'Home recent goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    const today = new Date();
    const due = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await h.api('/api/items', { title: 'Due today thing', due, status: 'todo' });
    await page.goto(`${h.alfred.url}/#/`);
    await page.getByText('Home recent goal').first().waitFor({ timeout: 8000 });
    await page.getByText('Due today thing').first().waitFor({ timeout: 5000 });
    expect(await page.getByRole('button', { name: /new goal/i }).count()).toBe(1); // only the top bar's
    const text = (await page.locator('main').textContent())!;
    expect(text).toMatch(/GPU|Qwen/);
  }, 60_000);
});

describe('inbox', () => {
  it('lists approvals, parked and failed work, and decides approvals', async () => {
    const { page } = h;
    const g = h.alfred.store.createGoal({ title: 'Inbox goal' });
    const t = h.alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'Needs a push' });
    h.alfred.store.claim(t.id, 'w', 60_000);
    h.alfred.store.transition(t.id, 'blocked', { reason: 'approval needed: git push', by: 'w' });
    const ap = h.alfred.store.requestApproval(t.id, 'git push', 'git push origin main');
    const t2 = h.alfred.store.createTask({ goalId: g.id, persona: 'researcher', title: 'Asked Claude' });
    h.alfred.store.claim(t2.id, 'w2', 60_000);
    h.alfred.store.transition(t2.id, 'needs_claude', { reason: 'contradictory spec', by: 'w2' });
    await page.goto(`${h.alfred.url}/#/inbox`);
    await page.getByText('git push origin main').first().waitFor({ timeout: 8000 });
    await page.getByText('contradictory spec').first().waitFor({ timeout: 5000 });
    await page.getByTestId(`approve-${ap.id}`).click();
    await until(() => h.alfred.store.approvals({ status: 'approved' }).some(a => a.id === ap.id));
    await until(async () => (await page.getByTestId(`approve-${ap.id}`).count()) === 0);
  }, 60_000);
});

describe('chat', () => {
  it('sends a message and shows the reply live', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/chat`);
    await page.getByTestId('chat-input').fill('anything on fire?');
    await page.getByTestId('chat-input').press('Enter');
    await page.getByText('Nothing is on fire.').first().waitFor({ timeout: 8000 });
    expect(page.url()).toMatch(/#\/chat\/[\w-]+/);
    await page.getByTestId('new-thread').click();
    await until(async () => (await page.getByText('Nothing is on fire.').count()) === 0);
  }, 60_000);

  it('asks from the palette deep link', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/chat?ask=${encodeURIComponent('status please')}`);
    await page.getByText('status please').first().waitFor({ timeout: 8000 });
    await until(async () => (await page.getByText('Nothing is on fire.').count()) > 0, 8000);
  }, 60_000);
});
