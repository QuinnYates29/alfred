// Shared Playwright harness for the P17 web acceptance tests. Written by the orchestrator.
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startAlfred, type Alfred } from '../../../src/main.js';
import type { LLM, LLMRequest } from '../../../src/runtime/contract.js';

export const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');

/** Idles until aborted (tasks stay running) unless a route in `script` matches the first user message. */
export function idleLLM(script: Record<string, (req: LLMRequest) => any> = {}): LLM {
  return {
    async chat(req: LLMRequest) {
      const first = req.messages[0]?.content ?? '';
      for (const [k, fn] of Object.entries(script)) if (first.includes(k) || req.system.includes(k)) return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 }, ...fn(req) };
      await new Promise((r, j) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
      return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

export interface Harness { alfred: Alfred; browser: Browser; page: Page; api: (path: string, body?: any, method?: string) => Promise<any>; base: string; close(): Promise<void> }

export async function boot(llm: LLM, o: { viewport?: { width: number; height: number }; extra?: Record<string, any> } = {}): Promise<Harness> {
  if (!existsSync('web/dist/index.html')) execSync('npm run build:web', { stdio: 'inherit' });
  const base = mkdtempSync(join(tmpdir(), 'alfred-web-'));
  const alfred = await startAlfred({
    dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 25, deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm, gitRoot: join(base, 'git'),
    extra: { llm, ...(o.extra ?? {}) },
  });
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: o.viewport ?? { width: 1400, height: 900 } });
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  const api = async (path: string, body?: any, method?: string) => {
    const res = await fetch(alfred.url + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  return { alfred, browser, page, api, base, async close() { await browser.close(); await alfred.stop(); } };
}

export async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
