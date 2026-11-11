# Local Codex configuration and suite updates

This is an opt-in **local** Codex preset, distributed with the plugin. It is not an
automatically loaded plugin configuration, hook, policy override, or credential bundle.
The `.agenticx` export/import allowlist does not carry Codex configuration or backups.
On each machine, install the plugin, then activate its local packaged asset explicitly.

Resolve `<skill-root>` from this loaded skill's directory. The asset is
`<skill-root>/templates/codex/config.toml` and the helper is
`<skill-root>/scripts/codex_config.py`. Do not guess a cache version or copy this
repository's path. The plugin root is two directories above `<skill-root>`.

## Start sessions with the saved configuration

Session creation and management belong to the portable
[Delegation skill](../../delegation/SKILL.md). Its
[Codex launch reference](../../delegation/references/codex.md) owns configuration
inheritance, explicit overrides and effective-setting readback. Starting a session
is separate from activating or transferring configuration.

## Suite updates and hook trust

To update the suite and automatically approve its current enabled hooks, run:

```sh
uv run <skill-root>/scripts/codex_config.py update
```

This updates only the `agentic-workflows` marketplace, asks the installed Codex
app-server for current hook hashes, and refreshes `trusted_hash` entries under
`[hooks.state]` in the intended user's `config.toml`. Only enabled, non-managed
plugin hooks with the exact ID `agentic-workflows@agentic-workflows` qualify.
Explicitly disabled hooks, other plugins, user/project hooks and permission settings
retain their existing values. New enabled hooks from this suite are included;
using this command opts into trusting this suite's current hook definitions.

For the first update, use the installed helper if it already exposes `update`;
otherwise perform the normal `codex plugin marketplace upgrade agentic-workflows`,
reload the skill from the new installation, and use `trust-hooks`. Future updates
use the command above. Resolve the installed skill root again if an update changes
the plugin cache path.

Codex does not offer a persistent per-plugin “always trust” setting or execute a
plugin-owned post-update script. Updating from its plugin UI or running the native
marketplace command directly still needs a separate refresh:

```sh
uv run <skill-root>/scripts/codex_config.py trust-hooks --preview
uv run <skill-root>/scripts/codex_config.py trust-hooks
```

The preview writes nothing. Both operations require an installed `codex` on `PATH`
with the `hooks/list` app-server API (verified with CLI 0.162.0). Use
`--codex-home /chosen/local/codex-home` before the subcommand to select another
client home; discovery uses that same home and excludes project hooks. The update
command fails before trust changes when the marketplace update fails. Discovery or
metadata failures also leave trust unchanged. A failed update may already have
refreshed marketplace files; restoring config does not downgrade plugin files.

