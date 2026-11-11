# Deliverable continuity, measured verification, and external work

Use these sections only when the task has the corresponding deliverables, checks, or external
dependencies. The optional version-1 record fields preserve compatibility with retained records;
new task records should populate applicable sections instead of creating a second state file.

## Keep the user's deliverable contract current

At intake, make a compact list of the requested outcome, named artifacts, issue-first order,
PR/review/merge/deployment expectations, explicit exclusions, user decisions, and the evidence
needed to prove each item. Mark every item `explicit`, `inferred`, or `unknown` with a short source
reference. Do not paste full messages or protected content into the record. An inference cannot
override an explicit user instruction. A later explicit correction changes only the affected
item; retain unrelated requirements and previously granted authority. Treat an explicit request
to implement or fix as authorization for routine in-scope edits, validation, commit, push, and
reviewable PR handoff. Do not convert an internal plan or issue artifact into another approval
gate unless the user reserved that decision or a material choice remains unresolved.

In a task record, use `delivery_contract.requirements` and `changes`. Add or correct an item with
`standard_workflow_record.py contract-update <task.json> <update.json>`; the command writes the
validated updated record to stdout so the caller can review and save it. An update has `id`,
`kind`, named `target`, authoritative `proof_source`, `state` (`required`, `excluded`, or `unknown`),
`authority` (`explicit` or `inferred`), and `source_ref`. Use kind `decision` for a material
user-chosen product or implementation choice; a later change to its target remains in the change
log. Completion requires a fresh `evidence_ref`, not just a prior plan. A requirement's
`status` is `pending`, `complete`, `blocked`, or `not_applicable`. The helper clears stale evidence
when a material requirement changes.

Before each stage, inspect live repository, issue, PR, check, and deployment state for applicable
items. If the user requested an issue first, create or reuse the correct issue before planning or
implementation. If the user later excludes an issue or PR for an explanation-only task, stop that
artifact path. A scope correction is not blanket revocation of unrelated approvals. Before the
final answer, audit each required item against its authoritative current source. `--require-final`
rejects an incomplete required item; a URL in the record is a pointer to inspect, not proof of
current state.

## Measure and schedule verification

Collect existing CI/log measurements before changing the verification plan. For each check, keep
its exact command, claim/surface coverage, required-gate flag, setup time, median and p95 runtime,
mutable resources, reuse policy, measurement timestamp, and evidence reference in the repository
profile's `capabilities.verification_costs`. If timing is unknown, measure a baseline and say so;
do not invent a time saving. Profile setup, build, fixture creation, test body, and cleanup
separately when the repo permits. Compare before/after wall time and resource use with coverage and
failure detection, not duration alone.

`standard_workflow_record.py profile-check <samples.json>` calculates median setup/runtime and
nearest-rank p95 runtime from actual timestamped samples. The input identifies the check, command,
claims, gate, mutable resources, reuse policy, and evidence reference; each sample has
`setup_seconds`, `run_seconds`, and `measured_at`. Retain the source log/CI link as the evidence
reference. Do not use an invented sample or a benchmark from another repository as a current
measurement.

Map acceptance claims to checks. During development and draft-PR handoff, run only focused checks
for affected behavior and consumers. Defer the full suite until merging is requested or reached
under verified merge authority; freeze the merge candidate before that suite. Keep a
`verification_runs` manifest recording check, exact source revision,
environment, platform/architecture, input digest, artifact digest when applicable, phase, duration, outcome, claim refs,
and isolation/capacity evidence for overlap. Use
`standard_workflow_record.py verification-plan <task.json> --profile <profile.json>
--environment <environment> --platform <platform> --input-digests <digests.json>` to see which measured final checks have
an exactly matching passed run. The planner never reuses checks with `reuse_policy: never`, an
unmatched source/input/environment, or an iteration-only run. Recheck volatile external state
before accepting a prior result. If a repeated execution is necessary, record the changed input
or a concrete invalidation reason. Never use a quick unit check to satisfy a required full
integration, production-built Compose, browser, provider, staging, or production gate.

