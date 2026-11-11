# Closeout, archive, and recovery

A managed task is archive-eligible only when live state proves all of the
following:

- terminal completed state, or an explicitly blocked terminal handoff;
- final result read;
- reconciliation against required deliverables and dependencies;
- no transient needs-attention state or unread user-input/review request;
- exact task and optional host IDs captured;
- archive intent recorded before mutation.

A completed issue session is not archive-eligible until an independent review
has a terminal `clear` outcome and an independent verification session has a
terminal `passed` outcome certified against the same unchanged full live
base/head pair. Never accept independently matching review and verification
pairs: the closeout transition compares one supplied full pair and evaluates
both child records against that exact pair. Both child tasks must retain exact
model/reasoning readback. Supply freshly resolved revisions when recording
archive intent and resolve and revalidate them again immediately before
accepting the authoritative archive result.

The terminal verifier must be authoritatively archived first: its task must
read back as `archive_state: archived`, `status: archived_known`, and
`closeout_result: archived`, and its shared-worktree claim must be released by
the persisted register transition. Only then may the implementation enter
`archive_intent`; the same verifier-archive gate applies before implementation
`cleanup_intent`. A blocked issue session may use its explicit blocked handoff
instead; that exception never invents review or verification proof. Archive
the terminal review first when the workflow requires it, then archive the
verifier and implementation subject; capacity-deferred review therefore keeps
the implementation task, branch, and worktree recoverable.

Archive eligible managed tasks automatically during requested closeout.
Archive is reversible; task deletion is never allowed. Do not archive running,
waiting, needs-attention, ambiguous, unrelated, or still-needed tasks. A
blocked issue session is archive-eligible only after its explicit terminal
handoff is read and reconciled; an ordinary blocked observed peer remains
ineligible.

For an issue-owned session, archival is followed by the exact safe worktree
cleanup sequence in its lifecycle reference. Review and verification sessions
release but never remove their shared implementation worktree. Register and
claim-sidecar writes are one guarded persistence unit; if register persistence
fails after claim synchronization, pre-existing claim bytes are restored and
only newly written candidate claims are removed. Archive success does not
prove release or cleanup. Dirty, unmerged, active, shared, ambiguous, or
evidence-bearing resources are preserved and reported instead of deleted. A
stale review or verification may be archived and cleaned, but neither ever
satisfies the implementation closeout gate. Terminal verification outcomes
(`passed`, `failed`, `blocked`, and `stale`) are immutable; a new attempt uses
a fresh verification task.

Record archive success only from authoritative tool success/readback. Keep the
orchestration task unarchived until it has delivered the final coordination
readback. Self-archive only when explicitly requested or through a later safe
completion action.

To recover a known task:

1. resolve the exact project-scoped register;
2. match an exact task ID, or one unambiguous retained display title;
3. record `blocked` when multiple records match; never guess or ask the operator
   to select an identity;
4. unarchive the exact ID;
5. read live state and return it to the managed set.

Never guess an archived task ID.

A terminal completed or blocked review may be recovered independently for
inspection even when its implementation subject remains archived. A pending or
active review requires its subject task, branch, and worktree to be recovered
first; recovery does not grant authority to restart or mutate either task.

Schema-v2 registers that retained abbreviated Git revisions are upgraded only
after Git re-resolves the abbreviation in the exact recorded worktree to one
unambiguous full object ID. If that worktree is unavailable or the abbreviation
is ambiguous, preserve the register, restore the worktree, and retry; never pad,
guess, or silently discard the managed-session record. Canonicalize legacy
worktree spellings during migration and fail closed if two records resolve to
the same filesystem identity.