Changed config uses the same private backup, concurrency guard and exact restore
contract below. The helper confirms trust with a fresh native hook listing before
reporting success; failed verification restores the saved config when no later
edit conflicts. Start a fresh task/client to load the approved hooks. No background
service or blanket hook-trust bypass is installed. Codex's
[hook trust guide](https://learn.chatgpt.com/docs/hooks) explains why changed hooks
otherwise need another review.

## Activate and restore

Run with `uv` (which supplies Python 3.10+ and pinned `tomlkit`) or an equivalent
Python environment with `tomlkit==0.13.3`. The TOML editor preserves comments and
unrelated settings; regular-expression merging or replacing the whole config can
damage existing authentication, provider settings, or table scope.

Close competing configuration editors before applying. Start with the sanitized preview:

```sh
uv run <skill-root>/scripts/codex_config.py preview --all-configured-servers
uv run <skill-root>/scripts/codex_config.py apply --all-configured-servers
```

These commands match the practical full-access setup including every locally
configured MCP and plugin-server default. The explicit `--all-configured-servers`
option touches only definitions in this user config; it does not discover new
servers or change per-tool overrides. Omit it to retain existing server defaults.

Defaults target `$CODEX_HOME/config.toml`, or `~/.codex/config.toml` when unset.
Pass `--codex-home /chosen/local/codex-home` **before** the subcommand for a custom
installation. In PowerShell, quote resolved paths and use `$env:CODEX_HOME` to inspect
that environment variable; the helper uses Python's home resolution on Windows too.
Use the Codex home of the client/execution host you intend to configure, not another
machine or a project `.codex` directory. The helper refuses Git-contained or symlinked
destinations and never reads authentication stores. Do not print existing config or backups.

The result reports `applied` and an exact backup directory, or `unchanged` on repeat.
Backups can contain secrets from an existing config: keep them local and private.
The helper creates a private backup directory with the exact prior bytes and a
version-1 receipt (before/after SHA-256 and original file mode), then atomically
replaces config. A helper lock serializes helper operations; it cannot lock the
desktop settings editor. Re-preview after any external edit. A failed/interrupted
operation can leave its backup or `.agentic-workflows-config.lock`; inspect local
state and confirm no helper is running before removing only that stale lock.

```sh
uv run <skill-root>/scripts/codex_config.py restore /exact/returned/backup-directory
```

Restore checks that the current config still matches the applied bytes, restores
the original file and mode (or removes only the file it created), and retains the
backup. If config changed later, restore refuses to overwrite it. Reconcile those
changes locally; never force-copy a backup over newer settings. Backups do not
travel through plugin updates or `.agenticx` files. POSIX backups use mode 0700/0600;
on Windows, use an OS-user-private home with suitable ACLs: POSIX mode bits do not
establish Windows ACL isolation.

## Exact settings and scope

| Setting | Effect and limit |
| --- | --- |
| `approval_policy = "never"` | Suppresses command approval prompts; denied operations fail rather than gain authority. |
| `sandbox_mode = "danger-full-access"` | Removes Codex's local shell filesystem/network sandbox where permitted. OS/account/container/network and managed limits still apply. |
| `web_search = "live"` | Requests live native web search where the client provides it; does not provision tools or authenticate providers. |
| `apps._default.enabled`, `destructive_enabled`, `open_world_enabled` = `true` | Enables defaults for app tools and advertised destructive/open-world capabilities, subject to specific overrides and enforced policy. |
| `apps._default.default_tools_approval_mode = "approve"` | Automatically approves app tool prompts where supported; does not authorize the underlying task or establish an account connection. |
| `computer_use.default_app_access = "allow"` | Lets normal native-app approvals and policy checks continue. This is also the product default; it does **not** silently approve every app. |

Activation removes the root `default_permissions` selector so it cannot conflict
with `sandbox_mode`. It retains custom `[permissions.*]` definitions and all
unrelated settings. It preserves specific app/tool/server policy, enabled states,
allow/deny lists, and platform app rules; these can keep particular tools restricted.
The asset deliberately supplies neither machine-specific paths nor identities,
credentials, connection definitions, global MCP wildcards, or hook trust.

For existing, explicitly selected MCP server definitions, append these flags to
**both** preview and apply as needed:

```sh
uv run <skill-root>/scripts/codex_config.py preview --mcp-server SERVER_ID --plugin-server PLUGIN_KEY SERVER_ID
uv run <skill-root>/scripts/codex_config.py apply --mcp-server SERVER_ID --plugin-server PLUGIN_KEY SERVER_ID
```

Use actual configured table keys, including the marketplace suffix when present.
The helper sets only that server's `default_tools_approval_mode = "approve"` at
`mcp_servers.<id>` or `plugins.<plugin>.mcp_servers.<server>`. Missing definitions
fail before writing; per-tool overrides remain. For plugin servers configured only
through their manifest, add/review the documented plugin-scoped policy table in
user settings first; the helper does not invent a connection or enumerate private
config through these policy flags. `approve` does not approve MCP
elicitation/authentication or expose disabled tools.

These defaults govern tool prompts. They never authorize sending communications,
merging, deployment, paid actions, or unrelated destructive operations. Follow the
task's actual authorization and all effective runtime, tool-specific, managed, and
OS restrictions. Do not try alternate tools or change permissions to evade a denial.

## Explicit native browser setup for iOS Remote

When the user explicitly requests native browser parity on their connected macOS
desktop host, this helper can provision `mcp_servers.cua_repl` using the installed
signed app's own browser runtime and desktop-provided account context. Installation
does not activate this option. It requires the native bundled Computer Use plugin,
an existing normal desktop chat with browser tools, and this script's pinned Python
environment, normally supplied by `uv`. Resolve the actual app bundle rather
than assuming its name or install location:

```sh
uv run <skill-root>/scripts/codex_config.py preview --desktop-browser-app /resolved/ChatGPT.app
uv run <skill-root>/scripts/codex_config.py apply --desktop-browser-app /resolved/ChatGPT.app
```

These commands also apply the full-access preset described above. Add
`--all-configured-servers` only when its separate server-default change is wanted.
The browser option copies a unique existing account scope from current-user native
desktop REPL processes. It verifies OpenAI signatures, executable ancestry, the
installed native manifest and browser preloader, app version, host pipes and Codex
home. Missing, ambiguous or unsupported runtime state fails before config writes.
It never reads login/token stores. Do not print process environments or private
config to troubleshoot it.

The complete MCP definition exposes CUA to Code Mode and requires successful MCP
startup. A small internal MCP launcher resolves the current native runtime paths,
refreshes the app-instance ID from the connected host's native marker and executes
the original signed runtime with its browser-access preloader. It retains the
activation environment's Python path and uses process replacement, without a
`uv` parent during native MCP execution or runtime dependency downloads. The stored account
scope remains desktop-provided. Native account matching, signed requests, nonce
checks, Work settings, browser routing, OS consent and per-tool policy still apply.
Explicitly disabled CUA/plugin tools and unrelated custom transports are rejected;
recognized native definitions retain their custom restrictions and comments.
Conflicting plugin/explicit policy layers require local reconciliation before
activation; disjoint per-tool rules are retained.

This handles the observed startup discrepancy in desktop 26.1023.50603 / bundled
CLI 0.165.0-alpha.1.2: native CUA is omitted from Code Mode, and an iOS-created
chat's generic browser marker can lack the desktop's per-chat account association.
The latter can produce a Work-settings denial before actual Work settings are
read. A real policy denial still requires addressing that policy through its owner.
This option does not change the product's Work/Codex view or provision unrelated
tools that the host does not supply.

The account scope stays only in local private config/backups; it is not part of the
portable preset or `.agenticx` payload. After changing account/workspace, reactivate
from a normal desktop chat; a mismatch fails closed. App restarts use the new host
instance without a desktop chat warm-up. Native layout changes or missing plugin
cache fail closed and require re-previewing against the installed runtime. Moving
the skill, plugin reinstall or Python/cache cleanup can invalidate its absolute
launcher/interpreter path; reapply from the current installed skill before removing
the old environment. Do not
copy this machine's generated connection definition to another machine.

Keep the returned exact backup for the existing `restore` command. Newer config
edits are protected by the same digest check. Verify in fresh iOS text and voice
chats on this host: open example.com with CUA, read the page, close only the created
tab, and inspect effective approval/sandbox settings. Do not send a desktop follow-up
to warm up the test chat. Record any automatic desktop resume and its timing;
using a hidden tab can separate browser execution from desktop rendering. Tool
presence, a synthetic app-server probe or a successful desktop resume alone does
not prove the real iOS startup path works.

## Client, platform, and verification

Verified against installed **Codex CLI 0.162.0** and official documentation on
2026-10-31. The supported legacy `sandbox_mode` path avoids assuming beta permission
profiles on older clients. Older releases may reject newer app/native/MCP options;
verify/update the intended client rather than silently dropping unsupported settings.

After activation, start a new task and restart the relevant client/server if it
caches defaults. A running task, resume, pending approval, explicit task override,
selected profile file, or trusted project's config can retain different effective
permissions. Inspect effective task permissions in the client; where available,
use app-server `config/read` with origins and `configRequirements/read` to distinguish
stored defaults from applied policy. Do not expose the full config response because
it can contain connection details. A parsed file is not proof of a tool's execution.

| Execution host | Practical limits |
| --- | --- |
| macOS local | Shell remains under the OS user. Native apps need supported Computer Use tools plus OS Screen Recording/Accessibility consent and normal app approvals. |
| Linux local | Shell preset applies where the client supports it. This file does not install a desktop, browser, or native-app control capability. |
| Windows local | Shell runs under the Windows user; filesystem ACLs/UAC and network policy remain. Native app policy uses signed packaged AUMIDs or signed executable identity, not portable file paths. WSL uses its own Linux Codex home/runtime. |
| Remote host / hosted task / Work Cloud | Activate on the actual local execution host where supported. A local file cannot relax hosted/container/coordinator limits, managed requirements, client-owned tool policy, or account availability. |

Official sources: [configuration basics and precedence](https://learn.chatgpt.com/docs/config-file/config-basic),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security),
[permissions](https://learn.chatgpt.com/docs/permissions), and
[plugin packaging and installed MCP policy](https://developers.openai.com/plugins/build/plugins).
