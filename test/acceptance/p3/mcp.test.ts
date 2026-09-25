// P3 acceptance — written by the orchestrator. Do not edit to make it pass.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpHub, loadMcpConfig } from '../../../src/connectors/mcp.js';
import type { ToolContext } from '../../../src/runtime/contract.js';

const TSX = resolve('node_modules/.bin/tsx');
const FIXTURE = resolve('test/fixtures/fake-vault-mcp.ts');
const ctx: ToolContext = { taskId: 't', goalId: 'g', workspace: tmpdir(), persona: 'researcher', signal: new AbortController().signal, acceptance: [], progress: () => {} };

describe('MCP hub', () => {
  const hub = new McpHub({ servers: {
    vault: { command: TSX, args: [FIXTURE] },
    dead: { url: 'http://127.0.0.1:9/mcp' },
    off: { command: 'nope', disabled: true },
  } }, { connectTimeoutMs: 8000 });
  afterAll(() => hub.close());

  it('exposes read tools, hides write tools on a read-only server, and survives a dead server', async () => {
    await hub.connectAll();
    const st = Object.fromEntries(hub.status().map(s => [s.name, s]));
    expect(st.vault.ok).toBe(true);
    expect(st.dead.ok).toBe(false);
    expect(st.dead.error).toBeTruthy();
    expect(st.off).toBeUndefined();
    const names = hub.tools().map(t => t.schema.name);
    expect(names).toContain('vault_read_note');
    expect(names).toContain('vault_search_notes');
    expect(names).not.toContain('vault_write_note');
    const read = hub.tools().find(t => t.schema.name === 'vault_read_note')!;
    const r = await read.run({ path: 'Projects/alfred.md' }, ctx);
    expect(r).toMatchObject({ ok: true });
    expect(r.output).toContain('agent platform');
    const miss = await read.run({ path: 'nope.md' }, ctx);
    expect(miss.ok).toBe(false);
  }, 30_000);

  it('refuses Independent/ paths before calling the server', async () => {
    const read = hub.tools().find(t => t.schema.name === 'vault_read_note')!;
    const r = await read.run({ path: 'Independent/secret.md' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/Independent\/ is off-limits/);
    expect(r.output).not.toContain('TOP SECRET');
    const calls = hub.tools().find(t => t.schema.name === 'vault_calls')!;
    expect((await calls.run({}, ctx)).output).not.toContain('Independent');
  });

  it('allowWrite re-exposes a named write tool', async () => {
    const h2 = new McpHub({ servers: { v: { command: TSX, args: [FIXTURE], allowWrite: ['write_note'] } } });
    await h2.connectAll();
    expect(h2.tools().map(t => t.schema.name)).toContain('v_write_note');
    await h2.close();
  }, 30_000);

  it('loads config with ${VAR} substitution, and a missing file is empty', () => {
    const d = mkdtempSync(join(tmpdir(), 'alfred-mcp-'));
    writeFileSync(join(d, 'mcp.json'), JSON.stringify({ servers: { obsidian: { url: 'http://h/mcp', headers: { Authorization: 'Bearer ${TOK}' } } } }));
    const c = loadMcpConfig(join(d, 'mcp.json'), { TOK: 'abc' });
    expect(c.servers.obsidian.headers!.Authorization).toBe('Bearer abc');
    expect(loadMcpConfig(join(d, 'missing.json'))).toEqual({ servers: {} });
    expect(existsSync('config/mcp.example.json')).toBe(true);
    expect(readFileSync('config/mcp.example.json', 'utf8')).toContain('100.82.152.2:3556');
  });
});

