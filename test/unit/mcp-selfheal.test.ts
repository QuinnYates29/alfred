// The MCP hub heals dead sessions: a call that fails at the session/transport level reconnects the
// server once and replays; a server that wasn't connected is tried on demand; tool errors are not retried.
import { describe, it, expect } from 'vitest';
import { McpHub, SESSION_LOST_RE } from '../../src/connectors/mcp.js';

function hubWith(clients: any[]) {
  const hub: any = new McpHub({ servers: { obsidian: { url: 'https://x/mcp', internal: true } } });
  let n = 0;
  const connects: number[] = [];
  hub.connectOne = async (name: string) => {
    connects.push(n);
    const client = clients[n++];
    hub.conns.set(name, client ? { ok: true, client, tools: [] } : { ok: false, error: 'connect refused', tools: [] });
  };
  return { hub, connects };
}
const client = (impl: () => any) => ({ callTool: async () => impl(), close: async () => {} });
const text = (t: string) => ({ content: [{ type: 'text', text: t }] });

describe('McpHub self-heal', () => {
  it('reconnects once and replays when the session is gone', async () => {
    const dead = client(() => { throw new Error('Error POSTing to endpoint (HTTP 404): Session not found'); });
    const fresh = client(() => text('216 items'));
    const { hub, connects } = hubWith([fresh]);
    hub.conns.set('obsidian', { ok: true, client: dead, tools: [] });
    const r = await hub.callInternal('obsidian', 'vault', { action: 'list' });
    expect(r).toEqual({ ok: true, output: '216 items' });
    expect(connects).toHaveLength(1);
  });

  it('connects on demand when the server was down at the last retry', async () => {
    const { hub, connects } = hubWith([client(() => text('ok'))]);
    hub.conns.set('obsidian', { ok: false, error: 'fetch failed', tools: [] });
    expect(await hub.callInternal('obsidian', 'vault', { action: 'list' })).toEqual({ ok: true, output: 'ok' });
    expect(connects).toHaveLength(1);
  });

  it('gives up after one reconnect, and never retries tool-level errors', async () => {
    const { hub, connects } = hubWith([]); // reconnect fails
    hub.conns.set('obsidian', { ok: true, client: client(() => { throw new Error('socket hang up'); }), tools: [] });
    const r = await hub.callInternal('obsidian', 'vault', { action: 'list' });
    expect(r.ok).toBe(false);
    expect(connects).toHaveLength(1);

    const h2 = hubWith([]);
    h2.hub.conns.set('obsidian', { ok: true, client: client(() => ({ isError: true, ...text('File not found: a.md') })), tools: [] });
    expect(await h2.hub.callInternal('obsidian', 'vault', { action: 'read', path: 'a.md' })).toEqual({ ok: false, output: 'File not found: a.md' });
    expect(h2.connects).toHaveLength(0);
  });

  it('concurrent failures share one reconnect', async () => {
    const dead = client(() => { throw new Error('ECONNRESET'); });
    const { hub, connects } = hubWith([client(() => text('ok'))]);
    hub.conns.set('obsidian', { ok: true, client: dead, tools: [] });
    const rs = await Promise.all([1, 2, 3].map(() => hub.callInternal('obsidian', 'vault', { action: 'list' })));
    expect(rs.every((r: any) => r.ok)).toBe(true);
    expect(connects).toHaveLength(1);
  });

  it('classifies transport errors', () => {
    for (const m of ['Session not found', 'HTTP 404', 'fetch failed', 'ECONNRESET', 'Not connected']) expect(SESSION_LOST_RE.test(m)).toBe(true);
    expect(SESSION_LOST_RE.test('File not found: notes.md')).toBe(false);
  });
});
