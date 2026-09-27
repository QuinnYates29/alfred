// P17c acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boot, idleLLM, until, type Harness } from './harness.js';
import { RepoHub } from '../../../src/git/hub.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }).trim();

let h: Harness;
beforeAll(async () => {
  h = await boot(idleLLM({
    'UI-GIVEUP': () => ({ toolCalls: [{ id: 'g', name: 'give_up', args: { reason: 'the upstream API is gone' } }] }),
  }));
}, 180_000);
afterAll(async () => { await h?.close(); });

describe('goals list and detail', () => {
  it('lists goals with filters and opens the detail with a live failure card', async () => {
    const { page } = h;
    const idle = await h.api('/api/goals', { title: 'UI idle goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    await page.goto(`${h.alfred.url}/#/goals`);
    await page.getByText('UI idle goal').first().waitFor({ timeout: 8000 });
    const failing = await h.api('/api/goals', { title: 'UI-GIVEUP goal', persona: 'coder', spec: 's', acceptance: [{ name: 'a', cmd: 'true' }] });
    await page.goto(`${h.alfred.url}/#/goal/${failing.goal.id}`);
    const card = page.getByTestId('failure-card').first();
    await card.waitFor({ timeout: 5000 });
    expect(await card.textContent()).toContain('the upstream API is gone');
    await page.goto(`${h.alfred.url}/#/goal/${idle.goal.id}`);
    await until(() => h.alfred.store.getTask(idle.task.id)!.status === 'running');
    await page.getByRole('button', { name: /^stop$/i }).first().click();
    await until(() => h.alfred.store.getTask(idle.task.id)!.status === 'stopped');
  }, 60_000);

  it('shows the transcript of a task', async () => {
    const { page } = h;
    const g = h.alfred.store.createGoal({ title: 'Transcript goal' });
    const t = h.alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'Transcript task' });
    h.alfred.store.appendEvent(g.id, t.id, 'turn', { turn: 1, text: 'I will look at the **README**', calls: [{ name: 'read_file', args: '{"path":"README.md"}' }], usage: { promptTokens: 10, completionTokens: 5 } });
    h.alfred.store.appendEvent(g.id, t.id, 'tool', { name: 'read_file', ok: true, output: '[README.md lines 1-3 of 3]\nhello' });
    await page.goto(`${h.alfred.url}/#/goal/${g.id}/transcript`);
    const tr = page.getByTestId('transcript');
    await tr.waitFor({ timeout: 5000 });
    await until(async () => (await tr.textContent())!.includes('I will look at the'));
    expect(await tr.textContent()).toContain('read_file');
    expect(await tr.locator('strong', { hasText: 'README' }).count()).toBeGreaterThan(0);
    // live: a new turn appears without reload
    h.alfred.store.appendEvent(g.id, t.id, 'turn', { turn: 2, text: 'Second thought here', calls: [], usage: { promptTokens: 1, completionTokens: 1 } });
    await until(async () => (await tr.textContent())!.includes('Second thought here'));
  }, 60_000);

  it('reviews and merges pushed changes', async () => {
    const { page } = h;
    // a Spark repo registered + a goal branch in the hub
    const src = join(h.base, 'proj');
    mkdirSync(src);
    git(src, 'init', '-q');
    writeFileSync(join(src, 'app.js'), 'console.log(1)\n');
    git(src, 'add', '-A');
    git(src, 'commit', '-qm', 'init');
    h.alfred.store.upsertRepo({ name: 'proj', paths: { local: src }, defaultBranch: 'main' });
    await new RepoHub({ root: join(h.base, 'git') }).ensure('proj', src);
    const bare = join(h.base, 'git', 'proj.git');
    const wt = join(h.base, 'wt');
    git(h.base, 'clone', '-q', bare, wt);
    git(wt, 'checkout', '-q', '-b', 'alfred/ui/1');
    writeFileSync(join(wt, 'app.js'), 'console.log(42)\n');
    git(wt, 'commit', '-qam', 'answer');
    git(wt, 'push', '-q', 'origin', 'alfred/ui/1');
    const g = h.alfred.store.createGoal({ title: 'Review me', meta: { repo: 'proj' } });
    const t = h.alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'Review me' });
    h.alfred.store.appendEvent(g.id, t.id, 'pushed', { branch: 'alfred/ui/1', sha: git(wt, 'rev-parse', 'HEAD') });
    await page.goto(`${h.alfred.url}/#/goal/${g.id}/changes`);
    await page.getByText('app.js').first().waitFor({ timeout: 8000 });
    await page.getByText('console.log(42)').first().waitFor({ timeout: 5000 });
    await page.getByTestId('merge-btn').click();
    await page.getByRole('dialog').getByRole('button', { name: /merge/i }).last().click();
    await until(() => git(h.base, '--git-dir', bare, 'show', 'main:app.js') === 'console.log(42)', 8000);
  }, 60_000);

  it('browses workspace files', async () => {
    const { page } = h;
    const ws = join(h.base, 'files-ws');
    mkdirSync(join(ws, 'docs'), { recursive: true });
    writeFileSync(join(ws, 'notes.txt'), 'remember the milk');
    const g = h.alfred.store.createGoal({ title: 'Files goal' });
    const t = h.alfred.store.createTask({ goalId: g.id, persona: 'coder', title: 'Files task' });
    h.alfred.store.appendEvent(g.id, t.id, 'workspace', { path: ws, node: 'local' });
    await page.goto(`${h.alfred.url}/#/goal/${g.id}/files`);
    await page.getByText('notes.txt').first().click({ timeout: 8000 });
    await page.getByText('remember the milk').first().waitFor({ timeout: 5000 });
    expect(await page.getByText('docs').count()).toBeGreaterThan(0);
  }, 60_000);
});
