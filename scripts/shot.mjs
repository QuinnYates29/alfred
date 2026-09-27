// Screenshot dashboard routes: node scripts/shot.mjs <baseUrl> <outDir> [route…] (default routes: / /board /goals /inbox /system)
// Env: SHOT_W/SHOT_H viewport (default 1440x900), SHOT_THEME=light|dark.
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const [base, out, ...routes] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');
const browser = await chromium.launch({ executablePath: EXE, args: ['--disable-gpu'] }); // the GPU is full of Qwen: no NVRM noise
const page = await browser.newPage({ viewport: { width: Number(process.env.SHOT_W ?? 1440), height: Number(process.env.SHOT_H ?? 900) }, colorScheme: process.env.SHOT_THEME === 'light' ? 'light' : 'dark' });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
for (const r of routes.length ? routes : ['/', '/board', '/goals', '/inbox', '/system']) {
  const u = new URL(base);
  u.hash = '#' + r;
  await page.goto(u.toString());
  await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
  const file = join(out, (r.replace(/\W+/g, '_') || 'home') + '.png');
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
