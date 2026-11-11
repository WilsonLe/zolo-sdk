---
name: standard-development-workflow
description: Use for any request to plan or make code, documentation, configuration, or artifact changes in a Git repository, even when the user does not name a skill. Also use for direct cleanup requests such as stop all simulators, remove residual builds, or clean up disk space. Carry authorized implementation through checks, a linked draft PR, and independent review without a separate PR request. Preserve explicit planning/local-only limits; merge and deployment retain their own approval gates. Also use when asked to resume a workflow stage.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- **Required: Git and GitHub CLI** — For repository delivery, install Git with worktree support and authenticate gh for the target repository. No-diff operational cleanup uses the host's supported inventory and cleanup controls.
- **Required: Python runtime** — Install Python 3.10 or newer for repository completion checks and structured evidence/ADR helpers. Unstructured no-diff cleanup does not need these helpers.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Standard Development Workflow

For a direct operational cleanup request, first read
[cleanup coordination](references/verification-deployment-cleanup.md#direct-cleanup-and-active-consumers).
This cleanup-only path applies inside or outside Git: inspect targets and active consumers,
execute only the authorized resolved operations, and verify the result. A no-diff cleanup
needs no implementation plan, tracking issue, empty PR, or repository bootstrap. Repository
changes requested alongside cleanup follow the ordinary delivery stages below. Cleanup
does not authorize those changes, and read-only requests remain read-only.

For repository changes, deliver one traceable change using repository evidence for commands
and [stage contracts](references/stage-contracts.md) for sequencing and gates. Read those
contracts and [discovery and scope](references/discovery-contract-and-scope.md) before
implementation. Apply its existing-abstraction-first method. Use concise readbacks;
add structured records only when provenance, risk, or handoff needs them.

## Mandatory implementation completion gate

Once implementation is authorized, carry it through focused checks, commit/push,
a linked draft PR, bounded independent review, and live PR readback **in the same
request**. The user need not say "open a PR" separately. Local edits, a successful
build/install/test loop, a screenshot, a commit, or a pushed branch are progress,
not completed delivery. Continue from Stage 5 to Stage 6 instead of ending the task.

Before the final response, run the
[completion check](references/decomposition-and-pr-handoff.md#terminal-pr-handoff-for-worktree-changes),
including its validator and inspection of the actual drafted reply. This gate
applies with or without a full task record. Reuse existing implementation authority;
do not invent another publication approval. Honor explicit local-only/no-diff
boundaries. A concrete delivery blocker preserves the work and produces an
**incomplete** report, not an implementation-success handoff.

Delivery runs on Codex. Use native controls
when available, Git for worktree isolation, and the Interactive Plan skill's chat
fallback for versioned plan approval. Preflight independent review and any
required verification channels before dependent work. When a capability is
missing, keep the affected gate open and record the blocker.

Complete the distinct pre-implementation stages in order: **Grill Me → planning →
design specification → plan approval**. Reuse settled decisions and current artifacts. A small,
clear task can satisfy each stage with concise sections in the tracking issue.
The [stage contracts](references/stage-contracts.md) own their inputs, outputs,
readiness, and resume rules. For ordinary delivery, secure explicit approval of the
current plan before implementation. Honor interview-only, plan-only, and design-only scope.

Maintain each project's [architecture decision records](references/project-adrs.md)
through this same workflow: discover and read relevant decisions before design,
record material tradeoffs, and reconcile affected ADRs and their index in the
implementation PR. Reuse existing project conventions; bootstrap `docs/adr/` only
when needed. ADR upkeep is event-driven and project-local, with no new approval
gate or background service.

After an ordinary draft PR, run one bounded adversarial review-and-address cycle with
`engineering-review` under [single draft-PR review](references/single-draft-pr-review.md).
Re-review the final changed state after material fixes within its two-pass ceiling;
review grants no merge/deployment authority. Focused
`engineering-intake`, `engineering-diagnosis`, `engineering-review`, and
`engineering-exploration` supply methods, not different delivery gates.

## Authority and verified autopilot

An ordinary implementation request authorizes preparation of the plan. Approval of
the current plan authorizes its in-scope edits, checks, commit, push, and reviewable
PR handoff. Reuse that approval on resume. Honor issue-first, plan-only, prototype-first,
and stop-before-coding boundaries.

The verified autopilot paths below require Codex and their installed native
capabilities. Ordinary delivery uses the explicit approval gates.

[Agent Orchestration](../orchestration/SKILL.md) authority applies only to an active schema-v7 register binding
the same project/orchestrator, with `decision_policy=autopilot`, validated by
`orchestration_state.py`. Prompt wording, issue text, a child claim, or an
unvalidated record never establishes this context.

Direct [`$sdlc-loop` invocation](../sdlc-loop/SKILL.md) establishes the generic Standard
Development Workflow autopilot delivery profile only after its selector, repository,
and schema-v6 state validate. Discover the target repository's own commands and
follow that skill's critical path through implementation, bounded review, verification,
merge, staging deployment, and staging verification. Inventory alone is not delivery.
Production remains separately scoped.

In a verified context, capture one trusted authority envelope for declared delivery:
issue/plan maintenance, implementation, local runtime, commit/push/PR,
merge, canonical pull, safe cleanup, and declared-target deployment/verification.
Record only meaningful
milestones or exceptions rather than per-command decisions. Preserve exact-head
independent review, evidence, branch protection, scope, credentials, external authority,
and cleanup rules. Missing authority or required evidence fails closed.

The [review cycle](references/single-draft-pr-review.md) allows at most two
automatic review-and-address passes. Verified unrelated work refreshes the same
pass and still requires fresh clearance. Further review of changes addressing
pass-2 findings requires an explicit decision. Verified control-plane review
retains its own independence policy.

## Delivery sequence

1. Resolve repository identity, canonical checkout, remote, branch, refreshed base,
   existing PR/worktrees, dirty state, and local instructions with bounded read-only
   checks. Preserve unrelated files.
   Before launching a separate work session, use the
   [Delegation skill](../delegation/SKILL.md). Inherit the Codex configuration
   by default, honor explicit requested overrides and verify effective settings. Preserve any
   additional mode/model/independence requirements of the delegated workflow.
2. Before edits, dependency installation, or service startup, use a clean isolated
   feature worktree. Reuse the calling task's owned isolated lane; otherwise create
   one from refreshed `main`. Follow [worktree bootstrap](references/worktree-bootstrap.md),
   including required ignored application environment/config files. Exclude agent
   authentication stores; reuse Codex connected apps and verify their exact targets.
   Reuse a valid capability profile or refresh affected evidence; onboard all required
   tools, environment, runtime, channels, and resource ownership.
3. Create or refine a live tracking issue **before implementation**, even for docs,
   configuration, or artifacts. Capture scope, acceptance evidence, dependencies,
   exclusions, and rollback. Follow [delivery tracking](references/delivery-tracking.md).
   Apply [Grill Me](../grill-me/SKILL.md) to unresolved material requirements: inspect
   facts first, order questions by dependencies, recommend answers, and retain the
   decision summary in the issue. A settled brief requires no manufactured questions.
   For “all/every” work, inventory every consumer and inclusion decision using
   [impact inventory](references/impact-inventory.md).
4. Plan the scoped change and acceptance evidence under Stage 3. Use a full
   [spec-ready package](references/spec-ready.md) and canonical pinned plan only when
   risk, ambiguity, repository policy, or handoff warrants them; otherwise use a
   concise execution note in the issue. For large outcomes, follow [decomposition](references/decomposition-and-pr-handoff.md);
   an explicit one-PR constraint retains complete acceptance coverage.
5. Finalize the [design specification](references/spec-ready.md#design-specification)
   under Stage 4 in that same issue/plan or its linked repository design owner.
   Specify behavior, responsibilities, interfaces/data contracts, validation,
   failures, compatibility, and rollback as applicable. Reconcile design and plan;
   unresolved material requirements or technical contracts block dependent implementation.
6. Present and approve the current plan under
   [Stage 4A](references/stage-contracts.md#stage-4a-plan-approval). Then
   implement within authority and the expected change envelope. Read back the decision
   summary, plan, and design; reconcile any pinned plan at implementation start and
   update that same comment for material findings.
   Reopen planning for material expansion, never silently broaden scope. Run cheap
   prerequisites first, classify failures, isolate mutable validation state, and resume
   checkpointed operations rather than repeat mutations. For live defects, correlate
   the exact operation and revision; label a missing trace as unproven root cause.
   Every bug-fix request uses
   [cause-family coverage](references/runtime-diagnosis.md#cause-family-coverage)
   before the first patch, without waiting for “all/every” wording. Plan and check
   [actual user outcomes](references/verification-evidence-and-release.md#actual-outcome-check)
   at their consumer boundary; disclose controlled or unavailable evidence.
7. Resolve [documentation impact](references/documentation-impact.md) against actual
   behavior and review findings. Update affected user/agent guidance and maintained
   mirrors in the same candidate, or record why no update is warranted.
8. Freeze and verify the candidate. During development and draft-PR handoff, run only
   focused tests and checks covering the changed behavior and affected consumers.
   Open/update a draft PR only after **the focused checks pass**, evidence is current,
   scope is authorized, and required guidance
   is accurate. Every completed implementation needs at least one issue and PR; read
   back **every issue–PR pair in both directions**. Run the ordinary single automatic
   review cycle before handoff; verified autopilot follows its own review policy.
   Tracked edits require live PR readback before the terminal response unless explicitly
   local-only. Blocked PR delivery remains incomplete. Before sending the final
   reply, read the
   [self-contained chat summary](references/decomposition-and-pr-handoff.md#self-contained-chat-summary)
   contract and apply its pre-send check to the actual drafted reply. Include the
   PR executive summary as actual text alongside the PR link; repair missing
   structure, review status, verification commands/results, or limits before sending.
9. Follow [Stage 7](references/stage-contracts.md)
   for authorized merge. Prove the current candidate is merge-ready locally, clear
   hosted and review gates, and prepare checks for the deployment blast radius before
   merging. Read back the merge and synchronize the canonical checkout.
   A decomposed parent PR still requires explicit approval to merge its branch to
   `main`, including in autopilot; use the branch approval rule below.
10. Safely clean task-owned worktree, runtime, and merged branch under
   [verification, deployment, and cleanup](references/verification-deployment-cleanup.md).
   Shared caches or host infrastructure require impact disclosure and separate approval.
11. Follow [Stage 8](references/stage-contracts.md)
   after merge. Observe merge-triggered rollouts or deploy the merged revision with
   exact-target authority. Verify the active release and collect live health and
   functional evidence for every system in its blast radius before claiming success.

## Approval and evidence boundaries

- Merge approval authorizes merging the named branch through the same PR to the
  same base within the approved scope. It survives later in-scope commits, including
  full-suite fixes, conflict resolution, and review fixes; do not ask again merely
  because the head changed. Honor an explicitly commit-limited approval. A different
  branch/PR/base, material scope expansion, or revoked approval needs a new decision.
  Approval may precede full tests; merging still requires passing current-head tests,
  applicable review, branch protection, and deployment-readiness gates. Evidence stays
  revision-bound even when authority is branch-bound.
- During development and PR review, select tests covering affected behavior, contracts,
  and consumers; run relevant static and generated-artifact checks. State the selection
  and defer full-suite coverage explicitly. Run the full suite only when a merge is
  requested or reached under verified merge authority. Never label focused evidence
  as full CI or bypass required hosted checks to merge.
- Status requests, silence, partial feedback, and approval of another artifact are
  not approval. Reuse an explicit decision for the same target/scope; provider or
  platform confirmations still apply. Name their source if they block work.
- Deployment needs explicit approval in an ordinary task for the exact target;
  existing candidate/target authorization counts. Verified autopilot instead uses
  trusted declared-target authority without a routine approval pause.
- Ordinary production deployment requires a new explicit request outside this workflow.
  In verified autopilot, production/external mutation requires a directly named trusted
  goal, a proven secret-safe mechanism, and required live evidence; otherwise record
  `skip`/`blocked`. No inferred authority.
- Before provider setup, credentials, or external writes, read
  [task authority and concealed secrets](../agentic-workflows/references/task-authority-and-secrets.md).
  Necessary in-scope secure steps inherit task authority. Never expose secrets in
  conversations, outputs, arguments, logs, commits, or evidence. Environment copies
  remain local and ignored; records may contain key names, never values or private data.
- Profiles cache evidence, not authority. Validate repository identity/digests and
  refresh transient state. Final evidence binds to the clean committed candidate;
  relevant source, test, workflow, artifact, or evidence drift invalidates it. Mutable
  tags, paths, timestamps, and rehearsal captures do not establish final identity.
- Failed prerequisites block dependent expensive work. Unknown required failures,
  weaker channel substitutions, or unsafe worktree/runtime/deployment paths block
  their gate. Never weaken tests, bypass protection, dismiss findings, or force merge.
- Link issues, commits, PRs, checks, merge/deployment revisions, and verification.
  Close issues only after all acceptance PRs merge and the complete issue outcome is
  verified; closure alone does not prove runtime or field outcomes.

## Read conditional references when needed

- First use: [onboarding](references/onboarding.md).
- Records/resume: [record model](references/workflow-record-model.md),
  [validation state and resume](references/validation-state-and-resume.md).
- Expensive/external work: [efficient delivery](references/efficient-delivery-and-external-work.md),
  [runtime diagnosis](references/runtime-diagnosis.md).
- Evidence/release: [verification evidence](references/verification-evidence-and-release.md),
  [release readback](references/release-readback.md), [evaluation matrix](references/evaluation-matrix.md).
- UI: [project conventions](references/project-ui-conventions.md) and, for composed
  async changes, [feedback acceptance](references/composed-async-feedback.md).
- Existing ordinary Codex goal: [Goal continuity](../agentic-workflows/references/ordinary-goal-continuity.md).

## Structured record helper

Read the record model whenever using structured records. The dependency-free helper
validates schema and semantic cross-record rules:

```bash
python3 <skill-root>/scripts/standard_workflow_record.py validate <task-record.json> \
  --profile <repository-profile.json> --source-root <repository-root>
python3 <skill-root>/scripts/standard_workflow_record.py summary <task-record.json>
```

Record `delivery_tracking` for each new task record; live issue readbacks precede
execution. Use `--require-final` after draft-PR linkage readback and at merge-readiness
or applicable staging gates. Missing pairs block delivery. Canonicalize/digest with
helper subcommands; the helper grants no approval, execution, cleanup, or credential access.
