#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["tomlkit==0.13.3"]
# ///
"""Manage opt-in local Codex defaults and suite hook trust, without secrets output."""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit
import uuid
from contextlib import contextmanager

import tomlkit

PRESET = Path(__file__).resolve().parents[1] / "templates" / "codex" / "config.toml"
SUITE_PLUGIN = "agentic-workflows@agentic-workflows"
BROWSER_PLUGIN = "unified-computer-use@openai-bundled"
NATIVE_TEAM = "2DC432GLL2"
DESKTOP_CONTEXT = "AGENTIC_WORKFLOWS_DESKTOP_BROWSER_CONTEXT"
CONTEXT_FIELDS = (
    "BROWSER_USE_ACCESS_EXECUTOR_ID",
    "BROWSER_USE_ACCESS_PIPE_PATH",
    "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
    "BROWSER_USE_CODEX_APP_VERSION",
    "CODEX_HOME",
)


class ConfigError(RuntimeError):
    """A sanitized configuration failure."""


def checked(
    path: Path, *, allow_root_owner: bool = False, must_exist: bool = False
) -> Path:
    """Reject links, non-files, foreign ownership, and Git-contained private state."""
    path = Path(os.path.abspath(path.expanduser()))
    for part in reversed((path, *path.parents)):
        if part.is_symlink() or (part / ".git").exists():
            raise ConfigError(
                "configuration and backups must be outside Git and symlink-free"
            )
    if not path.exists() and must_exist:
        raise ConfigError("required native runtime file is missing; config unchanged")
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise ConfigError("expected a regular configuration file")
        owners = {os.getuid()} if hasattr(os, "getuid") else set()
        if allow_root_owner:
            owners.add(0)
        if owners and info.st_uid not in owners:
            raise ConfigError("configuration must be owned by the current user")
    return path


def read(path: Path) -> bytes | None:
    checked(path)
    return path.read_bytes() if path.exists() else None


