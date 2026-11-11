---
name: grill-me
description: Use this skill whenever the user wants a plan, design, spec, or idea stress-tested, poked holes in, or questioned before building (grill me, challenge my plan, what am I missing), and during SDLC requirements clarification. Read it before questioning the user; it asks dependency-ordered questions with recommended answers, inspects repository facts first, and reuses settled decisions.
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

# Grill Me

Adapted from [Matt Pocock's Grill Me and Grilling](references/upstream.md).
This skill owns the interview method. The calling workflow owns tracking,
artifacts, implementation authorization, and delivery gates.

## Establish the decision tree

Read the request, existing issue, plan, design, and accepted answers. Identify the
desired outcome, users, scope, non-goals, constraints, acceptance criteria, failure
paths, and decisions that depend on other decisions. Separate verified facts,
accepted choices, provisional assumptions, and unresolved questions.

Inspect the repository or other authorized sources to resolve factual questions
before the first question: list the working directory and read files the brief or
plan names, configuration, and modules its decisions touch. Note which questions
those files settle and cite the paths; say no repository exists only after listing
the directory. A missing fact or unfinished investigation remains a prerequisite;
ask only independent questions while resolving it. Report unavailable evidence
rather than invent an answer. Research does not require delegation.

## Interview by dependency

1. Select an unresolved material decision whose prerequisites are settled. Ask one
   focused question at a time; a small round may group independent questions when
   the host supports it and it reduces effort for the user.
2. Give a recommended answer and the reason or tradeoff. Phrase the question so
   an explicit acceptance of the recommendation has a clear meaning. Never treat
   silence, elapsed time, or a preselected option as acceptance.
3. Wait for the answer before making a dependent decision. Continue independent
   authorized research while waiting. Incorporate corrections, then recompute the
   remaining decisions; do not ask dependent questions in the same round.
4. Explore the affected branches until the outcome, boundaries, important states,
   and acceptance criteria are understood. Reuse accepted choices and avoid asking
   the user to restate discoverable facts or approve routine implementation details.

Use the host's question tool when available; otherwise ask in the conversation.
Do not invent a tool dependency or require another installed skill named `grilling`.

## Finish and hand off

Return a concise decision summary: outcome, scope/non-goals, accepted choices with
their sources, safe assumptions, acceptance criteria, and remaining blockers with
owners. Update the existing issue or canonical plan when the calling workflow
authorizes it; keep one source of truth instead of a second interview ledger.

The interview is complete when no unresolved material decision blocks the next
authorized stage. If the brief already settles the tree, record that and continue
without manufactured questions. For an explicit interview-only request, present
the summary and stop; seek confirmation when the user reserved it. In SDLC, the
request or prior authorization can already satisfy the decision gate. Grilling
does not authorize coding on a plan-only request, merging, deploying, or expanding
scope. On resume, inspect the summary and current evidence, then ask only questions
whose prerequisites or answers have changed.
