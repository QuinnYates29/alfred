// Owner-only file writes for config that may hold secrets (mcp.json headers/env, alfred.local.yaml…)
// and their backups.
import { chmodSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** mkdir -p with 0700 for every directory created; the leaf is chmod'ed 0700 too. */
export function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours */
  }
}

/** Write `content` with mode 0600 (also tightening an existing file). */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync keeps an existing file's mode
}

/** Atomic variant: tmp (0600) + rename. */
export function writePrivateFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writePrivateFile(tmp, content);
  renameSync(tmp, path);
}

/**
 * Copy `src` to `backupDir/<rel>` with mode 0600; `backupDir` and every directory under it that
 * this creates are 0700.
 */
export function backupPrivate(src: string, backupDir: string, rel: string): string {
  const bak = join(backupDir, rel);
  mkdirPrivate(backupDir);
  const sub = relative(backupDir, dirname(bak));
  let cur = backupDir;
  for (const part of sub ? sub.split(sep) : []) {
    cur = join(cur, part);
    mkdirPrivate(cur);
  }
  copyFileSync(src, bak);
  chmodSync(bak, 0o600);
  return bak;
}
