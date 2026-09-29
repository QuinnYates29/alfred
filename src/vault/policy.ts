// V1 — config/vault.yaml: which node serves the Obsidian vault and how freely agents may write.
// Read fresh every time (like powers.yaml); missing or broken = the defaults below.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ModuleDeps } from '../modules.js';
import { powersRoot } from '../powers/gate.js';

export interface VaultPolicy {
  /** Node name; '' = the first connected node with the `vault` cap. */
  node: string;
  /** Agents write here freely (created on first write); anywhere else needs Quinn's OK. */
  agentFolder: string;
  /** Longest page content the server accepts (the node caps writes at 512 KB anyway). */
  maxPageBytes: number;
  /** Internal MCP server (config/mcp.json) of the Obsidian MCP plugin; preferred over the node when connected. '' = node only. */
  mcp: string;
}

export const DEFAULT_VAULT_POLICY: VaultPolicy = { node: '', agentFolder: 'Alfred', maxPageBytes: 200000, mcp: 'obsidian' };

/** config/vault.yaml, read fresh. Missing or broken → defaults. */
export function loadVaultPolicy(deps: ModuleDeps): VaultPolicy {
  const root = powersRoot(deps);
  if (!root) return { ...DEFAULT_VAULT_POLICY };
  const p = join(root, 'config', 'vault.yaml');
  if (!existsSync(p)) return { ...DEFAULT_VAULT_POLICY };
  try {
    const raw = parseYaml(readFileSync(p, 'utf8')) as any;
    const node = typeof raw?.node === 'string' ? raw.node.trim() : '';
    const folder = typeof raw?.agentFolder === 'string' && raw.agentFolder.trim() ? raw.agentFolder.trim().replace(/^\/+|\/+$/g, '') : DEFAULT_VAULT_POLICY.agentFolder;
    const max = Number(raw?.maxPageBytes);
    return {
      node,
      mcp: typeof raw?.mcp === 'string' ? raw.mcp.trim() : DEFAULT_VAULT_POLICY.mcp,
      agentFolder: folder,
      maxPageBytes: Number.isFinite(max) && max > 0 ? Math.min(max, 512_000) : DEFAULT_VAULT_POLICY.maxPageBytes,
    };
  } catch (e: any) {
    console.error(`[vault] ignoring config/vault.yaml: ${e?.message ?? e}`);
    return { ...DEFAULT_VAULT_POLICY };
  }
}

/** `Alfred` (or whatever Quinn configured) without slashes. */
export const agentPrefix = (policy: VaultPolicy) => `${policy.agentFolder}/`;

/** Is this vault-relative page/folder inside the agent folder? */
export const insideAgentFolder = (path: string, policy: VaultPolicy): boolean => {
  const p = path.replace(/^\/+/, '');
  return p === policy.agentFolder || p.startsWith(agentPrefix(policy));
};

/**
 * A page path, normalised: forward slashes, no leading /, `.md` added when missing.
 * Any `.`/`..`/empty segment → '' (rejected): `Alfred/../Private.md` would otherwise count as
 * "inside the agent folder" (auto, no approval) while the node resolves it outside.
 */
export const normalizePage = (p: unknown): string => {
  let s = String(p ?? '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (s.startsWith('./')) s = s.slice(2);
  if (!s) return '';
  if (s.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return '';
  if (!s.toLowerCase().endsWith('.md')) s += '.md';
  return s;
};
