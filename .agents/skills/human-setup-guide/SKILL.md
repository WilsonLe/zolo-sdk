---
name: human-setup-guide
description: Prepare a verified, step-by-step guide or optional interactive script for provider setup, secrets, migration, or cutover steps that require human action.
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

# Human setup guide

Use this skill for manual steps the agent cannot complete with the user's current authorization and tools. Inspect the real repository configuration and current provider documentation or interface first. Do the authorized work before handing the user a procedure. Read
[task authority and concealed secrets](../agentic-workflows/references/task-authority-and-secrets.md)
first: required provider clicks and a supported concealed credential route are agent work.
Use a human handoff only for a concrete missing capability, authority, decision, or
enforced human-only approval; explain that limitation and its source.

1. List each human action and the value or state it produces. Map each value to its destination, such as a local environment file, provider setting, or CI secret. Mark secrets without reading or printing their values.
2. Verify the current route to every control and the exact target account or project. If a dashboard step is unknown, investigate it or label the uncertainty. Do not invent menu paths or claim a saved setting proves the end-to-end flow.
3. Order steps by dependency. Give each step a visible completion check and a safe resume point. Reuse authority already covering an irreversible migration or cutover; request confirmation only when its target or impact is not authorized.
4. When repetition justifies a script, use hidden input for secrets, idempotent writes, no secret-bearing logs, and narrow names for variables. Validate syntax and review the destinations statically before asking the human to run it. Keep a one-off script out of the maintained package unless reuse is intended.
5. After the human completes the steps, read back the resulting configuration through the authorized surface and verify the actual flow separately. Report each stage at its observed status.

This skill does not enlarge the task's external-mutation authority. Follow the repository's delivery rules and the Standard Development Workflow when available if a reusable guide or script is committed.
