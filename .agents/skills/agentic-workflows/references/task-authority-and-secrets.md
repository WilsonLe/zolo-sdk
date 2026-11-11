# Task authority and concealed secrets

Remote provider management uses [Codex connected apps](service-browser-operations.md#connected-app-operations).
Codex owns authentication; recover connections there without local CLI tokens or
credential copying. The concealed-secret steps below apply only when an authorized
application/runtime integration needs its own secret, not to connector login.

## Carry the request through completion

A user's request to achieve an outcome authorizes the necessary steps within that
outcome's account, project, environment, and purpose. Reuse that authority across
turns and dependent steps. Inspect the current target, execute, read back, and
verify the requested flow without asking the user to approve each button or command.

Save, Add, Approve, Authorize, consent, credential creation, secure storage, and
configuration can be necessary steps. A button's label does not create a new human
approval gate. Check its actual effect and requested permissions first. Complete
ordinary in-scope steps yourself when the available tools support them.

Record the originating request and resolved target as nonsecret authority evidence.
Required CLI confirmation flags may express that existing authority; the user
does not need to type a helper's exact phrase. Such flags do not establish authority
by themselves. Credential access also does not authorize unrelated actions.

Ask only when a required account, target, material choice, or authority remains
unresolved, or a higher-priority platform/tool rule requires human input. A new
charge, unrelated permission grant, destructive effect, merge, or deployment needs
authority covering that effect; reuse a request that already covers it. Respect
explicit read-only, plan-only, and stop-before-action instructions. Follow the
delivery workflow's distinct merge and deployment gates; a generic request to
change repository guidance does not authorize releasing it.

Prepare all independent authorized work before asking. Explain the exact missing
decision or restriction and its source. An ordinary provider confirmation dialog
can be completed by the agent within scope; an enforced human-only platform
approval cannot be bypassed. If an automatic approval review rejects an action,
report the action and stated reason. Continue independent work where possible.

## Keep secret values inside the transfer process

Concealed credential handling is permitted within an authorized setup. The agent
can click a provider's Copy control and transfer the clipboard directly to the
user's secret store without seeing the value. A masked field alone does not prove
the transfer path is safe: establish that clipboard APIs, tool responses,
screenshots, child output, and errors will not return plaintext to the agent.

On macOS, prefer a reviewed local helper that reads the clipboard and writes the
exact named Keychain item in one process. Use the Security framework's item APIs
for secret data, rather than passing a password to a shell command. Apple documents
[adding a password](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain),
[updating items](https://developer.apple.com/documentation/security/updating-and-deleting-keychain-items),
and the [pasteboard API](https://developer.apple.com/documentation/appkit/nspasteboard).
These API references describe a pattern, not a bundled Keychain helper or a claim
that an arbitrary CLI accepts stdin. Inspect and validate the selected mechanism
before using a real credential.

1. Resolve the credential's source, type, least sufficient permissions, and exact
   destination from the request and provider metadata. Do not reveal a masked field.
2. Inspect the transfer helper and downstream CLI for secret-bearing arguments,
   logs, telemetry, errors, and output. Exercise the route with a synthetic value
   before real use when its output behavior has not been established.
3. Click Copy only when the concealed route is ready. Consume the value internally;
   never return clipboard text, a DOM input value, or a secret to chat or tool output.
4. Store it in the named Keychain item, existing approved secret manager, or the
   project's approved runtime secret mechanism. Verify
   status and presence without printing the value. Preserve an existing credential
   unless replacement is within the request. Clear the clipboard after successful
   transfer if it still contains the copied value; handle failure and concurrent
   clipboard changes without losing the user's unrelated data.
5. Retrieve the value inside a local launcher and pass it directly to the consumer
   through supported stdin, a narrowly scoped child environment, or a protected
   provider channel. Suppress or sanitize child output and failures before they
   reach a tool response. Keep inherited environments and access narrow.
6. Verify credential health read-only, then confirm the saved configuration and
   requested end-to-end behavior. Report names, targets, and status only.

Do not print `pbpaste`, return a clipboard getter's value, display Keychain secret
output, interpolate a Keychain lookup into a CLI argument, or use
`security add-generic-password -w <value>` for automated transfer. Shell expansion
still places secrets in process arguments even when the command text hides them.
Do not put secret values in tool arguments, history, traces, source files, issues,
PRs, screenshots, recordings, or evidence. A protected environment still requires
output discipline; a child process may echo it.

When an existing provider helper requires a private file, retain its storage and
type checks. An authorized local bridge may create only the required owner-only
input outside tracked Git content without returning its content, then invoke that helper. Minimize
plaintext lifetime and remove or archive input according to the helper's documented
contract. Do not claim existing file-based helpers use Keychain. If no safe transfer
route is available, complete the rest of setup and report that concrete limitation;
ask for private entry only for the unsupported step.

## Runtime configuration and worktrees

Provider authentication belongs to Codex connected apps and is excluded from
configuration transfer, local setup, and worktree copies. Leave legacy files
untouched; do not inventory their contents or treat them as bootstrap inputs.

For separately required application env files, use the project's documented secret
mechanism and [safe worktree bootstrap](../../standard-development-workflow/references/worktree-bootstrap.md).
Resolve exact source/destination paths; verify they are ignored, untracked,
owner-controlled, and free of symlinks before an independent copy. Preserve
conflicting destination state. Never copy connector credentials, global stores,
or a broad home directory. Verify only presence and runtime readiness without
printing values. Runtime configuration does not authorize remote account access.

## Check the rule against the task

| Request or observation | Next action |
| --- | --- |
| Set up a named provider integration; Save/Add/Authorize is required for its stated permissions | Inspect the effect, click, and verify using the original request |
| Copy a masked API credential into a named Keychain item | Use the validated concealed bridge; report presence and credential health |
| Configure an explicitly selected application/runtime from that Keychain item | Retrieve internally through the supported concealed runtime input; keep output secret-free |
| A helper needs a write-confirmation phrase | Supply it only when the original request covers the exact write |
| Inspect the account without changes | Read only; no setup or write as a test |
| A permission grant expands access beyond the integration, or the target is ambiguous | Finish independent work, then ask for the missing decision |
| A tool requires human approval or rejects the action | Obey and name the enforced restriction; do not bypass it |
| The setting saved successfully | Read it back and test the requested flow before claiming completion |