Overlap checks only after proving separate mutable databases, queues, fixtures, ports, and files,
plus sufficient host capacity. Record one `overlap_group` with distinct `isolation_refs` and a
`capacity_evidence_ref`; otherwise schedule serially. Cache or artifact reuse also needs exact
source, dependency, build input, configuration, platform, and immutable artifact identity.

## Recover authenticated sources and resume provider work

Before provider setup, separate independent stable choices from dependent consent and private
credential entry. Record nonsecret answers and the source turn in optional
`interaction_decisions.questions`; store only a reference for private input. Use
`standard_workflow_record.py interaction-plan <task.json>` to bundle ready stable choices into
one concise user question, or identify the next just-in-time action. Increase `ask_count` when
the question is sent; while it remains pending, the planner will not prompt it again. List
safe `independent_work` references so it can continue those tasks while input is pending.
If no independent work remains, wait for input. Do not ask the same answered question or
approval again unless its target or scope materially changes; record that reason. First inspect
the current screen or provider state, prior answers, and the requested outcome. A routine save,
readback, or test within an approved provider setup does not need a new workflow confirmation.
Apply [task authority and concealed secrets](../../agentic-workflows/references/task-authority-and-secrets.md)
to consent, credential creation, secure storage, and required provider controls. A necessary
in-scope approval click can use existing task authority. A terms acceptance, spending
decision, identity grant, or external write needs further authority only when prior
instructions do not cover its actual effect. A saved choice does not prove the provider flow worked.
If an enforced browser, provider, host, or tool rule requires human confirmation, obey it and
identify that requirement and its source in the prompt. Ordinary provider dialogs may be
completed by the agent within existing authority. Do not present a workflow preference as a platform restriction.

Define the requested artifact or live outcome and its source of truth before choosing a channel.
Follow [browser selection](../../agentic-workflows/references/browser-selection.md)
for provider setup, credentials, and authenticated browser sources. Preflight the
selected host channel and honor the user's named browser, profile, or connector.
Record each route with target, opaque
`source_identity`, channel, existing `authorization_ref`, observed state, timestamp, and evidence.
On failure, classify the route as authentication redirect,
permission, stale session, unavailable connector, network, unsupported control, or other. Try a
bounded, already-authorized equivalent channel that reaches the *same* source. Never bypass access
controls, use an unapproved identity, treat an error page as source content, or label a weaker
route equivalent merely because it returns something.
`source-recovery <task.json> --target <target> --source-identity <identity>` selects only a
verified or available authorized route to that exact source. A failed route never counts as a
successful recovery.

Record each provider dependency in `external_work.provider_steps` with exact target and
environment, action, dependencies, required flag, and one state: `pending`, `observed`, `saved`,
`read_back`, `flow_verified`, or `blocked`. Include evidence/timestamp for observed and later
states in the ordered `observations` list; retain earlier observations as the step advances.
Include the exact blocker when blocked. A saved setting is still `saved` until live readback
and the requested flow prove it works. `next-external <task.json>` returns the first unverified
step whose dependencies are verified. Recheck transient provider state when resuming; do not
blindly replay writes. Keep only secret-free identities and references in the ledger.

For a source copy, use `external_work.artifact_checks` to compare the local artifact with the
authoritative pages, sections, tables, or other requested units. Record every expected
`source_unit` and only mark the check verified once `verified_units` covers exactly those units.
For hosted work, test the actual
authenticated target flow and record local, Preview, staging, and production observations
separately. `--require-final` rejects a required provider step without `flow_verified` and a
required artifact check without `verified`. If a required channel truly remains unavailable,
report the specific blocker and continue only independent work.

See [efficiency scenarios](../examples/efficiency-scenarios.md) for compact examples and
[verification-channel rules](verification-evidence-and-release.md) for evidence equivalence.
