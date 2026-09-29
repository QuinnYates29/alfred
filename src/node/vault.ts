// V1 — Obsidian vault ops on the node. The vault dir is NEVER a general root: fs/exec ops
// can't reach it, and vault paths are vault-RELATIVE only — no absolute paths, no '..',
// no hidden segments (.obsidian/.trash/.git…), Markdown for read/write/append/move.
// Containment uses the same realpath check as guardRoot/containedPath.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  VAULT_CAP, VAULT_LIST_MAX, VAULT_READ_MAX, VAULT_SEARCH_MAX_BYTES, VAULT_SEARCH_MAX_FILES, VAULT_WRITE_MAX,
} from './protocol.js';
import { containedPath } from '../pathguard.js';

export interface VaultEntry { path: string; dir: boolean; size: number; mtime: number }
export interface VaultHit { path: string; line: number; text: string }
/** A vault refusal: honest text for the model; the op did not happen. */
export class VaultError extends Error {}

export const vaultError = (msg: string): never => {
  throw new VaultError(msg);
};

const isDotSegment = (seg: string) => seg.startsWith('.');

/**
 * vaultDir + a vault-relative path → the real path inside the vault, or null.
 * Refuses absolute paths, '..', any segment starting with '.', NULs and symlink escapes.
 * With `.md: true` the path must end in .md (read/write/append/move).
 */
export function vaultResolve(vaultDir: string, rel: unknown, o: { write?: boolean; md?: boolean } = {}): string | null {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const norm = rel.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:[\\/]/.test(norm)) return null;
  const segs = norm.split('/').filter((s) => s !== '' && s !== '.');
  if (!segs.length || segs.some((s) => s === '..' || isDotSegment(s))) return null;
  return containedPath([vaultDir], segs.join(path.sep), { base: vaultDir, write: !!o.write });
}

/** Like vaultResolve, but throws a VaultError with a specific reason (ops use this). */
export function vaultMustResolve(vaultDir: string, rel: unknown, o: { write?: boolean; md?: boolean } = {}): string {
  if (typeof rel !== 'string' || !rel.trim()) throw new VaultError('path is required (vault-relative, e.g. "Alfred/notes.md")');
  if (path.isAbsolute(rel)) throw new VaultError(`absolute paths are not allowed: ${rel} (paths are relative to the vault root)`);
  const norm = rel.replaceAll('\\', '/');
  const segs = norm.split('/').filter(Boolean);
  if (segs.some((s) => s === '..')) throw new VaultError(`".. is not allowed in vault paths: ${rel}`);
  if (segs.some(isDotSegment)) throw new VaultError(`hidden segments are not allowed (a name starting with "."): ${rel}`);
  if (o.md && !norm.toLowerCase().endsWith('.md')) throw new VaultError(`only .md pages can be read or written here: ${rel}`);
  const abs = vaultResolve(vaultDir, rel, o);
  if (!abs) throw new VaultError(`outside the vault: ${rel}`);
  return abs;
}

const isMd = (name: string) => name.toLowerCase().endsWith('.md');

function statOf(p: string): { dir: boolean; size: number; mtime: number } {
  try {
    const s = statSync(p);
    return { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
  } catch {
    return { dir: false, size: 0, mtime: 0 };
  }
}

/** Depth-first walk of the vault (dot dirs skipped), up to `cap` entries. */
function walk(root: string, dir: string, recursive: boolean, out: VaultEntry[]): void {
  if (out.length >= VAULT_LIST_MAX) return;
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of items) {
    if (out.length >= VAULT_LIST_MAX) return;
    if (isDotSegment(e.name)) continue;
    let dirish = e.isDirectory();
    try {
      dirish = statSync(path.join(dir, e.name)).isDirectory(); // follow symlinked dirs for listing only (never written through)
    } catch {
      /* dangling symlink */
    }
    const rel = (dir === root ? '' : `${path.relative(root, dir)}/`) + e.name;
    const st = statOf(path.join(dir, e.name));
    out.push({ path: rel.split(path.sep).join('/'), dir: dirish, size: st.size, mtime: st.mtime });
    if (recursive && dirish) walk(root, path.join(dir, e.name), true, out);
  }
}

export function vaultList(vaultDir: string, args: { path?: string; recursive?: boolean }): { entries: VaultEntry[] } {
  let dir = vaultDir;
  if (args?.path !== undefined && args.path !== '') {
    dir = vaultMustResolve(vaultDir, args.path);
    const st = statOf(dir);
    if (!st.dir) vaultError(`not a folder: ${args.path}`);
  }
  const entries: VaultEntry[] = [];
  walk(vaultDir, dir, !!args?.recursive, entries);
  return { entries };
}

export function vaultRead(vaultDir: string, args: { path?: string }): { content: string; mtime: number } {
  const abs = vaultMustResolve(vaultDir, args?.path, { md: true });
  const st = statOf(abs);
  if (st.dir) vaultError(`not a file: ${args?.path}`);
  if (!exists(abs)) vaultError(`no such page: ${args?.path}`);
  if (st.size > VAULT_READ_MAX) vaultError(`page too large: ${st.size} bytes (max ${VAULT_READ_MAX})`);
  return { content: readFileSync(abs, 'utf8'), mtime: st.mtime };
}

const exists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

