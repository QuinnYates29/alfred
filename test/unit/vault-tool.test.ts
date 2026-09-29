// V1 unit tests — the `vault` agent tool: agent-folder writes run free, everything else parks
// for Quinn's approval; offline nodes park goal tasks; events never carry page content.
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

let store: Store;
let root: string;
let deps: ModuleDeps;
let tool: Tool;
let calls: { node: string; op: string; args: any }[];
let online = true;

function ctxFor(taskId: string, goalId = ''): ToolContext {
  return { taskId, goalId, workspace: root, persona: 'alfred', signal: new AbortController().signal, acceptance: [], progress: () => {} };
}
function task() {
  const g = store.createGoal({ title: `g-${Math.random()}` });
  return store.createTask({ goalId: g.id, persona: 'alfred', title: 't' });
}

function fakeNodes() {
  return {
    list: () => (online ? [{ name: 'macbook', caps: ['fs', 'vault'], vault: 'QuinnVault' }] : []),
    call: async (node: string, op: string, args: any) => {
      calls.push({ node, op, args });
      if (op === 'vaultList') return { ok: true, value: { entries: [{ path: 'Alfred/a.md', dir: false, size: 4, mtime: 1 }] } };
      if (op === 'vaultRead') return { ok: true, value: { content: 'body text', mtime: 1 } };
      if (op === 'vaultSearch') return { ok: true, value: { hits: [{ path: 'Alfred/a.md', line: 2, text: 'a hit' }] } };
      return { ok: true, value: { path: args?.path ?? '', bytes: String(args?.content ?? '').length } };
    },
  };
}


