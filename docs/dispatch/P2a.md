You are a senior TypeScript engineer working on the `alfred` agent platform in the current directory (a git worktree; Node 22, ESM, imports use `.js` suffixes, vitest). Read CLAUDE.md, docs/phases/P2-executors.md, docs/recon/executors.md, src/types.ts, src/runtime/contract.ts first. NEVER edit test/acceptance/**, src/types.ts semantics, src/runtime/contract.ts or src/runtime/testing.ts. Work method: implement, run the test command, read failures, fix, repeat until green. Reply with a short summary and the final test output line.

YOUR SCOPE: section "0. Store + workspace additions" of the phase doc.
- src/store.ts: add Goal.meta (JSON column, default {}), createGoal accepts meta, new method setGoalMeta(goalId, patch) (shallow merge). Add `meta: Record<string, any>` to the Goal interface in src/types.ts (that addition IS allowed).
- src/workspace.ts: workspaceFor(store, task, {root}) exactly as specified. Use child_process.execFileSync('git', [...]) with cwd = the repo. Worktree: `git -C <repo> worktree add -b <branch> <path> HEAD`; if the path already exists, return it.
Test command: npx vitest run test/acceptance/p2/workspace.test.ts test/acceptance/p0 test/unit
