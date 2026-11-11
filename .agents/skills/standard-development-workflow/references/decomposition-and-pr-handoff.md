# Issue decomposition and PR handoff

## Required many-to-many tracking

Every SDLC request has at least one tracking issue before implementation and at least one
linked PR before completed delivery. One issue may span several PRs, and one PR may deliver
several issues. Read back each pair in both directions; list all tracking issues in each PR
body and all associated PRs in each issue body or canonical comment. A reference to a
dependency does not count as implementation tracking. See [delivery tracking](delivery-tracking.md).

## Decide whether to split

Inspect the request's independently testable outcomes, coupled files and data, verification
cost, review size, and rollback boundaries. Use one issue for a cohesive change. For a broad
request, write one parent issue with the overall acceptance matrix and dependency graph, then
create the smallest useful child issues. Each child needs a deliverable, likely surfaces,
dependencies, an exact test mapping, and a contribution to the parent outcome. Use native
sub-issues when supported; preserve an explicit link otherwise. A child must be valuable and
reviewable on its own, not a ceremony-only phase.
Prefer a narrow vertical slice that makes one user-facing path work through all necessary
layers. Name the child issues that truly block it, so any unblocked child can be worked
without waiting for unrelated work. For a wide mechanical migration that cannot keep each
vertical slice green, use expand, migrate, contract steps with explicit dependencies and a
combined verification point. Do not force independent PRs where coupled changes need one
candidate to remain valid.
For a structured candidate list, `standard_workflow_record.py decomposition-plan
<request.json>` accepts `outcomes` with IDs, deliverables, cohesion groups, dependencies,
and mapped tests plus `one_pr_requested`. It groups coupled outcomes and exposes the
minimal child dependency graph for review; the agent still verifies the issue plan and
creates the actual GitHub issue relationships. An explicit one-PR request yields one delivery.

## Branch and merge topology

Create the parent issue branch from freshly verified `main`. Create isolated child branches
from the appropriate current parent head. Each child PR targets the parent branch; verify
its base and head by live readback before review or merge. Use focused development checks for
the child draft PR; at its authorized merge stage run full local tests. After those checks, exact-head CI,
required review, and verification pass against the same child head and parent base, the trusted
child delivery envelope may merge that
child PR into the parent branch automatically. Resolve conflicts and stale evidence first.
Read back the child merge, close the delivered child issue, and update the parent matrix.
Independent children may progress only with isolated worktrees and mutable test resources.

