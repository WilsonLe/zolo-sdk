# Spec-ready GitHub issue contract

A spec-ready issue is an implementation-planning input, not a vague idea and not a hidden design
document. It gives a capable engineer enough verified context to produce an exhaustive plan without
guessing about intended behavior.

## Required issue content

1. **Title and outcome** — one concrete, searchable outcome.
2. **Problem and user impact** — who is affected, what is wrong or missing, why it matters, and the
   desired outcome without prematurely dictating an unsupported solution.
3. **Evidence and current behavior** — reproducible observations, relevant URLs or screenshots,
   logs with secrets removed, existing code paths, related issues or pull requests, and the
   repository revision or environment inspected.
4. **Proposed behavior** — observable behavior after completion, including important states,
   workflows, error handling, compatibility, and edge cases.
5. **Scope** — included surfaces, components, users, data, APIs, and environments.
   For pattern-wide language, attach the discovered-consumer inventory, inclusion/exclusion
   reasons, shared implementation point, and planned proof for every included surface.
6. **Non-goals** — plausible adjacent work intentionally excluded.
7. **Acceptance criteria** — finite, unambiguous, externally observable, and testable conditions.
   Use scenario form when it improves precision. Include regression expectations.
8. **Constraints and invariants** — repository conventions, compatibility, performance, security,
   privacy, accessibility, localization, data migration, operability, or compliance requirements
   that actually apply.
9. **Dependencies and blockers** — upstream work, credentials, decisions, services, feature flags,
   migrations, and issue relationships. Use GitHub dependencies or sub-issues when supported.
   For a large multi-outcome request, explain whether a parent/child split improves review and
   verification. If split, give each child its own deliverable, acceptance tests, dependencies,
   and branch/PR target, plus a combined parent acceptance matrix. Do not create children for
   inseparable edits or override an explicit one-PR instruction.
10. **Verification expectations** — required unit, integration, end-to-end, manual, visual,
    accessibility, performance, security, migration, rollback, and environment checks as applicable.
11. **Release and rollback considerations** — local, staging, observability, data safety, feature
    flags, and rollback or recovery expectations. Production remains outside this workflow.
12. **Open questions and decisions** — confirmed facts, safe assumptions, unresolved items, owner,
    and whether each item blocks planning or implementation.
13. **Definition of done** — code, tests, documentation, telemetry, PR evidence, merge,
    synchronization, cleanup, and staging verification applicable to the change.
14. **Minimal correct path** — direct work, inseparable enabling work, follow-ups, prohibited work,
    expected changed-component envelope, and observable scope-expansion triggers.
15. **Execution prerequisites** — consumed capability-profile identity, resource ownership and
    capacity, validation ladder, required verification channels, and blocking unknowns.

## UI change requests: mandatory visual package

For any request that changes a rendered interface, layout, visual styling, or interaction
presentation, the issue is not spec-ready until its body contains a complete, inspectable visual
package:

- **Request-image inventory** — count every image supplied by the user in the request, preserve the
  request order, and upload each image to GitHub so it is embedded in the issue body as a
  GitHub-hosted image. Give each image a short stable label or caption. Do not replace a supplied
  image with a local path, chat attachment, external link, prose summary, or “same as above.” Record
  the transferred count and labels in the issue. If the request supplied no images, record
  `Request images: none` explicitly.
- **Proposed-result sketches** — produce one or more exported PNG sketches of the intended result
  and upload/embed them in the issue body under a clearly labelled proposed-result section. Cover
  every changed viewport or state needed to understand the request. Show structure, hierarchy,
  placement, and relevant responsive or interaction states; the issue text remains authoritative
  for behavior and acceptance criteria.
- **Tool-neutral issue text** — do not name or link the sketching tool or a private design workspace
  in the issue. Present the uploaded PNGs as visual specification evidence.
- **No silent omission** — if any supplied image or required exported PNG cannot be uploaded, is not
  inspectable, or is missing from the issue body, keep the issue `Needs specification` (or the
  repository equivalent) and state the exact reason. Never call it spec-ready based on a partial
  image set.

## Research procedure

1. Read the complete request and attached evidence. For a UI change request, inventory every
   supplied image before drafting the issue and preserve the one-to-one image transfer required by
   the visual package above.
2. Inspect repository instructions, architecture, tests, nearby implementations, history, open and
   closed issues, relevant pull requests, and CI/deployment configuration.
3. Reproduce or observe current behavior when safe and relevant.
   For runtime defects, capture the active revision and first correlated failure; mark an exact
   root cause unproven when the required trace is absent.
4. Search authoritative external documentation for unstable or unfamiliar technologies. Prefer
   official documentation and primary sources.
