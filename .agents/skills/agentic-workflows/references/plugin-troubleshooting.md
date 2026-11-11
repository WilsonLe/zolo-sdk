# Plugin troubleshooting

Use this runbook for plugin installation, discovery, cache, marketplace, or host-connection
failures. Keep diagnosis read-only until the operator explicitly authorizes a recovery action.

## Evidence-first triage

Capture the smallest useful facts before changing anything:

1. Record the exact error, affected plugin, declared version, host platform, and requested
   verification channel.
2. Separate package discovery from runtime connection. An enabled package or extension does not
   prove that its executable, generated configuration, or host transport is usable.
3. Use the installed host's supported diagnostics for the selected surface. For Chrome, the
   matching checks cover the browser process, installed browsers, extension state, and native-host
   manifest. Use the exact browser family named by the request.
4. Do not inspect or copy cookies, passwords, tokens, private messages, profile databases, or
   credential stores. Do not use environment dumps as a credential check.
5. Classify the failure before retrying: browser process, extension, manifest, executable/config,
   cache lifecycle, runtime transport, package state, or external dependency.

Static checks are diagnostic evidence and static diagnostics, not live control evidence. They
become acceptance evidence only when the requested runtime channel also succeeds.

## Chrome native-host connection failures

This section covers the Codex/ChatGPT Chrome extension.

### Symptom

The control surface reports:

```text
Browser is not available: chrome
```

This can occur even when Chrome Profile 1 is visible to the operator and the ChatGPT Chrome
extension appears installed or enabled.

### Layered checks

Check each layer independently and stop at the first failed prerequisite:

| Layer | Positive evidence | Failure classification |
| --- | --- | --- |
| Browser process | The selected Google Chrome family is running | Browser not running or terminated |
| Extension | The expected extension is installed and enabled in the selected profile | Extension installation, disablement, or policy |
| Manifest | The native-host manifest exists, names the expected host, and allows the expected extension origin | Host registration or policy |
| Executable/config | The manifest's exact `path` exists and is executable; its adjacent generated `extension-host-config.json` exists and points to existing same-session runtime files | Native-host package/cache/configuration |
| Live transport | Chrome can be selected, tabs can be listed, an exact tab can be claimed, and visible state can be read | Bridge/runtime transport or stale session |

The standard manifest check validates registration fields and origins. It does not by itself prove
that the executable named by `path` or the generated companion configuration exists. Always check
those exact paths when the manifest check passes but Chrome remains unavailable.

## Known stale-cache signature

The recurring failure investigated on macOS had this shape:

1. The Chrome extension was installed and enabled.
2. The native-host manifest had the expected host name and extension origin.
3. The manifest `path` ended in a moving cache alias:

   ```text
   .../plugins/cache/openai-bundled/chrome/latest/extension-host/...
   ```

4. The `latest` executable path did not exist.
5. A versioned sibling bundle, such as `chrome/<installed-version>/extension-host/...`, did exist.
6. The generated `extension-host-config.json` was absent from the usable host directory.

This is a cache-registration/configuration lifecycle failure, not evidence that the Chrome profile
or extension is corrupt. The bundled installer intentionally normalizes a cache-rooted plugin path
to `latest`; a refresh, cache cleanup, or version reinstall can therefore leave a persisted manifest
pointing at an alias that is no longer materialized. A full Codex-app reinstall appears to fix the
problem because it recreates the browser-plugin registration and generated configuration, but it
does not make the cache lifecycle durable.

Installing or refreshing the latest plugin version is an exposure or trigger, not the root cause
by itself. The root cause is the cache-registration/configuration lifecycle failing to keep the
persisted alias, executable, generated configuration, and current runtime paths synchronized when
the bundled plugin cache changes.

## Recovery decision tree

### Browser is not running

Ask before launching the selected browser when the workflow has not already authorized launch.
After it starts, retry the supported browser connection once.

### Extension is missing or disabled

Use the supported browser/plugin UI and respect browser or enterprise policy. Do not override a
policy or inspect profile internals to force-enable the extension.

### Manifest is missing or invalid

Prefer reinstalling or repairing the supported Browser/Chrome plugin through the host's plugin UI.
Do not run a bundled native-host installer from an arbitrary path or hand-copy a host binary.

### Manifest is valid but the host/config path is missing

The durable recovery is the supported Browser/Chrome plugin recovery path. A manual mitigation is
allowed only when the operator explicitly authorizes it and all of these conditions hold:

- use an exact existing host from the same installed plugin version and architecture;
- restore the generated configuration beside that host using the current Codex app's verified
  runtime paths;
- preserve the prior manifest/config so the change can be reversed;
- never guess a path, copy an unrelated executable, inspect profile data, or delete broad caches;
- re-run the live Chrome verification below before claiming recovery.

