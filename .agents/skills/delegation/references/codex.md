# Codex session launches

For user-requested Codex work sessions, inherit the intended execution host's
`$CODEX_HOME/config.toml` (or `~/.codex/config.toml`). Confirm the target project
and existing Codex home without printing config contents or secrets. Retain the
existing environment; do not point `CODEX_HOME` at another installation to obtain
different permissions. Starting a session does not activate a bundled preset.

For a new independent Git session, create an isolated worktree first under the
repository's conventions, then use its resolved path as the session's `cwd`/`--cd`.
Use native worktree controls or `git worktree add`; inspect the base and dirty
source state and preserve task-required local setup. A supported `codex exec
--worktree` is another option when its managed location meets repository rules.
Read back the actual new worktree and session working directory; selecting
configuration defaults does not itself isolate a checkout. An explicit request
to use the current directory or an existing lane is handled by the main skill.

Prefer a host task-creation capability only when it can inherit user configuration
without supplying unsolicited permission overrides. Apply an explicit user-requested
override only through supported controls and verify the resulting settings.
If a tool forces an unrequested profile, approval policy,
or sandbox mode, use the installed native CLI for an ordinary work session:

```sh
codex exec --json --cd /resolved/task/worktree 'Read-only preflight: report your effective working directory, approval policy, sandbox and network restrictions. Do not perform dependent work.'
```

Keep the CLI in the foreground of a resumable execution tool, retain its emitted
`thread.started` ID, and monitor completion. Use native argument arrays or proper
shell quoting for real prompts. For default inheritance, do not add `--ignore-user-config`, `--sandbox`,
`--approve-for-me`, bypass flags, a profile, or `--config` permission overrides.
Do not silently select another model, enable hooks, or edit TOML to make a launch
pass. If the CLI or required host controls are unavailable, report that limitation.

Before assigning dependent work or claiming inherited permissions, read back the
exact new thread's effective approval policy, sandbox and network restrictions.
Use supported task readback or the exact session's recorded `turn_context` when
available; inspect only relevant permission fields. A host request or prompt
claiming full access is insufficient. If permissions differ from the intended
configuration, retain the session identity, report `permission_mismatch`, and do
not send dependent work or retry with forced permissions. Check applicable trusted
project/profile settings and managed requirements without rewriting them. Resume
and fork can retain a prior session's overrides; verify them by the same contract
instead of treating them as fresh inherit-config launches.

When a host can create an idle session, verify its effective settings before the
first work turn. When creation starts execution immediately, use a read-only
preflight as the initial prompt. Only after successful readback,
continue the verified thread with the authorized task through native CLI resume
or a host continuation capability proven to preserve those permissions. Missing
authoritative readback records `readback_unavailable` and blocks dependent work.

CLI sessions are not a promise of a desktop tab or of Goal mode. Orchestration
delegation still requires its authoritative Goal-mode and other workflow readbacks;
missing support blocks that lane. If a workflow requires full access but the saved configuration
is restrictive, record the incompatibility instead of overriding the user's choice.
Enforced managed, runtime, tool and OS policies still apply. This launch contract
does not authorize evading a denial, sending communications, merge or deployment.

This contract covers user work sessions. The separate ephemeral session-title
utility deliberately uses isolated configuration; it must not be reused as a
work-session launcher. Instruction/package checks establish the guidance contract,
not universal agent adherence. Report observed live session permissions separately
from untested write/network behavior or unchanged desktop-tool behavior.

The native CLI example requires a Git repository; for an ordinary directory
outside Git, add `--skip-git-repo-check`, which does not change permissions. A
CLI session is not an app-managed task: preserve requested interface and required
tools, and report incompatibility before substituting one for the other.

For explicitly requested native browser setup on a connected macOS host, use the
configuration owner's [iOS Remote browser option](../../agentic-workflows-config-transfer/references/codex-configuration.md#explicit-native-browser-setup-for-ios-remote).
Ordinary session launches do not activate it; a desktop-resumed browser check does
not establish fresh iOS startup parity.

With a supported app-server connection, `thread/start` without model or permission
overrides can create an idle session. Compare its returned `approvalPolicy`,
`approvalsReviewer` and `sandbox` with the intended effective configuration before
`turn/start`. Keep that connection alive while managing the task. A separate
app-server process does not control an already-running desktop session.

Official sources: [configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic),
[CLI options](https://learn.chatgpt.com/docs/cli/reference), and
[app-server creation and continuation](https://learn.chatgpt.com/docs/app-server).
