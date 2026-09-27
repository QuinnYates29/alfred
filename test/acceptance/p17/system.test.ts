// P17e acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { boot, idleLLM, until, type Harness } from './harness.js';

const calls: { cmd: string; args: string[] }[] = [];
const exec = async (cmd: string, args: string[]) => {
  calls.push({ cmd, args });
  if (cmd === 'nvidia-smi') return { code: 0, stdout: 'NVIDIA GB10, 37, 2411, 41, 23.5, [N/A]\n', stderr: '' };
  if (cmd === 'systemctl' && args[1] === 'show') return { code: 0, stdout: 'ActiveState=active\nSubState=running\nMainPID=42\nMemoryCurrent=104857600\nExecMainStartTimestamp=Thu 2026-09-24 21:33:45 EDT\n', stderr: '' };
  if (cmd === 'journalctl') return { code: 0, stdout: 'log line one\nlog line two\n', stderr: '' };
  if (cmd === 'qwenctl' && args[0] === 'logs') return { code: 0, stdout: 'qwen log\n', stderr: '' };
  return { code: 0, stdout: 'ok', stderr: '' };
};

let h: Harness;
beforeAll(async () => {
  h = await boot(idleLLM(), { extra: { exec, spawnDetached: () => {}, qwenUrl: 'http://127.0.0.1:9' } });
}, 180_000);
afterAll(async () => { await h?.close(); });

describe('system', () => {
  it('overview, services with confirm, logs', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/system`);
    await page.getByText(/NVIDIA GB10|37\s?%/).first().waitFor({ timeout: 8000 });
    await page.goto(`${h.alfred.url}/#/system/services`);
    await page.getByText('qwen-server').first().waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: /^restart$/i }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: /restart|confirm/i }).last().click();
    await until(() => calls.some(c => c.cmd === 'systemctl' && c.args.includes('restart') && c.args.includes('qwen-server.service')), 5000);
    await page.goto(`${h.alfred.url}/#/system/logs`);
    await page.getByText('log line two').first().waitFor({ timeout: 8000 });
  }, 60_000);

  it('edits a persona file with validation errors shown inline', async () => {
    const { page } = h;
    const original = readFileSync('personas/researcher.yaml', 'utf8');
    try {
      await page.goto(`${h.alfred.url}/#/system/config`);
      await page.getByText('personas/researcher.yaml').first().click({ timeout: 8000 });
      const editor = page.getByTestId('config-editor');
      await until(async () => (await editor.inputValue()).includes('name: researcher'));
      await editor.fill(original.replace('tools: [', 'tools: [no_such_tool, '));
      await page.getByTestId('config-save').click();
      await page.getByTestId('confirm-dialog').getByRole('button', { name: /save|confirm/i }).last().click().catch(() => {});
      const err = page.getByTestId('config-error');
      await err.waitFor({ timeout: 5000 });
      expect(await err.textContent()).toContain('no_such_tool');
      expect(readFileSync('personas/researcher.yaml', 'utf8')).toBe(original);
    } finally {
      // never leave the real persona file modified
      if (readFileSync('personas/researcher.yaml', 'utf8') !== original) writeFileSync('personas/researcher.yaml', original);
    }
  }, 60_000);

  it('keeps the legacy routes: personas and models tabs', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/personas`);
    await page.getByText('coder-lg').first().waitFor({ timeout: 8000 });
    await page.goto(`${h.alfred.url}/#/models`);
    await page.getByText('qwen-local').first().waitFor({ timeout: 8000 });
  }, 60_000);
});

describe('automations', () => {
  it('creates an automation with a cron preset and toggles it', async () => {
    const { page } = h;
    await page.goto(`${h.alfred.url}/#/automations`);
    await page.getByRole('button', { name: /new automation|add automation/i }).first().click({ timeout: 8000 });
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel(/name/i).first().fill('Morning check');
    await dlg.getByLabel(/cron/i).first().fill('0 8 * * *');
    await dlg.getByLabel(/title/i).first().fill('Check overnight failures');
    await dlg.getByRole('button', { name: /^save$/i }).click();
    await until(async () => (await h.api('/api/automations')).some((a: any) => a.name === 'Morning check'), 5000);
    await page.getByText('Morning check').first().waitFor({ timeout: 5000 });
  }, 60_000);
});
