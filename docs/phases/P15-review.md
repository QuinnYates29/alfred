# P15 — Review, land, transcripts, workspace files

Status: **SPEC** · Branch: `p15-review` · Acceptance: `npx vitest run test/acceptance/p15/`
Scope (files you own): `src/review/**` (+ `test/unit/review*.test.ts`). Do NOT edit `src/main.ts`, `src/server/app.ts`, `src/modules.ts`,
`src/store.ts`, `src/runtime/agent.ts`, `test/acceptance/**`.

When a goal finishes, Quinn reviews what changed and lands it (or throws it away) from the Mac. He can also read what an agent
actually did (its transcript) and browse its workspace.

## 1. Module seam
`src/review/index.ts` exports `createReviewModule(deps: ModuleDeps): AlfredModule` → `{ name: 'review', router }`.
Split: `git.ts` (a small promisified `git(args, cwd?)` helper that rejects with the output tail), `changes.ts`, `land.ts`, `transcript.ts`, `files.ts`, `routes.ts`.
Uses `deps.store`, `deps.repoHub` (`barePath(name)`, `branches(name)`), `deps.nodes` (`backend(node)` for node workspaces), `deps.workRoot`.

## 2. Where a goal's code is (the facts the runtime records)
- `pushed` events `{branch, sha}` on the goal's tasks: finished work in the hub (P10). The latest event per branch wins.
- `workspace` events `{path, node, branch?}` on each task: where it ran.
- The goal's repo: `goal.meta.repo` is a registered repo name (`store.getRepo`), or a path that matches a registered repo's
  `paths` value. No repo → there are no hub branches (sandbox goals: browse files instead).
- Base branch: `repo.defaultBranch`, else the hub's HEAD (`git --git-dir <bare> symbolic-ref --short HEAD`) if that branch exists, else `main`, else `master`.

## 3. Routes
| Route | |
|---|---|
| `GET /goals/:id/changes` | id or slug → `{ repo: string\|null, base: string\|null, branches: [{branch, sha, taskId}], commits: [{sha, subject, author, date /* ISO */}], files: [{path, status /* A M D R */, additions, deletions}], diff: string, truncated: boolean }`. Commits/files/diff are for the **first** branch (or `?branch=`) against base using `base...branch`. The diff is capped at 200,000 chars (`truncated: true`). No repo or no pushed branch → `repo` as known, `branches: []`, the rest empty. 404 unknown goal. |
| `GET /goals/:id/changes?file=<path>` | → `{ file, diff }` for that one file (cap 1,000,000). |
| `POST /goals/:id/merge` | `{ branch?, into?, strategy?: 'merge' \| 'squash' = 'merge', message?, deleteBranch?: boolean = true, confirm: true }` — see §4 |
| `POST /goals/:id/discard` | `{ branch?, confirm: true }` — see §5 |
| `GET /tasks/:id/transcript` | → `[{ id, ts, kind, ...data }]`: the task's events of kinds `workspace, turn, tool, progress, transition, verify, pushed, push_failed, compacted, approval_requested, approval_decided`, ascending. 404 unknown task. |
| `GET /goals/:id/files?path=&task=` | list a workspace dir → `{ workspace, node, path, entries: [{name, dir}] }` sorted dirs first then by name |
| `GET /goals/:id/file?path=&task=` | → `{ workspace, node, path, content, size, truncated }` (cap 512,000 chars) |

Every mutating route needs `confirm: true` (400 otherwise). Git failures → 500 `{error}` with the git output tail, except the cases below.

## 4. Merge (land a goal's branch in the hub)
- Branch: `branch` or the goal's first pushed branch; none → 409 `{error:'nothing to merge'}`. `into` default = base (§2).
- Work in a temp clone of the bare repo (`git clone -q <bare> <tmp>`; always removed afterwards): `checkout <into>`, then
  - merge: `git merge --no-ff -m <message> origin/<branch>`;
  - squash: `git merge --squash origin/<branch>` then `git commit -m <message>`.
  Commit identity: `-c user.name=alfred -c user.email=alfred@localhost`. Default message: `Merge <branch>: <goal title>`.
- Conflicts → `git merge --abort` (squash: `git reset --hard`), **409** `{ error: 'merge conflict', conflicts: [paths] }` (from `git diff --name-only --diff-filter=U` before aborting). Nothing is pushed.
- Success → `git push origin <into>`; if `deleteBranch`, `git push origin --delete <branch>`.
- If the repo has a Spark checkout (`repo.paths.local`) that is clean (`git status --porcelain` empty) and currently on `<into>`, fast-forward it:
  `git -C <local> fetch <bare> <into>` + `git -C <local> merge --ff-only FETCH_HEAD`. Failures here are reported, not fatal.
- Event `goal_merged {branch, into, sha, strategy}` on the goal. → 200 `{ ok: true, into, sha /* new tip of into */, localUpdated: boolean }`.

## 5. Discard
Deletes the goal's pushed branch(es) from the hub (`git --git-dir <bare> branch -D <branch>`; only `branch` if given), and removes
local workspaces of the goal's tasks: a path inside `deps.workRoot` → `rm -rf`; a path containing `/.alfred-worktrees/` on the local
machine → `git -C <repo checkout> worktree remove --force <path>` (repo checkout = the path before `/.alfred-worktrees/`). Node workspaces are left alone
(listed in `kept`). Event `goal_discarded {branches}`. → `{ ok: true, branches: string[], removed: string[], kept: string[] }`.

## 6. Workspace files
The workspace is the latest `workspace` event of `?task=` (default: the goal's root task, i.e. the first task without a parent).
None → 404 `{error:'no workspace yet'}`. `path` is relative to the workspace (default `.`); resolve it and refuse anything outside
(400). Local (`node === 'local'`) → `node:fs`; otherwise `deps.nodes.backend(node)` (`listDir`, `readFile`). A `NodeOfflineError`
(from `src/runtime/contract.ts`) → **503** `{ error: 'node <name> offline' }`.

## Done when
`npx vitest run test/acceptance/p15/` passes; earlier suites + `npx tsc --noEmit` stay green.
