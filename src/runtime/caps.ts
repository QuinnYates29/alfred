// Capability classes for tool permissions. A per-model `deny` entry is a tool name OR `class:<cap>`
// (e.g. `class:exec` = "anything that runs commands"). Denying one tool never implies another;
// classes are how Quinn blocks a whole kind of power at once.
import type { Tool } from './contract.js';

export const CAP_CLASSES = ['exec', 'fs-write', 'network', 'people', 'platform-admin'] as const;
export type ToolCap = (typeof CAP_CLASSES)[number];

export const CAP_LABELS: Record<ToolCap, string> = {
  exec: 'runs commands',
  'fs-write': 'writes files',
  network: 'reaches the network',
  people: 'contacts people',
  'platform-admin': 'changes alfred itself',
};

/**
 * Caps of the built-in tools, by name (tools may also declare `caps` themselves, which wins).
 * Every tool that can run a shell command is `exec` — run_shell AND the executors.
 */
export const BUILTIN_CAPS: Record<string, ToolCap[]> = {
  run_shell: ['exec', 'fs-write', 'network'],
  dsh_code: ['exec', 'fs-write', 'network'],
  pipeline_run: ['exec', 'fs-write', 'network'],
  langgraph_code: ['exec', 'fs-write', 'network'],
  write_file: ['fs-write'],
  message: ['people', 'network'],
  call: ['people', 'network'],
  contacts: ['people'],
  notify: ['people'],
  platform: ['platform-admin'],
  connectors: ['platform-admin', 'network'],
  alfred_dev: ['platform-admin'],
  web_search: ['network'],
  web_fetch: ['network'],
};

export function isCapClass(s: string): s is ToolCap {
  return (CAP_CLASSES as readonly string[]).includes(s);
}

/** A deny entry: `class:<cap>` must name a known class; anything else is a tool name. */
export function denyEntryError(entry: string): string | null {
  if (entry.startsWith('class:')) return isCapClass(entry.slice(6)) ? null : `unknown capability class "${entry}" (${CAP_CLASSES.map((c) => `class:${c}`).join(', ')})`;
  return null;
}

export function toolCaps(name: string, tool?: Pick<Tool, 'caps'> | null): ToolCap[] {
  const own = tool?.caps;
  if (Array.isArray(own) && own.length) return own.filter(isCapClass);
  return BUILTIN_CAPS[name] ?? [];
}

/** Is tool `name` blocked by this deny set (by name or by one of its classes)? */
export function denies(deny: ReadonlySet<string> | readonly string[], name: string, caps: readonly ToolCap[]): boolean {
  const set = deny instanceof Set ? deny : new Set(deny as readonly string[]);
  if (set.has(name)) return true;
  return caps.some((c) => set.has(`class:${c}`));
}

/** Why `name` is blocked (the matching entry), or null. */
export function denyReason(deny: ReadonlySet<string>, name: string, caps: readonly ToolCap[]): string | null {
  if (deny.has(name)) return name;
  const c = caps.find((x) => deny.has(`class:${x}`));
  return c ? `class:${c}` : null;
}
