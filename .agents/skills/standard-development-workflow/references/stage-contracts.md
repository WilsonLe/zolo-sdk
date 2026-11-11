# Stage contracts and approval gates

## Gate owner

These stage descriptions default to ordinary human-gated delivery. Use the
entrypoint's verified autopilot authority rules for a trusted control plane.
Record the plan decision, material choices, exceptions, merge, deployment, and
terminal disposition. Routine actions inherit applicable authority.

Retain the declared goal, credentials and external authority boundaries,
independence, branch protection, and cleanup requirements in every mode.

## Stage 1 — Isolated worktree ready

Deliver evidence of the feature branch and base revision, worktree path, instructions read,
prerequisites installed, environment-file presence and ignore safety, unique runtime identity,
non-overlapping port map, and local stack health when the task needs a running stack. Also identify
the repository capability-profile digest or the sections that were refreshed, required
verification-channel availability, and resource-budget applicability.

Do not continue if onboarding is incomplete.

Discover the project's ADR conventions and read relevant decisions using
[project ADR maintenance](project-adrs.md); reuse the existing store and authority.

## Stage 2 — Grill Me and spec-ready issue

Every repository-change SDLC request requires at least one live tracking issue before implementation. Reuse or
create it with a concise scope and acceptance note; issue creation is never conditional on
repository habits or change size. Follow [delivery tracking](delivery-tracking.md).

Apply [Grill Me](../../grill-me/SKILL.md) to the request and repository findings.
Its input is the brief, current behavior, existing issue, and accepted decisions;
its output is a shared outcome, scope/non-goals, constraints, testable acceptance
criteria, and a decision summary distinguishing facts, choices, assumptions, and
blockers. Explore factual unknowns before asking dependency-ordered questions with
recommendations. Reuse settled choices; a complete brief can finish this stage
without an interview round. Unanswered material questions block only dependent work.

Keep the summary in the tracking issue or existing canonical plan. Refine the issue
using [spec-ready](spec-ready.md) when risk, ambiguity, policy, or handoff warrants
the full package. This stage is ready for planning when the intended behavior and
material constraints are settled; technical choices still requiring investigation
remain explicit planning work. An interview-only or issue-first boundary stops here
unless the user already authorized the later work.

## Stage 3 — Planning

