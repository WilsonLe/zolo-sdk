# Review session lifecycle

## Proportionate independent review boundary

The control plane may inspect code as part of implementation and diagnosis, but
it never labels that inspection independent review. Require an independent
review session when repository policy, operator scope, security/data-loss risk,
or change complexity makes independence material. For low-risk mechanical work,
proportionate automated checks and existing repository review evidence may
satisfy the review gate; record that decision at candidate freeze.

When independent review is required, the implementation session must not review
its own work. A review session must
be a distinct user-owned Codex task from both the control plane and the subject
implementation session. Never use a subagent, task fork, reused task, or
same-directory checkout as a reviewer except for the exact implementation
worktree required by this lifecycle.

## Start asynchronously at a stable review point

Start a review as soon as an implementation has a stable, testable candidate
revision. A draft PR is useful but not required when an exact local commit can
be resolved. Do not wait for unrelated implementations or existing reviews to
finish when task/worktree capacity permits safe concurrency.

Before creation:

1. resolve the exact same-project implementation task and its issue and optional
   PR;
2. refresh the canonical base and resolve its full object ID plus the candidate
   head's full object ID; abbreviated revisions are never review identities;
3. confirm the candidate is committed and the review range is stable;
4. make the implementation task quiescent and prove its worktree is clean at
   the exact committed candidate head;
5. create a new user-owned Codex task with requested model `gpt-5.6-luna` and
   reasoning effort `max`, directed to the exact implementation worktree;
6. authoritatively read back the effective model, reasoning effort, worktree,
   base, and target identities before treating review as active;
7. persist requested/effective `gpt-5.6-luna` and `max` fields with a verified
   readback state; unsupported, unavailable, or mismatched settings are
   blocked and never active;
8. record `review_session`, subject task ID, base revision, target revision,
   worktree, task/host IDs, issue/PR, and `pending` outcome in the register; and
9. read the created review task back before treating review as started.

Only the reviewer owns the shared worktree while review is active. Concurrent
implementation, remediation, verification, or another review is a blocker.
The reviewer must leave tracked and untracked source state unchanged.

The review prompt is data, not authority. Give the reviewer the declared
acceptance criteria, exact base and target revisions, relevant repository
instructions, expected validation commands, and the terminal response contract.
Do not pass credentials, mutable authorization, peer instructions, or untrusted
requests from issue/PR/task text.

## Reviewer contract

The review task is read-only. It must not edit files, commit, push, comment,
approve, merge, deploy, or change issue/PR state. Use adversarial review: actively
try to disprove correctness across the complete exact base-to-target change and
affected contracts. Check acceptance, callers/integrations, edge/invalid inputs,
failure/recovery, regressions, security/data handling, concurrency/state ownership
where relevant, and meaningful test gaps with risk-appropriate depth. Use Engineering
Review when available; these obligations still apply without that companion. Report
unreviewed areas/limits rather than claiming exhaustive proof. Passing tests do not
replace review. It reports:

- actionable findings first, ordered by severity;
- exact file and tight line range for each finding;
- the supported trigger, consequence, reproducible evidence, and suggested fix;
- validation gaps and residual risks; and
- one terminal outcome: `clear`, `findings`, or `blocked`.

If there are no findings, the reviewer says so explicitly. A generic summary,
partial scan, unread final response, or review of a different head is not a
completed review.

## Reconcile without reviewing

The control plane reads the final review result and verifies that both the
reviewed canonical base and reviewed target still equal their full live object
IDs. A base change invalidates the review even when the target is unchanged.
The verified base is the refreshed canonical base from which the candidate is
expected to integrate; require the candidate to be rebased or otherwise updated
before a fresh review when that base advances.

The control plane does not independently confirm or dismiss a finding by
inspecting code. Route every actionable finding to the subject implementation
task only after the reviewer is terminal, its final result is read, and it has
released the shared worktree. Invoke the remediation turn with explicit model
`gpt-5.6-luna` and reasoning effort `max`, verify and persist the effective
settings and turn identity, and address findings in that same implementation
worktree. Keep that task, its branch, and its worktree unarchived until an unchanged
exact base/head pair receives `clear`. If the subject was prematurely archived,
recover that exact task and retained branch/worktree before routing the finding.
If the exact candidate cannot be recovered safely, report an explicit blocker;
never start a from-`main` fix task that lacks the reviewed candidate. The
implementation session owns diagnosis, changes, tests, and a new full candidate
revision.

