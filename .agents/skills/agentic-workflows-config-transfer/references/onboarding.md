# Agentic Workflows configuration transfer onboarding

## Prerequisites

- A compatible Agentic Workflows plugin in both sessions.
- `uv` and the pinned `cryptography` dependency.
- A supported masked native prompt or user-controlled terminal on macOS/Windows.
- The OS-protected local encryption key for local-session mode, or the private
  passphrase for portable mode. Never paste either into chat.

Ask to export workflow preferences for another session on this machine, or export
a portable preferences file for another computer. Portable mode prompts locally
twice; store its passphrase separately from the `.agenticx` file.

Attach one archive and explicitly request import. The helper authenticates and
validates it, shows only preference field names, and atomically applies allowlisted
preferences. Version-1 files with provider credentials are rejected before writes;
legacy preference-only files are supported. Preserve old archives and create a new
preferences-only export rather than manually decrypting tokens.

Provider connections are configured through Codex independently on each host.
No provider credential inventory, transfer, or live verification is needed by
preferences import. Ready means the runtime, masked prompt/key, synthetic encrypted
round trip, and compatible preference schema are verified; plugin installation alone
does not prove those prerequisites.
