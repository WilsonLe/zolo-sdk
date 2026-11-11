---
name: interactive-plan
description: Use whenever the user wants to discuss, revise, approve, or resume an interactive plan, see an executive or engineering view, or manage the plan's todos.
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

# Interactive plan

Start from the current brief, plan, open decisions, and authoritative artifact.
For SDLC, the issue execution note or canonical pinned plan owns scope and
approval. Use the existing task-run record when present. For other work, use the
plan the user is already reviewing, or the current chat if there is no saved plan.

1. Show the version and status, then a short executive view with the outcome,
   scope, ordered steps, and observable completion. Provide engineering detail
   on demand. Keep dependencies, design, verification, risks, and rollback in
   the same plan.
2. Use the available native interactive surface. In Codex, when Visualize is
   available, follow its skill for expandable details and chat follow-up actions.
   Provide expandable sections, a field for questions and revisions, and a
   distinct approval action that names the displayed version. Use confirmed
   chat follow-up actions so feedback reaches the agent. Accept approval from
   a trusted user message that unambiguously authorizes the current version.
   Treat local widget state as display state.
3. Without a suitable surface, run the same interaction in chat. Present the
   executive view first and offer individual engineering sections. Ask a focused
   question for any open decision. Answer questions and revise the same plan from
   feedback. Show the new version and changes before requesting approval.
4. Record the approval source with the exact plan version and scope. On resume,
   read the current plan and its decision. A material change to scope, approach,
   risk, or acceptance produces a new version for approval. Progress updates and
   wording corrections retain the approved version.
5. Derive todos from the steps. Use the host's task-list tool if exposed, with
   checkboxes in the plan as the portable fallback. Update progress and the next
   unblocked step in the same plan so it can resume without the widget. Mark
   completion from observed work and its acceptance evidence.

The caller owns enforcement. For SDLC, return the plan version, decision source,
and current status to the workflow's plan approval gate. Implementation, merge,
and deployment use their respective authority.
