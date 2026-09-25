// Regression: the first real deploy crash-looped because ~/.alfred did not exist.
import { it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAlfred } from '../../src/main.js';
import { scriptedLLM } from '../../src/runtime/testing.js';

it('creates missing parent directories for the database', async () => {
  const base = join(mkdtempSync(join(tmpdir(), 'alfred-fresh-')), 'does', 'not', 'exist');
  const a = await startAlfred({ dbPath: join(base, 'alfred.db'), mirrorDir: join(base, 'v'), workRoot: join(base, 'w'),
    personasDir: 'personas', port: 0, host: '127.0.0.1', deck: null, env: { ALFRED_NOTIFY_DESKTOP: '0' }, llm: scriptedLLM([]) } as any);
  expect(existsSync(join(base, 'alfred.db'))).toBe(true);
  await a.stop();
}, 30_000);