Use the Stage 2 outcome, acceptance criteria, repository findings, and current
authority as inputs. Produce an ordered implementation and verification plan,
including change surfaces, dependencies, risks, rollback, and definition of done.
For bug fixes, discover the supported [cause family](runtime-diagnosis.md#cause-family-coverage)
and plan [actual outcome checks](verification-evidence-and-release.md#actual-outcome-check)
for the original symptom and materially distinct branches before implementation.
Propose the architecture and identify technical decisions for Stage 4; planning
owns sequencing and evidence, while design specification owns the final contracts.
Every task completes this stage. For a small settled change, a concise execution
note in the issue is sufficient; it must still map acceptance criteria to checks.
When risk, ambiguity, repository policy, or a durable handoff warrants the full specification,
post one canonical implementation plan comment under [spec-ready](spec-ready.md).
Include
`<!-- standard-development-plan -->`, pin the comment, read it back, and retain its comment
ID and URL. Update this same comment in place; do not create competing plan comments.

A full canonical plan must include:

- objective, issue link, scope, non-goals, assumptions, and blocking decisions;
- repository findings and exact change surfaces;
- proposed architecture, data flow, interfaces, contracts, compatibility, and migration approach,
  with the design specification finalized in Stage 4;
- consumed capability-profile identity, task execution contract, minimal correct path, expected
  change envelope, and material-expansion triggers;
- resource capacity/ownership, validation ladder, verification-channel claims, and conditional
  sandbox/artifact/operation requirements;
- file-by-file or component-by-component changes and their sequencing;
- for a pattern-wide request, discovered surface IDs, inclusion/exclusion reasons, shared points,
  and each included surface's planned verification;
- failure modes, edge cases, security, privacy, accessibility, performance, localization,
  observability, data integrity, and rollback where applicable;
- likely documentation, agent-instruction, and release-note consumers of the change, or a
  provisional reason no update appears warranted; revisit this after implementation;
- exact dependency and generated-artifact handling;
- a requirements-to-tests matrix mapping every acceptance criterion to planned automated and/or
  manual evidence;
- unit, integration, end-to-end, regression, manual, visual, browser/device, accessibility,
  performance, security, migration, and failure-path tests as applicable;
- test data, fixtures, mocks, environment, commands, URLs, port map, expected assertions, and
  evidence artifacts;
- CI parity and required checks;
- for UI changes, the complete request-image inventory and exported-PNG sketch inventory, with
  one-to-one issue-body image evidence and any upload blockers;
- draft PR structure, review evidence, local merge readiness criteria, cleanup steps, deployment
  method and rollback, and checks for affected systems on each applicable deployment target;
- risks, mitigations, unresolved questions, and a precise definition of done.

Resolve implementation details from repository evidence and established user choices.
Raise unresolved material choices about behavior, security, data handling, cost, or external impact.
Verified autopilot may resolve these within the trusted goal. Keep blocking unknowns visible.

The planning output is ready for design specification when every acceptance
criterion has planned evidence, sequencing and dependencies are explicit, and no
unresolved scope or authority decision prevents design. A plan-only request stops
after its requested planning/design artifacts; it does not authorize implementation.

## Stage 4 — Design specification

Use the settled brief and implementation plan to finalize the observable behavior
and technical contracts under [design specification](spec-ready.md#design-specification).
Apply [existing abstractions first](../../engineering-exploration/SKILL.md#existing-abstractions-first)
to the current owner, callers, and invariants. Use a focused survey or disposable
prototype only when evidence is needed to settle a design question.

The output is a design section in the same issue/execution note or canonical plan,
or a linked existing repository design document. Do not create a competing plan,
design ledger, or workflow schema. A small change can specify the changed behavior
and preserved contracts in a few sentences; every task still completes the stage.
Reconcile final design choices with plan sequencing and acceptance evidence before
implementation. No unresolved material contract may be hidden as an assumption.
Honor a design-only or stop-before-coding request. Present the reconciled plan
and design for Stage 4A before source work.

Apply [project ADR maintenance](project-adrs.md): link relevant decisions in this
same design output, create proposals for new durable tradeoffs, or record a
justified no-impact result. Unresolved conflicts with accepted decisions block
dependent implementation until their authority and replacement are resolved.

## Stage 4A Plan approval

Use [Interactive Plan](../../interactive-plan/SKILL.md) to present the current
version, executive view, and engineering detail. Keep one plan in the existing
issue execution note or pinned comment. Answer questions and revise that plan
before requesting a decision. Record the approved version and trusted decision
source in the same plan and in the task record if used.

In ordinary SDLC, begin implementation only after the user approves the current
plan. A prior explicit approval of that plan counts. For verified autopilot,
accept the reconciled plan only when the trusted authority envelope explicitly
delegates plan approval for this scope. Record the decision and version under the
existing plan gate. With missing authority, keep the plan pending and block
dependent implementation.

On resume, read the current plan and approval. Reopen the gate for a material
change to scope, approach, risk, or acceptance. Update the same plan and ask
about the new version. Checklist progress and wording corrections retain the
existing approval. Plan approval authorizes implementation within scope.

## Stage 5 — Authorized implementation and local verification

Implement when Stage 4A has cleared the current plan. An issue-first,
plan-only, prototype-first, or stop-before-coding request still needs its reserved decision. At
implementation start, read back the decision summary, plan, and design specification;
reconcile any canonical pinned plan. Update that same comment
when material findings change status,
assumptions, decisions, risks, sequencing, or requirements-to-tests mappings. Keep the issue and
plan synchronized; mark the comment `reapproval_required` when a material scope or
architecture change exceeds existing authority. Return to Stage 2 for changed
requirements, Stage 3 for changed sequencing/evidence, and Stage 4 for changed
contracts; reconcile the affected outputs before continuing. On resume, reuse
current accepted outputs and revisit only decisions invalidated by new evidence.

Run only the focused portion of the fail-fast ladder while developing and preparing a draft PR.
Select tests for changed behavior and affected consumers, plus relevant static and generated
checks; record commands, selection reasons, and full-suite coverage deferred to Stage 7. Preserve and
classify first failures before changing code or tests. Isolate suite state, reuse only identity-bound
immutable artifacts, and checkpoint long operations when applicable. Exercise the live local stack
for user-visible or integration behavior. Capture proportionate rehearsal evidence without secrets.
Compare the final diff against the issue, plan, expected envelope, repository policy, and
unrelated-file boundary.
For a pattern-wide request, reconcile every discovered surface with final proof; for a runtime
defect, retain the correlated failing operation or the precise missing-trace limitation.
For every bug fix, reconcile the cause-family inventory and actual observed outcomes;
a passing helper, stored input, or controlled response cannot substitute for its consumer.
Compare the implemented behavior and review findings with the relevant user and agent guidance.
Update warranted instructions and maintained mirrors in the same candidate, or record why no
update is warranted. Follow [documentation impact](documentation-impact.md) for the decision.
Reconcile affected ADRs with the actual implementation, preserve decision history,
and refresh/check the project index under [project ADR maintenance](project-adrs.md).
Include the affected ADR IDs and results, or a justified no-impact reason, in the PR.

Do not open the review gate with failing or unknown required focused tests, unexplained skipped coverage,
an unapproved scope expansion, a weaker verification substitute, stale operation/artifact state,
or known stale required guidance.

## Stage 6 — Draft pull request review

Passing Stage 5's local checks is an intermediate milestone. Continue into this
stage in the same implementation request; a separate "open/deliver PR" prompt
is unnecessary once implementation is authorized. Apply the
[mandatory completion check](decomposition-and-pr-handoff.md#terminal-pr-handoff-for-worktree-changes)
before any implementation-completion reply, including small documentation changes.

Freeze the committed candidate and finalize evidence before pushing the feature branch. Validate
the candidate evidence, then open a draft PR with at least one tracking issue. Read back every
issue–PR pair in both directions and validate the record with `--require-final` before handoff.
Every completed request has at least one issue and one PR; each delivered issue and every PR
needs at least one link. Use closing keywords only when this PR finishes the whole issue.
Use `Refs` for partial delivery or acceptance that requires post-merge evidence, and
ordinary references for dependencies or separate follow-up work.
The PR description must state what changed, why, scope/non-goals, design decisions, test commands
and results, manual evidence, screenshots or videos for visual changes, risks, migrations,
deployment and rollback notes, remaining limitations, and the documentation-impact result:
updated surfaces with applicable validation, or a concise reason no update was warranted.

Re-check remote checks and findings. In ordinary mode, run the bundled
`engineering-review` skill as one bounded adversarial review-and-address cycle after
opening the draft PR. Follow [single draft-PR review](single-draft-pr-review.md) for
independence, finding disposition, final-state re-review after material fixes,
candidate identity, resume behavior, and stop conditions. In verified autopilot,
retain the repository's required review and the control plane's independence policy;
use adversarial review with risk-appropriate depth across the full change and affected
contracts. Tests and review supply distinct evidence.

Run cheap prerequisites before review and reserve pass 2 for the stable candidate
after material review fixes. An independently verified unrelated change refreshes
the same pass with current evidence. Apply the
[two-pass decision](single-draft-pr-review.md#two-pass-decision) to remediation,
refresh eligibility, and blocking findings before the next authorized step.

Before the terminal response, apply the
[self-contained chat summary](decomposition-and-pr-handoff.md#self-contained-chat-summary)
contract. Write the useful PR summary directly in chat alongside the link, including
the final implementation, review/disposition, verification and limits. Apply its
pre-send check to the actual drafted reply and repair omissions before sending.

## Stage 7 — Approval, squash merge, synchronization, and cleanup

On an explicit request to merge the branch/PR in ordinary mode, or the merge stage in verified
autopilot, use the [branch approval rule](../SKILL.md#approval-and-evidence-boundaries).
Approval authorizes in-scope fixes on that branch; a later commit alone does not require reapproval.
Approval and passing merge evidence are separate gates:

1. Prove local merge readiness. Run the full repository-required suite and local CI on the clean
   committed merge candidate. Record the commands, results, and tested head and base. If checks
   fail, diagnose and fix within scope, commit/push, rerun affected checks and the full suite,
   and update PR evidence. Reuse branch approval under the branch approval rule.
   Recheck the live base and head before merge. Refresh affected evidence if they drift.
2. Confirm the target PR, current review, required hosted checks, unresolved threads, mergeability,
   repository policy, final evidence identity, and required verification channels. Split and track
   unfinished implementation. Apply [deployment-triggering merge readiness](merge-deployment-readiness.md)
   to determine whether the merge activates a release and clear any target prerequisites.
   For a triggered rollout or an authorized deployment after merge, prepare the
   [post-merge checks](verification-deployment-cleanup.md#post-merge-deployment-verification)
   before merging. Confirm the target, blast radius, access to evidence, and recovery path.
   Clear the applicable gates before merging. Use queued or automatic merge only when its
   mechanism enforces those gates through execution, including evidence freshness if the
   base or head changes. Otherwise recheck the candidate and merge immediately.
3. Mark the draft ready when required, then squash-merge by default. Use another strategy only
   when the user explicitly asks or repository policy makes squash unavailable. Report the
   deviation before acting when a choice is needed.
4. Read back the PR's merged state and merge commit. For each implementation issue fully delivered by
   this PR, first verify all required linked PRs have merged and its acceptance criteria are met.
   Then check its live state, close it if still open even when the PR used `Refs`, and verify
   it is closed. Do not close dependency, parent, or follow-up issues merely because they were
   mentioned.
   Track deployment and field verification separately when they are outside the issue's
   acceptance criteria. Keep issues with outstanding acceptance criteria open.
5. Fast-forward the clean canonical checkout from its configured remote and base branch. Preserve
   unrelated files. Verify the canonical HEAD equals the merged revision.
6. Perform the targeted cleanup in `verification-deployment-cleanup.md`.
7. Continue to Stage 8 after merge and record its disposition. Verification of a triggered
   rollout can proceed independently of feature-worktree cleanup.

## Stage 8 — Declared-target deployment

For a merge-triggered rollout, observe the deployment initiated by the authorized merge.
For a separate rollout, deploy the merged revision or its immutable artifact from the canonical
checkout or release pipeline through the project's runbook. In ordinary mode, that deployment
needs explicit target approval. Verified autopilot uses the trusted goal's declared target
without a routine pause. A direct “deploy” instruction may use the repository's single
unambiguous documented target. Production must be directly named by the operator. If no
rollout applies, record why. If an expected rollout is outside current authority, leave
its status pending.

Complete [post-merge deployment verification](verification-deployment-cleanup.md#post-merge-deployment-verification)
on the actual target. Read back the active release, then verify health and functionality for every
included system. Keep release verification open on failed, blocked, or unobserved checks. Report
merge state, deployment state, and live results separately, including any authorized recovery.
Close and read back implementation issues whose remaining acceptance checks now pass.
