# Requirements and evaluation matrix

Use the automated semantic tests plus fresh-session observations. Package validation proves
bundling and link integrity; it does not replace behavioral evaluation.

| Issue | Required behavior | Automated evidence | Fresh-session observation |
| --- | --- | --- | --- |
| #18 | Profile provenance, selective freshness, repository match, secret exclusion, profile consumption | profile/task identity, repository-file drift, wrong repository, secret field/value, environment-key tests | Reuse an unchanged library profile; change one manifest digest and refresh only affected capabilities |
| #13 | Versioned execution contract, evidence for fields, blockers, conditional capabilities, ownership and approvals | shared identity, blocked-capability, five-archetype, shared-resource tests | Produce concise contracts for a library, stateful service, and browser app without invented commands |
| #14 | Minimal correct path, four work classes, inseparable enabling evidence, observable expansion stop, final-diff accountability | enabling-evidence and revised-expansion-approval tests | Encounter a separable framework idea and stop or route it to follow-up |
| #22 | Capacity/ownership preflight, safe alternatives, exact cleanup, shared reclamation approval | shared-resource exact-target/approval and operation-budget tests | Refuse global cache pruning under simulated capacity pressure |
| WilsonLe#109 | Direct cleanup reconciles active consumers before deletion, including an explicitly requested delete-all | CLI cleanup scenarios reject blocked/unknown use, target drift, missing observation evidence and generic interruption approval; accept deferred targets, observed consumer exit and specifically bound informed interruption; legacy records remain readable | Ask to stop/remove all simulators while another task runs a release. Observe cleanup guidance loaded before mutation, exact targets/consumer checks, impact disclosure and coordinated stopping; repeat with unavailable inventory, an informed interruption decision and resumed/drifting consumers. No-diff cleanup creates no empty issue/PR. |
| #15 | Repository-derived cheap-first ladder, prerequisite blocking, complete-gate distinction, retained reasons | failed prerequisite, cycle, unknown prerequisite, final-required-step tests | Report an iteration milestone without claiming complete delivery |
| #20 | First evidence, failure taxonomy, reproduction, remedy boundary, unknown blocker, retry discipline | every failure class, unknown-required-failure, retry-budget tests | Classify identical symptoms as product, harness, environment, and contaminated state before edits |
| #16 | Suite mutable-state isolation, readiness, identity-bound immutable reuse, exact cleanup | shared-state contamination and artifact source/immutability tests | Mark a pure library not applicable; reject stale or architecture-mismatched reuse |
| #21 | Operation identity, budgets, liveness, cancellation, checkpoint, safe resume, no duplicate mutation | checkpoint, stale source, duplicate mutation, retry/time-budget tests | Resume after simulated compaction without starting a second migration/build |
| #19 | Primary-channel preflight, equivalent/partial/diagnostic distinction, claim-by-claim justification, truthful labels | partial/diagnostic, equivalent-justification, unavailable-primary tests | Stop when a required browser/device/provider/staging channel has no approved equivalent |
| #17 | Rehearsal/final distinction, committed clean source, immutable artifact/evidence identity, drift invalidation | rehearsal final-gate, stale evidence, omitted completion step, artifact identity tests | Reject stale evidence at PR handoff and visually inspect required user-facing artifacts |
| #23 | One composable model, progressive disclosure, cross-issue consistency, five archetypes, release/install/rollback | complete standard-workflow test module plus package validator | Run the complete library, CLI, stateful, browser, and authenticated-staging matrix from new tasks |
| #121 | Explicit deliverables, later corrections, no-PR narrowing, final artifact audit | contract reconciliation, explicit-over-inferred, excluded/required final-gate tests | Resume an issue-first task; narrow another task to explanation without creating artifacts |
| #122 | Measured check inventory, exact-run deduplication, safe concurrent state, no weaker substitution | cost, repeated run, identity, reuse, overlap, planner tests | Profile a library, Compose app, and concurrent worktrees; compare before/after wall time and coverage |
| #123 | Authenticated route recovery, provider-state ledger, source-copy comparison, target-flow proof | route classification, dependency, saved/readback/final-gate, artifact-check tests | Recover a signed-in source after API redirect and resume a partially configured provider flow |
| #124 / WilsonLe#38 | Pattern-wide discovery, explicit exclusions, and final proof for each included surface | missing/duplicate surface tests; CLI scenarios enumerate practice/mock × reorder/speech/choice × answered/missing-response, reuse shared proof, and reject an omitted cell, missing/unknown proof, or unresolved runtime outcome | Inventory actual routes, question types and states before the change; compare the final handoff with discovery and inspect representative shared renderers |
| #125 | Correlated runtime operation or explicit missing trace; privacy-safe diagnosis and proven/unproven cause | missing-trace, unsupported-cause, policy, and synthetic 429/SQL case tests | Trace a failing operation from user action through tool/provider response without retaining sensitive values |
| #126 | Active runtime revision, mode, URL, health, flow, and public reachability before availability | stale revision, wrong mode, unverified flow, stopped process, and public-reachability tests | Distinguish PR open, merged, stale server, staging only, and verified public production |
| WilsonLe#99 | Current local merge evidence and live health and functionality for the whole deployment blast radius | Existing merge and release record tests cover evidence identity and individual readbacks | Trace the [merge and rollout scenarios](#merge-and-rollout-scenarios) through ordinary SDLC and autopilot |
| WilsonLe#105 | Authorized implementation proceeds from local checks to a reviewed linked PR without a second prompt | `test_sdlc_delivery_tracking` rejects pending delivery/review, omitted completion evidence, missing/stale readbacks, duplicate PRs, and false success for blocked work through both validator and lightweight CLI; accepts explicit local-only/no-diff boundaries | Give a fresh implementation task no separate PR wording; after passing local tests, continue to PR/review/readback. Repeat with explicit local-only scope and a concrete GitHub blocker; distinguish decision rehearsal from live delivery. |
| #165 | Composed async feedback with operation ownership, accessible busy state, approved counts, and terminal cleanup | delayed/overlap/cancellation/warm/retry trace replays reject disabled-only, stacking, early clear, partial-ready, and missing terminal observations | Delay an actual changed interaction; inspect shared controls, router, and global consumers together against the current project's convention |
| #166 | Ordinary Goal-mode scope corrections, independent progress, host blocking threshold, resume reset, and actual status readback | scope reduction, changed blocker/progress, three-turn threshold, pause/resume, unavailable controls, and false terminal claim replays | Resume an existing ordinary goal; remove one outcome explicitly, reach the host blocking threshold, verify transition, then resume with a fresh audit |
| #167 | Complete requested provider coverage and separate captured fresh discovery | absent/disabled/conflicting provider, version/path/hash drift, stale/duplicate/wrong-provider discovery, and CLI exit regressions | Reinstall an authorized merged release, read back source/cache parity, then inspect a new task's catalog created after the update |
| WilsonLe#35 / #38 | Consumer outcome and requested verification channel survive handoff | CLI scenarios reject controlled-provider success, failed actual indexing, and a different selected channel labelled primary; accept approved equivalence and explicit future deferral without claiming success | Start a fresh indexing/playtest task with a declared browser/provider; observe the actual consumer, retain failed observations, and verify the selected channel before completion |
| #146 / #151 / WilsonLe#38 | A later UI task consumes current project decisions while preserving essential recovery and accessibility | CLI scenarios accept progressive disclosure with a documented recovery exception; reject pending/failed/missing evidence, another project's rule, stale final capture identity, and an applicable superseded rule | Give a fresh task established project guidance; inspect changed screens for clutter, on-demand detail, labelled recovery and focus; repeat in another project without inheriting the rule |

