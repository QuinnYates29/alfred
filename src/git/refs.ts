// Branch/ref names from API input: `git check-ref-format --branch` rules, checked in-process,
// plus no leading '-' (so a name can never be read as a git option).

/** True when `name` is a usable branch name (short form, e.g. `alfred/abc123`). */
export function validBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (name.startsWith('-') || name === '@' || name === 'HEAD') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  for (const part of name.split('/')) {
    if (!part || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

/** Throws (message says which field) unless `name` is absent or a valid branch name. */
export function assertBranch(name: unknown, what = 'branch'): void {
  if (name === undefined || name === null) return;
  if (!validBranchName(name)) throw Object.assign(new Error(`invalid ${what} name: ${String(name).slice(0, 100)}`), { status: 400 });
}

export const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
