// V1 — the `vault` agent tool: Quinn's Obsidian vault, served by a node with the `vault` cap.
// Reads (list/read/search) are free; writes inside the agent folder are free, anywhere else
// and every move go through the approval gate. Successful writes append a `vault` event
// { op, path, to?, bytes, auto } to the task's goal — never the content.
import type { ModuleDeps } from '../modules.js';
import { NodeOfflineError, type Tool, type ToolContext, type ToolResult } from '../runtime/contract.js';
import { parkIfNodeOffline } from '../runtime/tools.js';
import { gated, sha256 } from '../powers/gate.js';
import { insideAgentFolder, loadVaultPolicy, normalizePage, type VaultPolicy } from './policy.js';

/** What the model sees of a page before it is cut with a note. */
const READ_CHAR_CAP = 16_000;
const LIST_LINE_CAP = 300;
export const OFFLINE_MSG = 'the Mac with the vault is offline';

interface VaultNodeInfo {
  name: string;
  caps: string[];
  vault?: string;
}

/** The node that serves the vault: config names one, else the first connected with the cap. */
export function pickVaultNode(deps: ModuleDeps, policy: VaultPolicy): VaultNodeInfo | null {
  let list: VaultNodeInfo[] = [];
  try {
    list = (deps.nodes?.list?.() ?? []) as VaultNodeInfo[];
  } catch {
    return null;
  }
  const withCap = list.filter((n) => Array.isArray(n.caps) && n.caps.includes('vault'));
  if (policy.node) return withCap.find((n) => n.name === policy.node) ?? null;
  return withCap[0] ?? null;
}

/** Offline: a goal task parks `blocked` (NodeOfflineError semantics); chat just says so. */
export function offlineResult(node: string | null, ctx: ToolContext): ToolResult {
  if (String(ctx?.taskId ?? '').startsWith('chat:')) return { ok: false, output: OFFLINE_MSG };
  return parkIfNodeOffline(new NodeOfflineError(node || 'vault')) ?? { ok: false, output: OFFLINE_MSG };
}

type CallOk = { ok: true; value: any };
type CallBad = { ok: false; bad: ToolResult };

async function nodeCall(deps: ModuleDeps, node: VaultNodeInfo | null, ctx: ToolContext, op: string, args: any): Promise<CallOk | CallBad> {
  if (!node) return { ok: false, bad: offlineResult(null, ctx) };
  let r: any;
  try {
    r = await deps.nodes.call(node.name, op as any, args);
  } catch (e: any) {
    return { ok: false, bad: parkIfNodeOffline(e) ?? { ok: false, output: `error: ${e?.message ?? String(e)}` } };
  }
  if (r?.ok) return { ok: true, value: r.value };
  const err = String(r?.error ?? `${op} failed on ${node.name}`);
  // The node dropped between picking and calling → same semantics as never finding it.
  if (/\boffline\b/i.test(err)) return { ok: false, bad: offlineResult(node.name, ctx) };
  return { ok: false, bad: { ok: false, output: `error: ${err}` } };
}