def digest(data: bytes | None) -> str | None:
    return hashlib.sha256(data).hexdigest() if data is not None else None


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    checked(path)
    fd, name = tempfile.mkstemp(prefix=".codex-config-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def locked(home: Path):
    lock = home / ".agentic-workflows-config.lock"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ConfigError(
            "another configuration operation holds the lock; inspect before retrying"
        ) from error
    try:
        os.close(fd)
        yield
    finally:
        lock.unlink()


def _native_command(arguments: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            arguments, capture_output=True, text=True, check=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ConfigError(
            "native desktop inspection failed; no changes applied"
        ) from error


def _verify_native_binary(path: Path) -> None:
    checked(path, allow_root_owner=True)
    _native_command(["/usr/bin/codesign", "--verify", "--strict", str(path)])
    metadata = _native_command(
        ["/usr/bin/codesign", "-d", "--verbose=2", str(path)]
    ).stderr
    team = re.search(r"^TeamIdentifier=(.*)$", metadata, re.M)
    if team is None or team.group(1) != NATIVE_TEAM:
        raise ConfigError("expected an OpenAI-signed native desktop binary")


def _native_process_path(pid: int) -> Path | None:
    library = ctypes.CDLL("/usr/lib/libproc.dylib")
    function = library.proc_pidpath
    function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    function.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    return (
        Path(os.fsdecode(buffer.value))
        if function(pid, buffer, len(buffer)) > 0
        else None
    )


def _native_environment(pid: int) -> dict[str, str]:
    # Only return the native browser metadata allowlist. Never log process output.
    raw = _native_command(["/bin/ps", "eww", "-p", str(pid), "-o", "command="]).stdout
    values = {}
    for key in CONTEXT_FIELDS:
        match = re.search(
            r"(?:^|\s)" + re.escape(key) + r"=(.*?)(?=\s[A-Za-z_][A-Za-z_0-9]*=|$)",
            raw,
        )
        if match:
            values[key] = match.group(1)
    return values


def _browser_scope(value: str, sizes=(3,)) -> list[str]:
    try:
        scope = json.loads(value)
        if (
            isinstance(scope, list)
            and len(scope) in sizes
            and all(isinstance(item, str) and 0 < len(item) < 1024 for item in scope)
        ):
            return scope
    except (ValueError, TypeError):
        pass
    raise ConfigError("native desktop browser context is missing or invalid")


def _desktop_context(app: Path, home: Path, version: str) -> str:
    resources = app / "Contents/Resources"
    node = resources / "cua_node/bin/node_repl"
    cli = resources / "codex-cli/CodexCLI.app/Contents/MacOS/codex"
    main = app / "Contents/MacOS/ChatGPT"
    rows = _native_command(["/bin/ps", "-axo", "pid=,ppid=,uid="]).stdout
    processes = {}
    for line in rows.splitlines():
        pid, parent, owner = map(int, line.split())
        if owner == os.getuid():
            processes[pid] = parent
    contexts = set()
    for pid, parent in processes.items():
        if _native_process_path(pid) != node or parent not in processes:
            continue
        if _native_process_path(parent) != cli:
            continue
        if _native_process_path(processes[parent]) != main:
            continue
        if (
            "app-server"
            not in _native_command(
                ["/bin/ps", "-p", str(parent), "-o", "command="]
            ).stdout.split()
        ):
            continue
        try:
            values, host = _native_environment(pid), _native_environment(parent)
            executor = values.get("BROWSER_USE_ACCESS_EXECUTOR_ID", "")
            scope = _browser_scope(executor)
            host_scope = _browser_scope(
                host.get("BROWSER_USE_ACCESS_EXECUTOR_ID", ""), (2, 3)
            )
            if (
                scope[0] != host_scope[0]
                or values.get("BROWSER_USE_CODEX_APP_VERSION") != version
                or Path(values.get("CODEX_HOME", "")).expanduser().resolve()
                != home.resolve()
                or any(
                    not values.get(key) or values[key] != host.get(key)
                    for key in CONTEXT_FIELDS[1:3]
                )
            ):
                continue
            # Copy the app-provided value verbatim; do not construct an identity.
            contexts.add(executor)
        except (ConfigError, OSError, ValueError, TypeError):
            continue
    if len(contexts) != 1:
        raise ConfigError(
            "a unique current native desktop browser context is unavailable; "
            "open a normal desktop chat with browser tools and retry preview"
        )
    return contexts.pop()


def _desktop_runtime(app: Path, home: Path) -> tuple[Path, str, dict]:
    if sys.platform != "darwin":
        raise ConfigError("native desktop browser activation currently requires macOS")
    try:
        info_path = checked(
            app / "Contents/Info.plist", allow_root_owner=True, must_exist=True
        )
        app = info_path.parents[1]
        info = plistlib.loads(info_path.read_bytes())
        version = info["CFBundleShortVersionString"]
        if info["CFBundleIdentifier"] != "com.openai.codex" or not re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+", version
        ):
            raise ConfigError("expected the installed native ChatGPT/Codex app bundle")
        cache = home / "plugins/cache/openai-bundled/unified-computer-use"
        manifest_path = checked(cache / version / ".mcp.json", must_exist=True)
        native = json.loads(manifest_path.read_bytes())["mcpServers"]["cua_repl"]
        resources = app / "Contents/Resources/cua_node"
        expected_arguments = [
            "--import",
            checked(
                manifest_path.with_name("require-browser-access.mjs"), must_exist=True
            ).as_uri(),
            str(resources / "lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"),
        ]
        if (
            native["command"] != str(resources / "bin/node")
            or native["args"] != expected_arguments
            or native["env"]["CUA_REPL_NODE_REPL_PATH"]
            != str(resources / "bin/node_repl")
            or native["env"]["BROWSER_USE_CODEX_APP_VERSION"] != version
            or Path(native["env"]["CODEX_HOME"]).expanduser().resolve()
            != home.resolve()
            or native.get("enabled") is not True
        ):
            raise ConfigError(
                "installed native browser layout is unsupported; config unchanged"
            )
        checked(Path(expected_arguments[2]), allow_root_owner=True, must_exist=True)
        for binary in (
            Path(native["command"]),
            resources / "bin/node_repl",
            app / "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            app / "Contents/MacOS/ChatGPT",
        ):
            _verify_native_binary(
                checked(binary, allow_root_owner=True, must_exist=True)
            )
        return app, version, native
    except ConfigError:
        raise
    except Exception as error:
        raise ConfigError(
            "native browser configuration is missing or invalid; config unchanged"
        ) from error


def _browser_launcher(app: Path, home: Path) -> tuple[str, list[str]]:
    # Retain the activated environment's interpreter path (including its venv).
    # A uv parent at MCP runtime breaks native browser process provenance.
    python = os.path.abspath(sys.executable)
    try:
        _native_command(
            [
                python,
                str(Path(__file__).resolve()),
                "--help",
            ]
        )
    except ConfigError as error:
        raise ConfigError(
            "native browser launcher Python environment is unavailable; "
            "run this helper with uv run --script, then retry preview"
        ) from error
    return python, [
        str(Path(__file__).resolve()),
        "--codex-home",
        str(home),
        "browser-mcp",
        "--desktop-browser-app",
        str(app),
    ]


def desktop_browser_definition(app: Path, home: Path, document) -> dict:
    """Provision one native MCP, retaining policy and the app-provided account scope."""
    try:
        app, version, native = _desktop_runtime(app, home)
        cache = home / "plugins/cache/openai-bundled/unified-computer-use"
        plugin = document.get("plugins", {}).get(BROWSER_PLUGIN, {})
        policy = dict(plugin.get("mcp_servers", {}).get("cua_repl", {}))
        existing = dict(document.get("mcp_servers", {}).get("cua_repl", {}))
        if (
            plugin.get("enabled") is False
            or policy.get("enabled") is False
            or existing.get("enabled") is False
        ):
            raise ConfigError("native browser is explicitly disabled; config unchanged")
        transport = {"command", "args", "env", "env_vars", "url", "type"}
        if transport.intersection(policy):
            raise ConfigError(
                "custom plugin transport policy needs manual reconciliation"
            )
        custom_environment = {}
        if existing and DESKTOP_CONTEXT in existing.get("env", {}):
            arguments = existing.get("args", [])
            if (
                "url" in existing
                or len(arguments) != 6
                or Path(arguments[0]).name != Path(__file__).name
                or arguments[1:3] != ["--codex-home", str(home)]
                or arguments[3:] != ["browser-mcp", "--desktop-browser-app", str(app)]
                or not Path(existing.get("command", "")).name.startswith("python")
                or "BROWSER_USE_ACCESS_EXECUTOR_ID" in existing.get("env", {})
            ):
                raise ConfigError(
                    "refusing to replace a custom native browser launcher"
                )
            custom_environment = {
                key: value
                for key, value in existing.get("env", {}).items()
                if key != DESKTOP_CONTEXT
            }
        elif existing:
            arguments = existing.get("args", [])
            if (
                existing.get("command") != native["command"]
                or len(arguments) != 3
                or arguments[0] != "--import"
                or arguments[2] != native["args"][2]
                or "url" in existing
            ):
                raise ConfigError("refusing to replace a custom CUA transport")
            uri = urlsplit(arguments[1])
            guard = Path(unquote(uri.path))
            if (
                uri.scheme != "file"
                or uri.netloc
                or uri.query
                or uri.fragment
                or guard.parent.parent != cache
                or guard.name != "require-browser-access.mjs"
            ):
                raise ConfigError("refusing to replace a custom CUA browser guard")
            previous = json.loads(checked(guard.with_name(".mcp.json")).read_bytes())[
                "mcpServers"
            ]["cua_repl"]
            if (
                previous["command"] != existing["command"]
                or previous["args"] != arguments
            ):
                raise ConfigError(
                    "prior native CUA manifest does not match this connection"
                )
            for key, value in existing.get("env", {}).items():
                if (
                    key != "BROWSER_USE_ACCESS_EXECUTOR_ID"
                    and previous.get("env", {}).get(key) != value
                ):
                    custom_environment[key] = value
        native["env_vars"] = list(
            dict.fromkeys([*native.get("env_vars", []), *existing.get("env_vars", [])])
        )
        merged_policy = {
            key: value for key, value in policy.items() if key not in transport
        }
        for key, value in existing.items():
            if key in transport or key in {"required", "omit_tools_from"}:
                continue
            if key == "tools":
                tools = {
                    name: dict(rule)
                    for name, rule in merged_policy.get("tools", {}).items()
                }
                for name, rule in value.items():
                    previous = tools.setdefault(name, {})
                    for field, setting in rule.items():
                        if field in previous and previous[field] != setting:
                            raise ConfigError(
                                "conflicting native browser policies need manual reconciliation"
                            )
                        previous[field] = setting
                merged_policy[key] = tools
            elif key in merged_policy and merged_policy[key] != value:
                raise ConfigError(
                    "conflicting native browser policies need manual reconciliation"
                )
            else:
                merged_policy[key] = value
        native.update(merged_policy)
        if "js" in native.get("disabled_tools", []) or "js" not in native.get(
            "enabled_tools", ["js"]
        ):
            raise ConfigError(
                "native CUA js tool is explicitly restricted; config unchanged"
            )
        native["env"] = {
            **custom_environment,
            DESKTOP_CONTEXT: _desktop_context(app, home, version),
        }
        native["command"], native["args"] = _browser_launcher(app, home)
        native.update(required=True, omit_tools_from=[])
        return native
    except ConfigError:
        raise
    except Exception as error:
        raise ConfigError(
            "native browser configuration is missing or invalid; config unchanged"
        ) from error


def _rebind_browser_context(stored: str, inherited: str) -> str:
    provided = _browser_scope(stored)
    current = _browser_scope(inherited, (2, 3))
    if len(current) == 3:
        if current[1:] != provided[1:]:
            raise ConfigError(
                "native desktop account changed; reactivate browser setup"
            )
        return inherited
    if current[1] != "native-browser-plugin":
        raise ConfigError("expected the native desktop browser marker")
    # The prefix is an app-instance ID, not an account identity. Account components
    # remain app-provided, and the native broker checks them against the live login.
    return json.dumps(
        [current[0], *provided[1:]], ensure_ascii=False, separators=(",", ":")
    )


def browser_mcp(app: Path, home: Path) -> None:
    """Exec the signed native MCP with current runtime paths and host-instance ID."""
    app, _, native = _desktop_runtime(app, home)
    try:
        document = tomlkit.parse(read(checked(home / "config.toml")).decode("utf-8"))
        explicit = dict(document["mcp_servers"]["cua_repl"].get("env", {}))
        if not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in explicit.items()
        ):
            raise ValueError()
        inherited = os.environ.get("BROWSER_USE_ACCESS_EXECUTOR_ID", "")
        if any(not os.environ.get(key) for key in CONTEXT_FIELDS[1:3]):
            raise ConfigError(
                "start native browser MCP through the connected desktop host"
            )
        context = _rebind_browser_context(explicit.pop(DESKTOP_CONTEXT), inherited)
        environment = {**os.environ, **native["env"], **explicit}
        environment.pop(DESKTOP_CONTEXT, None)
        environment["BROWSER_USE_ACCESS_EXECUTOR_ID"] = context
    except ConfigError:
        raise
    except Exception as error:
        raise ConfigError(
            "native browser setup is missing or invalid; reactivate it"
        ) from error
    os.execve(native["command"], [native["command"], *native["args"]], environment)


