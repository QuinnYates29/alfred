// ALF-7 — test alfred's UI for real, in the agent's sandbox: boot a throwaway copy of alfred from the
// current checkout (temp DB, random port, a model that never acts), drive it in headless Chromium,
// screenshot it. Run from a checkout's root (the agent's workspace):
//
//   npx tsx scripts/ui-test.mts --smoke             every page, desktop + phone; fails on page errors
//   npx tsx scripts/ui-test.mts --steps steps.json  a scripted run (the `ui_test` tool writes the file)
//
// Writes .ui-test/NN-<name>.jpg + .ui-test/result.json {ok, mode, shots:[{name,file}], errors, steps};
// the runtime turns those into a goal output (screenshots) and removes the folder. Exit 0 = ok.
// A safety rail (src/review/peer.ts GUARDRAIL_RE): agents may not change what judges their UI.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const OUT = resolve('.ui-test');
const EXE = join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell');
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

export interface Step {
  do: 'goto' | 'click' | 'fill' | 'press' | 'wait' | 'expect' | 'screenshot' | 'api' | 'viewport';
  path?: string; // goto: a dashboard route like "/#/agents"
  text?: string; // click/wait/expect: visible text
  role?: string; // click: ARIA role (with name)
  name?: string; // click: accessible name; screenshot: file name
  testid?: string; // click/fill/wait/expect: data-testid
  label?: string; // fill: field label
  placeholder?: string; // fill
  selector?: string; // click/fill/wait/expect: CSS selector (last resort)
  value?: string; // fill
  key?: string; // press
  ms?: number; // wait: plain delay (max 10 s)
  visible?: boolean; // expect: default true
  method?: string; // api
  body?: unknown; // api
  width?: number; // viewport
  height?: number; // viewport
  phone?: boolean; // viewport: 390×844
}

const args = process.argv.slice(2);
const mode = args.includes('--smoke') ? 'smoke' : args.includes('--steps') ? 'steps' : '';
if (!mode) {
  console.error('usage: npx tsx scripts/ui-test.mts --smoke | --steps <file.json>');
  process.exit(2);
}