A versioned manual path is a tactical workaround. A future plugin update may replace the cache and
require the registration to be regenerated again. Do not represent the workaround as an upstream installer fix.

### Static checks pass but live Chrome still fails

Do not keep retrying inside a stale long-running browser task. Start a fresh browser-attached task
or session when the supported troubleshooting guidance requires it, then record the exact result.
Do not substitute an in-app browser, standalone Playwright, Computer Use, AppleScript, or source
checks when the requested claim is native Chrome control.

## Live verification contract

For a recovered Chrome bridge, all of the following must succeed through the selected Chrome
control surface:

1. Select the requested Chrome browser family.
2. List the user's open tabs.
3. Claim one exact tab returned by that fresh listing.
4. Read its URL, title, or visible DOM state.

Chrome process state, extension state, manifest output, or a screenshot alone is not proof of live
tab control. Keep localhost, authenticated production, staging, and other browser environments
separate in reports.

## General package installation failures

When the failure concerns an Agentic Workflows package rather than the Chrome host:

- verify the marketplace identity and exact declared version;
- refresh the marketplace and reinstall the package through the documented plugin CLI;
- verify enabled state, resolved source, cached package existence, and changed-file parity;
- start a new session because newly installed skills and tools are loaded at session start
;
- report any unavailable Plugins UI or fresh-session observation explicitly.

Never claim installed-state parity from a source checkout alone. Never retain credentials or
machine-specific cache contents in the repository.

## Read-only installed-state diagnostic

In Codex, run the bundled diagnostic through its resolved installed plugin root:

```text
python3 <plugin-root>/scripts/diagnose_installed_plugins.py \
  --authoritative-marketplace agentic-workflows \
  --expected-package agentic-workflows=/absolute/path/to/merged/plugins/agentic-workflows \
  --required-skill plugin-creator=~/.codex/skills/.system/plugin-creator/SKILL.md
```

The report probes candidate Codex launchers independently, uses the first working launcher for
`plugin list --json`, lists enabled plugin identities and versions, checks their resolved source
and inferred versioned cache paths, flags duplicate enabled normalized names, and records missing
required authoring skills. A broken launcher earlier on `PATH` is reported without preventing a
later known-good launcher from being selected. For each `--expected-package NAME=PATH`, the report
also compares the selected authoritative provider's manifest version and secret-safe file hashes
against both its resolved source and inferred versioned cache directory.
Requested names are checked even when absent or disabled. Expected packages require an explicit
authoritative marketplace. `requested_verification` is `verified` only when every requested
package has exactly one installed/enabled authoritative provider, no enabled conflicting provider,
a matching declared version, and matching source and cache trees. Missing paths, different bytes,
or an empty installation fail. Without requested packages this field is `unobserved`; a successful
inventory command does not prove parity. Use the exact merged candidate as the expected tree.

To check a captured fresh-task catalog, add both `--discovery-file catalog.json` and
`--discovery-not-before <ISO-timestamp-of-verified-provider-update>`. Minimal catalog shape:

```json
{
  "task_id": "actual-new-task-id",
  "created_at": "2026-10-04T02:00:00Z",
  "observed_at": "2026-10-04T02:01:00Z",
  "skills": [{"name": "example-skill", "plugin_id": "example@authority",
              "path": "/exact/versioned/cache/example/skills/example-skill/SKILL.md"}]
}
```

Capture this minimal projection from the actual new task's skill catalog and installed provider
readback; exclude prompts, transcripts, and credentials. Creation must follow the verified update
boundary and observation must follow creation. Every expected skill must appear exactly once under
the selected plugin identity and exact versioned cache path; missing skills, duplicates, source
checkout paths, older cache paths, and different providers fail. Skill entries accept bare names
or the catalog's `package:skill` names; a qualified package must match the selected package.
`fresh_discovery.verification` checks captured-catalog consistency; externally verify task creation and catalog provenance before
claiming actual fresh discovery. Omitted discovery is explicitly `unobserved`. No helper creates
a new task or infers fresh discovery from installation hashes.

The diagnostic is intentionally read-only and secret-safe: it does not dump the environment,
inspect credential stores, disable duplicate providers, clear caches, refresh a marketplace, or
install packages. Exit status `3` means duplicate enabled names, a missing required skill, failed
requested provider parity, or failed captured discovery. Status `2` means invalid input or an
unavailable diagnostic prerequisite. Resolve conflicts only through a separately authorized provider selection
or installation workflow, then start a fresh task to verify discovery.

## Incident report template

Record:

```text
Surface:
Exact error:
Declared/plugin version:
Browser family/profile (if applicable):
Process check:
Extension check:
Manifest check:
Exact executable/config check:
Live selection/list/claim/readback:
Classification:
Authorized mitigation:
Rollback:
Remaining limitation:
```

Keep the report secret-safe and distinguish confirmed facts from hypotheses.