def merged(
    before: bytes | None,
    servers: list[str],
    plugin_servers: list[list[str]],
    *,
    all_servers: bool = False,
    browser_app: Path | None = None,
    codex_home: Path | None = None,
) -> bytes:
    try:
        document = tomlkit.parse((before or b"").decode("utf-8"))
        preset = tomlkit.parse(PRESET.read_text(encoding="utf-8"))
        if browser_app is not None:
            if codex_home is None:
                raise ConfigError("native browser setup needs the intended Codex home")
            definition = desktop_browser_definition(browser_app, codex_home, document)
            servers_table = document.setdefault("mcp_servers", tomlkit.table())
            browser = servers_table.setdefault("cua_repl", tomlkit.table())
            environment = browser.setdefault("env", tomlkit.table())
            new_environment = definition.pop("env")
            for key in list(environment):
                if key not in new_environment:
                    environment.pop(key)
            environment.update(new_environment)
            browser.update(definition)
        if all_servers:
            servers = sorted(set(servers) | set(document.get("mcp_servers", {})))
            plugin_servers = plugin_servers + [
                [plugin, server]
                for plugin, values in document.get("plugins", {}).items()
                for server in values.get("mcp_servers", {})
            ]
        # Choose the supported legacy mode alone; retain custom profile definitions.
        document.pop("default_permissions", None)
        for key in ("approval_policy", "sandbox_mode", "web_search"):
            document[key] = preset[key]
        for section, values in (
            ("apps", preset["apps"]),
            ("computer_use", preset["computer_use"]),
        ):
            if section not in document:
                document[section] = tomlkit.table()
            if section == "apps":
                if "_default" not in document[section]:
                    document[section]["_default"] = tomlkit.table()
                document[section]["_default"].update(values["_default"])
            else:
                document[section].update(values)
        for server in servers:
            # Existing definitions only: never invent a connection or wildcard policy.
            document["mcp_servers"][server]["default_tools_approval_mode"] = "approve"
        for plugin, server in plugin_servers:
            document["plugins"][plugin]["mcp_servers"][server][
                "default_tools_approval_mode"
            ] = "approve"
        result = tomlkit.dumps(document).encode("utf-8")
        tomlkit.parse(result.decode("utf-8"))
        return result
    except ConfigError:
        raise
    except Exception as error:
        raise ConfigError(
            "invalid TOML/table shape or named server is not configured; no changes applied"
        ) from error


