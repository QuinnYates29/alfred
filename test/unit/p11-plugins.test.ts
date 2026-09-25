// P11 unit tests — plugins loader edges, config layering, allEvents.
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins, type PluginContext } from '../../src/plugins.js';
import { loadConfig } from '../../src/config.js';
import { openStore } from '../../src/store.js';

function fakeCtx(name: string): PluginContext {
  return {
    name,
    config: {},
    store: null as any,
    log: () => {},
    registerTool: () => {},
    registerPersonaDir: () => {},
    registerSink: () => {},
    registerMcpServer: () => {},
    registerAutomationDir: () => {},
    registerRoute: () => {},
    registerStatic: () => {},
    onEvent: () => () => {},
  };
}

describe('loadPlugins', () => {
  it('skips missing names and reports them as failed', async () => {
    const rt = await loadPlugins({
      dirs: [join(tmpdir(), 'no-such-plugin-dir-xyz')],
      enabled: ['ghost'],
      config: {},
      makeContext: fakeCtx,
    });
    expect(rt.loaded).toEqual([]);
    expect(rt.failed).toEqual([{ name: 'ghost', error: 'plugin not found' }]);
  });

  it('reports a plugin whose default export is not a plugin', async () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-plug-'));
    const dir = join(d, 'weird');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export const nope = 1;\n');
    const rt = await loadPlugins({ dirs: [d], config: {}, makeContext: fakeCtx });
    expect(rt.loaded).toEqual([]);
    expect(rt.failed[0]?.name).toBe('weird');
    expect(rt.failed[0]?.error).toMatch(/default export/);
  });

  it('built-ins only load when enabled lists them', async () => {
    const rt = await loadPlugins({
      dirs: [],
      enabled: ['b1'],
      config: {},
      makeContext: fakeCtx,
      builtins: [
        { name: 'b1', setup: () => {} },
        { name: 'b2', setup: () => {} },
      ],
    });
    expect(rt.loaded).toEqual(['b1']);
  });
});

describe('loadConfig', () => {
  it('env overrides plugins.enabled and ~ expands inside mirror specs', () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-cfg2-'));
    writeFileSync(join(d, 'alfred.yaml'), 'plugins: { enabled: [a] }\npaths: { mirror: "local:~/m" }\n');
    const c = loadConfig(d, { ALFRED_PLUGINS: 'b, c' });
    expect(c.plugins.enabled).toEqual(['b', 'c']);
    expect(c.paths.mirror).not.toContain('~');
    expect(c.paths.mirror).toMatch(/^local:.*\/m$/);
  });

  it('defaults apply when no file exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-cfg3-'));
    const c = loadConfig(d, {});
    expect(c.server.port).toBe(8790);
    expect(c.plugins.enabled).toBeUndefined();
  });
});

describe('store.allEvents', () => {
  it('replays ascending, honors sinceId and limit', () => {
    const store = openStore(':memory:');
    const g1 = store.createGoal({ title: 'g1' });
    const g2 = store.createGoal({ title: 'g2' });
    store.appendEvent(g1.id, null, 'k1', {});
    store.appendEvent(g2.id, null, 'k2', {});
    store.appendEvent(g1.id, null, 'k3', {});
    const all = store.allEvents();
    expect(all.map((e) => e.kind)).toEqual(['goal_created', 'goal_created', 'k1', 'k2', 'k3']);
    expect(all.every((e, i, a) => i === 0 || a[i - 1].id < e.id)).toBe(true);
    const since = store.allEvents({ sinceId: all[1].id });
    expect(since[0].kind).toBe('k1');
    expect(store.allEvents({ limit: 2 })).toHaveLength(2);
    store.close();
  });
});
