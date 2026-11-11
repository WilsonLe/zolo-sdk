# Verification, deployment, and cleanup rules

## Direct cleanup and active consumers

Apply this preflight to direct cleanup requests and cleanup within a delivery cycle,
before stopping processes, deleting devices, or reclaiming files. A request such as
“stop all simulators and remove them” grants the requested scope; first establish its
current impact. Git worktree isolation does not isolate host simulators or build state.

1. Resolve the exact target inventory, ownership and recovery consequences. Expand “all”
   into named targets rather than using a host-wide command against an unseen inventory.
2. Inspect current consumers through available task/status controls and live process/runtime
   inventory. Include tests, release/signing/upload runs, previews and other chats using
   those targets. Match exact device IDs, paths and process identities/start times; a
   shutdown device or an archived chat is not proof that its resource is unused. Keep
   private task details out of public evidence. When task history is unavailable, use
   supported live observations to resolve consumers; unresolved use remains unknown.
3. Separate inactive disposable targets from targets in use or of unknown use. Proceed
   with independently safe authorized targets. For an active consumer, report the concrete
   interruption and lost state, then coordinate completion or graceful stopping through
   supported controls under existing authority. If interruption is necessary, use an
   explicit decision covering that target, affected consumers and consequences. Reuse an
   existing decision that already covers these facts; a generic deletion request alone
   does not establish informed interruption. Unknown use blocks the affected deletion.
4. Preserve required partial results/checkpoints, stop only resolved authorized consumers,
   confirm their exit, and refresh the target inventory immediately before deletion.
   Changed consumers, recreated devices, reused PIDs/paths or resumed work invalidate the
   previous observation. Reconcile again after interruption/resume; do not restart another
   chat's stopped work without its applicable authority.
5. Run the applicable exact-target cleanup below and verify removed targets, retained
   consumers/resources and outstanding blockers. An authorized interruption stays an
   interruption, not a passing test or completed release.

