// Focused unit coverage for mirror.ts behaviour the acceptance suite doesn't pin down.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/store.js';
import { writeMirror } from '../../src/mirror.js';

describe('writeMirror on a bare goal', () => {
  it('renders placeholders for no acceptance checks and no tasks, no failure section', () => {
    const store = openStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mirror-bare-'));
    const g = store.createGoal({ title: 'Bare Goal' });

    const p = writeMirror(store, g.id, dir);
    const md = readFileSync(p, 'utf8');

    expect(md).toContain('Status: **ACTIVE**');
    expect(md).toContain('_none_'); // acceptance section
    expect(md).not.toContain('## Failures');
    expect(md).toContain('## Recent events');
  });

  it('throws for an unknown goal id', () => {
    const store = openStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mirror-missing-'));
    expect(() => writeMirror(store, 'nope', dir)).toThrow();
  });

  it('caps recent events at 20 lines even with many more events', () => {
    const store = openStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'alfred-mirror-many-'));
    const g = store.createGoal({ title: 'Chatty Goal' });
    for (let i = 0; i < 30; i++) {
      store.appendEvent(g.id, null, 'ping', { n: i });
    }
    const p = writeMirror(store, g.id, dir);
    const md = readFileSync(p, 'utf8');
    const eventLines = md
      .split('\n')
      .filter((l) => l.startsWith('- [') && l.includes('ping'));
    expect(eventLines).toHaveLength(20);
    // the most recent events (highest n) should be the ones kept
    expect(md).toContain('"n":29');
    expect(md).not.toContain('"n":9}');
  });
});