/** "{{demo.goalId}}" / "{{last.goal.id}}" → values seen so far. */
function fill(v: unknown, vars: Record<string, any>): any {
  if (typeof v === 'string') {
    return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
      const val = p.split('.').reduce<any>((o, k) => (o == null ? o : o[k]), vars);
      return val == null ? '' : String(val);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

function locate(page: Page, s: Step) {
  if (s.testid) return page.getByTestId(s.testid).first();
  if (s.role) return page.getByRole(s.role as any, s.name ? { name: s.name } : {}).first();
  if (s.label) return page.getByLabel(s.label).first();
  if (s.placeholder) return page.getByPlaceholder(s.placeholder).first();
  if (s.text) return page.getByText(s.text).first();
  if (s.selector) return page.locator(s.selector).first();
  throw new Error('needs one of testid, role(+name), label, placeholder, text, selector');
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // The workspace's own UI: build it if this checkout hasn't (deps are linked read-only: no npm install).
  if (!existsSync('web/dist/index.html')) execSync('npm run build:web:local', { stdio: 'inherit' });

  const base = mkdtempSync(join(tmpdir(), 'alfred-ui-'));
  const { startAlfred } = await import(pathToFileURL(resolve('src/main.ts')).href);
  // A model that never acts: tasks stay `running`, so pages have live agents to show.
  const idle = {
    async chat(req: any) {
      await new Promise((r, j) => {
        const t = setTimeout(r, 3_600_000);
        req.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
      return { content: '', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
  const alfred = await startAlfred({
    dbPath: join(base, 'a.db'), mirrorDir: join(base, 'vault'), workRoot: join(base, 'work'), personasDir: 'personas',
    port: 0, host: '127.0.0.1', pollMs: 100, deck: null, allowNoToken: true, llm: idle, gitRoot: join(base, 'git'),
    env: { ALFRED_NOTIFY_DESKTOP: '0' }, extra: { llm: idle },
  });
  const url: string = alfred.url;
  const api = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(url + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new Error(`${method ?? (body === undefined ? 'GET' : 'POST')} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return json;
  };

  // Demo data: a goal with a root task and a subtask, both live.
  const demo = await api('/api/goals', { title: 'UI test demo goal', persona: 'alfred', spec: 'demo', acceptance: [{ name: 'a', cmd: 'true' }] });
  alfred.store.createTask({ goalId: demo.goal.id, parentTaskId: demo.task.id, persona: 'coder', title: 'Demo subtask', spec: 'demo' });
  const vars: Record<string, any> = { demo: { goalId: demo.goal.id, slug: demo.goal.slug, taskId: demo.task.id } };

  // The same Chromium setup as the P17 harness: --disable-gpu alone still opens the NVIDIA driver,
  // which fails with Qwen holding the unified memory; point EGL/Vulkan at Mesa/lavapipe instead.
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--disable-gpu'],
    env: { ...process.env, __EGL_VENDOR_LIBRARY_FILENAMES: '/usr/share/glvnd/egl_vendor.d/50_mesa.json', VK_ICD_FILENAMES: '/usr/share/vulkan/icd.d/lvp_icd.json' },
  });
  const page = await browser.newPage({ viewport: DESKTOP });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 300)}`); });

  const shots: { name: string; file: string }[] = [];
  const shoot = async (name: string) => {
    const file = `${String(shots.length + 1).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '-').slice(0, 60)}.jpg`;
    await page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 55, fullPage: false });
    shots.push({ name, file });
  };
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(900); // the SPA renders + its first fetches land (SSE keeps the network busy)
  };

  const steps: { i: number; do: string; ok: boolean; error?: string }[] = [];
  let ok = true;
  try {
    if (mode === 'smoke') {
      const g = vars.demo.goalId;
      const routes: [string, string][] = [
        ['home', '/#/'], ['inbox', '/#/inbox'], ['agents', '/#/agents'], ['board', '/#/board'], ['goals', '/#/goals'],
        ['goal', `/#/goal/${g}`], ['goal-transcript', `/#/goal/${g}/transcript`], ['goal-changes', `/#/goal/${g}/changes`],
        ['chat', '/#/chat'], ['automations', '/#/automations'], ['system', '/#/system'],
      ];
      for (const [vpName, vp] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
        await page.setViewportSize(vp);
        for (const [name, path] of routes) {
          await page.goto(url + path);
          await settle();
          await shoot(`${name}-${vpName}`);
        }
      }
      ok = !errors.some((e) => e.startsWith('page error'));
    } else {
      const file = args[args.indexOf('--steps') + 1];
      const plan: Step[] = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(plan) || plan.length > 60) throw new Error('steps: a JSON array of at most 60 steps');
      await page.goto(url + '/#/');
      await settle();
      for (let i = 0; i < plan.length; i++) {
        const s: Step = fill(plan[i], vars);
        try {
          switch (s.do) {
            case 'viewport': await page.setViewportSize(s.phone ? PHONE : { width: s.width ?? DESKTOP.width, height: s.height ?? DESKTOP.height }); break;
            case 'goto': await page.goto(url + (s.path ?? '/#/')); await settle(); break;
            case 'click': await locate(page, s).click({ timeout: 5000 }); await page.waitForTimeout(400); break;
            case 'fill': await locate(page, s).fill(String(s.value ?? ''), { timeout: 5000 }); break;
            case 'press': await page.keyboard.press(s.key ?? 'Enter'); await page.waitForTimeout(300); break;
            case 'wait':
              if (s.ms) await page.waitForTimeout(Math.min(s.ms, 10_000));
              else await locate(page, s).waitFor({ timeout: 8000 });
              break;
            case 'expect': {
              const visible = await locate(page, s).isVisible().catch(() => false);
              if (visible !== (s.visible ?? true)) throw new Error(`expected ${s.text ?? s.testid ?? s.selector} to be ${s.visible === false ? 'hidden' : 'visible'}`);
              break;
            }
            case 'screenshot': await shoot(s.name ?? `step-${i + 1}`); break;
            case 'api': vars.last = await api(s.path ?? '/api/health', s.body, s.method); break;
            default: throw new Error(`unknown step: ${(s as any).do}`);
          }
          steps.push({ i: i + 1, do: s.do, ok: true });
        } catch (e: any) {
          steps.push({ i: i + 1, do: s.do, ok: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 300) });
          ok = false;
          await shoot(`failed-step-${i + 1}`).catch(() => {});
          break;
        }
      }
      if (errors.some((e) => e.startsWith('page error'))) ok = false;
    }
  } finally {
    await browser.close().catch(() => {});
    await alfred.stop().catch(() => {});
    rmSync(base, { recursive: true, force: true });
  }

  const result = { ok, mode, shots, errors: errors.slice(0, 30), steps };
  writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`ui-test ${mode}: ${ok ? 'PASS' : 'FAIL'} — ${shots.length} screenshots${errors.length ? `, ${errors.length} errors` : ''}`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  for (const s of steps.filter((x) => !x.ok)) console.log(`  step ${s.i} (${s.do}) failed: ${s.error}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`ui-test: ${e?.stack ?? e}`);
  try { writeFileSync(join(OUT, 'result.json'), JSON.stringify({ ok: false, mode, shots: [], errors: [String(e?.message ?? e)], steps: [] })); } catch { /* best effort */ }
  process.exit(1);
});
