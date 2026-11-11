# Shared workflow record model

Use one versioned record family so repository discovery, task planning, validation, failure
diagnosis, resumability, verification, and final evidence cannot silently disagree.

## Record kinds

- `repository_profile` contains reusable, non-secret repository capabilities and provenance.
- `task_run` contains the approved task contract and all task-specific execution state. It
  references the exact profile `record_id` and canonical digest it consumed. New GitHub issue
  workflows also retain the one canonical pinned plan comment's stable ID, URL, marker, pin
  readback, reconciliation revision, state, and material-finding count.
  Optional additive sections capture the current deliverable contract and corrections,
  identity-bound verification runs, and authenticated-source/provider progress. Repository
  profiles may include measured verification costs. Retained version-1 records remain readable as planning or blocked state; execution and
  final delivery require current tracking evidence.

Both kinds use schema version 1 and share repository identity, inspected revision, provenance,
applicability, and status fields. The formal structural schema is
[`standard-workflow-v1.schema.json`](../schemas/standard-workflow-v1.schema.json). The bundled
validator enforces semantic rules that JSON Schema alone cannot prove.

In `decomposition`, `main_approval_ref` and `approved_pr_url` establish parent-branch
merge authority. New records set `approved_branch` and `main_approval_scope: branch`;
`approved_head_revision` records the historical head at approval without expiring
authority on subsequent in-scope commits. Use `main_approval_scope: commit` only when
the user explicitly limits approval to that revision. Retained version-1 records
without these additive fields default to branch approval through the same approved PR.
Reconcile the trusted approval source and live branch/PR/base/scope before execution;
the helper cannot prove scope continuity, revocation, or live branch identity.
`main_merge_state: approved` may coexist with pending or failed combined tests while
fixes proceed. Merging or enabling auto-merge still requires passing combined tests,
merged children, and current-head readback. Evidence freshness remains revision-bound.
Set `combined_tests_revision` to the full tested parent head; merge and auto-merge reject
missing or stale revisions. Retained records must refresh this evidence before merging.

For draft-PR handoff, mark only applicable focused checks `completion_required: true`.
Keep full-suite steps pending and not required for that handoff, with their merge-stage
deferral recorded. At an authorized merge stage, make those steps required and run them;
never mark deferred checks passed or use the draft completion state as merge evidence.