def apply(
    home: Path,
    servers: list[str],
    plugin_servers: list[list[str]],
    *,
    preview: bool,
    all_servers: bool = False,
    browser_app: Path | None = None,
) -> dict:
    target = checked(home / "config.toml")
    home = target.parent
    before = read(target)
    after = merged(
        before,
        servers,
        plugin_servers,
        all_servers=all_servers,
        browser_app=browser_app,
        codex_home=home,
    )
    if after == before:
        return {"status": "unchanged"}
    if preview:
        return {
            "status": "preview",
            "changes": [
                "approval_policy",
                "sandbox_mode",
                "web_search",
                "apps._default",
                "computer_use.default_app_access",
            ]
            + (["mcp_servers.cua_repl"] if browser_app is not None else []),
            "removes_default_permissions": "default_permissions"
            in tomlkit.parse((before or b"").decode("utf-8")),
            "all_configured_servers": all_servers,
            "selected_mcp_server_count": len(servers) + len(plugin_servers),
        }
    return commit_config(home, before, after)


def commit_config(home: Path, before: bytes | None, after: bytes) -> dict:
    """Share the existing exact-backup and atomic-write contract across operations."""
    target = checked(home / "config.toml")
    home = target.parent
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    with locked(home):
        if read(target) != before:
            raise ConfigError("configuration changed during preparation; retry preview")
        mode = stat.S_IMODE(target.stat().st_mode) if before is not None else 0o600
        # Backups can contain credentials; create an independent, private directory.
        backup = home / ("agentic-workflows-config-backup-" + uuid.uuid4().hex)
        backup.mkdir(mode=0o700)
        if before is not None:
            atomic_write(backup / "config.toml", before)
        receipt = {
            "version": 1,
            "before_sha256": digest(before),
            "after_sha256": digest(after),
            "mode": mode,
        }
        atomic_write(backup / "receipt.json", json.dumps(receipt).encode("utf-8"))
        if read(target) != before:
            raise ConfigError(
                "configuration changed; backup retained, no activation performed"
            )
        atomic_write(target, after, mode)
    return {
        "status": "applied",
        "backup": str(backup),
        "restart": "start a new task/client and inspect effective permissions",
    }


