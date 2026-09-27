// P17b acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot, idleLLM, until, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await boot(idleLLM()); }, 180_000);
afterAll(async () => { await h?.close(); });

const item = (key: string) => h.alfred.modules.board && (h.alfred.modules.board as any).board.getItem(key);

describe('board view', () => {
  it('renders columns and cards, quick-adds, and follows live changes', async () => {
    await h.api('/api/items', { title: 'Existing task', status: 'todo', priority: 'high', labels: ['home'], due: '2026-01-01' });
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/board`);
    for (const c of ['backlog', 'todo', 'doing', 'review', 'done']) await page.getByTestId(`board-column-${c}`).waitFor({ timeout: 8000 });
    const card = page.getByTestId('card-ALF-1');
    await card.waitFor();
    expect(await card.textContent()).toContain('Existing task');
    expect(await card.textContent()).toContain('home');
    await page.getByTestId('quick-add-backlog').fill('Buy stamps');
    await page.getByTestId('quick-add-backlog').press('Enter');
    await until(() => item('ALF-2')?.title === 'Buy stamps');
    await page.getByTestId('card-ALF-2').waitFor({ timeout: 5000 });
    // an agent/API edit shows up live
    await h.api('/api/items', { title: 'Made by an agent', status: 'doing', by: 'agent:researcher' });
    await page.getByTestId('card-ALF-3').waitFor({ timeout: 5000 });
    expect(await page.getByTestId('board-column-doing').textContent()).toContain('Made by an agent');
  }, 60_000);

  it('moves cards by drag and drop and by the card menu', async () => {
    const { page } = h;
    await page.getByTestId('card-ALF-2').dragTo(page.getByTestId('board-column-todo'));
    await until(() => item('ALF-2')?.kind === 'todo', 5000);
    // menu path (phones)
    const card = page.getByTestId('card-ALF-2');
    await card.hover();
    await card.getByRole('button', { name: /more|⋯|menu|actions/i }).first().click();
    await page.getByRole('menuitem', { name: /review/i }).first().click();
    await until(() => item('ALF-2')?.kind === 'review', 5000);
  }, 60_000);

  it('edits an item in the drawer: title, status, checklist, comment, send to agent', async () => {
    const { page } = h;
    await page.getByTestId('card-ALF-1').click();
    const drawer = page.getByTestId('item-drawer');
    await drawer.waitFor({ timeout: 5000 });
    const title = page.getByTestId('item-title');
    await title.fill('Existing task, renamed');
    await title.press('Enter');
    await until(() => item('ALF-1')?.title === 'Existing task, renamed');
    await page.getByTestId('item-status').selectOption('doing');
    await until(() => item('ALF-1')?.kind === 'doing');
    await page.getByTestId('item-priority').selectOption('urgent');
    await until(() => item('ALF-1')?.priority === 'urgent');
    await page.getByTestId('checklist-add').fill('call first');
    await page.getByTestId('checklist-add').press('Enter');
    await until(() => item('ALF-1')?.checklist?.[0]?.text === 'call first');
    await page.getByTestId('comment-input').fill('on it');
    await page.getByTestId('comment-send').click();
    await until(() => (h.alfred.modules.board as any).board.comments('ALF-1').some((c: any) => c.body === 'on it'));
    await page.getByTestId('edit-description').click();
    await page.getByTestId('item-description').fill('Details **here**');
    await page.getByRole('button', { name: /^save$/i }).first().click();
    await until(() => item('ALF-1')?.description === 'Details **here**');
    await page.getByTestId('send-to-agent').click();
    await page.getByTestId('dispatch-dialog').waitFor();
    await page.getByTestId('dispatch-persona').selectOption('researcher');
    await page.getByTestId('dispatch-submit').click();
    await until(() => item('ALF-1')?.goalIds?.length === 1, 5000);
    const goal = h.alfred.store.getGoal(item('ALF-1').goalIds[0])!;
    expect(h.alfred.store.listTasks(goal.id)[0].persona).toBe('researcher');
    expect(page.url()).toMatch(/#\/board\/ALF-1|#\/goal\//);
  }, 60_000);

  it('opens an item by URL, has a list view with inline status, filters, and board settings', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/board/ALF-3`);
    await page.getByTestId('item-drawer').waitFor({ timeout: 5000 });
    expect(await page.getByTestId('item-title').inputValue()).toBe('Made by an agent');
    await page.keyboard.press('Escape');
    await page.getByTestId('view-list').click();
    const row = page.getByTestId('list-row-ALF-3');
    await row.waitFor({ timeout: 5000 });
    await row.locator('select').first().selectOption('done');
    await until(() => item('ALF-3')?.kind === 'done');
    await page.getByTestId('board-filter').fill('stamps');
    await until(async () => (await page.getByTestId('list-row-ALF-3').count()) === 0);
    expect(await page.getByTestId('list-row-ALF-2').count()).toBe(1);
    await page.getByTestId('board-filter').fill('');
    await page.getByTestId('view-board').click();
    await page.getByTestId('board-settings').click();
    await page.getByTestId('settings-dialog').waitFor();
    await page.getByTestId('add-column').click();
    const inputs = page.getByTestId('settings-dialog').locator('input[type="text"], input:not([type])');
    await inputs.last().fill('Waiting');
    await page.getByTestId('settings-dialog').getByRole('button', { name: /^save$/i }).click();
    await until(() => (h.alfred.modules.board as any).board.defaultBoard().columns.some((c: any) => c.name === 'Waiting'), 5000);
  }, 60_000);

  it('works on a phone-sized screen', async () => {
    const phone = await h.browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await phone.goto(`${h.alfred.url}/#/board`);
    await phone.getByTestId('card-ALF-2').waitFor({ timeout: 8000 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await phone.close();
  }, 60_000);
});
