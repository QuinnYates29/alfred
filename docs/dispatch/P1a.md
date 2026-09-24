You are a senior TypeScript engineer implementing part of the `alfred` agent platform in the current directory (a git worktree; Node 22, ESM, `"type":"module"`, imports use `.js` suffixes, vitest for tests).

Read first: CLAUDE.md, docs/phases/P1-agent-runtime.md (sections tokens.ts, tools.ts, personas.ts), src/runtime/contract.ts, src/types.ts.

YOUR SCOPE (only these files):
- src/runtime/tokens.ts
- src/runtime/tools.ts  (ToolRegistry + builtinTools)
- src/runtime/personas.ts  (promptCost + loadPersonas, use the `yaml` npm package, already installed)
- personas/alfred.yaml, personas/coder.yaml, personas/researcher.yaml, personas/coder-lg.yaml

Contract tests you must make pass (DO NOT edit anything under test/acceptance/ or src/runtime/contract.ts, src/runtime/testing.ts, src/types.ts):
  npx vitest run test/acceptance/p1/tools.test.ts test/acceptance/p1/personas.test.ts

Key requirements:
- Paths resolve against ctx.workspace with path.resolve; anything not inside the workspace → {ok:false, output:'path outside workspace: <path>'}. Tools never throw.
- run_shell: spawn('bash', ['-c', cmd], {cwd: workspace, detached: true}); on timeout kill the whole process group with process.kill(-child.pid, 'SIGKILL'). Output = combined stdout+stderr tail (last 8000 chars, leaving room for the suffix) followed by a line `exit=<code>`. ok = exit code 0.
- Control tools (finish, give_up, ask_claude, spawn_subagent, wait_subtasks) have kind 'control' and run() returns {ok:true, output:''}.
- Tool descriptions: one short sentence each. Keep schemas minimal — every persona's promptCost must stay under its promptBudgetTokens (≤ 6000).
- Persona YAML fields: name, description, system, tools (list), promptBudgetTokens, canSpawn (list), optional maxTokensPerTurn. alfred.canSpawn = [coder, researcher, coder-lg]; others canSpawn = [] and do not list spawn_subagent/wait_subtasks. Each system prompt (keep it under ~250 words) must mention: call `finish` only when acceptance checks should pass; `give_up` with a concrete reason if impossible; `ask_claude` if stuck on something hard; never claim success in plain text.

Work method: write the code, run the test command, read failures, fix, repeat until green. Then also run `npx tsc --noEmit -p . 2>&1 | grep -E 'src/runtime/(tokens|tools|personas)'` and fix any type errors in YOUR files. When finished, reply with a short summary of what you built and the final test result.