function record(deps: ModuleDeps, ctx: ToolContext, data: { op: string; path: string; to?: string; bytes: number; auto: boolean }): void {
  try {
    deps.store.appendEvent(ctx?.goalId || '', ctx?.taskId || null, 'vault', data);
  } catch {
    /* the event log must never break a tool */
  }
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** The internal Obsidian MCP server to use, when configured and connected. */
export function mcpBackend(deps: ModuleDeps, policy: VaultPolicy): { server: string; hub: any } | null {
  const hub: any = deps.hub;
  if (!policy.mcp || !hub?.connected?.(policy.mcp) || typeof hub.callInternal !== 'function') return null;
  return { server: policy.mcp, hub };
}

/**
 * The same ops and the same policy as the node path, over the Obsidian MCP plugin's `vault` / `edit`
 * tools. Only these actions are ever sent: list, read, search, create, update, move, append —
 * never delete/rename/split/combine (the plugin has them; agents never get them).
 */
async function runViaMcp(deps: ModuleDeps, policy: VaultPolicy, mcp: { server: string; hub: any }, op: string, args: any, ctx: ToolContext): Promise<ToolResult> {
  const call = (tool: 'vault' | 'edit', a: Record<string, unknown>) => mcp.hub.callInternal(mcp.server, tool, a, ctx?.signal) as Promise<ToolResult>;
  const cap = (r: ToolResult) => (r.output.length > READ_CHAR_CAP ? { ...r, output: `${r.output.slice(0, READ_CHAR_CAP)}\n… truncated at ${READ_CHAR_CAP} chars` } : r);
  if (op === 'list') {
    const dir = typeof args?.path === 'string' ? args.path.trim().replace(/^\/+|\/+$/g, '') : '';
    if (dir.split('/').some((seg: string) => seg === '..' || seg === '.')) return { ok: false, output: 'invalid folder' };
    return cap(await call('vault', { action: 'list', directory: dir }));
  }
  if (op === 'read') {
    const path = normalizePage(args?.path);
    if (!path) return { ok: false, output: 'path is required' };
    return cap(await call('vault', { action: 'read', path }));
  }
  if (op === 'search') {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, output: 'query is required' };
    return cap(await call('vault', { action: 'search', query, includeSnippets: true, pageSize: 20 }));
  }
  const path = normalizePage(args?.path);
  if (!path) return { ok: false, output: 'path is required (vault-relative, e.g. "Alfred/notes.md")' };
  if (op === 'move') {
    const to = normalizePage(args?.to);
    if (!to) return { ok: false, output: 'to is required for move' };
    const free = insideAgentFolder(path, policy) && insideAgentFolder(to, policy);
    const run = async (): Promise<ToolResult> => {
      const r = await call('vault', { action: 'move', path, destination: to });
      if (!r.ok) return { ok: false, output: `error: ${r.output}` };
      record(deps, ctx, { op: 'move', path, to, bytes: 0, auto: free });
      return { ok: true, output: `saved to Obsidian: ${to} (moved from ${path})` };
    };
    return free ? run() : gated({ deps, tool: ctx }, 'vault.move', `vault move ${path} → ${to}`, run, { bind: sha256(`move${path}${to}`) });
  }
  if (op !== 'write' && op !== 'append') return { ok: false, output: `unknown op: ${op}` };
  const content = typeof args?.content === 'string' ? args.content : '';
  if (!content.trim()) return { ok: false, output: 'content is required' };
  if (bytes(content) > policy.maxPageBytes) {
    return { ok: false, output: `content too large: ${bytes(content)} bytes (max ${policy.maxPageBytes}; split it across pages)` };
  }
  const free = insideAgentFolder(path, policy);
  const run = async (): Promise<ToolResult> => {
    let r: ToolResult;
    if (op === 'append') {
      r = await call('edit', { action: 'append', path, content });
      if (!r.ok && /not found|does not exist|no such/i.test(r.output)) r = await call('vault', { action: 'create', path, content });
    } else {
      r = await call('vault', { action: args?.overwrite ? 'update' : 'create', path, content });
    }
    if (!r.ok) return { ok: false, output: `error: ${r.output}` };
    record(deps, ctx, { op, path, bytes: bytes(content), auto: free });
    return { ok: true, output: `saved to Obsidian: ${path}${op === 'append' ? ' (appended)' : ''}` };
  };
  return free
    ? run()
    : gated({ deps, tool: ctx }, 'vault.write', `vault ${op} ${path}`, run, { info: content, bind: sha256(`${op}${path}${content}`) });
}

