# Workflow-record archetype examples

These examples show applicability decisions, not commands to copy. Repository evidence supplies
every real command, path, service, account, and verification channel.

| Archetype | Capability profile | Task-run decisions | Final evidence |
| --- | --- | --- | --- |
| Small library | Static, unit, package metadata; no services, browser, reusable artifact, or staging | One focused-to-complete validation ladder; sandbox, operation, resource budget, and artifact sections not applicable | Committed source plus complete static/unit results |
| CLI/package | Static, unit, build/package commands and supported platforms | Immutable artifact bound to source, lockfile/build-input digest, command, platform, and package digest | Source, package digest, complete tests, and CLI behavior claims |
| Stateful service | Migrations, database, queues, integration commands, readiness, ports, and cleanup ownership | Separate suite-owned mutable state; resource/capacity preflight; failure clean-state comparison | Source, migrations, integration results, state identities, limitations |
| Browser application | Build/runtime commands, browser channels, responsive and accessibility boundaries | Browser suite isolated from integration state; requested channel preflight; interaction and visual claims kept distinct | Source/artifact identity plus inspectable responsive, interaction, console, and accessibility evidence |
| Authenticated staged service | Local and staging commands, provider/account boundary, external approvals, deployment identity, rollback | Local completion precedes separately approved staging; local evidence cannot satisfy deployed claims; long deployment/check operations checkpointed | Squash-merged source, immutable deployed artifact, authenticated staging channel, logs/health, and rollback readiness |

## Required negative scenarios

- a changed instruction, manifest, lockfile, CI file, runtime definition, or deployment runbook
  invalidates only affected profile sections;
- a blocking unknown cannot become implementation-ready;
- an unapproved material expansion stops work;
- insufficient capacity does not authorize shared-cache reclamation;
- a failed prerequisite prevents an expensive dependent validation;
- product, harness, fixture, environment, platform, external, expected, nondeterministic, and
  unknown failures retain distinct remedies;
- shared mutable suite state without safety evidence is rejected;
- mutable tags, stale inputs, architecture mismatch, or unverified output invalidate artifacts;
- a compacted session inspects a checkpoint before resuming and never duplicates a mutation;
- partial or diagnostic channels cannot satisfy a required claim;
- rehearsal or drifted evidence cannot satisfy the PR, merge, or staging gate.

## Engineering judgment scenarios

These are instruction walkthroughs, not measured agent-performance results. Use them
to challenge a proposed workflow or design before adding another mechanism.

| Request and evidence | Expected decision | Counterexample to reject |
| --- | --- | --- |
| Simplify a test selector; every CI run already executes the full suite | Check whether the selector still has a useful consumer; adapt or remove the existing mechanism within scope | Reorganize the selector without establishing its value |
| Local database policy fails because setup uses a role name different from the canonical migration | Align the responsible setup contract and verify the intended policy path | Copy a second policy into setup to compensate for the mismatch |
| Replay captures and returns an ordered sequence | Supply known input independently, then compare returned values, completeness, and order; show that a wrong sequence fails | Assert only that the recorder was called or derive expected output from its implementation |
| One game needs a recording fix; other games work | Complete and verify that game's vertical path using the existing owner | Expand to unrelated games or invent a shared framework without necessity evidence |
| Existing parser cannot represent a required second protocol safely | Explain the limitation; define one protocol responsibility, dependency direction, input/output schema, validation, errors, and compatibility | Reject all new abstractions, or introduce an unbounded generic parser with hidden dependencies |

## Pre-implementation stage walkthroughs

These are instruction walkthroughs, not measured agent-performance results. Each
task completes grilling, planning, and design specification with proportionate
artifacts in the same tracking issue/plan before authorized implementation.

| Request and evidence | Grilling → planning → design specification | Authorized next action |
| --- | --- | --- |
| Small fix with settled expected behavior and an existing owner | Reuse the accepted requirement without a question round; record the affected owner/checks and order; specify the behavior change, preserved interface, and failure expectations in a concise issue note | Implement within the existing request; no repeated plan/design confirmation |
| Ambiguous account-data feature | Inspect current storage first; ask the user the material retention choice with a recommendation before dependent questions; plan affected consumers and checks; specify ownership, lifetime, validation, errors, and compatibility | Block dependent coding until the material decision and final contracts are resolved; continue independent research |
| User asks for a plan only | Clarify unresolved requirements; produce the requested sequence and verification mapping; include a design section if needed to make that plan usable | Deliver the requested planning artifacts and stop before implementation |
| User asks for a design specification only | Reuse settled requirements; outline relevant scope/evidence; finalize contracts and alternatives in the existing design owner and link it from the issue | Deliver the requested design and stop before coding, committing implementation, or opening an empty PR |
| Resume after the user changes the accepted data-retention rule | Read current issue/plan; reopen only the affected decision branch; update sequence/tests and ownership/lifetime/recovery contracts in the same artifacts | Reconcile the affected outputs; seek a decision only if the change exceeds existing authority |
| Direct SDLC loop with a complete trusted goal | Inspect facts and reuse accepted choices; write the minimal ordered plan; finalize contracts under the verified envelope | Continue authorized delivery without manufacturing an interview or inferring production authority |
