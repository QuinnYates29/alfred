// Symlink-safe containment checks for workspace / node-root file operations.
// Stdlib only (the Mac node imports it through src/node/protocol.ts).
//
// path.resolve alone is not enough: a symlink inside the workspace (planted by a
// shell command, a cloned repo, or a dangling link) would let read/write/list
// follow it out. Here every check is made on the REAL path: the target (or its
// nearest existing ancestor, found with lstat so a dangling link counts as
// existing) is realpath'ed and must stay under one of the realpath'ed roots.
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import path from 'node:path';

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/**
 * The real path `abs` refers to (nearest existing ancestor realpath'ed, the rest
 * appended), or null when an existing component cannot be resolved (dangling link,
 * loop, permission).
 */
export function realpathNearest(abs: string): string | null {
  let cur = path.resolve(abs);
  const rest: string[] = [];
  while (!lexists(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = realpathSync(cur);
  } catch {
    return null; // e.g. a dangling symlink: refuse rather than guess where a write would land
  }
  return rest.length ? path.join(cur, ...rest) : cur;
}

/**
 * Resolve `p` (relative to `base` when not absolute) and require that its real
 * location stays inside one of `roots`. Returns the real path, or null.
 * With `write`, an existing symlink as the final component is refused too.
 */
export function containedPath(
  roots: string[],
  p: unknown,
  o: { base?: string; write?: boolean } = {},
): string | null {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const abs = o.base ? path.resolve(o.base, p) : path.resolve(p);
  const lexRoots = roots.map((r) => path.resolve(r));
  if (o.write) {
    try {
      if (lstatSync(abs).isSymbolicLink()) return null;
    } catch {
      /* does not exist yet */
    }
  }
  const real = realpathNearest(abs);
  if (!real) return null;
  for (const r of lexRoots) {
    const rr = realpathNearest(r);
    if (rr && under(real, rr)) return real;
  }
  return null;
}

/**
 * Write a file without following a symlink at the final component (O_NOFOLLOW),
 * creating parent dirs. Callers check containment with containedPath() first.
 */
export function writeFileNoFollow(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    const buf = Buffer.from(content, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}
