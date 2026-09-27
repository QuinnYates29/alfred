// P14 §8 — the P10 repo registry, plus live branch lists.
import { existsSync } from 'node:fs';
import type { ModuleDeps } from '../modules.js';

export async function listReposWithBranches(deps: ModuleDeps) {
  const repos = deps.store.listRepos();
  const out = [];
  for (const r of repos) {
    let branches: string[] = [];
    try {
      branches = (await deps.repoHub.branches(r.name)) ?? [];
    } catch {
      branches = [];
    }
    out.push({ ...r, branches });
  }
  return out;
}

export async function createRepo(deps: ModuleDeps, body: any) {
  const name = String(body?.name ?? '');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw Object.assign(new Error('name must match ^[A-Za-z0-9._-]+$'), { status: 400 });
  }
  const paths = body?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw Object.assign(new Error('paths must be an object of machine → absolute path'), { status: 400 });
  }
  const repo = deps.store.upsertRepo({
    name,
    paths: Object.fromEntries(Object.entries(paths).map(([k, v]) => [String(k), String(v)])),
    defaultBranch: body?.defaultBranch ? String(body.defaultBranch) : null,
  });
  const local = repo.paths?.local;
  if (local && existsSync(local)) await deps.repoHub.ensure(name, local);
  return repo;
}
