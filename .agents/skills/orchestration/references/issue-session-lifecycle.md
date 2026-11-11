# Issue session lifecycle

## Start or reuse one issue-owned writer

Prefer a separate issue-owned writer when concurrent coordination, isolation, or
handoff value justifies it. Otherwise the current control-plane task may own the
single foreground writer lane. For a separate writer:

1. resolve the exact saved project and confirm it is the intended Git
   repository;
2. refresh and re-read the canonical `main` branch and its commit identity;
3. establish the explicit delegated goal contract: objective, exact project and
   issue boundary, observable completion conditions, and constraints/authority;
4. apply the proportionate delegated-session launch-settings preflight;
5. use the host's Codex task creation capability for that project with a new
   worktree starting from the verified `main` branch;
6. create or verify one issue-specific branch in that worktree based on the
   same `main` commit; never leave issue work detached or on a reused branch;
   for an approved decomposed parent, a child branch instead starts from the
   verified current parent-issue branch and its PR targets that parent branch;
7. give the session one issue-scoped objective, unchanged authority boundaries,
   expected evidence, and a terminal handoff contract;
8. read back and verify effective Full Access and `goal` mode before activation;
9. retain the exact task and optional host IDs plus verified issue, base
   revision, branch, and worktree identities in the coordination register; and
10. read the created task back before treating the lane as started.

Never use subagents, delegation APIs, an in-process worker, a fork of another
task, a stale base, or a concurrently shared writable worktree. If the current
task already owns a clean isolated worktree, it may use it for the foreground
implementation rather than creating another ceremony-only task and worktree.

If the host cannot inherit saved TOML, select Goal mode, or read back effective
Full Access and Goal mode, do not create or activate a delegated lane. The current
task may continue in-scope work, but
must not claim a delegated Goal-mode session. Never emulate a host setting with
prompt text.

## Focused development checks and full merge checks

Every SDLC implementation request requires at least one live tracking issue before editing
and at least one linked PR before completed delivery. Read back all issue–PR pairs in both
directions; one issue can span multiple PRs and one PR can deliver multiple issues.
For tracked implementation changes, terminal handoff requires a live PR whose
head and base match the issue worktree candidate. An explicit local-only user
instruction or a no-diff/read-only task is the narrow exception. If the PR
cannot be opened, preserve the branch and report a blocked handoff.

Inspect the repository's active CI workflows and identify safe local equivalents.
During development and before opening/updating a PR, run only focused tests for
changed behavior and affected consumers, plus relevant static/generated checks.
Diagnose failures, fix within scope, and rerun affected focused checks before pushing.
Record commands, candidate revision, results, selection, and full-suite coverage deferred
to merge; never relabel focused evidence as full CI parity.

When merging is requested or the verified control plane reaches an authorized merge
stage, run the full required local CI-equivalent suite. Diagnose and fix failures,
then rerun affected checks and the full suite on the resulting candidate before merging.
Existing branch approval covers these in-scope fixes under the Standard Development
Workflow's approval rule. Never weaken tests, retries, timeouts, workers, or assertions.
Re-read required remote checks for the exact pushed head; keep runner, service, and
unavailable-log failures distinct from code failures.

## Foreground delivery checkpoint

Only one issue session may own implementation focus. Keep it active and
recoverable until it reaches either:

1. a clean committed candidate with passing focused development checks, a tested
   linked draft PR, and every currently applicable independent review,
   independent verification, and CI result reconciled against the unchanged
   exact candidate; or
2. an explicit terminal blocked handoff that names the missing authority or
   external change and preserves all recovery evidence.

Do not start another issue implementation while the foreground issue is
waiting, needs attention, has a failed test, lacks a PR, has unresolved review
findings, or lacks required verification. Review and verification for the same
foreground candidate may use available capacity under their own ownership
rules. Read-only preparation for a next issue is allowed, but it must not
create a second implementation worktree or mutate delivery state.

## Coordinate to terminal handoff