After all children merge, run focused combined checks on the parent branch and open one parent
PR targeting `main` with the child links and focused evidence. **Do not merge that PR or enable
auto-merge until the user explicitly approves merging the parent branch through that PR.**
A plan approval, child-merge authority, control-plane activation, or `$sdlc-loop` invocation
does not supply this approval. Then run the full combined integration/regression suite and local
CI. Approval persists through in-scope fixes on the same branch/PR/base, under the
[branch approval rule](../SKILL.md#approval-and-evidence-boundaries). Recheck current-head
tests, branch protection, review, base/head, and mergeability before merging or enabling
auto-merge. Deployment remains a separate gate.
Child merges do not update `main`, staging, or production. Keep parent and child branches
until their evidence is safely handed off; never delete unmerged work.
Record the live closed state of each merged child issue and its readback reference. The
parent PR record must list every child issue, its exact head/base, and the live readback
reference before approval or merge.

An explicit request for one PR, as with a grouped implementation, overrides the default
split topology for that task. Record that decision; it is not a reason to omit acceptance
coverage for the grouped components.

## Terminal PR handoff for worktree changes

For tracked code, documentation, configuration, or artifact edits in a Git worktree, finish
appropriate checks, commit and push the branch, open or update its reviewable PR, and read
back the PR URL, exact head, base, state, and checks **before the terminal user response**.
Do this in the original implementation request. Missing PR wording, a local
build/install/test loop, or a request to avoid remote CI is not a local-only instruction.
Attach it to the task when the host supports attachments. Do not stop at local edits, a
commit, or a pushed branch. An existing matching PR should be updated, not duplicated.
Record its current open/draft/merged state, review state, and checks from the live readback.
For completion after an authorized merge, reuse that verified merged PR rather
than opening a replacement. `head_revision` and `pr_head_revision` retain the
submitted feature candidate, including after a squash merge. Keep the distinct
canonical merge/release revision in the existing [Stage 7/8 evidence](stage-contracts.md).
The handoff check does not grant merge authority or waive post-merge verification.
Make the PR body easy to scan: use the smallest flow, diagram, or file map that clarifies
the change when helpful; put before/after evidence near the claim it proves; and describe
merge risk and blast radius for consequential changes. Include all repository-required
checks and release notes from the stage contract.
List task-owned added, modified, and deleted paths against the intake base,
including committed changes and remaining staged/unstaged work. A clean working
tree does not mean no implementation occurred. Carry the existing PR URL found at intake;
a new PR URL must not replace it. If remote
or permission failure blocks PR creation, record the preserved branch/commit reference and
the concrete blocker.

Pure inspection, issue/plan work with no repository diff, and an unchanged checkout do not
need empty PRs. A direct user instruction to keep changes local overrides the default and
must be recorded. If no remote, permission, branch access, or a required check prevents a
PR, continue resolving the blocker where authorized; if genuinely impossible, preserve the
work and report the exact blocker as incomplete. Opening a PR never authorizes merging or
deployment. Record mandatory `delivery_tracking`; use `pr_handoff` and `decomposition` task-record sections to validate
the recorded identities and gates.

Before sending an implementation-completion reply:

1. Reconcile that change inventory with the request. For no-diff inspection or an
   explicitly local-only request, record why PR delivery does not apply and the
   explicit user source for a local-only override. Do not infer an override from
   silence about GitHub or from the repository's local verification commands.
2. Read back the linked issue/PR pairs and live PR head/base against the committed
   candidate. Complete the required bounded independent review on that pair.
   Pending review or an unresolved required check keeps delivery incomplete.
   Hosted checks may remain pending when not required for draft handoff; report
   their actual state and keep merge gates separate.
3. Populate the existing `pr_handoff` object in the
   [task template](../templates/task-run.json) from those observations. With a full
   task record, run `standard_workflow_record.py validate <task.json> --require-final`.
   Without one, save just that object outside Git and run the same validator's
   lightweight entry point; a full record is not needed:

   ```sh
   python3 <skill-root>/scripts/standard_workflow_record.py handoff-check <handoff.json>
   ```

   Exit 0 means recorded PR readiness or a valid no-diff/local-only exception;
   exit 1 rejects inconsistent or incomplete evidence. For blocked delivery, set
   `state: blocked`, supply the concrete `blocker` and `preserved_work_ref`, and
   use `--task-status blocked`: exit 2 deliberately reports **incomplete** rather
   than success. Resolve an actionable in-scope blocker before stopping. A missing
   Python runtime is a prerequisite to resolve, not a reason to waive PR delivery.
4. Inspect the actual drafted final reply under the summary contract below. It
   must contain the verified PR link and delivery evidence, or clearly identify
   the explicit exception/blocker. Repair omissions before sending; do not leave
   a local-success reply for the user to correct with "deliver PR".

The helper validates recorded observations; it does not query GitHub or enforce a
host stop hook. Retain live readbacks and report observation gaps honestly.

## Self-contained chat summary

After the review/fix cycle, write a self-contained PR executive summary as
actual text directly in the
final chat response, in addition to the PR link. The user must be able to understand
and assess the change without opening GitHub or reading the raw diff. A link-only
handoff, filename list, or pointer to the PR description does not satisfy this contract.
When publishing is blocked or reserved by the user, provide the same summary for the
prepared candidate and clearly state the missing PR/review steps; do not invent a URL.
This includes explicitly local-only changes. Include the summary in the first final
handoff reply, without waiting for the user to request it separately.

Use judgment and scale detail to complexity. Explain:

- the problem, resulting behavior, important changes and why they were chosen;
- the complete meaningful structure introduced or materially changed: key components,
  modules or files and their responsibilities, interactions or data/control flow,
  interfaces/schema, state ownership, validation and failure/recovery behavior where
  applicable. Group related files by responsibility; use a small flow or example
  when it helps. A simple edit may need only a sentence to explain its structure;
  review status, verification and limits still belong in the reply. A cross-layer
  change needs enough structure to assess how its parts work together;
- concrete before/after examples when useful, material tradeoffs, remaining risks,
  and unresolved decisions;
- review coverage/limits, findings and their fix/rejection/deferral, and whether the
  required final-state independent review matches the final PR base/head. Distinguish
  author inspection, independent review, and pending or stale evidence;
- actual verification commands and results, meaningful manual evidence and deferred
  coverage. Keep focused checks, full local CI, hosted checks, merge, deployment and
  live verification distinct; report unavailable evidence honestly.

Describe the final implementation, not abandoned approaches. Avoid exhaustive filename
dumps, repeated diffs, boilerplate and unsupported claims of exhaustive review. Keep
the PR body and chat consistent with the same final candidate; a concise PR body does
not waive the self-contained chat summary or justify omitting material structure.

Before sending, inspect the actual drafted final reply against the requirements
above using the final implementation and available evidence. Add missing content
and correct stale or unsupported claims in that draft before sending it. In
particular, check that the reply itself explains the outcome and meaningful
structure, states review findings/current-candidate coverage, gives actual
verification commands and results, and identifies deferred coverage and delivery
state. Group details to stay concise while retaining this content; honor explicit
user format/length constraints and state any resulting material evidence omissions.

Completion requires the user-visible summary in that reply. A PR-body summary,
internal checklist, status-only reply, or assertion that this check passed does not
satisfy it. This is a delivery-owner self-check, not an automated output guard or a
guarantee of future agent compliance.
