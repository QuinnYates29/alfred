// Screenshot dashboard routes: node scripts/shot.mjs <baseUrl> <outDir> [route…] (default routes: / /board /goals /inbox /system)
// Env: SHOT_W/SHOT_H viewport (default 1440x900), SHOT_THEME=light|dark.
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
const [base, out, ...routes] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');
const browser = await chromium.launch({ executablePath: EXE, args: ['--disable-gpu'], env: { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json', VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json' } });
// ^ --disable-gpu alone still loads the NVIDIA GL driver and opens /dev/nvidia0 (a real GPU context);
// with Qwen holding most of the unified memory that fails as NVRM NV_ERR_NO_MEMORY. Point EGL/Vulkan at Mesa/lavapipe.
const page = await browser.newPage({ viewport: { width: Number(process.env.SHOT_W ?? 1440), height: Number(process.env.SHOT_H ?? 900) }, colorScheme: process.env.SHOT_THEME === 'light' ? 'light' : 'dark' });
if (process.env.SHOT_SKIN) await page.addInitScript((k) => localStorage.setItem('alfred.skin', k), process.env.SHOT_SKIN);
page.on('pageerror', (e) => console.error('pageerror:', e.message));
for (const r of routes.length ? routes : ['/', '/board', '/goals', '/inbox', '/system']) {
  const u = new URL(base);
  u.hash = '#' + r;
  await page.goto(u.toString());
  await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
  const file = join(out, (process.env.SHOT_SKIN ? process.env.SHOT_SKIN + '-' : '') + (r.replace(/\W+/g, '_') || 'home') + '.png');
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