export function vaultTool(deps: ModuleDeps): Tool {
  return {
    kind: 'write',
    caps: ['fs-write'],
    schema: {
      name: 'vault',
      description:
        "Quinn's Obsidian vault (Markdown). op: list | read | search | write | append | move. " +
        `Writing inside the agent folder (${loadVaultPolicy(deps).agentFolder}/) is automatic; anywhere else, and every move, needs Quinn's OK. ` +
        'Search before writing to avoid duplicates; link related pages with [[Page Name]].',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['list', 'read', 'search', 'write', 'append', 'move'] },
          path: { type: 'string', description: 'vault-relative page or folder (.md added when missing)' },
          content: { type: 'string', description: 'page content (write/append)' },
          query: { type: 'string', description: 'search text (search)' },
          to: { type: 'string', description: 'destination page (move)' },
          overwrite: { type: 'boolean', description: 'replace an existing page (write)' },
          recursive: { type: 'boolean', description: 'walk subfolders (list)' },
        },
        required: ['op'],
      },
    },
    async run(args: any, ctx: ToolContext): Promise<ToolResult> {
      try {
        const policy = loadVaultPolicy(deps);
        const op = String(args?.op ?? '');
        const node = pickVaultNode(deps, policy);
        // Preferred: the Obsidian MCP plugin (internal connector) — works whenever Obsidian is open.
        const mcp = mcpBackend(deps, policy);
        if (mcp) return await runViaMcp(deps, policy, mcp, op, args, ctx);

        if (op === 'list') {
          const r = await nodeCall(deps, node, ctx, 'vaultList', {
            ...(typeof args?.path === 'string' && args.path ? { path: normalizePage(args.path).replace(/\.md$/, '') } : {}),
            recursive: !!args?.recursive,
          });
          if (!r.ok) return r.bad;
          const entries: any[] = r.value?.entries ?? [];
          const lines = entries.map((e) => (e.dir ? `${e.path}/` : `${e.path} (${e.size})`));
          const shown = lines.slice(0, LIST_LINE_CAP);
          return { ok: true, output: (entries.length ? shown.join('\n') : '(empty)') + (lines.length > shown.length ? `\n… ${lines.length - shown.length} more entries` : '') };
        }
        if (op === 'read') {
          const path = normalizePage(args?.path);
          if (!path) return { ok: false, output: 'path is required' };
          const r = await nodeCall(deps, node, ctx, 'vaultRead', { path });
          if (!r.ok) return r.bad;
          const content = String(r.value?.content ?? '');
          return {
            ok: true,
            output: content.length > READ_CHAR_CAP
              ? `${content.slice(0, READ_CHAR_CAP)}\n… truncated at ${READ_CHAR_CAP} of ${content.length} chars`
              : content || '(empty page)',
          };
        }
        if (op === 'search') {
          const query = String(args?.query ?? '').trim();
          if (!query) return { ok: false, output: 'query is required' };
          const r = await nodeCall(deps, node, ctx, 'vaultSearch', { query, max: 20 });
          if (!r.ok) return r.bad;
          const hits: any[] = r.value?.hits ?? [];
          return { ok: true, output: hits.length ? hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') : `no hits for "${query}"` };
        }

        const path = normalizePage(args?.path);
        if (!path) return { ok: false, output: 'path is required (vault-relative, e.g. "Alfred/notes.md")' };
        if (op === 'move') {
          const to = normalizePage(args?.to);
          if (!to) return { ok: false, output: 'to is required for move' };
          const free = insideAgentFolder(path, policy) && insideAgentFolder(to, policy);
          const run = async (): Promise<ToolResult> => {
            const r = await nodeCall(deps, node, ctx, 'vaultMove', { from: path, to });
            if (!r.ok) return r.bad;
            record(deps, ctx, { op: 'move', path, to, bytes: 0, auto: free });
            return { ok: true, output: `saved to Obsidian: ${to} (moved from ${path})` };
          };
          return free ? run() : gated({ deps, tool: ctx }, 'vault.move', `vault move ${path} → ${to}`, run, { bind: sha256(`move${path}${to}`) });
        }

        const content = typeof args?.content === 'string' ? args.content : '';
        if (!content.trim()) return { ok: false, output: 'content is required' };
        if (bytes(content) > policy.maxPageBytes) {
          return { ok: false, output: `content too large: ${bytes(content)} bytes (max ${policy.maxPageBytes}; split it across pages)` };
        }
        if (op !== 'write' && op !== 'append') return { ok: false, output: `unknown op: ${op}` };
        const free = insideAgentFolder(path, policy);
        const run = async (): Promise<ToolResult> => {
          const r = op === 'write'
            ? await nodeCall(deps, node, ctx, 'vaultWrite', { path, content, overwrite: !!args?.overwrite })
            : await nodeCall(deps, node, ctx, 'vaultAppend', { path, content });
          if (!r.ok) return r.bad;
          record(deps, ctx, { op, path, bytes: bytes(content), auto: free });
          return { ok: true, output: `saved to Obsidian: ${path}${op === 'append' ? ' (appended)' : ''}` };
        };
        return free
          ? run()
          : gated({ deps, tool: ctx }, 'vault.write', `vault ${op} ${path}`, run, { info: content, bind: sha256(`${op}${path}${content}`) });
      } catch (e: any) {
        return parkIfNodeOffline(e) ?? { ok: false, output: `error: ${e?.message ?? String(e)}` };
      }
    },
  };
}
