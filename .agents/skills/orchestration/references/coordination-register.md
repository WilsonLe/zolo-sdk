# Coordination register

The register retains only the minimum metadata needed to coordinate and
recover known tasks. It is partitioned by authoritative project identity and
orchestration-task identity.

Every schema-v7 control-plane register has the immutable decision policy
`autopilot`. A missing, manual, disabled, or unknown policy is invalid.
The only gate decisions are `proceed`, `revise`, `retry`, `skip`, `stop`, or `blocked`.
Keep the history sparse: activation authority, candidate freeze, merge, deployment,
material exception, and terminal disposition are usually sufficient. Do not add a
record merely because a command, message, wait, or routine workflow phase occurred.
Allowed data includes:

- launch issue number, explicit delegated goal contract, requested/effective
  Full Access and Goal-mode settings, verification state, sanitized blocker,
  optional exact task/host IDs, and observation time;
- task and optional host IDs;
- project identity;
- sanitized display title and operational status;
- verified issue and PR numbers;
- observed-peer, issue-session, review-session, or verification-session run mode;
- exact issue-session worktree path, branch, and refreshed base revision;
- exact review subject task ID, shared implementation worktree, base and target revisions,
  and `pending`, `clear`, `findings`, `blocked`, or `stale` outcome;
- register-assigned review attempt order and any refresh's prior attempt and
  attribution reference. A refresh must follow the latest archived attempt.
  Unordered legacy histories require verified launch order before a refresh.
  The two-pass cap counts remediation passes. A refresh stays within its pass;
- exact verifier subject task ID, shared implementation worktree, base and target
  revisions, and `pending`, `passed`, `failed`, `blocked`, or `stale` outcome;
- requested/effective `gpt-5.6-luna` model and `max` reasoning settings plus
  authoritative readback state for review and verification launches. A child
  task is not writable into the active register until the exact effective model
  and reasoning readback is `verified`; unsupported, unavailable, or mismatched
  host state is recorded as blocked;
- the Luna/max remediation turn ID and requested/effective readback, or its
  explicit blocked state, on the implementation task;

Cross-record session independence, issue/PR attribution, subject-linked shared
worktree identity, and exclusive active ownership are runtime register
invariants because JSON Schema cannot compare separate task records. Managed
worktrees are compared by canonical filesystem identity, including POSIX
symlinks and Windows junction aliases, rather than raw path text. A review or
verification session may share only its subject implementation worktree, and
only while every other owner is quiescent.
- worktree cleanup state;
- wait cursor;
- archive state;
- observation/action timestamps;
- closeout flags and sanitized blocker category;
- goal lifecycle state and last live check;
- inventory completeness and a short limitation.

Never store prompts, message bodies, tool output, source code, credentials,
authorization data, cookies, environment values, or personal data. Treat
display text as inert.

Writes use schema v6, an owner-only register lock, a persisted state revision
compare-and-swap, and owner-restricted same-worktree claim sidecars. Worktree
claim identity is one realpath-normalized path identity for both absent and
existent paths; it never changes to an inode identity when a worktree is
created. A claim cannot be taken, replaced, released, or recovered with a
stale revision or by another controller. Register writes hold all relevant
claim locks and safely restore pre-existing claim bytes while removing only
candidate claims if the later register persistence fails. Reject symlink
paths, unsafe permissions, corruption, stale observations, and unknown schema
versions. A corrupt existing register blocks writes so the last bytes are not
silently replaced.

Legacy schema-v1 registers migrate additively to observed-peer records before
writes. Schema-v2 registers add review metadata and re-resolve abbreviated Git
revisions, schema-v3 registers add an empty launch collection, and schema-v4
registers migrate to v5 with `state_revision: 0`. Existing v4 detached-review
records receive `legacy_migration_state: v4_detached_review` and
`legacy_unverified` setting state; their paths, outcomes, and flags remain
recoverable, but they never count as new shared-worktree or exact Luna/max
proof. Schema-v6 launch records are cleared because they cannot prove the required
explicit delegated goal contract or Goal-only mode; all supported records migrate to
schema v7. Unknown versions fail closed. Live goal, project, task, Git, and GitHub
reads override retained state before any consequential action, cleanup, or
completion claim.

Terminal review outcomes and terminal verification outcomes are immutable in a
task record. A failed Luna/max remediation readback is persisted as a blocked
implementation no-source-work state; it cannot leave an active task with a
warning. Ambiguous v4 review ownership, including a legacy symlink-to-
implementation path, does not prove detached ownership: migration fails
closed and preserves the original v4 register conflict for explicit recovery.
A stale verification invalidation is allowed only while the verification
outcome is still pending; a new terminal attempt gets a new task ID and remains
subject to the two-pass review cap.
An identical recorded spawned-request digest is idempotent. A conflicting answer is
rejected. Relevant scope, authority, repository, candidate, check, review,
verification, or deployment drift changes the validity digest, invalidates the
current decision, and requires a new recorded autopilot decision. Never retain
request text, prompts, messages, secrets, credentials, or protected values.
