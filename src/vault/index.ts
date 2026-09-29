// V1 — the vault module: the `vault` agent tool plus two dashboard routes.
// GET  /vault/status   → { node, online, vaultName, agentFolder } (which node serves the vault)
// POST /vault/publish  → Quinn's own "Save to vault": allowed anywhere, never gated
//                        (still node-guarded: vault-relative, .md, inside the vault).
import express, { type Request, type Response } from 'express';
import type { AlfredModule, ModuleDeps } from '../modules.js';
import type { Store } from '../store.js';
import type { Tool } from '../runtime/contract.js';
import { storeForTask } from '../approvals.js';
import { loadVaultPolicy } from './policy.js';
import { normalizePage } from './policy.js';
import { OFFLINE_MSG, mcpBackend, pickVaultNode, vaultTool } from './tool.js';

const bound = new WeakMap<Store, Tool[]>();

export function createVaultModule(deps: ModuleDeps): AlfredModule {
  const tools = [vaultTool(deps)];
  bound.set(deps.store, tools);
  return { name: 'vault', router: vaultRouter(deps), tools };
}

function vaultRouter(deps: ModuleDeps): express.Router {
  const r = express.Router();
  r.get('/vault/status', async (_req: Request, res: Response) => {
    const policy = loadVaultPolicy(deps);
    const node = pickVaultNode(deps, policy);
    const mcp = await mcpBackend(deps, policy);
    res.json({
      backend: mcp ? 'mcp' : node ? 'node' : null,
      mcp: policy.mcp ? { server: mcp?.server ?? policy.mcp, connected: !!mcp } : null,
      node: node?.name ?? null,
      online: !!mcp || !!node,
      vaultName: node?.vault ?? null,
      agentFolder: policy.agentFolder,
    });
  });
  r.post('/vault/publish', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const path = normalizePage(body?.path);
    const content = typeof body?.content === 'string' ? body.content : '';
    if (!path) return res.status(400).json({ error: 'path is required (vault-relative, e.g. "Notes/idea.md")' });
    if (!content.trim()) return res.status(400).json({ error: 'content is required' });
    const policy = loadVaultPolicy(deps);
    const mcp = await mcpBackend(deps, policy);
    if (mcp) {
      // Quinn's own "Save to vault": create, or replace when the page exists
      let r: any = await mcp.hub.callInternal(mcp.server, 'vault', { action: 'create', path, content });
      if (!r?.ok && /exist/i.test(String(r?.output))) r = await mcp.hub.callInternal(mcp.server, 'vault', { action: 'update', path, content });
      if (!r?.ok) return res.status(400).json({ error: String(r?.output ?? 'publish failed').slice(0, 300) });
      try {
        deps.store.appendEvent('', null, 'vault', { op: 'write', path, bytes: Buffer.byteLength(content, 'utf8'), auto: true });
      } catch {
        /* never break the response */
      }
      return res.json({ ok: true, path, via: 'mcp' });
    }
    const node = pickVaultNode(deps, policy);
    if (!node) return res.status(503).json({ error: OFFLINE_MSG });
    try {
      const r: any = await deps.nodes.call(node.name, 'vaultWrite', { path, content, overwrite: true });
      if (!r?.ok) return res.status(400).json({ error: String(r?.error ?? 'publish failed') });
      try {
        deps.store.appendEvent('', null, 'vault', { op: 'write', path, bytes: Buffer.byteLength(content, 'utf8'), auto: true });
      } catch {
        /* never break the response */
      }
      res.json({ ok: true, path, node: node.name });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });
  return r;
}

/**
 * The same tool without a module (allTools(), for registries built outside startAlfred):
 * same schema; a run finds the instance that owns the task's store, or says unavailable.
 */
export function vaultToolStubs(): Tool[] {
  const t = vaultTool({ extra: {} } as unknown as ModuleDeps);
  return [{
    ...t,
    run: async (args, ctx) => {
      const store = storeForTask(ctx.taskId);
      const real = store ? bound.get(store)?.find((x) => x.schema.name === t.schema.name) : undefined;
      return real ? real.run(args, ctx) : { ok: false, output: 'vault is not available in this runtime' };
    },
  }];
}