def listed_hooks(home: Path) -> list[dict]:
    """Ask the installed Codex for hashes; never implement its trust algorithm."""
    async def inspect() -> dict:
        process = await asyncio.create_subprocess_exec(
            "codex", "app-server", "--stdio",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, cwd=home,
            env={**os.environ, "CODEX_HOME": str(home)}, limit=4 * 1024 * 1024,
        )
        try:
            async def request(request_id, method, params):
                process.stdin.write((json.dumps({
                    "id": request_id, "method": method, "params": params,
                }) + "\n").encode())
                await process.stdin.drain()
                while line := await process.stdout.readline():
                    value = json.loads(line)
                    if value.get("id") == request_id:
                        if "error" in value or not isinstance(value.get("result"), dict):
                            raise ConfigError("native hook discovery failed; config unchanged")
                        return value["result"]
                raise ConfigError("native hook discovery disconnected; config unchanged")

            await request(1, "initialize", {
                "clientInfo": {"name": "agentic-workflows-config", "version": "1"},
                "capabilities": {"experimentalApi": True},
            })
            process.stdin.write(b'{"method":"initialized","params":{}}\n')
            return await request(2, "hooks/list", {"cwds": [str(home)]})
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()

    async def bounded():
        return await asyncio.wait_for(inspect(), timeout=20)

    try:
        result = asyncio.run(bounded())
        entries = result["data"]
        if (len(entries) != 1 or entries[0]["cwd"] != str(home)
                or entries[0]["errors"] or entries[0]["warnings"]
                or not isinstance(entries[0]["hooks"], list)
                or not all(isinstance(hook, dict) for hook in entries[0]["hooks"])):
            raise ValueError()
        return entries[0]["hooks"]
    except ConfigError:
        raise
    except Exception as error:
        raise ConfigError("native hook discovery unavailable or invalid; config unchanged") from error


