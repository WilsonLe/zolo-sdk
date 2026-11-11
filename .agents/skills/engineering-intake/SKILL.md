---
name: engineering-intake
description: Triage a software issue or pull request, clarify product decisions, and turn an agreed outcome into a spec or dependency-aware implementation slices.
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

# Engineering intake

Read repository issue, PR, and decision conventions; inspect the live request,
comments, code, related work, and prior decisions. For tracked edits, follow
repository delivery rules and the Standard Development Workflow when
available. This method grants no publication, merge, or deployment authority.

## Triage

1. Separate claims from verified behavior. Reproduce a bug safely on its named
   revision/environment or inspect the PR diff and checks. Search existing
   implementations and open/closed work by concept as well as wording.
2. Recommend a disposition using existing labels/states: ready, specific answer
   needed, human judgment needed, delivered, or declined. Do not invent labels
   or close another person's request without authority.
3. Preserve settled answers. Inspect accessible facts yourself; ask actionable
   questions only for decisions or facts unavailable from the sources.
4. For ready work, record outcome, current behavior, scope, acceptance evidence,
   constraints, dependencies, and open decisions in the existing issue or brief.
   Link the primary source and mark verification gaps.

## Clarify decisions

Group currently answerable decisions by dependency, with concrete options and an
evidence-based recommendation. Let answers reveal the next group; stop interviewing
when only authorized implementation details remain. Resolve ambiguous terms against
code and docs. Use an existing glossary for durable vocabulary, and an ADR for a
material tradeoff costly to reverse whose rationale a maintainer would need.
Follow [project ADR maintenance](../standard-development-workflow/references/project-adrs.md)
for discovery, lifecycle and project-local ownership; link affected IDs or a
justified no-impact result in the existing issue.

## Prepare implementation

Apply [existing abstractions first](../engineering-exploration/SKILL.md#existing-abstractions-first).
Identify the current owner, its useful consumers, and the real behavior/test boundary
before proposing layers. Any necessary new boundary needs an atomic responsibility,
explicit dependencies, and schemas under that method.
Use [Ponytail](../ponytail/SKILL.md) to compare existing, platform and dependency
options without dropping agreed acceptance criteria or adding speculative flexibility.

Synthesize agreed decisions into observable behavior, edge cases, exclusions, and
completion evidence. For large outcomes, use independently verifiable vertical
slices with true blocking dependencies and combined parent acceptance. Use an
explicit expand/migrate/contract sequence when a wide migration cannot stay green
as individual slices. Do not expand unrelated consumers to generalize a narrow fix.

Publish or edit issues only within task authority. Read back the resulting issue,
brief, or proposed breakdown concisely.
