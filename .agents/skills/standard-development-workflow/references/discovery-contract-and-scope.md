# Discovery, execution contract, scope, and resources

## Repository capability profile

Discover capabilities only from repository instructions, manifests, lockfiles, task runners, CI,
test configuration, deployment runbooks, local tool inspection, and explicitly authorized
read-only external checks. Record supported setup, static, generated-artifact, test, build,
browser, release, and deployment commands with evidence locations. Also record:

- runtime and tool versions;
- services, interfaces, readiness signals, ports, and mutable stores;
- environment key names and classifications without values;
- browser, device, provider, and control channels;
- CI checks, platform and architecture limits, registries, networks, and credential prerequisites.

Live GitHub, provider, deployment, credential, capacity, and listener state is transient even when
the profile file is unchanged.

## Task execution contract

Before implementation, read back the authority already present in the request or prior decisions:

- objective, issue, repository, base branch, resolved revision, and consumed profile digest;
- applicable instructions and skills;
- dedicated worktree and exact mutable-resource ownership;
- allowed, expected, prohibited, and not-applicable change surfaces;
- dependencies and environment key names without values;
- ordered iteration, completion, build, runtime, browser, evidence, review, cleanup, and deployment
  gates that actually apply;
- required approvals, stop conditions, deliverables, and definition of done.

Every field cites user or repository evidence or remains explicitly unknown. Only an unknown
that prevents a safe in-scope choice blocks the dependent work; continue independent authorized
work. Cached or example content never fills an unknown fact.
For a pattern-wide request, enumerate discovered consumers and their inclusion decisions before
selecting a shared fix; follow [impact-inventory.md](impact-inventory.md).

## Minimal correct path

Before selecting a change, apply [existing abstractions first](../../engineering-exploration/SKILL.md#existing-abstractions-first):
inspect the current owner, consumers, and useful behavior; adapt that owner before adding
a boundary. Any necessary new abstraction needs an atomic responsibility, explicit
dependencies and state ownership, and clear schemas. These design checks do not add a
routine approval gate; the material-expansion rules below still apply.
Apply [Ponytail](../../ponytail/SKILL.md) to implementation and dependency selection
inside that boundary. Complete the requested scope and required verification; a
smaller solution does not authorize weaker evidence or a skipped delivery gate.

Classify every planned change:

- **direct**: necessary for the requested observable outcome;
- **enabling**: necessary because no safe supported path exists, with evidence explaining why it
  cannot ship separately;
- **follow-up**: useful but independently deliverable;
- **prohibited**: unrelated or explicitly outside scope.

Record the expected component or file-family envelope without imposing a universal file limit.
Correctness and repository policy outrank minimal line count.

Stop and reopen planning when implementation introduces:

- a new subsystem, framework, persistence model, deployment mechanism, or public interface;
- shared infrastructure absent from the approved plan;
- a materially larger changed-path envelope;
- a migration, credential, external mutation, or rollback model not approved;
- removal, weakening, or substitution of an approved verification gate.

Route separable generalization or cleanup to a new spec-ready issue. At PR handoff, account for
every final-diff deviation from the approved envelope.

Examples:

- A small defect normally changes the failing component and a focused regression test; a new
  framework is follow-up work.
- A data/schema change may inseparably require the migration, compatibility read path, rollback,
  and migration tests identified in the approved plan.
- A cross-cutting framework limitation is enabling work only when repository evidence shows the
  requested outcome cannot be delivered safely through an existing boundary. Otherwise create a
  separate issue.

## Resource budget and ownership

Before expensive builds, transfers, stateful stacks, media capture, emulation, or exhaustive
suites, inventory proportionate capacity:

- free disk and expected growth;
- memory, CPU, concurrency, and emulation cost;
- ports and listeners;
- container, image, cache, database, filesystem, and evidence ownership;
- registry, network, transfer, and remote-runner constraints.

Classify each resource as task-owned, repository-shared, host-shared, or external. Prefer exact
task-owned cleanup, verified immutable reuse, lower safe concurrency, native-platform execution, or
an authorized supported runner. Never globally prune, delete a shared cache, broadly terminate
processes, or reclaim unrelated resources without explicit authorization after resolving exact
impact and recoverability. Insufficient capacity is a blocker, not authority to clean the host.

Report exact reclaimed targets, ownership evidence, expected impact, and recovery. Lightweight
tasks may mark the resource budget not applicable.

For UI work, apply [project UI conventions](project-ui-conventions.md) before selecting copy or components.
