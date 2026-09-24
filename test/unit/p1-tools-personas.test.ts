import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry, builtinTools } from '../../src/runtime/tools.js';
import { loadPersonas } from '../../src/runtime/personas.js';
import { estimateTokens } from '../../src/runtime/tokens.js';
import { PersonaConfigError, type ToolContext } from '../../src/runtime/contract.js';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    taskId: 't', goalId: 'g', workspace: mkdtempSync(join(tmpdir(), 'alfred-unit-')),
    persona: 'coder', signal: new AbortController().signal, acceptance: [], progress: () => {}, ...over,
  };
}

function reg() {
  const r = new ToolRegistry();
  for (const t of builtinTools()) r.register(t);
  return r;
}

describe('tokens', () => {
  it('estimates ceil(bytes/3)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('é')).toBe(1); // 2 bytes
    expect(estimateTokens('ééé')).toBe(2); // 6 bytes
  });
});

describe('registry', () => {
  it('throws on duplicate register and unknown schema lookup', () => {
    const r = reg();
    expect(() => r.register(builtinTools()[0])).toThrow();
    expect(() => r.schemasFor(['nope'])).toThrow(PersonaConfigError);
    expect(r.schemasFor(['read_file', 'note'])).toHaveLength(2);
  });
});

describe('tool edge cases', () => {
  it('never throws on bad args', async () => {
    const r = reg();
    const c = ctx();
    expect((await r.get('read_file')!.run({}, c)).ok).toBe(false);
    expect((await r.get('write_file')!.run({ path: 42, content: 'x' }, c)).ok).toBe(false);
    expect((await r.get('list_dir')!.run({ path: 'no-such-dir' }, c)).ok).toBe(false);
  });

  it('honors a huge timeoutSec by clamping to 600s (command still runs)', async () => {
    const r = reg();
    const res = await r.get('run_shell')!.run({ cmd: 'echo hi', timeoutSec: 99999 }, ctx());
    expect(res.ok).toBe(true);
    expect(res.output).toContain('hi');
    expect(res.output).toContain('exit=0');
  });

  it('kills the whole process group on timeout (no orphan children)', async () => {
    const r = reg();
    const c = ctx();
    const res = await r.get('run_shell')!.run(
      { cmd: 'sleep 30 & sleep 30', timeoutSec: 1 }, c,
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('timed out');
  });

  it('note calls progress', async () => {
    const r = reg();
    const seen: string[] = [];
    await r.get('note')!.run({ text: 'remember' }, ctx({ progress: (m) => seen.push(m) }));
    expect(seen).toEqual(['remember']);
  });
});

describe('loadPersonas validation', () => {
  it('rejects name != file basename and spawn_subagent without canSpawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alfred-u-'));
    writeFileSync(join(dir, 'a.yaml'), 'name: b\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: []\ntools: [read_file]\nsystem: s\n');
    expect(() => loadPersonas(dir, reg())).toThrow(PersonaConfigError);
    rmSync(join(dir, 'a.yaml'));
    writeFileSync(join(dir, 'c.yaml'), 'name: c\ndescription: d\npromptBudgetTokens: 5000\ncanSpawn: []\ntools: [spawn_subagent]\nsystem: s\n');
    expect(() => loadPersonas(dir, reg())).toThrow(PersonaConfigError);
  });
});
