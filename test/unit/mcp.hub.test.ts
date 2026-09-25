// Unit tests for the MCP hub (mine, not acceptance).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpHub, loadMcpConfig } from '../../src/connectors/mcp.js';

describe('loadMcpConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-unit-'));
  const write = (name: string, obj: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  it('substitutes ${VAR} deep (arrays + nested objects), missing var → empty', () => {
    const p = write('c.json', {
      servers: {
        s: {
          headers: { A: 'Bearer ${TOK}', B: 'x${MISSING}y' },
          args: ['--k=${TOK}', 'plain'],
          disabled: false,
        },
      },
    });
    const c = loadMcpConfig(p, { TOK: 'zz' });
    expect(c.servers.s.headers).toEqual({ A: 'Bearer zz', B: 'xy' });
    expect(c.servers.s.args).toEqual(['--k=zz', 'plain']);
    expect(c.servers.s.disabled).toBe(false);
  });

  it('missing or malformed files → {servers:{}}', () => {
    expect(loadMcpConfig(join(dir, 'nope.json'))).toEqual({ servers: {} });
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(loadMcpConfig(bad)).toEqual({ servers: {} });
  });
});

describe('McpHub without connections', () => {
  it('status lists non-disabled servers as down; tools empty; call fails gently', async () => {
    const hub = new McpHub({ servers: { a: { url: 'http://x.invalid/mcp' }, b: { command: 'x', disabled: true } } });
    const st = hub.status();
    expect(st.map((s) => s.name)).toEqual(['a']);
    expect(st[0]).toMatchObject({ ok: false, tools: [] });
    expect(hub.tools()).toEqual([]);
    await hub.close();
  });

  it('connectAll never rejects on a bad command', async () => {
    const hub = new McpHub({ servers: { broken: { command: 'definitely-not-a-real-binary' } } }, { connectTimeoutMs: 2000 });
    await expect(hub.connectAll()).resolves.toBeUndefined();
    expect(hub.status()[0]).toMatchObject({ ok: false });
    await hub.close();
  });
});
