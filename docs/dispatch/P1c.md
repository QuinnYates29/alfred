You are a senior TypeScript engineer implementing the core agent loop of the `alfred` platform in the current directory (git worktree; Node 22, ESM, `.js` import suffixes, vitest).

Read first: CLAUDE.md, docs/phases/P1-agent-runtime.md (sections agent.ts and scheduler.ts are YOUR scope; read the whole doc), src/runtime/contract.ts, src/runtime/testing.ts, src/types.ts, src/store.ts (API only), src/gate.ts, src/runtime/tools.ts, src/runtime/personas.ts, src/runtime/openai.ts (limitLLM). Reference for ideas (read-only): /home/quinna/repos/ai-task-dashboard/server/src/agentloop.ts.

YOUR SCOPE: src/runtime/agent.ts (runTask, RunOpts) and src/runtime/scheduler.ts (Scheduler). Do not modify other src files unless a tiny fix is unavoidable; never edit test/acceptance/**, contract.ts, testing.ts, types.ts.

Contract test: npx vitest run test/acceptance/p1/agent.test.ts
Everything else must stay green: npx vitest run test/acceptance/p0/ test/acceptance/p1/ test/unit

Implementation notes:
- Keep a message array: first user message built from the task (title, spec, acceptance `name: cmd` lines, and `## Notes from previous attempts` + notes when notes are non-empty). Append assistant messages (with toolCalls) and one `role:'tool'` message per call (toolCallId, name, content = result.output).
- Budget/abort checks happen BEFORE each LLM call; precedence: signal aborted → 'cancelled'; turns; tokens; wall clock.
- Stall watchdog: track lastEventAt (update it whenever you append any event for this task, including `progress` from ctx.progress). Use a setInterval (e.g. every min(1000, stallMs/3) ms) that aborts the current per-call AbortController when Date.now()-lastEventAt >= stallMs, and remember WHY it aborted so you can transition to stopped with a reason containing 'stall'. Clear the interval in finally.
- Acceptance checks without cwd run in the workspace: wrap the runner: (c) => (o.runner ?? defaultRunner)({ ...c, cwd: c.cwd ?? workspace }).
- After a failed finish the gate puts the task back to 'running' and clears the lease: re-establish ownership (e.g. the store may let you heartbeat only when leased; if heartbeat fails, you still own it logically — just keep going; tests observe status only). Make sure later transitions from 'running' still work.
- Default spawnRunner: start runTask(childId, {...o, workerId: `${o.workerId}/${childId.slice(0,8)}`}) without awaiting, catching errors. wait_subtasks polls store.children every pollMs until all are TERMINAL or PARKED.
- Unknown/unallowed tool → tool message 'unknown tool: X' (ok:false). Repeated-error detection keys on `${name}:${output}` for consecutive failing calls.
- Scheduler: setInterval(pollMs) loop: reclaimExpired(); while running < maxWorkers and claimNext(...) returns a task → start runTask with an AbortController per task (spawnRunner no-op). stop(): clear interval, abort all, await all promises. running(): ids. The agent must handle a task that is already 'running' and leased to its workerId (the scheduler claimed it).

Work method: implement, run the contract test, read failures carefully, fix, repeat. Reply with a short summary and the final test output line.
