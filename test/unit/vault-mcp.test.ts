// The vault tool over the Obsidian MCP plugin (an `internal` connector): same ops and policy as the
// node path, only safe plugin actions are ever sent, and internal servers expose no agent tools.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../../src/store.js';
import { ToolRegistry } from '../../src/runtime/tools.js';
import type { ModuleDeps } from '../../src/modules.js';
import type { Tool, ToolContext } from '../../src/runtime/contract.js';
import { clearChatAsks } from '../../src/powers/gate.js';
import { createVaultModule } from '../../src/vault/index.js';
import { McpHub } from '../../src/connectors/mcp.js';

let store: Store;
let root: string;
let tool: Tool;
let sent: { server: string; tool: string; args: any }[];
let connected = true;
let failNext: string | null = null;

const ctxFor = (taskId: string, goalId = ''): ToolContext =>
  ({ taskId, goalId, workspace: root, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} });
function task() {
  const g = store.createGoal({ title: `g-${Math.random()}` });
  return store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
}

beforeEach(() => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'alfred-vault-mcp-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  sent = [];
  connected = true;
  failNext = null;
  clearChatAsks();
  const hub = {
    connected: (s: string) => connected && s === 'obsidian',
    callInternal: async (server: string, t: string, args: any) => {
      sent.push({ server, tool: t, args });
      if (failNext) { const o = failNext; failNext = null; return { ok: false, output: o }; }
      return { ok: true, output: `${t}:${args.action} ok` };
    },
  };
  const deps: ModuleDeps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root,
    nodes: { list: () => [], call: async () => ({ ok: false, error: 'no node' }) } as any, repoHub: {} as any,
    deckState: { url: null }, modules: {}, personas: new Map(), extra: { repoRoot: root }, hub: hub as any,
  };
  tool = (createVaultModule(deps).tools ?? []).find((t) => t.schema.name === 'vault')!;
});

describe('vault over the Obsidian MCP plugin', () => {
  it('maps list/read/search to the plugin vault tool', async () => {
    const t = task();
    expect((await tool.run({ op: 'list', path: 'Alfred' }, ctxFor(t.id, t.goalId))).ok).toBe(true);
    await tool.run({ op: 'read', path: 'Alfred/notes' }, ctxFor(t.id, t.goalId));
    await tool.run({ op: 'search', query: 'compressor' }, ctxFor(t.id, t.goalId));
    expect(sent.map((s) => [s.tool, s.args.action, s.args.path ?? s.args.directory ?? s.args.query])).toEqual([
      ['vault', 'list', 'Alfred'], ['vault', 'read', 'Alfred/notes.md'], ['vault', 'search', 'compressor'],
    ]);
  });

  it('writes in Alfred/ go straight through; elsewhere park for approval; nothing is sent before it', async () => {
    const t = task();
    const ok = await tool.run({ op: 'write', path: 'Alfred/doc', content: '# hi' }, ctxFor(t.id, t.goalId));
    expect(ok.output).toContain('saved to Obsidian: Alfred/doc.md');
    expect(sent.at(-1)!.args).toMatchObject({ action: 'create', path: 'Alfred/doc.md', content: '# hi' });
    await tool.run({ op: 'write', path: 'Alfred/doc', content: 'v2', overwrite: true }, ctxFor(t.id, t.goalId));
    expect(sent.at(-1)!.args.action).toBe('update');
    const n = sent.length;
    const g = await tool.run({ op: 'write', path: 'Projects/x', content: 'outside' }, ctxFor(t.id, t.goalId));
    expect(g.park).toBeTruthy();
    expect(sent.length).toBe(n);
    expect(store.approvals({ status: 'pending', taskId: t.id })[0]!.info).toBe('outside');
  });

  it('append uses edit/append and creates the page when missing', async () => {
    const t = task();
    failNext = 'File not found: Alfred/log.md';
    const r = await tool.run({ op: 'append', path: 'Alfred/log', content: 'line' }, ctxFor(t.id, t.goalId));
    expect(r.ok).toBe(true);
    expect(sent.map((s) => `${s.tool}:${s.args.action}`)).toEqual(['edit:append', 'vault:create']);
  });

  it('never escapes the agent folder and never sends destructive actions', async () => {
    const t = task();
    for (const path of ['Alfred/../Private', '../x', 'Alfred//x']) {
      const r = await tool.run({ op: 'write', path, content: 'x' }, ctxFor(t.id, t.goalId));
      expect(r.ok).toBe(false);
      expect(r.park).toBeFalsy();
    }
    for (const op of ['delete', 'rename', 'split', 'combine']) {
      expect((await tool.run({ op, path: 'Alfred/a' }, ctxFor(t.id, t.goalId))).ok).toBe(false);
    }
    expect(await tool.run({ op: 'list', path: 'Alfred/..' }, ctxFor(t.id, t.goalId))).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    const m = await tool.run({ op: 'move', path: 'Alfred/a', to: 'Archive/a' }, ctxFor(t.id, t.goalId));
    expect(m.park).toBeTruthy(); // leaving Alfred/ needs Quinn
    await tool.run({ op: 'move', path: 'Alfred/a', to: 'Alfred/old/a' }, ctxFor(t.id, t.goalId));
    expect(sent.at(-1)!.args).toMatchObject({ action: 'move', path: 'Alfred/a.md', destination: 'Alfred/old/a.md' });
  });

  it('falls back to the node when the plugin is not connected; config can turn MCP off', async () => {
    connected = false;
    const t = task();
    const r = await tool.run({ op: 'read', path: 'Alfred/a' }, ctxFor(t.id, t.goalId));
    expect(sent).toEqual([]);
    expect(r.ok).toBe(false); // no node either → a plain error, never a forever-park
    expect(r.park).toBeUndefined();
    connected = true;
    writeFileSync(join(root, 'config', 'vault.yaml'), "mcp: ''\n");
    await tool.run({ op: 'read', path: 'Alfred/a' }, ctxFor(t.id, t.goalId));
    expect(sent).toEqual([]);
  });
});

