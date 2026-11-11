---
name: agentic-workflows-config-transfer
description: Use when the user asks to export, back up, transfer, migrate, restore, or import Agentic Workflows configuration, activate portable Codex defaults, update the suite with automatic hook approval, refresh suite hook trust, or explicitly configure native browser tools for iOS Remote. Transfer allowlisted preferences through an encrypted .agenticx file; provider authentication stays with Codex connected apps; manage local Codex settings with backup and restore. Separate task and session launches use the delegation skill.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- **Required: Python runtime** — Install Python 3.10 or newer before running the bundled helper scripts.
- **Required: Codex local configuration** — Use a supported Codex installation with local preference files and access to its OS-protected local encryption key; provider connections remain managed by Codex.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Agentic Workflows Config Transfer

For suite updates with automatic approval of this suite's hooks, read
[suite updates and hook trust](references/codex-configuration.md#suite-updates-and-hook-trust).
Run the existing helper's `update` command; `trust-hooks --preview` and `trust-hooks`
cover a separate trust refresh. These explicit operations preserve disabled hooks
and unrelated configuration and do not activate the full-access preset. A request
to update and approve this suite's hooks authorizes that reversible local operation.

For creating or managing another agent task or session, use the portable
[Delegation skill](../delegation/SKILL.md). Launching work inherits the chosen
harness configuration by default and does not activate this skill's preset.

For full-access Codex configuration or explicitly requested native browser setup
for iOS Remote, read [Codex activation](references/codex-configuration.md).
The installed asset is [templates/codex/config.toml](templates/codex/config.toml),
relative to this skill. Installation only distributes it; activation is opt-in.
Never apply it merely because a task encounters a permission denial. A direct request
to activate these defaults authorizes the reversible local update, subject to effective
runtime permissions. Configuration does not grant task authority or bypass managed
policy, tool restrictions, OS consent, or communications/merge/deployment approvals.

Use the bundled transfer helper to export or import one authenticated-encrypted `.agenticx` file.
Read [references/transfer-contract.md](references/transfer-contract.md) before every operation. For
first use, prompt behavior, or runtime setup, also read
[references/onboarding.md](references/onboarding.md).

## Export

A direct export request uses `local-session` mode for allowlisted workflow
preferences on the same machine and OS user. For another machine, use
`portable-passphrase`; the helper opens a masked local prompt twice. Never ask
for or accept the passphrase in chat.

```bash
uv run <plugin-root>/scripts/agentic_workflow_config_transfer.py export \
  --mode local-session \
  --output /user/selected/path/agentic-workflows-transfer-YYYYMMDD-HHMMSS.agenticx
# For another machine, select --mode portable-passphrase instead.
```

The payload contains preferences only. The helper never inventories provider
credential files or exports Codex connector authentication. Return the encrypted
file and included preference field names only; preserve the user's existing files.

## Import

For an attached `.agenticx` file and an explicit import request, resolve it outside
Git and run the helper. Portable files use a masked local prompt; local-session
files use the current OS user's protected encryption key. Review only sanitized
preference field names. The request authorizes the reversible local preference
update, not provider writes or connection changes.

```bash
uv run <plugin-root>/scripts/agentic_workflow_config_transfer.py import \
  /resolved/attachment/agentic-workflows-transfer.agenticx
```

The importer authenticates and validates before applying preferences atomically.
It accepts legacy version-1 files only when their credential map is empty. A
credential-bearing legacy file is rejected before writes: reconnect through Codex
and create a new preferences-only export. Never decrypt it manually or silently
discard/restore provider tokens. Preserve the attached archive and report the
sanitized result or blocked compatibility step. Provider connections are configured
and verified through Codex separately, not transferred by this suite.

## Boundaries

- Never request or expose passphrases, connector credentials, tokens, or decrypted payloads.
- Never use `--passphrase-stdin` in agent-driven commands; it is reserved for isolated
  tests and a user-controlled local terminal.
- Never export/copy a local-session encryption key to another user or machine;
  re-export in portable mode.
- Import does not authorize deployments, provider resource writes, token migration,
  rotation/deletion, or broader permissions.
- Do not delete or relocate the user's archive without an explicit request.
