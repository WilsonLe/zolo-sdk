---
name: orchestration
description: Turn the current Codex task into a mandatory-autopilot Goal Mode control plane when the operator explicitly calls it the control plane, main session, master session, orchestration session, or a clear synonym; clarify the goal, triage one foreground delivery issue, run selected implementation work in verified Full Access Goal or Plan Codex sessions, delegate serialized same-worktree GPT-5.6 Luna max review, remediation, and verification, and carry the issue through merge, pull, and declared-target deployment while preserving evidence and safety boundaries.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- **Required: Python runtime** — Install Python 3.10 or newer and the package dependencies before running its helper scripts.
- **Required: Git and GitHub CLI** — Install Git and authenticate gh for the target repository.
- **Required: Codex task controls** — Use a Codex host that exposes task creation, model readback, and worktree controls.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Agent Orchestration

Activate only after an explicit operator designation. A mention of the main branch,
a generic status request, or discussion about orchestration is not
activation.

Read [activation and Goal Mode](references/activation-and-goal-mode.md) first.
Do not inventory or coordinate peer tasks until the goal-clear gate passes.
Then read:

- [project scope and task trust](references/project-scope-and-trust.md);
- [portfolio triage](references/portfolio-triage.md);
- [delegated session launch settings](references/delegated-session-launch-settings.md);
- [issue session lifecycle](references/issue-session-lifecycle.md);
- [review session lifecycle](references/review-session-lifecycle.md);
- [verification session lifecycle](references/verification-session-lifecycle.md);
- [titles and status](references/titles-and-status.md);
- [coordination and waiting](references/coordination-and-waiting.md);
- [closeout, archive, and recovery](references/closeout-archive-recovery.md);
- [coordination register](references/coordination-register.md).

Use `<plugin-root>/scripts/orchestration_state.py` when durable coordination state,
portfolio selection, title formatting, wait batching, archive eligibility, or
worktree-cleanup proof materially helps the run. Do not create or update records
solely to narrate routine progress. The register is an index; live goal, project,
task, Git, and GitHub tools remain authoritative.

Never create subagents or use subagent/delegation APIs. Selected issue work,
code review, and candidate verification are started only with the host's
user-owned Codex task creation capability. Issue implementation uses a new
project worktree based on refreshed `main`. Review and verification each use a
new task but reuse that exact implementation worktree under an exclusive,
serialized handoff; they never create parallel review or verifier worktrees.

Every code-review task, every review-finding remediation turn, and every
test-and-verification task must run as `gpt-5.6-luna` with reasoning effort
`max`. Request both settings through host controls and authoritatively read
them back before the lane runs, then persist requested/effective fields and the
readback state in the register. Fail closed on unsupported controls, missing
readback, downgrade, or mismatch; prompt wording is never proof. Remediation
turns retain a deterministic turn ID and their own Luna/max readback.
Never create subagents or use subagent/delegation APIs. Use the host's user-owned
Codex task capability for separate implementation, review, or verification lanes
when independence or parallel value is required. Review and verification reuse
the exact implementation worktree only under the serialized handoffs below.
Never share a writable worktree concurrently.

The control plane never performs code review itself and does not claim independent code review
of its own changes. Use trusted scope authority and the plan gate below. The
decomposed-parent merge to `main` requires its own explicit approval.
It may inspect code while implementing and may verify identities, revisions, checks,
review state, and finding disposition. Use independent review when repository
policy, risk, or the goal requires it; otherwise proportionate automated checks
and existing review evidence may satisfy the gate. Never invent clearance.

At activation, capture one concise trusted authority envelope for the declared
goal. It pre-authorizes the ordinary delivery actions needed to finish that goal:
issue and plan maintenance, isolated implementation, local runtime use, commit,
push, PR creation or update, merge, canonical fast-forward pull, safe cleanup,
and deployment plus verification to the declared target. Clear the current plan
gate only with approval of its version or explicit delegation of plan approval
for the scope. Record that authority and version under the existing plan gate.
Block dependent implementation when the decision is missing.
For a decomposed parent issue, the envelope may merge passing child PRs into the
parent issue branch, but it never authorizes merging the parent PR into `main`
or enabling its auto-merge. Ask for explicit user approval to merge the parent branch
through that PR before that final merge.
Apply the Standard Development Workflow's branch approval rule: in-scope fix commits
retain approval, while current-head tests, review, and branch protection remain required.
Use focused tests during development and PR handoff. Apply the shared
[Stage 7 merge contract](../standard-development-workflow/references/stage-contracts.md)
at the authorized merge stage, including full local CI on the current candidate.
Carry the user's named deliverables, issue-first order, explicit exclusions, and later corrections
through every task handoff. Before closing the goal, inspect the current issue/PR and requested
target evidence for each required item. Give implementation and verification tasks the measured
check inventory and any secret-free external-provider next step; do not rerun an unchanged check
or treat saved configuration as verified flow evidence.
Use grouped independent provider questions and retain nonsecret answers across turns;
keep just-in-time consent and private credential entry separate. Apply the shared
[Stage 8 deployment contract](../standard-development-workflow/references/stage-contracts.md)
to triggered and authorized rollouts. Require live health and functional evidence
for every system in the blast radius before marking deployment verification complete.

Record a gate decision only at a meaningful milestone or exception: scope or
authority changes, candidate freeze, unresolved evidence, merge, deployment,
destructive action, or terminal disposition. Reuse a still-valid decision while
its identity, evidence, and authority remain unchanged. Do not record per-command,
per-message, per-wait, or ceremony-only decisions.

Deployment proceeds automatically when its target is named by the trusted goal,
is the repository's single unambiguous documented target for a direct “deploy”
instruction, or is separately named by the operator. Production is allowed only
by that direct trusted production scope; never infer it from staging authority.
Credentials must use a supported secret-safe mechanism. Autopilot never bypasses
branch protection, weakens required checks, relabels evidence, performs financial
activity without exact direct scope, or deletes ambiguous, dirty, shared, or
unmerged work.

Cap review and remediation before the next workflow step at two passes. Refresh
an attempt made stale by verified unrelated work within its existing pass. Require
current clearance and apply the review lifecycle's stop conditions for remediation.

Use the adversarial method and final-candidate requirements in the review lifecycle.
At terminal handoff, provide the self-contained PR summary directly in chat under
[SDLC Loop's handoff contract](../sdlc-loop/SKILL.md#delivery-procedure), including
when blocked. A PR link or a passing test run alone is not a sufficient handoff.
Apply that contract's pre-send check to the actual drafted final reply.

The v5 register uses revision compare-and-swap and owner-only same-worktree
claim locks across controllers. Claim identity is one realpath-normalized path
key for both missing and existent worktrees, so creation cannot strand a claim
or let a path alias bypass ownership. Register persistence holds all relevant
claim locks and rolls back only sidecars changed by the candidate when a later
register write fails. Existing v4 detached-review records migrate with
recoverable legacy markers and never count as newly proven shared-worktree or
model/reasoning evidence; ambiguous v4 ownership, including legacy symlink
paths, fails closed and preserves the v4 conflict. Completed implementation
closeout requires review and verification to certify the same unchanged exact
full base/head pair, then requires the terminal verifier task to be
authoritatively archived and its claim released before implementation archive
or cleanup intent. A failed Luna/max remediation readback is an integrated
blocked no-source-work transition, not an active task with a warning. Terminal
verification outcomes are immutable.
