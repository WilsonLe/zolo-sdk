# What to look for in a code review

Use this to actively seek counterexamples that disprove the candidate's correctness,
not to manufacture findings. Inventory the full change and affected contracts, then
select probes and depth by risk. Cover every relevant change, including deletions,
surrounding callers and integrations; record unreviewed areas and why they remain
unreviewed. A clean report is bounded evidence, not proof of exhaustive correctness.
Select sections from the actual changed surfaces. For each applicable area, retain
the inspected path, important scenario, and evidence or limitation. Mark an area
not applicable with a brief reason when its omission could otherwise be misleading.
Do not require every project to implement every mechanism mentioned here.

## Coverage evidence

Keep a compact map in the existing review report or caller-owned cycle note. A
small change may use a few sentences; use rows when several boundaries or modes
could otherwise disappear. Group by material entry surface, invariant and affected
subsystem/mode, using repository paths or symbols for stable identities. Do not
generate a Cartesian product of hypothetical attack classes.

For each unit, retain the starting paths and relevant callers, the scenario/control
checked, actual source or local-check evidence, and its coverage state: reviewed,
partial/blocked, unreviewed, or out of scope. An exclusion needs a reason. Reviewed
means that the stated check was completed, not that the surface is vulnerability-free.
A candidate's evidence state is separate: reviewed source can still leave a
needs-validation lead. File counts, test totals and a checklist tick alone do not
show which invariant was checked.

Before finishing, compare the map with the full diff, affected consumers and prior
open questions. Account for deletions, generated artifacts and relevant alternate
entry points/lifecycle modes. Verify generated changes through their canonical
source and generator rather than treating each mirror as an independent review.
Carry gaps into re-review; changed source or conditions invalidate dependent
evidence. Stop at the caller's budget with explicit gaps, not inferred clearance
or another automatic pass. Use the [security review guide](security-review.md)
when a mapped surface crosses a security boundary.

## Requirements, scope, and design

- Translate each acceptance criterion into an observable result. Where does the
  changed path produce it? Does the test assert that result or only call a helper?
  Check omitted roles, platforms, modes, and consumers when the request says all.
- Read the complete changed function and its callers. Has an argument, return value,
  error, side effect, or default changed? Search all consumers, including background
  jobs and generated clients, before deciding compatibility is preserved.
- Check ownership of each invariant. If a rule moves between layers, identify what
  enforces it now and whether any entry point bypasses that layer. Watch for two
  competing sources of truth or an abstraction that hides a required constraint.
- Assess complexity through a concrete cost: duplicated rules that can diverge,
  unclear state ownership, unnecessary coupling, or a helper whose contract callers
  cannot satisfy. Personal naming or architectural preference is not a defect.