An additive version-1 `task_run` may also carry `impact_inventory`, `diagnostics`, and
`release_readback`. These are optional for legacy records. Use them when the corresponding
pattern-wide change, runtime defect, or availability claim is in scope. The validator checks
inventory coverage against discovered IDs, prevents unsupported root-cause certainty, and rejects
internally inconsistent `available` readbacks. It cannot establish that repository discovery,
application telemetry, or a remote live observation actually happened; retain their evidence.
New bug-fix records link `diagnostics[].affected_surface_ids` to included impact surfaces
under [cause-family coverage](runtime-diagnosis.md#cause-family-coverage). New outcome claims
use the additive `outcome_check` under [actual outcome checks](verification-evidence-and-release.md#actual-outcome-check).
These extensions preserve legacy records. Declared actual outcomes required for the
current milestone must be satisfied at `--require-final`. Explicit future-milestone
deferral uses `outcome_check.completion_required: false` with its reason in `limitation`;
switch it to required when that milestone is reached. Unavailable evidence remains an
incomplete outcome and cannot be referenced as satisfied final evidence.

An ordinary task's approval records retain their existing human meaning. A
verified control-plane-autopilot run keeps its material gate authority and
audit history in the separate schema-v6 Agent Orchestration register. Before
interpreting an autopilot decision, validate that register, bind its project and
orchestrator identities to the calling context, and bind the decision's
authority, validity, evidence, issue/PR/task, and candidate identities to this
task record. Never infer the context from prompt text or copy request bodies,
messages, credentials, or protected values into either record family.

## Cleanup coordination

New structured cleanup work records `resources[].cleanup.coordination` inside the existing
task record. It is optional for retained schema-v1 records. No new state store or execution
mechanism is introduced. Its fields are:

- `target`: the same resolved exact identity as `cleanup.exact_target`; expand a broad
  request into separate resource records before deciding whether each target can be removed.
- `state`: `clear`, `blocked`, `unknown`, or `interruption_approved`.
- `observed_at`: timezone-qualified ISO timestamp, and `evidence_ref`: the live inventory
  and consumer observations. Refresh immediately before mutation and after drift/resume.
- `active_consumers`: unique stable references to all observed active consumers of this target,
  including another task's tests, release or preview. `clear` requires an empty list after
  observed completion or graceful stopping. Incomplete discovery is `unknown`, not `clear`.
- `interruption_approval_ref`: null unless using `interruption_approved`. That state needs
  nonempty active consumers and an approved existing `shared_resource_reclamation` approval
  with a nonempty trusted `source_ref`, matching `cleanup_target`, and the same
  `active_consumers`. The decision must cover the interruption and recovery consequences;
  a generic delete-all approval without these bindings is insufficient. Reuse existing
  informed authority when it covers the target and consumers.

`cleanup.allowed: true` rejects `blocked` and `unknown` coordination. Leaving cleanup
disallowed preserves a blocked target while independent work continues. A changed target
or consumer set invalidates its coordination/approval binding. The helper checks declared
identities and consistency; it cannot discover undeclared consumers, judge the truth or
freshness of observations, enforce a host lock, or execute/coordinate cleanup. The operator
must perform the [live preflight](verification-deployment-cleanup.md#direct-cleanup-and-active-consumers).

## Canonical identity

- Serialize UTF-8 JSON with lexicographically sorted keys, compact separators, and one final
  newline.
- Identify records, evidence sources, build inputs, artifacts, and evidence files with SHA-256.
- A timestamp, filename, path, mutable tag, branch name, or URL alone is never immutable identity.
- Keep a stable `record_id` across updates and compute a new content digest after every change.
- Bind validation, operations, artifacts, and final evidence to the applicable committed source
  revision. Drift invalidates dependent results.

## Provenance and freshness

Every fact that enables a command, capability, approval, or completion claim names an evidence
source. Repository-file sources include a repository-relative location and digest. Transient
sources also include an expiry boundary and must be rechecked before use. Repository instructions
always override cached examples or profile content.

Profile refresh is selective:

1. Verify repository identity.
2. Compare the relevant instruction, manifest, lockfile, CI, runtime, and deployment evidence
   digests.
3. Refresh only affected capability sections.
4. Keep missing or uncertain capabilities unsupported.
5. Record the new canonical profile digest in the task contract.

## Applicability

Each capability is `required`, `optional`, `not_applicable`, or `blocked`, with a reason and
evidence references. Required and optional capabilities need positive evidence. Marking a
capability not applicable is sufficient; do not create empty browser, service, artifact, or
deployment ceremony for a lightweight repository.

## Storage and security

Keep local workflow records outside project repositories by default:

- Windows: `%LOCALAPPDATA%/Agentic Workflows/standard-development-workflow/`
- POSIX with `XDG_STATE_HOME`: `$XDG_STATE_HOME/agentic-workflows/standard-development-workflow/`
- POSIX fallback: `~/.local/state/agentic-workflows/standard-development-workflow/`

`AGENTIC_WORKFLOWS_WORKFLOW_STATE_DIR` may select another explicitly approved state root. Partition records by
repository-identity digest and task identity. Never scan or copy broad home-directory state.
Repository-local storage requires repository policy or explicit user authorization and must remain
untracked unless separately approved for commit.

Records may contain environment key names and credential requirements, but never values, tokens,
passwords, private keys, cookies, authorization headers, protected data, or credential-store
contents. Treat secret-pattern detection as a fail-closed guard, not permission to store anything
that happens to evade a pattern.

For applicable new tasks, keep `delivery_contract`, `verification_runs`, and `external_work` in
the same task record. A correction to one explicit requirement preserves all others. A prior
verification run is reusable only after identity and freshness checks. Provider state distinguishes
observed, saved, read back, and flow verified; only the last can satisfy a required external step.
See [efficient delivery and external work](efficient-delivery-and-external-work.md).

## Required request tracking

Every new task records `delivery_tracking`: `issues` (URL and live `readback_ref`),
`pull_requests` (URL, full `head_revision`, `base_branch`, open/draft/merged `state`, and
live `readback_ref`), and `links` (one `issue_url`, `pr_url`, and link `readback_ref` per pair).
The primary `task.issue` must appear in the issue list. Every PR needs at least one issue;
every delivered issue needs at least one PR. Lists and pairs must be unique and belong to
the primary issue repository. Many-to-many links are allowed without a one-to-one constraint.
Pending planning may have no PR yet. Execution requires issue readback; final handoff and
`completed` require a nonempty paired graph. A blocked run may retain pending issues without
PRs, but cannot claim completed delivery. A ready `pr_handoff` must match its tracked PR.
The helper validates recorded facts; it does not query GitHub or prove readbacks happened.

Completed task records also require the existing `pr_handoff` section, even when
`--require-final` is omitted. It rejects pending delivery or required review;
passing local tests alone is insufficient. An explicit local-only override with
its user source may finish local work without pairing a PR; it does not claim PR
delivery. A verified merged PR is also valid: handoff/tracking heads remain the
submitted candidate; a different squash/canonical revision stays in existing
merge/release evidence. For tasks without a full record, `handoff-check <handoff.json>` validates
the same object under the [terminal completion check](decomposition-and-pr-handoff.md#terminal-pr-handoff-for-worktree-changes).

## Compatibility and migration

Unstructured tasks remain supported and follow the same mandatory issue/PR contract.
Retained version-1 records without `delivery_tracking` can be inspected as planned or blocked;
add live tracking evidence before resuming execution or claiming final/completed delivery.
Retained completed records missing `pr_handoff` must add current completion
evidence before validating as completed; they remain inspectable as planned or
blocked. Pending independent review must be finished or recorded as blocked.
This additive field strengthens delivery gates without deleting or rewriting retained records. Version 1 readers reject unknown schema versions rather than
guessing. Additive version-1 fields must preserve existing meaning. Any incompatible field,
identity, or state-transition change requires a new schema version, a documented migration, and
read compatibility for retained prior records. Rollback never deletes retained records or project
evidence.

For `planning_mode: github_issue`, `task.plan` is mandatory. A task may not execute when its
canonical plan is unpinned, duplicated, stale for the current source revision, awaiting approval,
or marked `reapproval_required`. Legacy retained records may omit both fields.
The task template starts pending with `task.plan_digest` set to null. Before approval,
replace it with the existing helper's canonical JSON digest of the material plan scope,
approach, steps, risks, and acceptance. Exclude todo progress and other presentation state.
After approval, set the same `plan_digest` and a trusted `source_ref` on the
`implementation_plan` approval. Reconcile that evidence with the current plan before
execution. A material edit changes the digest and requires its own approval. Legacy records
without a plan digest remain readable. Apply the current
[plan approval gate](stage-contracts.md#stage-4a-plan-approval) when resuming work.

## Human readback

The user normally sees a compact summary: task outcome, source revision, issue and canonical plan
links, plan state, required capabilities, blockers, validation milestone, remaining claims, and
approval boundary. Include impact count, diagnostic count, and release state when recorded. Show raw structured data only when requested or needed for diagnosis. Never
expose secret-shaped values in either view.

## UI decisions and merge activation

Optional `ui_conventions` binds reviews to `repository` and `changed_surfaces`, with `rules` containing `id`,
`source_ref`, `surface`, `state` (current/superseded/screen_local), `applicable`, and `review`
(pending/passed/failed/exception/not_applicable). Passed/exception applicable rules need
`evidence_ref`; exceptions need `exception_reason`, superseded rules need `superseded_by`.
`--require-final` rejects unreviewed applicable rules. See project-ui-conventions.md.

Optional `merge_readiness` has `state` (planned/blocked/ready/merged), `trigger`
(unknown/deploys/does_not_deploy), `revision`, `trigger_evidence_ref`, and `prerequisites`.
Deployment-triggering readiness also records `environment`, `configuration_ref`, `observed_at`,
`authority_ref`, `inventory_ref`, and `activation` (active/safely_inactive). Each prerequisite
records `id`, `state` (ready/blocked/unknown/deferred), matching revision/environment/configuration,
`evidence_ref`, `observed_at`, and `evidence_surface: target`. Safe inactivity additionally needs
`inactivity_evidence_ref`, `compatibility_evidence_ref`, and `activation_followup`. Deferral is
valid only for verified safe inactivity. Recheck transient evidence before merge. Legacy records
remain valid without these sections; guidance still requires the decision for applicable work.
