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

## 4a. Merges can't be lost, and say whether they're live (ALF-7)
- The hub's checkout → hub sync (`RepoHub.ensure`) only fast-forwards; it used to force `+refs/heads/*`, which wound the
  hub's master back to the checkout's and erased a merge only the hub had (the graph-view merge, 2026-10-01).
- Changes, merge, revert and deploy pins first bring the hub's base up to the live checkout (`syncBaseFromLocal`,
  fast-forward only), so merges are built on what is running.
- Merge copies the goal branch into the live checkout's repo before the hub branch may be deleted; when the checkout can't
  take the merge, the merge commit is kept there as `merged/<goal slug>`. The response (and `goal_merged`) carries
  `localUpdated` and `localNote` (why not); the dialog shows it instead of closing.
- **Merge & update** (goals on alfred; `POST /goals/:id/deploy {confirm, strategy?, deleteBranch?, sha?, baseSha?}`, powers
  module): merge exactly what was shown → live checkout → build-web → Mac app (app/, src/node, src/cli) → restart
  (src/, personas/, config/), each step reported. Quinn's click is the approval.

## 4b. Revert (ALF-7)
`POST /goals/:id/revert { sha?, confirm: true }` undoes a landed merge: `sha` (default: the latest `goal_merged` without a
`goal_reverted`) is reverted on the branch it landed on, in a temp clone (`git revert --no-edit`, `-m 1` for merge commits),
then landed like a merge (fetch + compare-and-swap of the base ref) and the clean Spark checkout fast-forwarded.
History is kept, so a revert can itself be reverted. Nothing landed / already reverted / not on the base → 409; conflicts → 409
`{error:'revert conflict', conflicts}`, nothing changes. Event `goal_reverted {into, sha, reverted}` →
`{ ok: true, into, sha, reverted, files /* paths the revert changed */, localUpdated }`.
`GET /goals/:id/changes` also returns `landed: {sha, into} | null` (what a revert would undo); the Changes tab shows **Roll back**.

## 4c. Peer review (ALF-7, `src/review/peer.ts`)
`POST /goals/:id/peer-review {confirm:true}` → 202 (409 without a repo/pushed branch); also automatic on `goal_status: done` for
goals with `meta.peerReview: true`. Clones the hub at the branch head into `<workRoot>/.peer-review/` (removed after), links
alfred's deps for a goal on `alfred`, and runs the LangGraph sidecar in `mode: "review"` (`sidecar/langgraph_coder/review.py`):
checks → each changed file in order (read-only tools, temperature 0, JSON rubric, ≤ 8 steps; an unusable answer is a `major`
finding) → one scope question. The verdict is code (`verdictOf`): `error` if it didn't run; `needs_human` if any file matches
`GUARDRAIL_RE`; `changes_requested` on failing checks or any blocker/major; else `approve`. Events `peer_review_started`,
`peer_review {sha, branch, base, verdict, checksOk, findings, reviewed, error?}`; output **Peer review** (markdown).
`/changes` returns the latest as `peerReview`, and `peerReviewRunning: {sha, step, since} | null` (also on `GET /goals/:id`)
from the in-process review, with its steps as `peer_review_progress` events — the goal header and Changes tab show it live. `alfred_dev deploy` of an opted-in goal requires an `approve` of the exact commit.

## 4c+. The decision layer around the review (ALF-7)
The review is `decide-risk → [LangGraph: checks → files → scope] → decide-done`, both decisions on `/v1/decision` (the jev
module's client, uses `review-gate` / `review-done`):
- **First** (`gateDecision`): P(issues) for the spec + diff against the rules (scope, tests, secrets, destructive ops, safety
  rails, obvious defects; "yes when in doubt"). The line-by-line review (files + scope) is skipped only when
  P(issues) < `SKIP_REVIEW_BELOW` (0.1); no answer, a diff over 24k chars or a safety rail → full review. Checks always run.
- **Last** (`finalDecision`): P(done), P(safe) from the spec, check + UI results and findings ("no usable verdict" findings
  are the reviewer's failures, not the change's). With passing checks/UI test and no safety rail, both ≥ `DONE_AT` (0.8) =
  approve, else changes requested. Unavailable → the verdict from the findings.
- An approve from the last decision marks the goal `done` (`setGoalStatus`, by `coder-lg review`) even if its own gate failed,
  and every finished review notifies Quinn (Slack + Mac). `PATCH /goals/:id {status, reason?}` (the "set status…" control on
  the goal page) overrides a goal's status any time; it stands until one of its tasks changes. The done → review trigger
  ignores statuses someone set (`by`).

## 4d. Transcript fix (ALF-7)
`transcriptFor` read `store.allEvents()` — the first 500 events ever recorded — so every task after those had an empty
transcript. It reads the task's goal events (`store.events(goalId)`). The tab opens on the latest root task (the latest attempt).

## 4e. Transcript, readable (ALF-7)
`turn` events carry `thinking` (the adapter splits `<think>` blocks, a leading "…</think>" the chat template opened, and
llama-server's `reasoning_content` out of the answer — it used to leak into the text) and `text` (the answer, ≤ 8000).
`tool` events carry `args` (≤ 4000) next to `output` (≤ 8000). The tab renders each turn as a collapsed **Thinking** and a
**Response** (open unless long), and each tool call as one block: ✓/✗, name, gist (command / path) → first output line;
expanded, **in** (shell commands as `$ cmd`, file writes as path + content, else JSON) and **out**. Older tool events
without `args` take theirs from the turn's calls (matched by name).
A goal is `active` while coder-lg reviews it (`store.setGoalActive`), then re-derived from its tasks
(`rollupGoalStatus`, reason `peer review finished` — which the done → review trigger ignores). Boot repairs goals a
restart left `active` with only finished tasks.

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
