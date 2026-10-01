# P10 — Git hub on the Spark + workspace modes

Status: **SPEC** · Branch: `p10-git` · Acceptance: `npx vitest run test/acceptance/p10`
Depends on: P2a (workspaces), P3b (approvals/guards), P9 (nodes). Core functionality: control-side UX is refined later, so everything here is API/CLI-first.

## Why
Workspaces live on two machines (the Spark and the Mac). Their git must be **connected**, so work done on one is fetchable from the other,
and nothing depends on GitHub. The Spark hosts the hub. Quinn also needs both **dedicated sandbox locations** and **existing repos anywhere** (Mac or Spark),
chosen per goal.

## 1. Repo hub (`src/git/hub.ts`)
```ts
export class RepoHub {
  constructor(o: { root: string /* ~/.alfred/git */; sshUser?: string /* $USER */; sshHost?: string /* 'gx10-de9a' */;
    urlForNode?: (node: string, barePath: string) => string /* test hook; default ssh://<user>@<host><barePath> */ })
  barePath(name: string): string                       // <root>/<name>.git
  ensure(name: string, source?: string): Promise<string> // create the bare repo if missing; if `source` (a local path) is given, push all its branches + tags into it. Idempotent.
  urlFor(name: string, node: string): string           // 'local' → the absolute bare path; any node → urlForNode(node, barePath)
  branches(name: string): Promise<string[]>
}
```
Pushes to the hub are Alfred-internal: `guardCommand` must **not** flag `git push spark …` (the remote named `spark`). Every other remote stays guarded.

## 2. Repo registry (store)
`repos` table + `store.upsertRepo({name, paths: Record<string /* 'local' | node */, string /* abs path on that machine */>, defaultBranch?})`,
`getRepo(name)`, `listRepos()`. A repo can exist on the Spark, the Mac, or both. `alfred_create_goal`, the HTTP API and the CLI accept `repo` as a
**registered name or an absolute path** (a path is auto-registered under its basename, with the machine given by `where`).

## 3. Workspace modes (goal meta)
```ts
goal.meta = {
  repo?: string,            // registered name or absolute path
  where?: 'local' | string, // machine that holds the workspace ('local' = Spark, or a node name like 'macbook'); default 'local'
  mode?: 'sandbox' | 'repo',// default: 'sandbox' when repo is absent or only registered elsewhere; 'repo' when repo has a path on `where`
  inPlace?: boolean,        // repo mode only: work in the checkout itself on a new branch (refuses if dirty) instead of a worktree
}
```
`resolveWorkspace(store, task, {root, nodes, hub, sandboxRoots})` returns `{backend, path, branch, remote}`:
| mode | where | workspace |
|---|---|---|
| sandbox, no repo | any | empty dir `<sandboxRoot>/<goal-slug>/` (Spark: `~/.alfred/work`; a node: the `sandbox` path it advertised in `hello`, default `~/alfred-sandbox`) |
| sandbox + repo | any | **a clone of the hub** at `<sandboxRoot>/<goal-slug>/<id8>`. `hub.ensure(name, <repo path on the Spark if registered there>)` first. Branch `alfred/<slug>/<id8>`, remote `spark` = `hub.urlFor(name, where)` |
| repo | any | a worktree `<repoPath>/.alfred-worktrees/<id8>` on branch `alfred/<slug>/<id8>` (or the checkout itself if `inPlace`). The repo gets a remote `spark` → the hub (added if missing, never renaming others); `hub.ensure(name)` |
In every mode with a repo, the workspace ends up with **remote `spark` pointing at the Spark hub** and the task branch's upstream set to `spark/<branch>`.
All git on a node runs through `backend.exec` (the node needs SSH access to the Spark; README documents `ssh-copy-id quinna@gx10-de9a` from the Mac).
The existing P2a behavior (`workspaceFor` with no hub → a local worktree) stays for compatibility.

## 4. Publishing work
- Commits use `-c user.name=Alfred -c user.email=alfred@<hostname>` unless the repo/global config already has an identity.
- The node `hello` gains `sandbox?: string` (default `~/alfred-sandbox`), and `connectNode` gains a `sandbox` option. The sandbox dir must be inside the node's roots.
- `RunOpts` gains `hub?: RepoHub`. When present (with `workRoot`), the runtime resolves via `resolveWorkspace` and publishes as below.
- After a task reaches `done` (and on every `finish` attempt), the runtime runs `git add -A && git commit -m "<task title> (alfred)" --allow-empty-message` if dirty, then
  `git push spark HEAD:<branch>` in the workspace. This is best-effort: event `pushed` `{branch, sha}` or `push_failed` `{error}` (never fails the task).
- `alfred repo add <name> --path [<where>:]<abs>`, `alfred repo ls`, `alfred repo fetch <name>` (prints the branches in the hub). API: `GET/POST /api/repos`.

## ALF-7 addendum (2026-10-01): retries continue
The workspace key (`<id8>` in `<slug>/<id8>` and `alfred/<slug>/<id8>`) is `workspaceKey(store, task)`: the root task's id,
except that a later root task of the same goal (a retry) reuses the latest earlier root's key (from its `workspace` event).
So a retry works in the same workspace on the same branch; if that workspace is gone, `setupClone` checks out `spark/<branch>`
(the attempt's pushed work) instead of the base, and repo-mode worktrees re-attach an existing branch.
`pushedBranches` is most-recently-pushed first, so every default (Changes, merge, deploy, peer review) is the latest attempt.

## Done when
`npx vitest run test/acceptance/p10` + all earlier suites + typecheck are green on `p10-git`.
