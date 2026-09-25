# P12 — Runtime hardening (from the P6 soak)

Status: **SPEC** · Branch: `p12-hardening` · Acceptance: `npx vitest run test/acceptance/p12/` (+ all other suites stay green)

Soak S1 (2026-09-25, docs/SOAK.md) showed three reliability bugs in `src/runtime/agent.ts`:
1. **Lease expiry during a long model call.** Heartbeats only happen between turns. One 5-minute LLM call outlived the 5-minute lease; the scheduler reclaimed the task and started a second run.
   **Fix:** a heartbeat timer for the whole life of a run (every `min(leaseMs/3, 60 s)`), cleared on every exit path.
2. **Zombie runs.** The first run never noticed it had lost the task and later transitioned it. **Fix:** a run owns a task only while
   `store.getTask(id)` has `leaseOwner === workerId` and the same `attempt` it claimed (or it is `verifying` right after its own finish). Check ownership
   (a) before every LLM call, (b) before every transition/appendNote the run makes, (c) whenever a heartbeat returns false. On lost ownership: stop
   immediately, abort in-flight work, make **no** further writes to that task, and resolve with the current task row. Emit nothing else for it.
   Note the gate path: after a failed `finish` the gate returns the task to `running` and clears the lease, so the run must re-claim it (e.g. a store
   method `reacquire(taskId, workerId, attempt, leaseMs)` that sets the lease only if status is `running` and there is no live lease by someone else).
3. **Timers outliving the run.** Every interval/timeout (stall watchdog, heartbeat, wall clock) is cleared in a `finally` on every exit path, including park, give_up and lost ownership.
Keep the `doWait` child-liveness mirroring already in agent.ts.

## P12b — shutdown requeues (soak finding: a service restart cancelled S2's running task forever)
- `Scheduler.stop(o?: { requeue?: boolean })`. With `requeue: true`, every running task is aborted and handed back: `appendNote("service stopped/restarted: resuming …")`,
  then transition `running → queued` (reason `service restart`), lease cleared, **not** stopped. The run must not write anything else afterwards (P12 ownership rules).
  Without the option (tests, explicit cancels) it keeps today's `stopped: cancelled` behavior.
- `startAlfred(...).stop()` uses `requeue: true`. `alfred serve` installs SIGTERM/SIGINT handlers that call `stop()` and then exit 0 (systemd sends SIGTERM on restart).
- An explicit `POST /api/v1/tasks/:id/stop` still ends the task `stopped`.
