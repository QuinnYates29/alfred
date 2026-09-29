// P9 §1 — the wire protocol shared by the Alfred server (NodeHub) and alfred-node.
// JSON messages over a WebSocket at GET /api/nodes/connect?token=<ALFRED_TOKEN>.
import { readdirSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { containedPath } from '../pathguard.js';

export const PROTOCOL_VERSION = '1';
export const OUTPUT_CAP = 8000;

export type NodeOp = 'readFile' | 'writeFile' | 'listDir' | 'exec' | 'cancel' | 'ping' | CommsOp;

/** P21b: people ops, served by a node started with --messages (caps `messages` + `calls`). */
export type CommsOp = 'sendMessage' | 'placeCall';
/** The cap a node must advertise for each comms op. */
export const COMMS_CAP: Record<CommsOp, string> = { sendMessage: 'messages', placeCall: 'calls' };
export interface CommsResult {
  ok: boolean;
  error?: string;
  /** The request reached the node but no answer came back (disconnect/timeout): it may have happened. */
  uncertain?: boolean;
}
/** Longest text a message may carry (Twilio's SMS limit; Messages accepts it too). */
export const MAX_MESSAGE_CHARS = 1600;

/**
 * A phone number the way the comms ops accept it: '+' and digits only (E.164-ish),
 * after stripping the usual formatting (spaces, dashes, dots, parentheses — not newlines or tabs).
 * Returns null for anything else.
 */
export function normalizePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[ \u00a0().-]/g, '');
  return /^\+?[0-9]{3,15}$/.test(s) ? s : null;
}

/** An iMessage handle: a phone number or an email address (no spaces, quotes or control characters). */
export function normalizeHandle(v: unknown): string | null {
  const phone = normalizePhone(v);
  if (phone) return phone;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length <= 254 && /^[^\s\x00-\x1f\x7f@"'\\<>]+@[^\s\x00-\x1f\x7f@"'\\<>]+\.[^\s\x00-\x1f\x7f@"'\\<>]+$/.test(s) ? s : null;
}

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

/**
 * Resolve p the way the node enforces its roots: the REAL location (nearest existing
 * ancestor found with lstat, so a dangling symlink counts and is refused) must be
 * inside one of roots. Returns the resolved real path, or null when it escapes.
 * With `write`, a symlink as the final component is refused as well (writes then use
 * O_NOFOLLOW, see writeFileNoFollow).
 */
export function guardRoot(roots: string[], p: unknown, o: { write?: boolean } = {}): string | null {
  if (typeof p !== 'string' || !p) return null;
  return containedPath(roots, p, { write: !!o.write });
}

export function outsideRoots(p: unknown): string {
  return `outside node roots: ${String(p)}`;
}
