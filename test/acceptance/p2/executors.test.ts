// P2 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { dshTool } from '../../../src/executors/dsh.js';
import { pipelineTool } from '../../../src/executors/pipeline.js';
import type { ToolContext } from '../../../src/runtime/contract.js';

function gitRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'alfred-p2-'));
  execSync('git init -q && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init', { cwd: d });
  return d;
}

function ctx(ws: string, extra: Partial<ToolContext> = {}): ToolContext & { progressed: string[] } {
  const progressed: string[] = [];
  return {
    taskId: 't', goalId: 'g', workspace: ws, persona: 'coder', signal: new AbortController().signal,
    acceptance: [{ name: 'tests', cmd: 'test -f out.txt' }], progress: (m: string) => progressed.push(m),
    progressed, ...extra,
  } as any;
}

function fakeBin(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'alfred-bin-')), 'fake');
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe('dsh_code', () => {
  it('runs headless in the workspace, passes the acceptance commands, reports exit and diff', async () => {
    const ws = gitRepo();
    const bin = fakeBin('echo "$@" > args.txt; pwd > cwd.txt; echo made > out.txt; echo "Created out.txt"; echo "dsh: reasoning:" >&2');
    const tool = dshTool({ bin });
    expect(tool.schema.name).toBe('dsh_code');
    expect(tool.kind).toBe('exec');
    const r = await tool.run({ task: 'make out.txt' }, ctx(ws));
    expect(r.ok).toBe(true);
    const args = readFileSync(join(ws, 'args.txt'), 'utf8');
    expect(args).toContain('--profile headless');
    expect(args).toContain('make out.txt');
    expect(args).toContain('test -f out.txt');
    expect(readFileSync(join(ws, 'cwd.txt'), 'utf8').trim()).toBe(ws);
    expect(r.output).toContain('exit=0');
    expect(r.output).toContain('Created out.txt');
    expect(r.output).toContain('out.txt'); // git status
  });

  it('reports a non-zero exit as not ok', async () => {
    const ws = gitRepo();
    const r = await dshTool({ bin: fakeBin('echo "dsh: turn-failed: model error" >&2; exit 1') }).run({ task: 'x' }, ctx(ws));
    expect(r.ok).toBe(false);
    expect(r.output).toContain('exit=1');
    expect(r.output).toContain('model error');
  });

  it('kills a runaway run on abort, including its children', async () => {
    const ws = gitRepo();
    const ac = new AbortController();
    const bin = fakeBin('(sleep 60; touch late.txt) & sleep 60');
    setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    const r = await dshTool({ bin }).run({ task: 'x' }, ctx(ws, { signal: ac.signal }));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/cancelled/);
    expect(Date.now() - t0).toBeLessThan(5000);
    await new Promise(res => setTimeout(res, 200));
    expect(existsSync(join(ws, 'late.txt'))).toBe(false);
  });

  it('times out', async () => {
    const ws = gitRepo();
    const r = await dshTool({ bin: fakeBin('sleep 60') }).run({ task: 'x', timeoutMin: 0.01 }, ctx(ws));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/timed out/);
  });
});

function fakePipeline(statuses: string[], opts: { exit?: number; pmv?: boolean | null; noState?: boolean } = {}) {
  const outcomes = JSON.stringify(statuses.map((s, i) => ({ chunk: { id: `c${i + 1}`, title: `chunk ${i + 1}` }, status: s, kill_reason: s === 'completed' ? '' : 'broke' })));
  const pmv = opts.pmv === undefined || opts.pmv === null ? '' : `,"post_merge_verify":{"ok":${opts.pmv},"skipped":false,"exit_code":${opts.pmv ? 0 : 1}}`;
  return fakeBin(`
echo "$@" > .alfred-pipeline-args.txt
cfg=""; tf=""
while [ $# -gt 0 ]; do case "$1" in --config) cfg="$2"; shift;; --task-file) tf="$2"; shift;; esac; shift; done
cp "$cfg" .alfred-seen-config.yaml; cp "$tf" .alfred-seen-task.md
${opts.noState ? '' : `mkdir -p .pipeline-runs/20260924-000000-abc; echo '{"kind":"run_start"}' > .pipeline-runs/20260924-000000-abc/events.jsonl
echo '{"run_id":"r","outcomes":${outcomes}${pmv}}' > .pipeline-runs/20260924-000000-abc/state.json`}
echo "=== Run r ==="
exit ${opts.exit ?? 0}`);
}

describe('pipeline_run', () => {
  it('passes the task file, a config with the acceptance verify command, and --no-load against :1110', async () => {
    const ws = gitRepo();
    const tool = pipelineTool({ bin: fakePipeline(['completed', 'completed']) });
    expect(tool.schema.name).toBe('pipeline_run');
    const r = await tool.run({ task: 'build the lexer and parser' }, ctx(ws, { acceptance: [{ name: 'a', cmd: 'npm test' }, { name: 'b', cmd: 'npm run lint' }] }));
    expect(r.ok).toBe(true);
    const args = readFileSync(join(ws, '.alfred-pipeline-args.txt'), 'utf8');
    expect(args).toMatch(/^run /);
    expect(args).toContain('--no-load');
    expect(args).toContain('--repo ' + ws);
    expect(args).toContain('http://127.0.0.1:1110/v1');
    expect(readFileSync(join(ws, '.alfred-seen-task.md'), 'utf8')).toContain('build the lexer and parser');
    const cfg = readFileSync(join(ws, '.alfred-seen-config.yaml'), 'utf8');
    expect(cfg).toContain('npm test && npm run lint');
    expect(cfg).toContain('qwen3.8-flash-next');
    expect(r.output).toContain('c1: completed');
  });

  it('is not ok when any chunk did not complete, even with exit 0', async () => {
    const ws = gitRepo();
    const r = await pipelineTool({ bin: fakePipeline(['completed', 'verify_failed']) }).run({ task: 't' }, ctx(ws));
    expect(r.ok).toBe(false);
    expect(r.output).toContain('c2: verify_failed');
  });

  it('is not ok when post-merge verify failed', async () => {
    const ws = gitRepo();
    const r = await pipelineTool({ bin: fakePipeline(['completed'], { pmv: false }) }).run({ task: 't' }, ctx(ws));
    expect(r.ok).toBe(false);
  });

  it('is not ok without a state.json', async () => {
    const ws = gitRepo();
    const r = await pipelineTool({ bin: fakePipeline([], { noState: true }) }).run({ task: 't' }, ctx(ws));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/no state\.json/);
  });

  it('solo mode only needs exit 0', async () => {
    const ws = gitRepo();
    const r = await pipelineTool({ bin: fakePipeline([], { noState: true }) }).run({ task: 't', mode: 'solo' }, ctx(ws));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(ws, '.alfred-pipeline-args.txt'), 'utf8')).toMatch(/^solo /);
  });
});
