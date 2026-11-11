# Critical state and background jobs at release

For a stateful release, an exact active revision and a passing HTTP health check are necessary
but insufficient. Before cutover, identify the records, worker loops, queues, and external
flows that must keep working. Record a small current baseline and the safe observation method.
Use a risk-based matrix; do not invent a live transaction merely to create a test.

| Invariant | Baseline | Safe probe | Post-release evidence | Failure action |
| --- | --- | --- | --- | --- |
| Durable record remains accessible | Authoritative store and expected read surface | Existing record or synthetic item | Store and UI/API readback at active revision | Stop success claim; approved rollback/remedy |
| Enabled worker actually runs | Configuration and process/job identity | Startup log, heartbeat, or synthetic queued item | Running state and processed outcome | Stop success claim; approved rollback/remedy |
| Queue and external result complete | Pending/processed counts or job ID | Synthetic or authorized real flow | Durable result and recipient/user path | Stop success claim; preserve replay evidence |

For each row, say whether it uses synthetic data, observes existing real state, or was not
exercised. Capture environment, active revision, timestamp, evidence link, and any authority
needed for a non-safe probe. A database row with a missing or stale UI/API result is a failure;
record how the read surface was compared with the authoritative current value. An
enabled worker that never starts is a failure even if the web process reports ready.
If a critical check fails or cannot be observed, do not say the release is available. Follow
the project's approved rollback or remediation procedure, retain the first failure evidence,
and repeat invalidated checks against the new exact revision.

Use optional `release_invariants` in the task record. Mark it `not_applicable` with a reason
for a stateless change; an available release must include this declaration. For a stateful
release, set `required`, provide baseline and rollback
references, and list critical checks. `standard_workflow_record.py validate --require-final`
rejects unproven critical checks when the release is marked available. The validator can
check record consistency only; it cannot prove remote behavior without authoritative live
readback. Never place a live trade, send customer mail, or change production data just to
satisfy this matrix without the required exact authorization.

## Evaluation examples

- **Missing durable row:** store baseline says present, post-release UI/API says absent: fail.
- **Silent stopped poller:** configuration says enabled, runtime says stopped: fail even if health passes.
- **Enquiry cutover:** synthetic request, database readback, queue job, staff alert, and cleanup
  all succeed on the same revision: pass, while delivery to an uninspected mailbox remains unproven.

Before a merge that triggers deployment, apply [merge readiness](merge-deployment-readiness.md). Post-release caveats do not substitute for prerequisite readiness or verified safe inactivity.
