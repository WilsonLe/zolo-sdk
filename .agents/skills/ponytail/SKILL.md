---
name: ponytail
description: Use this skill whenever the user asks for Ponytail, YAGNI, the simplest complete solution, less code, or an over-engineering/bloat check, and when engineering work chooses an implementation or dependency. Read the relevant code first, reuse existing capabilities, and minimize new code without weakening required behavior, safety, accessibility, or verification.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- No additional setup beyond installing this plugin.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Ponytail

Adapted from [DietrichGebert's Ponytail](references/upstream.md). This skill owns
implementation simplification, not architecture decisions, delivery authority or
another review cycle. Follow the repository's engineering workflow. Read the
current owner and consumers under [existing abstractions first](../engineering-exploration/SKILL.md#existing-abstractions-first)
before choosing a smaller implementation.

## Smallest complete change

Establish the requested result, constraints and affected callers, tests, fixtures,
configuration and exports. Preserve accepted architecture and useful shared
boundaries. Then take the first option that fully meets the task:

1. Omit unrequested features, flexibility and future-proofing. Keep every explicit
   requirement and inseparable supporting change; do not quietly narrow scope.
2. Reuse the project's existing helper, component, service or supported pattern in
   its owning layer. A house component takes precedence over a native substitute.
3. Use a suitable standard-library or native platform capability when the project
   has no appropriate owner. Check its actual behavior and supported environments.
4. Use a suitable installed dependency before introducing another. Add a dependency
   only when existing choices cannot safely meet the requirement and its benefit,
   compatibility and maintenance cost justify it; follow dependency approval rules.
5. Write the smallest clear implementation still needed. Prefer a readable short
   expression to scaffolding, but expand it when terseness conceals behavior.

Judge the complete change, including consumers and failure paths, rather than the
line count of one function. Keep the established layering and domain types when
they enforce a real contract. A wrapper or abstraction needs the justification in
the shared design method; this ladder does not replace that method.

## Preserve correctness and evidence

Retain trust-boundary validation, errors that prevent data loss, security,
accessibility, necessary device calibration and everything the user requested.
For a bug, trace all supported callers and fix the responsible owner once under
[Engineering Diagnosis](../engineering-diagnosis/SKILL.md). A smaller implementation
must preserve the actual consumer outcome, not merely pass its own helper test.

For new non-trivial logic, retain the smallest meaningful regression or self-check
at the right boundary; prefer extending an existing test. Follow repository-required
checks and preserve coverage through refactors. Trivial reversible changes need no
new test merely to satisfy this skill. Passing focused checks is not a full-suite
or runtime pass; the calling workflow determines when full CI is required.

Explain a necessary tradeoff in the existing issue/PR or a concise why-comment when
the code cannot express it. Use `shortcut: <limit>, <revisit trigger>` only when the
project accepts that convention. Do not add a competing debt ledger, speculative
upgrade path or comment on every ordinary choice.

## Explicit levels and handoff

Use these levels only within the current conversation/task context. `full` is the
default when applying this method; retain a user's selected level until they change
it or the task ends. Never write a mode flag or persistent default automatically.

| Request | Behavior |
| --- | --- |
| Ponytail lite | Deliver the requested result; briefly name a smaller viable alternative when useful. Do not pause settled work for routine choices. |
| Ponytail full | Apply the complete ladder above. |
| Ponytail ultra | Also challenge unnecessary additions with evidence. Reuse accepted answers; changing explicit requirements still needs the user's decision. |
| Ponytail off / stop Ponytail / normal mode | Stop this additional simplification method. Repository correctness, safety and delivery rules still apply. |

Report the chosen existing capability or justified new code, relevant checks and any
material omissions or risks concisely. Do not add a canned footer when nothing
material remains. Use [Engineering Review](../engineering-review/SKILL.md) for a
requested diff review; Ponytail adds complexity probes within that review, not an
automatic second reviewer. Walk through [evaluation scenarios](references/evaluation-scenarios.md)
when revising this adaptation; distinguish authored cases from observed agent behavior.
