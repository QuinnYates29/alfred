// P4b — the ModelRegistry is built even when c.llm overrides the runtime LLM,
// so /api/v1/models stays live in tests and in dev. (The role-switch and
// unknown-model 400 cases live in test/acceptance/p4/cli-models.test.ts.)
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAlfred } from '../../src/main.js';
import { scriptedLLM } from '../../src/runtime/testing.js';

describe('startAlfred + ModelRegistry', () => {
  it('serves models + roles even with an llm override, and survives reload', async () => {
    const b = mkdtempSync(join(tmpdir(), 'alfred-mr-'));
    const llm = scriptedLLM([]);
    const a = await startAlfred({
      dbPath: join(b, 'a.db'), mirrorDir: join(b, 'v'), workRoot: join(b, 'w'),
      port: 0, host: '127.0.0.1', deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm,
    } as any);
    try {
      const m = await (await fetch(`${a.url}/api/v1/models`)).json();
      expect(m.models.map((x: any) => x.name)).toContain('qwen-local');
      expect(typeof m.roles.default).toBe('string');
      const rel = await fetch(`${a.url}/api/v1/models/reload`, { method: 'POST' });
      expect(rel.status).toBeLessThan(300);
      // The override still wins for the runtime: models are NOT wired into the scheduler.
      expect((a.scheduler as any).o?.models).toBeUndefined();
    } finally {
      await a.stop();
    }
  }, 30_000);
});