describe('finding the Obsidian server', () => {
  it('uses the configured name, else the one server named like obsidian', async () => {
    const { vaultServerName } = await import('../../src/vault/tool.js');
    const pol: any = { mcp: 'obsidian' };
    expect(vaultServerName({ servers: () => ({ obsidian: {}, other: {} }) }, pol)).toBe('obsidian');
    expect(vaultServerName({ servers: () => ({ 'obsidian-http': {}, jira: {} }) }, pol)).toBe('obsidian-http');
    expect(vaultServerName({ servers: () => ({ 'obsidian-a': {}, 'obsidian-b': {} }) }, pol)).toBeNull(); // ambiguous
    expect(vaultServerName({ servers: () => ({ jira: {} }) }, pol)).toBeNull();
  });
});

describe('internal MCP servers', () => {
  it('a readOnly server hides multi-action tools whose actions write (not just write-named tools)', () => {
    const hub = new McpHub({ servers: {} }) as any;
    const listed = [
      { name: 'vault', inputSchema: { properties: { action: { enum: ['list', 'read', 'delete', 'move'] } } } },
      { name: 'view', inputSchema: { properties: { action: { enum: ['file', 'window'] } } } },
      { name: 'edit', inputSchema: { properties: { action: { enum: ['append'] } } } },
    ];
    expect(hub.buildTools('obsidian-http', { url: 'https://x/mcp' }, listed).map((t: any) => t.schema.name)).toEqual(['obsidian-http_view'.replace('-', '_')]);
  });

  it('expose no agent tools', () => {
    const hub = new McpHub({ servers: {} }) as any;
    expect(hub.buildTools('obsidian', { url: 'https://x/mcp', internal: true }, [{ name: 'vault' }, { name: 'edit' }])).toEqual([]);
    expect(hub.buildTools('other', { url: 'https://x/mcp' }, [{ name: 'vault' }]).map((t: any) => t.schema.name)).toEqual(['other_vault']);
  });
});