Use bounded task reads, follow-up messages, and cursor-aware waits for status,
questions, evidence, review findings, and handoff. Preserve the created task's
model and reasoning settings. The parent control plane remains responsible for
issue selection, dependency and overlap decisions, verification, and the final
live issue/PR/`main` readback.

While a verified Goal-mode child owns the foreground issue, the control plane
patiently waits, observes, and steers only. It uses cursor-aware reads and
bounded waits, then sends a focused in-scope decision only for new evidence,
an explicit `needs_attention` request, or a material goal/safety exception. It
does not edit the child's worktree, duplicate implementation, restart the goal
for routine silence, or convert interim progress into a terminal result.

Keep waiting until the child reports a completed handoff or a recoverable
terminal blocker and the control plane has read it back. Slow progress, a
waiting state, or an unchanged snapshot is not a reason to interrupt or replace
the child. The parent may start an independent review only at the documented
stable-candidate point; review never takes over implementation.

When a session asks a question, requests input or approval, or enters
`needs attention`, bind the event to its exact task, scope, worktree, cursor,
and candidate. The control plane records and sends its own bounded evidence-based
decision to that exact session and verifies readback. It never relays the
request to the operator. Missing authority, credentials, evidence, or safe
execution produces `skip`, `stop`, or `blocked` and preserves the lane.

A terminal handoff is either completed work or an explicitly blocked result
that identifies the blocker and preserves all recoverable work. Read the final
result and reconcile it against the issue, PR, branch, verification, and
dependencies before closeout. Silence, an interrupted task, an unread final
response, or a transient needs-attention state is not terminal.

Every reconciliation states the exact missing predecessor when no PR or test
evidence exists: plan decision, task launch, committed candidate, required local
tests, PR creation, review, independent verification, or CI. Local tests remain
distinct from independent verification.

When the implementation reaches a stable candidate revision, make the
implementation task quiescent and hand its exact worktree to a new Luna/max
review session under `review-session-lifecycle.md`. The issue session never
reviews its own work. After terminal review readback and release, findings are
addressed in the original implementation session and worktree by a new
Luna/max remediation turn whose requested/effective model, reasoning, and
turn ID are persisted. Unsupported or mismatched remediation readback blocks
the turn and atomically transitions the implementation to a blocked
no-source-work state; it must not remain active with a warning. A head change
makes prior review stale and requires a fresh review task.

At each stable candidate that is ready for final checks, keep the writer
quiescent and hand the same implementation worktree to a new Luna/max verifier
session under `verification-session-lifecycle.md`. Review, remediation, and
verification never own the shared worktree concurrently. The implementation
is complete only when unchanged exact-head review is clear and verification is
passed for the same base/head pair; both child tasks must have exact Luna/max
readback. Before implementation archive or cleanup intent, the terminal
verifier task must already be authoritatively archived and its shared-worktree
claim released in the persisted register.

## Archive and clean up

Every terminal issue session enters closeout, including explicitly blocked
sessions:

1. record terminal verification, final read, reconciliation, archive intent,
   and exact task/host identity;
2. archive the exact Codex task and verify authoritative success;
3. preserve any PR, commit, patch, or unmerged branch evidence required to
   continue or review the issue;
4. prove the exact worktree is task-owned, inactive, and clean before removal;
5. remove only that exact worktree through Git or the host-supported lifecycle;
6. delete the exact issue branch only when it is merged or otherwise proven
   disposable and no retained evidence depends on it; and
7. re-read task, worktree, branch, issue, PR, and `main` state and record the
   cleanup result.

Never remove a dirty, active, shared, ambiguous, unrelated, or evidence-bearing
worktree. Never delete unmerged work. When safety prevents full cleanup, archive
the terminal session, retain the exact branch or worktree needed for recovery,
mark cleanup `preserved`, and report the limitation; do not claim it was
cleaned. Never use broad globs, global pruning, or destructive repository-root
commands.