export function vaultSearch(vaultDir: string, args: { query?: string; max?: number }): { hits: VaultHit[] } {
  const q = String(args?.query ?? '');
  if (!q.trim()) vaultError('query is required');
  const max = Math.max(1, Math.min(Number(args?.max) || 20, 100));
  const needle = q.toLowerCase();
  const hits: VaultHit[] = [];
  const files: string[] = [];
  let scanned = 0;
  const collect = (dir: string) => {
    if (scanned >= VAULT_SEARCH_MAX_FILES) return;
    let items;
    try {
      items = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of items) {
      if (scanned >= VAULT_SEARCH_MAX_FILES) return;
      if (isDotSegment(e.name)) continue;
      const abs = path.join(dir, e.name);
      let dirish = e.isDirectory();
      try {
        dirish = statSync(abs).isDirectory();
      } catch {
        /* dangling symlink */
      }
      if (dirish) collect(abs);
      else if (isMd(e.name)) {
        scanned++;
        files.push(abs);
      }
    }
  };
  collect(vaultDir);
  let read = 0;
  for (const f of files) {
    if (hits.length >= max || read >= VAULT_SEARCH_MAX_BYTES) break;
    let content: string;
    try {
      const size = statSync(f).size;
      if (read + size > VAULT_SEARCH_MAX_BYTES) break;
      read += size;
      content = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(vaultDir, f).split(path.sep).join('/');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) hits.push({ path: rel, line: i + 1, text: lines[i]!.slice(0, 300) });
    }
  }
  return { hits };
}

/** atomic write (tmp + rename) inside the vault; never through a symlink. */
function atomicWrite(abs: string, content: string): void {
  if (content.includes('\0')) vaultError('content must not contain NUL');
  if (Buffer.byteLength(content, 'utf8') > VAULT_WRITE_MAX) {
    vaultError(`content too large: ${Buffer.byteLength(content, 'utf8')} bytes (max ${VAULT_WRITE_MAX})`);
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, abs);
  } catch (e: any) {
    try {
      rmSync(tmp);
    } catch {
      /* no temp file to clean */
    }
    if (e instanceof VaultError) throw e;
    vaultError(`write failed: ${e?.message ?? e}`);
  }
}

export function vaultWrite(vaultDir: string, args: { path?: string; content?: string; overwrite?: boolean }): { path: string; bytes: number } {
  const content = typeof args?.content === 'string' ? args.content : vaultError('content is required');
  const abs = vaultMustResolve(vaultDir, args?.path, { write: true, md: true });
  if (exists(abs)) {
    if (statOf(abs).dir) vaultError(`not a file: ${args?.path}`);
    if (!args?.overwrite) vaultError(`page already exists: ${args?.path} (pass overwrite:true to replace it, or append)`);
  }
  atomicWrite(abs, content);
  return { path: normRel(String(args?.path)), bytes: Buffer.byteLength(content, 'utf8') };
}

export function vaultAppend(vaultDir: string, args: { path?: string; content?: string }): { path: string; bytes: number } {
  const content = typeof args?.content === 'string' ? args.content : vaultError('content is required');
  if (Buffer.byteLength(content, 'utf8') > VAULT_WRITE_MAX) vaultError(`content too large (max ${VAULT_WRITE_MAX} bytes)`);
  const abs = vaultMustResolve(vaultDir, args?.path, { write: true, md: true });
  let next = content;
  if (exists(abs)) {
    if (statOf(abs).dir) vaultError(`not a file: ${args?.path}`);
    const total = statOf(abs).size + Buffer.byteLength(content, 'utf8') + 1;
    if (total > VAULT_WRITE_MAX) vaultError(`page would exceed ${VAULT_WRITE_MAX} bytes after appending (${total})`);
    next = `${readFileSync(abs, 'utf8')}\n${content}`;
  }
  atomicWrite(abs, next);
  return { path: normRel(String(args?.path)), bytes: Buffer.byteLength(content, 'utf8') };
}

export function vaultMove(vaultDir: string, args: { from?: string; to?: string }): { from: string; to: string } {
  const src = vaultMustResolve(vaultDir, args?.from, { md: true });
  const dst = vaultMustResolve(vaultDir, args?.to, { write: true, md: true });
  if (!exists(src) || statOf(src).dir) vaultError(`no such page: ${args?.from}`);
  if (exists(dst)) vaultError(`target already exists: ${args?.to}`);
  mkdirSync(path.dirname(dst), { recursive: true });
  try {
    renameSync(src, dst);
  } catch (e: any) {
    vaultError(`move failed: ${e?.message ?? e}`);
  }
  return { from: normRel(String(args?.from)), to: normRel(String(args?.to)) };
}

const normRel = (p: string) => p.replaceAll('\\', '/').replace(/^\/+/, '');

/** Handle a vault op on the node; the caller has already verified the `vault` cap. */
export function runVaultOp(vaultDir: string, op: string, args: any): any {
  switch (op) {
    case 'vaultList':
      return vaultList(vaultDir, args ?? {});
    case 'vaultRead':
      return vaultRead(vaultDir, args ?? {});
    case 'vaultSearch':
      return vaultSearch(vaultDir, args ?? {});
    case 'vaultWrite':
      return vaultWrite(vaultDir, args ?? {});
    case 'vaultAppend':
      return vaultAppend(vaultDir, args ?? {});
    case 'vaultMove':
      return vaultMove(vaultDir, args ?? {});
    default:
      vaultError(`unknown vault op: ${op}`);
  }
}

export { VAULT_CAP };
