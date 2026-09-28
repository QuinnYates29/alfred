// P21a — the approval gate for mutating agent tools, and the powers.yaml policy.
//
// Reading is free; changing the platform needs Quinn's OK. A gated call runs when:
//   1. the task holds an approved request for exactly this detail (spent once), or
//   2. config/powers.yaml pre-approves it (autoApprove), or
//   3. it comes from chat (Quinn is in the conversation) with confirm:true.
// Otherwise a goal task requests an approval and parks `blocked` (like run_shell's
// guard), and a chat call answers "needs Quinn's OK". Every gated call is logged as
// a `power` system event.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ToolContext, ToolResult } from '../runtime/contract.js';
import type { ModuleDeps } from '../modules.js';

export interface AutoApproveRule {
  action: string;
  /** Exact detail strings, or prefixes ending in '*'. Absent = every detail of the action. */
  detail?: string | string[];
  /** For message/call: contact names or numbers that are pre-approved. */
  to?: string[];
}

export interface PowersPolicy {
  autoApprove: AutoApproveRule[];
}

export interface GateCtx {
  deps: ModuleDeps;
  tool: ToolContext;
  /** The call's confirm flag; honoured only for chat calls. */
  confirm?: boolean;
}

export interface GateOpts {
  /** A fingerprint of what was asked for (e.g. a connector's config). An approval spent on a
   *  different fingerprint than the one it was requested with is refused and re-requested. */
  bind?: string;
  /** A note appended to the task when it parks, so the reviewer sees the specifics. */
  info?: string;
  /** For policy rules with `to` (message/call). */
  to?: string;
}

/** `<root>`: tests pass a temp root in extra.repoRoot. */
export function powersRoot(deps: ModuleDeps): string {
  return (deps.extra?.repoRoot as string | undefined) ?? deps.repoRoot;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** config/powers.yaml, read fresh. Missing or broken = nothing is pre-approved (fail closed). */
export function loadPolicy(deps: ModuleDeps): PowersPolicy {
  const path = join(powersRoot(deps), 'config', 'powers.yaml');
  if (!existsSync(path)) return { autoApprove: [] };
  try {
    const raw = parseYaml(readFileSync(path, 'utf8')) as any;
    const list = Array.isArray(raw?.autoApprove) ? raw.autoApprove : [];
    return {
      autoApprove: list
        .filter((r: any) => r && typeof r.action === 'string' && r.action)
        .map((r: any) => ({
          action: r.action,
          ...(r.detail !== undefined ? { detail: Array.isArray(r.detail) ? r.detail.map(String) : String(r.detail) } : {}),
          ...(Array.isArray(r.to) ? { to: r.to.map(String) } : {}),
        })),
    };
  } catch (e: any) {
    console.error(`[powers] ignoring config/powers.yaml: ${e?.message ?? e}`);
    return { autoApprove: [] };
  }
}

function detailMatches(pattern: string, detail: string): boolean {
  return pattern.endsWith('*') ? detail.startsWith(pattern.slice(0, -1)) : pattern === detail;
}

export function autoApproved(policy: PowersPolicy, action: string, detail: string, to?: string): boolean {
  return policy.autoApprove.some((r) => {
    if (r.action !== action) return false;
    if (r.to && !(to !== undefined && r.to.includes(to))) return false;
    if (r.detail === undefined) return true;
    const pats = Array.isArray(r.detail) ? r.detail : [r.detail];
    return pats.some((p) => detailMatches(p, detail));
  });
}

/** taskId + detail → the fingerprint the approval was requested with (in-memory; a restart fails closed). */
const requested = new Map<string, string>();

function record(deps: ModuleDeps, data: Record<string, any>): void {
  try {
    deps.store.appendEvent('', null, 'power', data);
  } catch {
    /* the event log must never break a tool */
  }
}

export async function gated(
  g: GateCtx,
  action: string,
  detail: string,
  run: () => Promise<ToolResult>,
  o: GateOpts = {},
): Promise<ToolResult> {
  const { deps, tool } = g;
  const store = deps.store;
  const taskId = tool.taskId;
  const chat = taskId.startsWith('chat:');
  const base = { action, detail, ...(chat ? {} : { taskId }) };
  const key = `${taskId}\n${detail}`;

  const go = async (extra: Record<string, any>) => {
    record(deps, { ...base, outcome: 'ran', ...extra });
    return run();
  };

  if (!chat && store.consumeApproval(taskId, detail)) {
    const want = requested.get(key);
    requested.delete(key);
    if (o.bind === undefined || want === o.bind) return go({});
    // Approved for something else under the same name: ask again for what is asked now.
  } else if (autoApproved(loadPolicy(deps), action, detail, o.to)) {
    return go({ auto: true });
  } else if (chat && g.confirm === true) {
    return go({ confirmed: true });
  }

  if (chat) {
    record(deps, { ...base, outcome: 'asked' });
    return { ok: false, output: `needs Quinn’s OK: ${action}: ${detail} — ask him, then call again with confirm:true` };
  }
  try {
    store.requestApproval(taskId, action, detail);
    if (o.bind !== undefined) requested.set(key, o.bind);
    if (o.info) store.appendNote(taskId, `approval requested — ${detail}: ${o.info}`);
  } catch (e: any) {
    record(deps, { ...base, outcome: 'refused' });
    return { ok: false, output: `approval needed: ${action}: ${detail} — but no task to park (${e?.message ?? e})` };
  }
  record(deps, { ...base, outcome: 'parked' });
  return {
    ok: false,
    output: `approval needed: ${action}: ${detail}`,
    park: { status: 'blocked', reason: `approval needed: ${action}` },
  };
}