5. Separate confirmed facts from inference. Link sources near the claims they support.
6. Search for duplicates before creating a new issue. Refine an existing issue when it is the
   unambiguous source of truth and the user has authorized the workflow.
7. Create the issue with appropriate type, labels, relationships, and milestone only when those
   conventions already exist. Do not invent taxonomy.

## Readiness test

The issue is ready only when:

- every acceptance criterion can be mapped to at least one planned verification method;
- every supported command and capability maps to repository or user evidence;
- scope and non-goals prevent obvious expansion;
- important edge cases and applicable cross-cutting requirements are represented;
- repository evidence identifies the likely change surfaces without prescribing unverified code;
- no unresolved requirement would materially change user-visible behavior, data
  handling, security, test strategy, or rollout. Technical alternatives requiring
  investigation are explicit planning/design work with an owner and completion
  condition; they must be resolved before implementation.
- for a UI change request, every user-provided image is present in the issue body as an embedded
  GitHub-hosted image in the original order, the transferred count is recorded, and the issue
  includes one or more inspectable exported PNG sketches of the proposed result;
- unavailable required verification channels and unknown ownership or capacity remain explicit
  blockers rather than silently weakened assumptions.

If a blocking requirement remains, keep the issue explicitly `Needs specification` (or the
repository's equivalent), apply [Grill Me](../../grill-me/SKILL.md) to the missing decision,
and do not claim it is spec-ready. Resolve repository facts through research.

## Design specification

This is the Stage 4 design output, distinct from Stage 3's execution sequence.
Use the settled issue, decision summary, plan, and inspected repository revision as
inputs. Keep the output in the existing issue/execution note, canonical plan comment,
or an existing repository design document linked from that plan. Match detail to
risk; do not require a new document or schema for a small change.

Specify the applicable contracts:

- observable behavior and acceptance scenarios, including states, transitions,
  failure/recovery, and compatibility;
- existing responsibility owner, affected callers/consumers, chosen approach,
  considered alternatives, and the evidence behind the choice;
- component boundaries, dependency direction, state/data ownership and lifetime;
- inputs/outputs or data schemas, validation, invariants, errors, and side effects;
- cross-cutting security, privacy, accessibility, performance, localization, and
  observability requirements actually affected by the change;
- migration, rollout, rollback, and documentation impact when applicable;
- acceptance-to-verification mapping reconciled with the implementation plan.

For UI work, reuse the required visual package above and describe relevant interaction
states; a sketch alone cannot specify behavior. For a necessary new abstraction,
follow [existing abstractions first](../../engineering-exploration/SKILL.md#existing-abstractions-first)
and explain why the current owner cannot safely express the requested outcome.
Mark irrelevant contracts with a concise reason instead of inventing architecture.

The specification is ready when another implementer can identify the intended behavior,
owners, contracts, failure handling, and verification without guessing; material
technical questions are resolved and the plan reflects the design. Block dependent
implementation on missing evidence or decisions. Route changed requirements back to
grilling, changed sequencing/evidence to planning, and changed contracts to design.
Reuse current accepted outputs on resume; invalidate only what new evidence affects.

## Canonical implementation plan comment

After the issue is spec-ready, post the exhaustive implementation plan as exactly one canonical
issue comment:

- begin with `<!-- standard-development-plan -->`;
- include the inspected source revision and every Stage 3 planning requirement;
- add the Stage 4 design specification to this same comment or link its existing
  repository owner; reconcile it with the plan before implementation;
- for UI changes, include the request-image count/order/labels and the uploaded exported-PNG sketch
  inventory so the visual package remains traceable through implementation;
- pin the comment and read it back before presenting it at
  [Stage 4A](stage-contracts.md#stage-4a-plan-approval). Put the short executive
  view above the engineering detail and record the approved version in the same comment;
- retain the comment ID and URL in the task record;
- after implementation authorization, change its status in place and append concise dated
  reconciliation entries for material findings and decisions;
- update requirements-to-tests mappings when findings change verification;
- mark it `reapproval_required` before proceeding when scope or architecture materially expands;
- never post a replacement authoritative plan comment merely because the plan evolved.

GitHub environments that cannot pin or update the comment block the canonical GitHub planning
mode. Keep the limitation explicit rather than silently substituting an unpinned or duplicate plan.

## Research basis

This contract operationalizes GitHub's issue forms and required-field model, issue relationships
and dependencies, GitHub's draft pull-request review boundary, and established code-review
expectations that reviewers receive the change's what, why, design, functionality, tests, and
documentation context. Repository-specific policy always wins.
