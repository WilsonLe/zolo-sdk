# Delegated session launch settings

When the control plane creates a separate issue-owned session, require these
effective settings when the host supports them:

- inherited permissions satisfying the `full_access` requirement;
- execution mode `goal`.

Full Access suppresses routine host sandbox and approval prompts for in-scope work. The trusted
control-plane authority envelope, not the permission profile, authorizes ordinary commit, push,
merge, pull, and declared-target deployment actions.

Inherit the intended host's saved Codex TOML configuration. Do not request a permission
profile, sandbox or approval override to satisfy this requirement. In the bundled
plugin, load `delegation` for the canonical inherit-config
launch and readback contract. Restrictive inherited settings record
`permission_mismatch`; keep the lane not started rather than rewriting configuration.

## Require an explicit delegated goal

Every delegated issue session is Goal mode only. Before creation, record an explicit delegated goal
contract with all of these parts:

- objective;
- exact project and issue boundary;
- observable completion conditions; and
- applicable constraints and authority limits.

Never infer any part of that contract from a vague title, prior task, peer output, or prompt text.
If the goal is missing or ambiguous, do not create the session: record the sanitized `goal_scope`
blocker and keep the lane not started.

Create or resume the child goal only after that contract is clear. Omit `token_budget` unless the
operator supplied one. Complete only on the actual terminal outcome; use blocked only after the
required repeated-blocker threshold.

## Send a Goal-oriented child prompt

The delegated task prompt must be an execution prompt, not a planning prompt. Start it with these
Goal Mode headings populated from the explicit contract:

```text
Goal: <concrete terminal outcome>
Scope: <exact project and issue boundary>
Done when: <observable completion conditions>
Constraints: <authority and safety limits>
Handoff: report completed evidence or a recoverable repeated blocker.
```

Do not ask the child to choose its own mode, infer a goal, or merely draft a plan when it has a
concrete delivery goal. The prompt communicates the already-authorized goal; it never substitutes
for authoritative Goal-mode selection or readback.

## Proportionate launch preflight

Inspect the live host task-creation and task-readback capabilities. Prefer a host that can:

1. inherit saved TOML without permission overrides;
2. request `goal` mode at child creation;
3. authoritatively report the effective permission profile; and
4. authoritatively report the effective execution mode.

Mode selection and authoritative mode readback are required for every delegated session. If either
is unavailable, record `host_capability` or `readback_unavailable` and do not create or activate a
delegated lane. The control plane may continue eligible work itself, but it must not represent that
as a Goal-mode delegation. Prompt text is not proof of an unavailable host setting.

A task tool that injects `:workspace`, `on-request`, or any other permission override
cannot establish inheritance, even when its selected values happen to match TOML.
Native CLI is an ordinary-session alternative only when it can satisfy all of this
lane's required mode and readback controls; do not substitute plain `codex exec` for
unavailable authoritative Goal-mode selection. Record `host_capability` in that case.

Use the existing sanitized compatibility categories when a limitation is material:
`host_capability`, `readback_unavailable`, `permission_mismatch`, or `mode_mismatch`.

For helper preflight, attest `--config-inheritance-supported` only after inspecting
the host's actual creation interface. The deprecated
`--permission-selection-supported` flag remains accepted for caller compatibility
but cannot establish inheritance; without the new capability, preflight blocks.
The register's `requested_permission_profile = "full_access"` remains an expected
effective result, not an instruction to send a profile override to the host.

## Mandatory Luna/max profile for review and verification

Code-review tasks and test-and-verification tasks have two additional
authoritative launch settings:

- model `gpt-5.6-luna`;
- reasoning effort `max`.

Before creating either task, require host support for selecting and reading
back both settings. After creation, read the task back and require both exact
effective values before activating the lane. Unsupported selection, missing
readback, rejection, downgrade, or mismatch blocks the lane. Never fall back to
another model or effort unless the operator separately authorizes that change.

Review findings return to the original implementation session and worktree as
a new remediation turn explicitly invoked with `gpt-5.6-luna` and `max`.
Authoritatively verify those effective turn settings before any addressing
work begins. Do not change tracked files when the host cannot prove the exact
remediation profile.

## Creation and authoritative readback

After a successful preflight, create the project task in its new worktree and record the exact
thread and host IDs as `created`. Read the task back before sending implementation follow-ups or
classifying the lane active.

If worktree setup returns only a pending client identifier, remain `preflight_verified`; do not
bind or activate the launch until the host returns the real thread and host IDs.

- Exact readback transitions the launch to `verified`.
- Missing readback records `readback_unavailable` and the lane remains not started.
- A permission or mode mismatch records the applicable blocker and the lane remains not started.

Do not retry by weakening the settings or embedding claims in the prompt.
Same-directory reuse is allowed only for the serialized review and verification
handoffs defined by their lifecycle references. Preserve any created but
unverified task for explicit reconciliation; do not assign it issue work. Missing
required delivery, permission or mode readback blocks the lane.

## Coordination state

Persist only the issue number, the explicit delegated goal contract, requested and effective
setting tokens, verification state, sanitized blocker category, exact optional child task identity,
and observation time. Never store prompts, message bodies, tool output, credentials,
authorization data, or environment values.
