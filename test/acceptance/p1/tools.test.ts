// P1 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, builtinTools } from '../../../src/runtime/tools.js';
import { PersonaConfigError, type ToolContext } from '../../../src/runtime/contract.js';

function setup() {
  const reg = new ToolRegistry();
  for (const t of builtinTools()) reg.register(t);
  const ws = mkdtempSync(join(tmpdir(), 'alfred-tools-'));
  const ctx: ToolContext = { taskId: 't', goalId: 'g', workspace: ws, persona: 'coder', signal: new AbortController().signal };
  const run = (name: string, args: any) => reg.get(name)!.run(args, ctx);
  return { reg, ws, run };
}

describe('builtin tools', () => {
  it('registers the exact built-in names with short descriptions', () => {
    const { reg } = setup();
    const names = ['read_file', 'write_file', 'list_dir', 'run_shell', 'note', 'finish', 'give_up', 'ask_claude', 'spawn_subagent', 'wait_subtasks'];
    for (const n of names) {
      const t = reg.get(n);
      expect(t, n).toBeDefined();
      expect(t!.schema.description.length, n).toBeLessThanOrEqual(160);
    }
    for (const n of ['finish', 'give_up', 'ask_claude', 'spawn_subagent', 'wait_subtasks']) expect(reg.get(n)!.kind).toBe('control');
    expect(() => reg.register(reg.get('note')!)).toThrow();
    expect(() => reg.schemasFor(['note', 'teleport'])).toThrow(PersonaConfigError);
  });

  it('writes, reads and lists inside the workspace, creating parent dirs', async () => {
    const { run, ws } = setup();
    expect((await run('write_file', { path: 'a/b/c.txt', content: 'hello' })).ok).toBe(true);
    expect(existsSync(join(ws, 'a/b/c.txt'))).toBe(true);
    const r = await run('read_file', { path: 'a/b/c.txt' });
    expect(r).toMatchObject({ ok: true });
    expect(r.output).toContain('hello');
    expect((await run('list_dir', { path: 'a' })).output).toContain('b');
    expect((await run('read_file', { path: 'nope.txt' })).ok).toBe(false);
  });

  it('refuses paths outside the workspace without throwing', async () => {
    const { run } = setup();
    for (const path of ['../x.txt', '/etc/passwd', 'a/../../x.txt']) {
      const r = await run('read_file', { path });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/outside workspace/);
    }
    const w = await run('write_file', { path: '/tmp/alfred-should-not-exist.txt', content: 'x' });
    expect(w.ok).toBe(false);
    expect(existsSync('/tmp/alfred-should-not-exist.txt')).toBe(false);
  });

  it('run_shell runs in the workspace, reports exit codes and times out', async () => {
    const { run, ws } = setup();
    const a = await run('run_shell', { cmd: 'pwd; exit 2' });
    expect(a.ok).toBe(false);
    expect(a.output).toContain(ws);
    expect(a.output).toContain('exit=2');
    const b = await run('run_shell', { cmd: 'echo fine' });
    expect(b.ok).toBe(true);
    const t0 = Date.now();
    const c = await run('run_shell', { cmd: 'sleep 20', timeoutSec: 1 });
    expect(c.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(8000);
    const big = await run('run_shell', { cmd: 'head -c 50000 /dev/zero | tr "\\0" y; echo TAIL' });
    expect(big.output.length).toBeLessThanOrEqual(8000);
    expect(big.output).toContain('TAIL');
  });
});
