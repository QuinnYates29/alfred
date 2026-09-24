# alfred — rules for implementers

- Read GOAL.md, PLAN.md and your phase doc in docs/phases/ first.
- `test/acceptance/**` is written by the orchestrator. **Never edit it to make it pass.** If you believe a test is wrong, stop and say so in your report.
- Add your own unit tests under `test/unit/`.
- Work on the branch named in your phase doc; commit when green. Do not push. Do not touch ~/mission-deck or other repos unless your phase doc says so.
- Keep persona prompts and tool schemas lean: context budget is a first-class constraint.
- Report honestly: if something isn't done, say what and why.
