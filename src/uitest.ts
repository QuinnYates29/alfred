// ALF-7 — UI tests against a sandboxed copy of alfred (scripts/ui-test.mts does the driving).
// This module turns a run's `.ui-test/` folder into a goal output (an `images` gallery Quinn sees on the
// goal page) and gives agents the `ui_test` tool: scripted clicks / typing / screenshots on a copy of
// the UI built from their own workspace.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { Tool, ToolContext, ToolResult } from './runtime/contract.js';
import { storeForTask } from './approvals.js';
import { isSelfRepo, UI_RUNNER } from './ops.js';

export const UI_DIR = '.ui-test';
const STEPS_FILE = '.ui-test-steps.json';

export interface UiResult {
  ok: boolean;
  mode: string;
  shots: { name: string; file: string }[];
  errors: string[];
  steps: { i: number; do: string; ok: boolean; error?: string }[];
}

/**
 * Publish `<workspace>/.ui-test` as an `images` output named `name` (+ a `ui_test` event), then remove the
 * folder so a later run never republishes stale screenshots. Null when there is no run to publish.
 */
export function publishUiRun(store: Store, goalId: string, taskId: string | null, workspace: string, name: string): UiResult | null {
  const dir = join(workspace, UI_DIR);
  const resultFile = join(dir, 'result.json');
  if (!existsSync(resultFile)) return null;
  try {
    const r = JSON.parse(readFileSync(resultFile, 'utf8')) as UiResult;
    const images = (r.shots ?? [])
      .filter((s) => /^[\w.-]+\.jpg$/.test(s.file) && existsSync(join(dir, s.file)))
      .map((s) => ({ name: s.name, src: `data:image/jpeg;base64,${readFileSync(join(dir, s.file)).toString('base64')}` }));
    if (images.length) store.putOutput({ goalId, taskId, name, kind: 'images', content: JSON.stringify(images) });
    store.appendEvent(goalId, taskId, 'ui_test', { ok: r.ok, mode: r.mode, shots: images.length, errors: (r.errors ?? []).slice(0, 10), output: name });
    return r;
  } catch {
    return null; // never fail a gate or a review over the screenshots
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One line per failure / error, for the model and for reports. */
export function summarize(r: UiResult): string {
  const lines = [`ui-test ${r.mode}: ${r.ok ? 'PASS' : 'FAIL'} — ${r.shots.length} screenshot(s)`];
  for (const s of r.steps ?? []) if (!s.ok) lines.push(`step ${s.i} (${s.do}) failed: ${s.error ?? ''}`);
  for (const e of (r.errors ?? []).slice(0, 10)) lines.push(e);
  return lines.join('\n');
}

export function uiTestTool(o: { runShell: (args: any, ctx: ToolContext) => Promise<ToolResult> }): Tool {
  return {
    kind: 'exec',
    schema: {
      name: 'ui_test',
      description:
        'Test your alfred UI change for real: boots a copy of alfred from your workspace (temp data, a demo goal with a subtask) in headless Chromium and runs your steps. ' +
        'Steps: {do:"goto",path:"/#/agents"} {do:"click",text|testid|role+name} {do:"fill",label|placeholder|testid,value} {do:"press",key} ' +
        '{do:"wait",text|testid|ms} {do:"expect",text|testid,visible?} {do:"viewport",phone:true} {do:"api",method,path,body} {do:"screenshot",name}. ' +
        '"{{demo.goalId}}" / "{{last.<field>}}" fill in ids. Screenshots go to Quinn on the goal page; you get pass/fail, failed steps and page errors.',
      parameters: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'object' } },
          title: { type: 'string', description: 'What this run checks (names the screenshots output).' },
        },
        required: ['steps'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      const store = storeForTask(ctx.taskId);
      const goal = store?.getGoal(ctx.goalId);
      if (!store || !goal || !isSelfRepo(store, goal.meta?.repo)) return { ok: false, output: 'ui_test runs a copy of alfred: only for goals on repo alfred' };
      if (ctx.backend && ctx.backend.node !== 'local') return { ok: false, output: 'ui_test runs on the Spark only' };
      const steps = Array.isArray(args?.steps) ? args.steps : null;
      if (!steps?.length || steps.length > 60) return { ok: false, output: 'steps: give 1–60 steps' };
      if (!existsSync(UI_RUNNER)) return { ok: false, output: 'the UI test runner is missing on this server' };
      writeFileSync(join(ctx.workspace, STEPS_FILE), JSON.stringify(steps));
      ctx.progress('ui_test: booting a copy of alfred and driving it');
      // Rebuild the UI from the workspace first, so the copy shows the change being made.
      const run = await o.runShell({ cmd: `npm run build:web:local >/dev/null 2>&1; npx tsx '${UI_RUNNER}' --steps ${STEPS_FILE}`, timeoutSec: 600 }, ctx);
      rmSync(join(ctx.workspace, STEPS_FILE), { force: true });
      const title = String(args?.title ?? '').trim().slice(0, 60) || 'UI test';
      const r = publishUiRun(store, ctx.goalId, ctx.taskId, ctx.workspace, `UI: ${title}`);
      if (!r) return { ok: false, output: `ui_test did not produce a result:\n${run.output.slice(-2000)}` };
      return { ok: r.ok, output: `${summarize(r)}\n(screenshots published to the goal as "UI: ${title}")` };
    },
  };
}
