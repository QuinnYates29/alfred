// U1 — build metadata for the self-updating Mac app: app/build.json (bundled in Alfred.app, so the running
// app knows what it is) and app/dist/latest.json (served by the Spark at GET /api/v1/app/latest).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Monotonic build id: UTC yyyymmddHHMMSS. */
export function buildId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `git rev-parse --short HEAD` (+ `-dirty` when the tree has changes); 'unknown' outside git. */
export function gitCommit(root, run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    const sha = run(['rev-parse', '--short', 'HEAD']).trim();
    let dirty = false;
    try {
      dirty = run(['status', '--porcelain']).trim() !== '';
    } catch {
      /* treat as clean */
    }
    return sha ? `${sha}${dirty ? '-dirty' : ''}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** { version, build, commit, builtAt } — the part the app bundles. */
export function makeBuildInfo({ version, commit, now = new Date() }) {
  return { version: String(version), build: buildId(now), commit: String(commit), builtAt: now.toISOString() };
}

/** latest.json for a finished zip. */
export function makeLatest(info, zip) {
  return { version: info.version, build: info.build, sha256: sha256File(zip), size: statSync(zip).size, builtAt: info.builtAt, commit: info.commit };
}

/** Atomic write (the server may read it mid-build). */
export function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

export const LATEST = (dist) => join(dist, 'latest.json');