For new structured cleanup records, keep this observation in the existing resource's
`cleanup.coordination` under the [record contract](workflow-record-model.md#cleanup-coordination).
Without a structured task, retain a compact target/consumer/disposition note in existing
private task evidence. No host-wide registry, scheduler or new cleanup service is needed.

## Verification quality

- During development and draft-PR handoff, use only repository-supported focused tests for
  changed behavior and affected consumers, plus relevant static and generated-artifact checks.
  Report selection and deferred full-suite coverage. Run the full suite/local CI only at an
  authorized merge stage; fix failures and rerun the full suite before merging.
- Tests must be capable of failing when behavior is broken. Do not accept assertions that merely
  execute code without proving outcomes.
- Cover happy paths, relevant boundaries, invalid inputs, permissions, failure recovery,
  concurrency, and regressions in proportion to risk.
- For web work, verify the rendered behavior at the real local origin. Include responsive,
  accessibility, console/network, and visual checks when relevant.
  Follow [browser selection](../../agentic-workflows/references/browser-selection.md)
  for local and staging browser checks on the current host.
- Match evidence to the request. A passing API test does not prove a visual change, and a
  screenshot does not prove data integrity.
- Record skipped or inapplicable checks with reasons. Never silently convert a required failure
  into a pass.
- Follow the repository-derived prerequisite ladder. Preserve first-failure evidence and diagnose
  product, harness, fixture, environment, platform, external, expected, nondeterministic, or unknown
  causes before applying a remedy.
- Record the exact verification channel for each claim. Partial or diagnostic evidence cannot
  satisfy a required claim.
- Distinguish rehearsal evidence from final evidence and bind final artifacts to the committed
  clean source and applicable immutable artifact identities.

## Post-merge deployment verification

Before merge, use the [impact inventory](impact-inventory.md#deployment-blast-radius) to plan
coverage for each target. Keep the inventory and results in the existing issue, plan, or release
evidence. Follow the project's release runbook and confirm the authorized probes and recovery path.

1. Read back the merge and the existing deployment run before starting or retrying any operation.
   Wait for rollout readiness within the project's runbook limits. Follow
   [release readback](release-readback.md) to bind the merged revision to the active target and
   expected artifact, configuration, and mode where applicable. Repeat the identity check if the
   target changes during verification.
2. Reconcile the inventory with the merged diff and actual target topology. For every included
   system, capture both a current **health signal** and a **functional result** with its expected
   outcome, observed result, target, time, and evidence reference. Use the actual target's endpoints,
   integrations, logs, and telemetry, and observe any stability window required by the runbook.
   Repeat the safe planned target checks, including applicable critical user journeys and visual
   checks. If a planned check cannot run safely, record the gap and any approved equivalent under
   the [verification-channel contract](verification-evidence-and-release.md#verification-channel-contract).
   A shared journey covers several systems only when its evidence shows each system's contribution
   and expected outcome. An affected dependency that kept its own version needs health and
   compatibility evidence on the live path.
3. Apply [critical release invariants](critical-release-invariants.md) to affected data, jobs,
   queues, and external effects. Prefer read-only observations and use synthetic data only with
   the required authority and isolation. Keep test data identifiable and removable, and clean it up
   through the authorized target procedure. Record partial evidence as such. Mark checks passed,
   failed, blocked, or unobserved, and give a reason for any exclusion. Verify rollback readiness
   and revalidate the evidence against the active release before claiming success.
4. If any required result is missing or failing, keep release verification incomplete. Retain the
   first failure, diagnose it, and follow the authorized remediation or rollback path. On resume,
   re-read the active target and repeat failed or invalidated checks. Report a recovered rollback
   separately from a successful release of the intended change.

## Exhaustive but safe worktree cleanup

Cleanup begins only after the PR is merged, the canonical checkout has fast-forwarded successfully,
and any evidence that must survive has been attached or moved to a durable approved location.
This timing governs removal of feature worktrees and merged branches. Direct operational
cleanup follows the preflight above without manufacturing a PR or merge prerequisite.

1. Resolve the exact feature worktree path, branch, Compose project, containers, networks, volumes,
   temporary files, and evidence targets. Never use broad globs or unresolved variables.
   Reconcile active consumers under the preflight above even when deletion is explicitly requested.
2. Confirm the feature worktree has no uncommitted or untracked user work. If it does, stop and
   report it rather than forcing removal.
3. Stop the feature stack with the repository's documented Compose command and unique project name.
   Remove feature containers, orphans, and feature-only networks.
4. Remove feature-only anonymous and named volumes only when they are confirmed disposable and do
   not contain evidence or data the user asked to preserve. Never prune Docker globally.
5. Remove feature-specific temporary runtime files and generated secrets only when their ownership
   and recoverability are clear. Do not delete shared caches or credentials.
6. Remove the exact Git worktree through Git, then prune stale worktree metadata.
7. Delete the exact merged local feature branch. Delete the remote feature branch when the merge
   operation did not already do so and repository policy permits it.
8. Remove only task-created temporary directories outside the worktree. Never recursively clean a
   repository root, home directory, parent worktree directory, or shared Docker namespace.
9. Verify the worktree no longer appears, the branch is merged and absent as intended, feature
   ports are free, feature containers/networks/approved volumes are gone, the canonical checkout is
   clean apart from pre-existing unrelated files, and its HEAD matches the merged revision.
10. Report what was removed, what was deliberately preserved, and whether any retained artifact
    still needs manual cleanup.

Shared caches, host-wide resources, unrelated processes, and external infrastructure remain outside
cleanup authority unless the user separately approves exact targets after impact and recoverability
are known. Interrupted-run cleanup follows the same ownership boundary.

Cleanup is independent of staging: staging deploys from the merged canonical revision or CI, not
from the removed feature worktree.
