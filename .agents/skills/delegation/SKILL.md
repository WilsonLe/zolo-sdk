---
name: delegation
description: Use whenever the user asks to start, launch, create, resume, fork, or manage a separate agent session or task, spawn another agent, or delegate work. Includes read-only audits and requests to stay here while another session works. For new independent Git sessions, default to an isolated worktree. Inherit the Codex configuration by default, apply explicit requested overrides, and verify effective settings before dependent work. Not for application login sessions or background jobs without agents.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- **Required: Native task or session controls** — Use Codex's supported creation and management controls; verify settings through native metadata or documented inheritance of the active configuration.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Delegation

Own the handoff to another agent or session, using Codex's native
capabilities. Keep task planning, review, delivery and project-specific authority
with their existing workflows. This skill adds no hook, launcher, configuration
preset or persistent coordination register.

## Before creation

Resolve the authorized task, destination project and Codex host from
the active conversation. Reuse settled choices; do not launch an agent merely
because this skill was loaded. Distinguish a new independent session, a native
subagent, and a resume/fork so the user receives the interface they requested.

For a **new independent session in a Git repository**, including a GitHub-backed
project or a read-only audit, default to a new isolated worktree before launching.
Use the repository's worktree/bootstrap rules and an intended base revision;
preserve the source checkout and its pending edits. An explicit same-directory
request or named existing task lane overrides this default where the calling
workflow allows it. Resume an existing session in its verified lane; a native
subagent within the same session may share its parent's worktree under the host's
contract. Do not silently substitute a subagent to avoid requested session isolation.
Non-Git projects use a separate session without inventing a Git repository.

Record the task-owned worktree path and base, and verify the session actually runs
there before dependent work. A new worktree does not include uncommitted files;
carry task-required local state only through the repository's safe bootstrap or
an explicitly accepted handoff, and report missing state instead of auditing or
editing the wrong snapshot. Never reset, relocate or reuse unrelated worktrees.

Use the destination Codex session's saved configuration by default, including model,
reasoning and permissions where applicable. The user need not mention configuration.
Apply a different setting only when explicitly requested or already authorized in
this task; verify it rather than silently reverting to the default. Preserve
project configuration layers and managed restrictions. Do not copy the originating
machine's paths, settings, credentials or permissions onto another user's machine.
A native subagent may inherit its parent's settings; confirm the host's actual
contract instead of assuming that it reloads user configuration.

Inspect the available creation and readback controls before sending the work.
A tool that silently forces settings contrary to the intended configuration is
incompatible. A prompt saying "use my config" cannot change Codex permissions.
Read [Codex launches](references/codex.md) before creating a session. Missing
native controls remain a concrete blocker; do not add a host adapter.

## Create, verify, and hand off

Use the native creation mechanism with configuration defaults and only the
explicitly accepted overrides. Establish the destination and required settings
before dependent work, and retain the exact session/agent identity when returned.
Prefer effective native metadata. For a native subagent with documented inheritance,
check its selected definition and invocation against the known active configuration;
record which evidence established inheritance instead of claiming every setting
was observed at runtime. Inspect Codex native controls rather than inventing a
separate settings API.

If creation starts execution immediately and required settings remain unresolved,
use a bounded read-only preflight and continue the same verified session afterward.
Model claims or the creation request alone do not establish effective settings.
Resume and fork may retain old overrides: inspect them too. Preserve a session
with an unresolved required setting and report the limitation; do not dispatch
the real task or force permissions to make the check pass.

Give the verified agent the concrete objective, scope, relevant artifacts,
constraints, completion evidence and a clear handoff. Preserve the user's limit on
who does the work, whether another session is requested, and whether this session
should remain available. Creating a task does not authorize messages to unrelated
tasks, external communications, merge or deployment. A calling workflow's Goal
mode or review-independence requirements still apply; ordinary delegation does not
activate an orchestration control plane.

## Manage and finish

Keep the returned task and host IDs and any continuation handle. Use supported
status/wait controls; continue independent authorized work and avoid repeated
unchanged polling. Carry steering into the same task instead of spawning a duplicate.
Only send follow-ups within the user's authorization to manage that task.

On an explicit pause/stop/archive request, use the native controls, preserve work,
and verify the actual stopped and archived states separately. Archiving a listing
alone is not proof that execution stopped. When taking work back, read its findings
and unfinished steps before continuing here. Report the result, evidence, settings
verification and any remaining limitation without claiming universal agent adherence.