def trust_hooks(home: Path, *, preview: bool = False, update: bool = False) -> dict:
    """Explicitly refresh only enabled hooks belonging to the suite's exact ID."""
    target = checked(home / "config.toml")
    home = target.parent
    before = read(target)
    if update:
        try:
            subprocess.run(
                ["codex", "plugin", "marketplace", "upgrade", "agentic-workflows"],
                cwd=home, env={**os.environ, "CODEX_HOME": str(home)},
                capture_output=True, check=True, timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise ConfigError("suite update failed; hook trust was not changed") from error
        # The native updater may itself write config. Preserve its completed work.
        before = read(target)
    hooks = listed_hooks(home)
    selected = {}
    try:
        document = tomlkit.parse((before or b"").decode("utf-8"))
        for hook in hooks:
            if hook.get("pluginId") != SUITE_PLUGIN or hook.get("source") != "plugin":
                continue
            if hook["isManaged"] is True or hook["enabled"] is False:
                continue
            key, current = hook["key"], hook["currentHash"]
            if (hook["isManaged"] is not False or hook["enabled"] is not True
                    or not isinstance(key, str) or not key.startswith(SUITE_PLUGIN + ":")
                    or key in selected or not isinstance(current, str)
                    or re.fullmatch(r"sha256:[0-9a-f]{64}", current) is None):
                raise ValueError()
            state = document.setdefault("hooks", tomlkit.table()).setdefault(
                "state", tomlkit.table()
            ).setdefault(key, tomlkit.table())
            if state.get("enabled") is False:
                continue
            state["trusted_hash"] = current
            selected[key] = current
        after = tomlkit.dumps(document).encode("utf-8")
        tomlkit.parse(after.decode("utf-8"))
    except Exception as error:
        raise ConfigError("invalid suite hook metadata or TOML; hook trust unchanged") from error
    summary = {"plugin": SUITE_PLUGIN, "hook_count": len(selected),
               "marketplace_updated": update}
    if not selected:
        return {"status": "unchanged", **summary}
    if after == before:
        if any(hook.get("trustStatus") != "trusted" for hook in hooks
               if hook.get("key") in selected):
            raise ConfigError("saved suite hook hashes are not effective; inspect client policy")
        return {"status": "unchanged", **summary, "verified": True}
    if preview:
        return {"status": "preview", **summary}
    result = commit_config(home, before, after)
    try:
        observed = {hook["key"]: hook for hook in listed_hooks(home)
                    if hook.get("pluginId") == SUITE_PLUGIN and hook.get("source") == "plugin"}
        if any(observed[key]["currentHash"] != current
               or observed[key]["trustStatus"] != "trusted" for key, current in selected.items()):
            raise ValueError()
    except Exception as error:
        # Restore refuses to overwrite concurrent edits and retains the backup.
        try:
            restore(home, Path(result["backup"]))
        except Exception as rollback_error:
            raise ConfigError(
                "native hook trust verification failed; automatic restore unavailable; "
                "preserve current config and reconcile backup at " + result["backup"]
            ) from rollback_error
        raise ConfigError("native hook trust verification failed; config restored, backup retained") from error
    return {**result, **summary, "verified": True,
            "restart": "start a new task/client to load approved hooks"}


def restore(home: Path, backup: Path) -> dict:
    target = checked(home / "config.toml")
    home = target.parent
    backup = Path(os.path.abspath(backup.expanduser()))
    if backup.parent != target.parent or not backup.name.startswith(
        "agentic-workflows-config-backup-"
    ):
        raise ConfigError(
            "backup must be the helper's backup directory in this Codex home"
        )
    try:
        receipt = json.loads(checked(backup / "receipt.json").read_bytes())
        before = read(backup / "config.toml")
        after_digest = receipt["after_sha256"]
        if (
            receipt["version"] != 1
            or digest(before) != receipt["before_sha256"]
            or not isinstance(after_digest, str)
            or len(after_digest) != 64
            or any(character not in "0123456789abcdef" for character in after_digest)
        ):
            raise ValueError()
        mode = receipt["mode"]
        if not isinstance(mode, int) or not 0 <= mode <= 0o777:
            raise ValueError()
    except (KeyError, ValueError, TypeError) as error:
        raise ConfigError("invalid backup; configuration was not changed") from error
    with locked(home):
        if digest(read(target)) != after_digest:
            raise ConfigError(
                "configuration changed since activation; preserve it and reconcile manually"
            )
        if before is None:
            target.unlink()
        else:
            atomic_write(target, before, mode)
    return {"status": "restored", "backup_retained": True}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")),
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("preview", "apply"):
        child = commands.add_parser(command)
        child.add_argument("--mcp-server", action="append", default=[])
        child.add_argument(
            "--desktop-browser-app",
            type=Path,
            help="explicitly provision native browser tools from this installed macOS app",
        )
        child.add_argument(
            "--plugin-server",
            nargs=2,
            action="append",
            default=[],
            metavar=("PLUGIN", "SERVER"),
        )
        child.add_argument(
            "--all-configured-servers",
            action="store_true",
            help="approve defaults for all MCP/plugin servers defined in this user config",
        )
    commands.add_parser("restore").add_argument("backup", type=Path)
    commands.add_parser("update", help="update this suite and refresh its hook trust")
    commands.add_parser("trust-hooks", help="refresh this suite's current hook trust").add_argument(
        "--preview", action="store_true", help="inspect without writing configuration",
    )
    commands.add_parser("browser-mcp").add_argument(
        "--desktop-browser-app",
        type=Path,
        required=True,
    )
    args = parser.parse_args()
    try:
        if args.command == "restore":
            result = restore(args.codex_home, args.backup)
        elif args.command in ("update", "trust-hooks"):
            result = trust_hooks(
                args.codex_home, preview=getattr(args, "preview", False),
                update=args.command == "update",
            )
        elif args.command == "browser-mcp":
            browser_mcp(args.desktop_browser_app, args.codex_home)
            return 0
        else:
            result = apply(
                args.codex_home,
                args.mcp_server,
                args.plugin_server,
                preview=args.command == "preview",
                all_servers=args.all_configured_servers,
                browser_app=args.desktop_browser_app,
            )
        print(json.dumps(result))
        return 0
    except (ConfigError, OSError) as error:
        # Never print parser or OS exceptions, which can contain private content.
        print(
            str(error)
            if isinstance(error, ConfigError)
            else "configuration I/O failed; inspect local files before retrying",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
