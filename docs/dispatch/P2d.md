You are a senior Python engineer working in the current directory: a git worktree of the `orchestrator` repo (Python 3, package `pipeline/`, tests in `tests/`, run tests with `.venv/bin/pytest`). Always use `python3` / `.venv/bin/...`, never bare `python`. Never cd outside this directory.

Background: pipeline/SCOPE_LESSONS.md "Finding 2" — the scratch integration branch (executor.py `_integrate_chunk`) and the final merge into the real repo (merger.py `merge`) are independent and can disagree, so a later-wave chunk can pass its own verify against content the real repo never ends up with. The fix: after the final merge, run the configured verify command again in the REAL repo and fail the run if it fails.

Contract test (DO NOT EDIT): tests/test_post_merge_verify.py. Read it first.

Implement:
1. In pipeline/models.py: add `post_merge_verify: VerifyResult | None = None` field to `RunReport` (import VerifyResult appropriately; avoid circular imports — use a TYPE_CHECKING import / string annotation if needed) and a property `ok` = no failed outcomes AND (post_merge_verify is None or post_merge_verify.skipped or post_merge_verify.ok).
2. In pipeline/cli.py: `async def post_merge_verify(config: RunConfig, events) -> VerifyResult | None`: returns None if `config.verify.configured` is False; otherwise `await run_verify(config.verify, config.repo)`, emits event `post_merge_verify` with fields ok, skipped, exit_code, output_tail (last 500 chars), and returns the result.
3. In `run_pipeline` (cli.py): after `merge(...)` and before `run_end`, call post_merge_verify and put the result on the RunReport; include it in the `run_end` event (post_merge_ok). In `_print_report`, print a line for it. Make every CLI exit code that currently uses `0 if not report.failed else 1` use `0 if report.ok else 1` instead.
4. Also persist it: wherever state.json is written at the end of the run, include `"post_merge_verify": {"ok":..., "skipped":..., "exit_code":...}` if you can do so without restructuring (optional; don't break state tests).
5. Add a short note under Finding 2 in pipeline/SCOPE_LESSONS.md: "Mitigated: post-merge verify re-runs verify in the real repo (see cli.post_merge_verify)".

IMPORTANT: the shared .venv has `pipeline` installed in editable mode from ANOTHER checkout, so always run tests as `PYTHONPATH=. .venv/bin/pytest -q tests` or your changes will not be imported.

Verify: `PYTHONPATH=. .venv/bin/pytest -q tests` — ALL tests must pass (there were 439 passing before plus the new file). Reply with a short summary.
