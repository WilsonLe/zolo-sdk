# Active release readback

Answer “is it available?” for a named surface: local demo, staging, production,
store processing, or public URL. If the target is ambiguous and project context
does not resolve it, ask once. A PR, passing CI, merge, saved configuration,
Preview deployment, and active runtime are separate observations.

Read current authoritative state in this order when applicable:

1. PR state and merged revision from the host, not a cached plan.
2. Build artifact digest and deployment/job identity from the release system.
3. Active process or deployment revision, start mode, configuration identity,
   target URL, and observed time from the actual runtime.
4. Live health and relevant functional outcomes on that surface. Public availability
   additionally needs a public reachability check. Authenticated behavior needs
   an authenticated test when it is the claim.

For a stateful release, also apply [critical release invariants](critical-release-invariants.md)
to durable data, background workers, queues, and external outcomes affected by the change.
One visible flow does not prove an enabled worker started or a pre-existing record survived.

For overall rollout success, reconcile each target's readback with the
[post-merge verification inventory](impact-inventory.md#deployment-blast-radius). A
surface-level availability result covers only that surface. Report overall verification
complete only when every included system has current health and functional proof.

After merge, deploy, or restart, compare the intended merged revision with the
active revision. A server still running an old commit or dev mode is not the
requested production-built result. Follow the authorized restart or deployment
path and re-read state. A saved browser tab is not proof that a process is live.
For long-running local services, retain the process/session handle and poll that
confirmed handle on resume. A timed-out observation does not authorize a second
server. When a handle is missing or terminal, inspect listener and deployment
state before starting a replacement.

Use optional `release_readback` in the task record to make the status concise.
Retain merged revision, artifact digest, deployment ID, and configuration
identity when the relevant system exposes them; leave unavailable fields empty
and say they were not verified.
Its `available` state requires a matching active revision, expected mode where
specified, live health, user-flow proof, and public reachability for a public
target. The validator checks the supplied readback for internal consistency.
Reconcile full blast-radius coverage in the release evidence. Keep live evidence
references and timestamps, and recheck transient state before repeating an availability claim.
If `release_invariants` is required, a critical check that failed, is blocked, or remains
unobserved prevents an availability claim even when HTTP health and the visible flow pass.

## Synthetic state checks

| Observed state | Accurate answer |
| --- | --- |
| PR open | Reviewable in PR; not deployed |
| Merged, deployment absent | Merged; target runtime not verified |
| Deployment complete, old process revision | Deployed job completed; active server is stale |
| Latest commit in dev mode, production build requested | Local service is running; requested build mode not verified |
| Staging health and flow pass | Available on staging only |
| Production health and flow pass, public URL reachable | Available publicly at the verified revision and URL |
