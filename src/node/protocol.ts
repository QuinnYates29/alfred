// P9 §1 — the wire protocol shared by the Alfred server (NodeHub) and alfred-node.
// JSON messages over a WebSocket at GET /api/nodes/connect?token=<ALFRED_TOKEN>.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const PROTOCOL_VERSION = '1';
export const OUTPUT_CAP = 8000;

export type NodeOp = 'readFile' | 'writeFile' | 'listDir' | 'exec' | 'cancel' | 'ping';

export interface HelloMsg {
  type: 'hello';
  name: string;
  roots: string[];
  caps: string[];
  version: string;
  /** P10: where the node keeps sandbox workspaces (must be inside its roots). */
  sandbox?: string;
}
export interface CallMsg {
  type: 'call';
  id: string;
  op: NodeOp;
  args: any;
}
export interface ResultMsg {
  type: 'result';
  id: string;
  ok: boolean;
  value?: any;
  error?: string;
}
export interface NotifyMsg {
  type: 'notify';
  level: string;
  title: string;
  body: string;
  url?: string;
}
export type NodeMsg = HelloMsg | CallMsg | ResultMsg | NotifyMsg;

export interface ExecValue {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export function encode(msg: NodeMsg): string {
  return JSON.stringify(msg);
}

/** Parse a wire line; null for anything unparseable (never throws). */
export function parseMsg(text: string): NodeMsg | null {
  try {
    const m = JSON.parse(text);
    if (m && typeof m === 'object' && typeof m.type === 'string') return m as NodeMsg;
  } catch {
    /* ignore */
  }
  return null;
}

/** Keep the tail of exec output at ≤ OUTPUT_CAP chars. */
export function tailOut(s: string): string {
  return s.length <= OUTPUT_CAP ? s : s.slice(-OUTPUT_CAP);
}

function realpathNearest(p: string): string {
  let cur = p;
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = realpathSync(cur);
  } catch {
    /* keep as-is */
  }
  return rest.length ? path.join(cur, ...rest) : cur;
}

/**
 * Resolve p the way the node enforces its roots: realpath the nearest existing
 * parent, then require containment inside one of roots. Returns the resolved
 * absolute path, or null when it escapes.
 */
export function guardRoot(roots: string[], p: unknown): string | null {
  if (typeof p !== 'string' || !p) return null;
  const abs = path.resolve(p);
  const real = realpathNearest(abs);
  for (const r of roots) {
    const rr = realpathNearest(path.resolve(r));
    if (real === rr || real.startsWith(rr + path.sep)) return abs;
  }
  return null;
}

export function outsideRoots(p: unknown): string {
  return `outside node roots: ${String(p)}`;
}
