# Verification session lifecycle

## Independent same-worktree verifier

Testing and verification run in a new user-owned Codex task distinct from the
control plane, implementation task, and review task. Request model
`gpt-5.6-luna` with reasoning effort `max` and authoritatively read back both
effective settings before activation. Never use a subagent, fork, existing
task, another model, lower effort, or prompt wording as a substitute.
Persist requested and effective model/reasoning fields and the readback state
on the verification task. Unsupported host selection, unavailable readback,
or any mismatch is a blocked outcome and cannot be activated or counted as a
passed verification.

The verifier uses the exact implementation worktree and branch. Before task
creation, make every writer and reviewer quiescent, prove the worktree is clean,
resolve the full canonical base and candidate head, and record an exclusive
handoff. Never create a separate verifier worktree. Concurrent ownership of the
shared worktree blocks verification.

## Verifier contract

Supply the approved acceptance criteria, repository instructions, exact
candidate identity, discovered commands, required evidence channels, and
terminal response contract as data. The verifier may perform scoped setup and
disposable runtime or test-state mutations needed by authorized checks. It
must not edit tracked source, commit, push, comment, approve, merge, deploy, or
change issue or PR state.

For browser-based checks, apply [browser selection](browser-selection.md): prefer
the Codex in-app browser when it supports the required evidence. Include the
preflight result and any justified fallback in the verifier handoff; retain
explicit channel requirements and required CLI/API/test-suite checks.

The verifier reports the full tested revision, exact worktree, commands and
channels used, results, artifacts, skipped checks, validation gaps, and residual
risk. It returns exactly one terminal outcome: `passed`, `failed`, or
`blocked`. A partial run, generic summary, dirty source result, different
revision, unavailable required channel, or missing evidence cannot pass.

Keep local, CI, browser, authenticated provider, staging, and production
evidence distinct. A local session never relabels a weaker channel as the
required one.

## Reconcile and release

Read the terminal result, prove the base and candidate head are unchanged, and
prove tracked source stayed clean. Any candidate drift makes the result
`stale`. A failure, blocker, or drift returns to a Luna/max remediation turn in
the original implementation task after the verifier releases the worktree.
Every changed candidate requires a fresh Luna/max verifier session.

Terminal verification outcomes `passed`, `failed`, `blocked`, and `stale` are
immutable like terminal review outcomes. A stale invalidation is accepted only
while the task is still pending; it cannot rewrite an earlier terminal result.

Record terminal readback, outcome, evidence identity, source-clean proof, and
worktree claim release before archiving the verifier task. The persisted
verifier archive/release transition is authoritative: an implementation archive
or cleanup intent must fail closed until it reads back as archived-known with
the verifier claim released. Never remove the shared implementation worktree
during verifier closeout; it remains owned by the implementation lane until
normal merged-work cleanup.