beforeEach(() => {
  store = openStore(':memory:');
  root = mkdtempSync(join(tmpdir(), 'alfred-vault-u-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  calls = [];
  online = true;
  clearChatAsks();
  deps = {
    store, registry: new ToolRegistry(), env: {}, repoRoot: root, personasDir: 'personas', workRoot: root,
    nodes: fakeNodes() as any, repoHub: {} as any, deckState: { url: null }, modules: {}, personas: new Map(),
    extra: { repoRoot: root },
  };
  const found = (createVaultModule(deps).tools ?? []).find((t) => t.schema.name === 'vault');
  if (!found) throw new Error('vault tool missing from the vault module');
  tool = found;
});

const pending = (taskId: string) => store.approvals({ status: 'pending', taskId });

describe('vault tool — agent folder (free)', () => {
  it('write inside Alfred/ runs directly, adds .md, stores a vault event, no approval', async () => {
    const t = task();
    const r = await tool.run({ op: 'write', path: 'Alfred/idea', content: 'the idea' }, ctxFor(t.id, t.goalId));
    expect(r.ok).toBe(true);
    expect(r.output).toContain('saved to Obsidian: Alfred/idea.md');
    expect(calls).toEqual([{ node: 'macbook', op: 'vaultWrite', args: { path: 'Alfred/idea.md', content: 'the idea', overwrite: false } }]);
    expect(pending(t.id)).toHaveLength(0);
  });

  it('append inside Alfred/ runs directly', async () => {
    const t = task();
    const r = await tool.run({ op: 'append', path: 'Alfred/log.md', content: 'line' }, ctxFor(t.id, t.goalId));
    expect(r.ok).toBe(true);
    expect(calls[0]!.op).toBe('vaultAppend');
  });

  it('reads never gate and never event', async () => {
    const t = task();
    expect((await tool.run({ op: 'list', recursive: true }, ctxFor(t.id, t.goalId))).output).toContain('Alfred/a.md');
    expect((await tool.run({ op: 'read', path: 'Alfred/a' }, ctxFor(t.id, t.goalId))).output).toBe('body text');
    expect((await tool.run({ op: 'search', query: 'hit' }, ctxFor(t.id, t.goalId))).output).toContain('Alfred/a.md:2: a hit');
    expect(calls.map((c) => c.op)).toEqual(['vaultList', 'vaultRead', 'vaultSearch']);
    expect(pending(t.id)).toHaveLength(0);
  });
});

describe('vault tool — outside the agent folder (gated)', () => {
  it('write outside parks the goal task, runs after Quinn approves, once', async () => {
    const t = task();
    const first = await tool.run({ op: 'write', path: 'Projects/x.md', content: 'secret sauce' }, ctxFor(t.id, t.goalId));
    expect(first.ok).toBe(false);
    expect(first.park?.status).toBe('blocked');
    expect(calls).toHaveLength(0);
    const ap = pending(t.id)[0];
    expect(ap).toBeTruthy();
    expect(ap!.action).toBe('vault.write');
    expect(ap!.detail).toBe('vault write Projects/x.md');
    expect(ap!.info).toContain('secret sauce'); // Quinn sees the content before OK-ing
    store.decideApproval(ap!.id, 'approved', 'quinn');
    const second = await tool.run({ op: 'write', path: 'Projects/x.md', content: 'secret sauce' }, ctxFor(t.id, t.goalId));
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const third = await tool.run({ op: 'write', path: 'Projects/x.md', content: 'secret sauce' }, ctxFor(t.id, t.goalId));
    expect(third.park).toBeTruthy(); // the approval is spent
  });

  it('an approval spent on different content (bind) does not run', async () => {
    const t = task();
    await tool.run({ op: 'write', path: 'Projects/x.md', content: 'v1' }, ctxFor(t.id, t.goalId));
    store.decideApproval(pending(t.id)[0]!.id, 'approved', 'quinn');
    const swapped = await tool.run({ op: 'write', path: 'Projects/x.md', content: 'v2 DIFFERENT' }, ctxFor(t.id, t.goalId));
    expect(swapped.park).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('move parks unless BOTH sides are in the agent folder', async () => {
    const t = task();
    // in → in: free
    await tool.run({ op: 'move', path: 'Alfred/a.md', to: 'Alfred/b.md' }, ctxFor(t.id, t.goalId));
    expect(calls).toHaveLength(1);
    // in → out: gated
    const g1 = await tool.run({ op: 'move', path: 'Alfred/b.md', to: 'Elsewhere/b.md' }, ctxFor(t.id, t.goalId));
    expect(g1.park?.status).toBe('blocked');
    expect(pending(t.id)[0]!.action).toBe('vault.move');
    expect(pending(t.id)[0]!.detail).toContain('Alfred/b.md');
    // out → in: gated too
    const g2 = await tool.run({ op: 'move', path: 'Elsewhere/b.md', to: 'Alfred/b.md' }, ctxFor(t.id, t.goalId));
    expect(g2.park).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it('chat: gated answers "needs Quinn’s OK" without parking', async () => {
    const r = await tool.run({ op: 'write', path: 'Notes/x.md', content: 'hi' }, ctxFor('chat:th1'));
    expect(r.ok).toBe(false);
    expect(r.park).toBeUndefined();
    expect(r.output).toContain('needs Quinn');
  });
});

describe('vault tool — offline node', () => {
  it('no vault node: a goal task parks blocked; chat says the Mac is offline', async () => {
    online = false;
    const t = task();
    const goal = await tool.run({ op: 'list' }, ctxFor(t.id, t.goalId));
    expect(goal.ok).toBe(false);
    expect(goal.park?.status).toBe('blocked');
    const chat = await tool.run({ op: 'read', path: 'Alfred/a.md' }, ctxFor('chat:th2'));
    expect(chat.ok).toBe(false);
    expect(chat.output).toBe('the Mac with the vault is offline');
    expect(chat.park).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('vault tool — events', () => {
  it('successful write/append/move store {op,path,to?,bytes,auto} and NEVER the content', async () => {
    const t = task();
    const SECRET = 'TOP-SECRET-MARKER';
    await tool.run({ op: 'write', path: 'Alfred/w.md', content: SECRET }, ctxFor(t.id, t.goalId));
    await tool.run({ op: 'append', path: 'Alfred/w.md', content: `${SECRET} more` }, ctxFor(t.id, t.goalId));
    await tool.run({ op: 'move', path: 'Alfred/w.md', to: 'Alfred/z.md' }, ctxFor(t.id, t.goalId));
    const rows = store.allEvents({ limit: 500 });
    const vs = rows.filter((e: any) => e.kind === 'vault');
    expect(vs.length).toBe(3);
    expect(vs[0].data).toMatchObject({ op: 'write', path: 'Alfred/w.md', bytes: SECRET.length, auto: true });
    expect(vs[2].data).toMatchObject({ op: 'move', path: 'Alfred/w.md', to: 'Alfred/z.md' });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });
});

describe('vault tool — policy', () => {
  it('config/vault.yaml changes the agent folder and the chosen node', async () => {
    writeFileSync(join(root, 'config', 'vault.yaml'), "node: studio-pc\nagentFolder: 'Agent Notes'\n");
    (deps.nodes as any).list = () => [
      { name: 'macbook', caps: ['vault'], vault: 'A' },
      { name: 'studio-pc', caps: ['vault'], vault: 'B' },
    ];
    const t = task();
    await tool.run({ op: 'write', path: 'Agent Notes/x.md', content: 'in folder' }, ctxFor(t.id, t.goalId));
    expect(calls[0]!.node).toBe('studio-pc'); // configured node wins
    expect(pending(t.id)).toHaveLength(0); // configured agent folder is free
    const g = await tool.run({ op: 'write', path: 'Alfred/x.md', content: 'not the folder' }, ctxFor(t.id, t.goalId));
    expect(g.park).toBeTruthy(); // 'Alfred' is NOT free once agentFolder is different
  });

  it('oversized content is refused before any node call', async () => {
    writeFileSync(join(root, 'config', 'vault.yaml'), 'maxPageBytes: 100\n');
    const t = task();
    const r = await tool.run({ op: 'write', path: 'Alfred/x.md', content: 'x'.repeat(101) }, ctxFor(t.id, t.goalId));
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/too large/);
    expect(calls).toHaveLength(0);
  });
});