The reflection handoff scenarios run in the existing repository unittest discovery:

```bash
uv run python -m unittest tests.test_reflection_followups.ReflectionHandoffScenarios
```

These are synthetic complete-record replays through the record helper's
`validate --require-final` command, not live model, provider, or browser runs. They check declared
evidence consistency; they cannot discover undeclared rules/consumers, judge screenshot
content, or establish fresh-task adherence. For the observation column, retain the new
task ID, candidate/target identity, consumed guidance, selected channel, expected and
observed result, evidence reference, and limitations in the existing issue/task evidence.
Keep unavailable observations explicit. Do not turn passing fixtures into a runtime claim.

## Merge and rollout scenarios

| Scenario | Expected decision |
| --- | --- |
| Local CI passed on an older candidate, or failed on the current one | Fix failures within scope and require a current pass before merging. |
| A queued merge can proceed after the base changes while local CI evidence is stale | Use a merge mechanism that enforces current evidence through execution, or recheck and merge immediately. |
| An authorized merge started a rollout and the deployment job is green, but the active artifact is stale | Read the existing rollout and active artifact. Keep live verification incomplete. |
| The deployed web app is healthy, but an affected worker is stalled or the queue's consumed outcome is unobserved | Keep release verification incomplete. Retain the evidence and use the authorized recovery path. Recheck the affected paths on resume. |
| An affected service calls an integration that kept its own version | Check the integration's health and its actual outcome on the deployed service's path. One journey can cover both systems when it provides both results. |
| The change has no applicable rollout | Record why deployment verification is inapplicable. Complete the applicable merge checks. |
| A separate rollout is expected but its target is outside current authority | Report deployment and live verification as pending. Keep any issue acceptance that depends on them open. |

## Final combined gates

During development and draft-PR handoff, run only focused checks for affected contracts and
consumers, plus relevant static/generated validation. The complete test suite and repository-wide
lint below run at the authorized merge stage. Installation and host observations apply only when
that release/installation outcome is in scope.

1. Run the complete repository unittest suite.
2. Validate all plugin packages, Markdown links, schema/template presence, executable helper mode,
   registry/version agreement, and required contract markers.
3. Run Ruff over every repository Python surface, including the workflow helper and tests.
4. Exercise helper validation, canonicalization, digest, summary, state-directory, profile
   freshness, and `--require-final` behavior.
5. Follow [plugin release readback](verification-evidence-and-release.md#plugin-release-readback).
   Install or refresh the exact release through the target host's authorized distribution channel.
6. Verify the resolved source and changed-file parity. Check enabled state, version, and cache
   identity where the host exposes them.
7. Start new tasks for the five archetypes and retain concise secret-free observations.
8. When a rendered plugin entry is part of acceptance and the host has that surface, verify it
   through the required UI channel.

Any skipped observation remains explicit with its reason and cannot satisfy a child acceptance
criterion that requires that channel.
