# Validation, failure diagnosis, state isolation, and resumability

## Repository-derived validation ladder

Build the ladder before implementation approval from repository instructions, manifests, task
runners, CI, test configuration, nearby changes, and generated-artifact rules. For every step
record its exact supported command or manual boundary, evidence source, prerequisites, mutable
resources, cost class, applicability, failure meaning, completion requirement, result, commit
identity, and skip reason.

Order applicable checks:

1. read-only integrity and scope;
2. syntax, static, configuration, and generated-artifact checks;
3. focused unit and contract tests;
4. builds and migrations;
5. stateful integration;
6. browser, device, and manual evidence;
7. authorized external or staging verification.

A failed prerequisite blocks dependent expensive work except bounded diagnostics of that same
failure. During development and draft-PR handoff, use only the focused steps covering changed
behavior and affected consumers; broaden the focused selection when impact is ambiguous. Record
full-suite checks as deferred to an authorized merge stage, not passed or waived. Focused checks
can satisfy draft-PR handoff, but cannot establish full CI parity or merge readiness. Once merging
is requested, run the complete repository-required suite and fix failures before merging.

For behavior that needs automated coverage, choose the highest practical seam that exercises
the observable path and compare it with nearby test patterns. When a test-first loop gives a
sharp signal, observe the relevant test fail, make the smallest change that turns it green,
then refactor with the test still passing. Avoid tests that only repeat implementation
details or add no useful risk coverage for a reversible, low-impact change.

Use the measured cost inventory and exact run manifest in
[efficient delivery and external work](efficient-delivery-and-external-work.md) to avoid repeating
an unchanged final check. Reuse never weakens a mandatory gate or crosses an environment boundary.

## Diagnose before patching

Preserve first-failure evidence before cleanup or rerun. Classify every required failure as:

- product;
- test or automation harness;
- fixture or shared-state contamination;
- environment or configuration;
- platform, architecture, or tooling;
- external dependency or service;
- known expected behavior;
- nondeterministic;
- unknown.

Use the smallest safe reproduction and a clean-state comparison when state is relevant. Compare an
unaffected baseline only when safe and meaningful. Edit product code only after product-cause
evidence. Edit tests only after proving the assertion, locator, timing, or fixture is defective
without weakening intended behavior. Retries, broader selectors, timeout increases, and skips need
a diagnosed cause; they are not diagnosis. Unknown required failures block review unless explicitly
accepted by the user or repository policy.

The failure ledger retains first evidence, reproduction, classification evidence, remedy, affected
reruns, and acceptance state without secrets.
For live application failures, follow [runtime-diagnosis.md](runtime-diagnosis.md): read the
active revision and correlated operation before claiming a root cause. A missing trace is a known
evidence gap, not a reason to guess. Record only sanitized trace references and a bounded
redaction, retention, and access policy.

## Validation sandboxes and artifacts

Inventory each suite's databases, object stores, queues, caches, files, test users, fixtures,
accounts, ports, migrations, readiness signals, and cleanup targets. Separate suite-owned mutable
state whenever one suite can change data observed by another. Sharing requires explicit repository
evidence on both suites. Concurrent sandboxes also require sufficient capacity and repository test
support.

Reusable artifacts bind to:

- committed source identity;
- dependency, configuration, generated-file, and declared build-input digest;
- exact build-command evidence;
- platform and architecture;
- immutable artifact digest;
- successful output verification.

Any relevant drift invalidates reuse. Mutable tags, filenames, paths, and timestamps do not prove
identity. Cleanup targets only exact task- or suite-owned resources and never performs global
pruning.

## Long-running operations

Before work expected to outlive a normal tool call or commentary interval, record:

- purpose and acceptance claim;
- exact command or tool, working directory, source identity, and input digest;
- expected outputs and ownership;
- mutation and dependency boundaries;
- soft and hard time budgets;
- trustworthy liveness and progress signals;
- safe cancellation and cleanup;
- resumability and restart rules;
- stable operation, checkpoint, and mutation identities.

States are planned, running, stalled, failed, cancelled, completed-unverified, and verified. A
checkpoint is evidence of progress, not proof of output correctness. On resume or after compaction,
inspect the live process, source/input identity, outputs, and checkpoint before launching anything.
Never duplicate a mutating operation. Invalidate checkpoints after relevant source, input,
environment, or output changes. Bound and justify retries. Report only meaningful state changes or
milestone timeouts, not unchanged polls.

Apply this contract proportionately to slow local processes, container or cross-architecture
builds, artifact transfers, migrations, exhaustive suites, browser captures, and hosted CI waits.
Mark unsafe, atomic, or unsupported operations non-resumable and document their recovery boundary
instead of pretending they can continue.