- Apply [existing abstractions first](../../engineering-exploration/SKILL.md#existing-abstractions-first).
  If a new boundary is introduced, check why the current owner cannot safely express
  the behavior, its cohesive responsibility, dependency direction, state ownership,
  and input/output or data schemas. Report a concrete cost or violated contract,
  rather than treating every new abstraction as a defect.
- Use [Ponytail](../../ponytail/SKILL.md) for a concrete simpler implementation or
  unnecessary dependency. Keep required shared contracts, validation and tests;
  fewer lines alone are not a finding and do not start another review cycle.
- Apply [project ADR maintenance](../../standard-development-workflow/references/project-adrs.md).
  Read relevant decisions; compare the diff with accepted constraints. Check that
  new material choices, authority evidence, supersession links and index changes
  accompany the implementation, or that the PR justifies no ADR impact. Flag drift
  without rewriting history or accepting a proposal on the author's behalf.
- Inspect deleted code and tests for removed behavior, not only added code. For a
  refactor, compare outputs, side effects, exceptions, and ordering with the base.

## Logic, validation, and boundaries

- Follow branch conditions and early returns. Can a success response occur before
  the work succeeds? Does a failure fall through to success or swallow useful errors?
- Try relevant empty, absent, zero, negative, duplicate, minimum/maximum, and malformed
  values. Distinguish absent from intentionally empty; check inclusive/exclusive
  bounds, integer overflow, precision, units, encoding, and timezone conversions.
- Verify validation at the trusted boundary, including direct API calls that bypass
  the UI. Ensure parsing, normalization, and validation agree about the stored value.
- Inspect collection operations for missing members, wrong ordering, unstable cursor
  assumptions, and mutation while iterating. For pagination, test equal sort values
  and inserts between pages; ask whether results can be omitted or repeated.
- Check domain invariants with a specific example: totals reconcile, money retains
  required precision, inventory cannot go below its allowed bound, or consent
  withdrawal prevents later processing. Derive the invariant from this project.

## Authorization, trust boundaries, and privacy

- For a security-sensitive change, read [security review](security-review.md) and
  select probes from the actual boundary. Establish the strongest existing control
  and try to refute each material candidate before assigning severity.
- Trace actor, action, and resource together. Authentication alone does not prove
  ownership or tenant access. Check reads, writes, list/export endpoints, files, and
  background jobs against the declared policy, including intentional public access.
- Substitute another permitted test user's resource ID. Does the server enforce the
  relationship or merely trust a client-provided owner/tenant field? Check what
  happens when no permission rule matches and when authorization evaluation fails.
- Trace untrusted input to sensitive sinks: SQL, shell commands, HTML, file paths,
  redirects, server-side fetches, deserialization, and tool execution. Identify the
  sink and missing parameterization, encoding, or constraint before claiming an exploit.
  Follow framework escaping and validation to avoid false positives.
- Check newly exposed fields and logs for tokens, credentials, personal data, and
  cross-user leakage. Verify that cache keys and storage scopes include the identity
  required by the policy. Use synthetic data; never print secrets as proof.
- For dependencies and CI permissions, inspect the exact change, its executable
  context, and existing policy. Verify version-specific concerns with authoritative
  evidence rather than asserting that every new dependency is insecure.

## Persistence, transactions, and migrations

- List writes and external effects in execution order. If step two fails after step
  one succeeds, what durable state remains? Does the consumer observe an inconsistent
  result? Check the real transaction boundary rather than assuming adjacent writes
  are atomic. A database transaction does not roll back an external API call.
- Probe repeated delivery or retry after an ambiguous timeout. Is deduplication tied
  to the same logical operation? Can two concurrent requests pass the same check?
  Verify the actual constraint, atomic update, or idempotency guarantee where needed.
- For a migration, consider existing rows, backfills, nulls, uniqueness collisions,
  lock duration at plausible volume, and deployment order. Can old and new app
  versions coexist during rollout? Can rollback read the new state without loss?
- Inspect deletes and cleanup for scope, ownership, reference integrity, and retained
  records. A filter omission or broad path glob can be more important than the
  function's happy path. Do not execute destructive probes against real state.

## Concurrency, asynchronous work, and recovery

- Write down one adverse event order: request A starts, B starts, B finishes, A
  finishes. Can A replace B's current result? Inspect version/ownership checks rather
  than assuming cancellation guarantees that an old callback cannot run.
- Trace success, rejection, timeout, cancellation, unmount, and retry. Are resources,
  locks, leases, subscriptions, and busy states released on every terminal path?
- For workers, identify acknowledgement order, crash windows, lease expiration, and
  duplicate delivery. Can a crash lose work or repeat an external effect? Check
  whether failure is retained for retry instead of being marked completed.
- Verify retry bounds and whether the retried operation is safe to repeat. Examine
  backoff, timeout budgets, and cancellation propagation when these are relevant;
  do not prescribe infrastructure solely because asynchronous code exists.
- For caches and offline state, trace stale data, invalidation, reconnect, and identity
  changes. Ensure a previous user's data cannot become another user's initial state.

## APIs, configuration, dependencies, and performance

- Compare request/response shapes, status codes, error contracts, defaults, and
  serialization with consumers. Test an old client against a new optional/required
  field; distinguish a documented breaking change from an accidental one.
- Check config parsing, missing values, feature flags, and supported disabled modes.
  Verify manifests, lockfiles, build outputs, and generated clients agree. Consult
  the installed dependency version before assuming an API or platform feature exists.
- Look for work proportional to unbounded input: queries inside loops, full-table
  reads, eager buffering, repeated rendering, or blocking I/O in a shared execution
  path. State a plausible input size, operation count, or measured effect; avoid
  calling code slow because it looks verbose.
- Check changed startup, health, rollout, and rollback behavior against the runbook.
  A build passing does not prove that migrations, permissions, workers, or external
  integrations work in the intended environment.

## User interfaces and accessibility

- Exercise the changed interaction when available: initial, loading, empty, success,
  and error states. Check keyboard access, focus after updates, semantic labels,
  error discoverability, and whether assistive technology receives relevant status.
- Try a slow operation and repeated submission. Does the control convey busy state
  and prevent unintended duplicate effects? Check current repository conventions
  rather than inventing a new global loading design.
- Check relevant narrow layouts, long content, localization, and unsupported/offline
  states. Inspect actual output for visual claims; source-only review cannot verify
  that a rendered control is visible or usable.

## Tests, documentation, and agent instructions

- Map tests to behavior and risk. Check assertions about returned and durable results,
  not merely invocation counts. Can a mock remove the boundary where the bug occurs?
  Do fixtures represent supported roles, data, and failure conditions?
- Derive expected results independently of the implementation under review. Would
  wrong values, omitted records, or reordered results fail the check? A fixture
  computed by the same faulty helper can conceal the defect.
- Inspect changed assertions, deleted tests, skips, snapshots, and broad exception
  handling for concealed regressions. For a bug fix, ask whether its regression test
  fails on the original behavior. Avoid demanding redundant tests for trivial edits.
- For a bug fix, reconcile the discovered cause family against owner/callers/consumers
  and supported states under [runtime diagnosis](../../engineering-diagnosis/SKILL.md#cover-the-cause-family).
  Check branch/leaf inclusion and exclusions even if the request names one symptom.
- Inspect independently expected and actually observed consumer results under
  [actual outcome checks](../../engineering-diagnosis/SKILL.md#verify-actual-outcomes).
  Ask whether stored inputs or controlled model text conceal the missing renderer,
  live-model behavior, or durable effect. Report the exact unverified boundary.
- Prefer a targeted counterexample at the right seam over blanket coverage quotas.
  Keep required full-CI evidence separate from reviewer-run focused checks.
- Verify user docs, examples, commands, manifests, and generated copies against the
  resulting behavior. Follow the source-of-truth generator; do not fix mirrors alone.
- When the diff changes a skill, workflow, or policy, treat instructions as executable
  contracts: check trigger, actor, required inputs, sequence, authority, stop condition,
  and observable completion. Walk through happy, failure, and resumed-task scenarios.
  Look for contradictory entrypoint/reference rules and unreachable required tools.
- Check that a resume or updated commit cannot reset a bounded budget, stale evidence
  cannot satisfy a new candidate's gate, and fallback wording does not weaken an
  approval or verification requirement. Text-marker tests prove presence, not that
  an agent follows the instructions; state that limit.
- After material fixes, challenge the final changed state against the original
  acceptance criteria, earlier findings and their dispositions. Trace interactions
  and newly introduced regressions, verify fixes with meaningful evidence, and bind
  the review to the final base/head. A green test run cannot certify that review.
- Inspect the terminal handoff contract: does the user receive actual summary text
  in chat explaining the resulting behavior, meaningful structure, review results,
  verification and limits alongside the PR link? A detailed PR body alone does not
  satisfy a required self-contained chat summary.

## Worked examples: findings and restraint

These are synthetic examples, not findings about the current repository. Actual
findings must cite real files and verified conditions.

**Ownership omission.** A new `DELETE /projects/:id` handler authenticates the actor,
then deletes by `id` alone. Inspection confirms no middleware or service ownership
check and that projects are private to an owner. Useful comment: "[P1] Constrain the
delete to the authorized owner. A signed-in user can supply another user's project
ID and delete it because this query filters only by ID. Apply the resource policy
before deletion and test user A deleting user B's project: it must be rejected with
the row intact." If existing middleware already enforces that relationship, withdraw
the concern rather than demanding a duplicate guard.

**Out-of-order UI result.** A search effect stores every response without checking
the active request. Useful comment: "[P2] Ignore superseded search results. If the
query changes from A to B and B resolves first, A's later response replaces the
displayed B results. Bind updates to the current request and test the B-then-A
completion order." "Async code may have race conditions" alone is not a finding.

**Partial write.** A handler commits an order and then inserts required line items
outside a transaction. A failed insert leaves a visible empty order, contrary to
the domain contract. Name that failure point, the durable result, and the needed
atomicity or recovery contract. Do not suggest wrapping an external payment in a
database transaction as if it could roll back the payment.

**Unsupported criticism.** "Use a different state library," "add more tests," or
"this loop is inefficient" lacks a demonstrated violated contract. Investigate a
specific stale update, uncovered failure, or input-dependent cost first. If none
exists, omit it or clearly label a proportionate suggestion non-blocking.

## Sources and scope

The general review dimensions and comment discipline are informed by Google's
[review checklist](https://google.github.io/eng-practices/review/reviewer/looking-for.html)
and [comment guidance](https://google.github.io/eng-practices/review/reviewer/comments.html).
The authorization prompts draw on OWASP's
[Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
The concrete probes and examples here adapt those principles to this skill; they
are not mandates to copy another organization's internal policies. Check the
repository's own requirements and current official API documentation for each review.
Coverage evidence and security candidate falsification also adapt
[Cloudflare's security-audit workflow](upstream.md), with our existing diff scope,
static-proof allowance and bounded review policy retained.
