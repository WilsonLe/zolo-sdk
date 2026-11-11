---
name: agent-instruction-design
description: Create or revise agent skills, AGENTS.md guidance, or a session retrospective so instructions are discoverable, concise, and verifiable.
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

# Agent instruction design

Follow the repository's skill schema, generator, and validation commands. Do not
edit memory or unrelated global instructions without an explicit request.

## Write instructions

1. Apply [existing abstractions first](../engineering-exploration/SKILL.md#existing-abstractions-first).
   Extend the existing skill, reference, helper, or schema owner before creating
   another. A necessary new owner needs one task responsibility, explicit asset
   dependencies, and clear input/output or record contracts.
2. Put the actual trigger in the description or smallest existing navigation
   pointer. Lead a skill description with when to use it ("Use this skill whenever
   ...") and the user's own phrasings; smaller models skip skills whose descriptions
   only summarize capability. Keep always-needed actions in the entry point and
   conditional detail in a reference read for that condition. Avoid a router for a
   one-path task. Keep repository guidance in `AGENTS.md`.
3. Give important steps observable completion conditions. State desired behavior
   directly; reserve prohibitions for concrete safety or authority boundaries.
4. Keep each rule authoritative in one place. Link existing commands, schemas, and
   policies rather than copy discoverable facts that may drift.
5. Walk through a realistic request, including failure and resume: correct trigger,
   reachable dependencies, settled authority, and an observable finish. Run package
   and instruction validation. Text checks alone do not establish agent behavior.

## Review a session

Read actual evidence; find recurring navigation, verification, instruction, tool,
information-access, or engineering-judgment failures. Check existing fixes before
proposing a remedy. Prefer deterministic checks for mechanical failures and prose
for decisions requiring judgment. Report evidence and severity without silently
creating trackers or changing instructions. In Codex, use `session-reflection` for
multiple sessions or live issue deduplication.