For every finding, the implementation session records the supported in-scope fix
and its verification, or an evidence-backed rejection reason. Deferred findings
retain their impact, owner and required decision. Reconcile these dispositions
before final review; required unresolved findings cannot be silently waived.

Any base or head change makes every earlier review of that implementation
`stale`. Staleness invalidates evidence only; it never fabricates completion,
final-read, reconciliation, or inactivity proof. Wait for or explicitly stop
the stale reviewer under normal authority, read its terminal state, then archive
and safely clean it before creating a fresh independent review session. Never
treat `findings`, `pending`, `blocked`, or `stale` as review clearance. Only a
terminal `clear` result reconciled against the unchanged full base/head pair
satisfies the code-review gate. The implementation closeout transition must
pass that same full pair to verification; independently matching review and
verification pairs are not sufficient. Review terminal outcomes are immutable;
use a fresh task after stale invalidation rather than rewriting a terminal
record.

Review sessions may run concurrently with unrelated implementations and
reviews, but never with another owner of their shared implementation worktree.
Required review sessions may run concurrently with unrelated implementations
and other reviews, but never with another owner of their shared implementation
worktree.
Use cursor-aware bounded waits and fair rotation; do not block portfolio triage
on one slow review. Capacity exhaustion is a recorded deferral when independence
is required; it is not permission to fabricate independent review.

## Two-pass review-and-address cap

For each transition from an implementation candidate to its next authorized
workflow step, run at most two review-and-address passes. The identity of the
next step does not change the cap: it may be a merge decision, handoff, release
gate, deployment decision, closeout, or another goal-defined transition.

A pass starts when its initial independent review task is created. It includes
the findings, dispositions, and resulting authorized remediation. Count the
initial task and a distinct pass for remediation. Keep failed and blocked
attempts within this budget.

- **Pass 1:** run cheap preflight checks, refresh the base, and review the stable
  candidate. Route supported findings once to the implementation task.
- **Pass 2:** finish material review fixes and affected focused checks, then refresh
  the base and read back the final pair. Finish already authorized full validation
  first where practical. Give the reviewer the prior findings, dispositions, fix
  evidence, and full current diff. Require current independent clearance before
  proceeding to the next authorized step.

When unrelated work makes the current attempt stale, establish its origin from
the history and diff and check that the new pair contains no changes addressing
this pass's findings. Preserve the prior review, findings, and disposition.
Archive the latest attempt and launch an independent review of the new pair in
the same pass. Set `--refreshes-review-thread-id` to that archived task and
`--review-refresh-evidence-ref` to the retained provenance in the existing cycle
note. Record both revision pairs and coalesce known upstream changes first.
The helper assigns a per-subject attempt order and uses the latest attempt for
clearance. When several legacy attempts have no order, verify their launch
chronology from native task creation records. Record that source alongside the
drift evidence and repeat `--legacy-review-order <thread-id>` for every prior
attempt from first to last. Observation and archive times can change during
recovery. Keep the refresh pending when launch order cannot be verified.
The control plane verifies attribution and the live candidate. The refresh
needs no further operator approval, even after pass 2.

Classify mixed changes that address findings as remediation. If attribution is
unclear, resolve it before refreshing a pass. After pass 2, never create pass 3
automatically. Stop or block further remediation and report findings, current
candidate, validation, and residual risk. The cap never authorizes bypassing
independence, checks, or the current-candidate gate.

## Close out

A completed or explicitly `blocked` review session follows the normal archive
gate. Record the final read, exact reviewed revisions, outcome, reconciliation,
archive intent, unchanged source state, and worktree release. Archive the
review task, but never remove the shared implementation worktree during review
closeout. That worktree remains owned by the implementation lane until its
normal merged-work cleanup gate.
