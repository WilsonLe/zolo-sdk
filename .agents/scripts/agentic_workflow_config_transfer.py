#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["cryptography==49.0.0"]
# ///
"""Export or import authenticated-encrypted Agentic Workflows workflow configuration."""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import platform
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from account_credential_common import (
    CredentialError,
    atomic_private_write,
    git_container,
    validate_private_file,
)

FORMAT_ID = "agentic-workflows-transfer"
ENVELOPE_VERSION = 1
PAYLOAD_VERSION = 2
MAX_ENVELOPE_BYTES = 262_144
PREFERENCES = (
    Path.home() / ".config" / "agentic-workflows" / "agentic-workflows" / "config.json"
)
WORKFLOW_IDS = {
    "academic-writing-workflow",
    "cloudflare-account-operations",
    "digitalocean-account-operations",
    "railway-account-operations",
    "food-image-editing",
    "humanizer",
    "standard-development-workflow",
    "verified-literature-research",
}
LANGUAGE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
KEYCHAIN_SERVICE = "org.agentic-workflows.transfer"
KEYCHAIN_ACCOUNT = "local-session-key-v1"
SALT_BYTES = 16
NONCE_BYTES = 12
KEY_BYTES = 32
SCRYPT_N = 2**17
SCRYPT_R = 8
SCRYPT_P = 1


class TransferError(RuntimeError):
    """A sanitized transfer failure."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def b64decode(value: Any, field: str) -> bytes:
    if not isinstance(value, str):
        raise TransferError(f"{field} must be base64 text")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as error:
        raise TransferError(f"{field} is not valid base64") from error


def normalize_passphrase(value: str) -> bytes:
    normalized = unicodedata.normalize("NFKC", value)
    if len(normalized) < 12:
        raise TransferError("portable passphrases must contain at least 12 characters")
    if len(normalized.encode("utf-8")) > 1024:
        raise TransferError("the portable passphrase is unexpectedly large")
    return normalized.encode("utf-8")


def prompt_macos(message: str) -> str:
    script = (
        'set answerText to text returned of (display dialog "'
        + message.replace('"', '\\"')
        + '" default answer "" with hidden answer buttons {"Cancel", "Continue"} '
        'default button "Continue" cancel button "Cancel")\n'
        "return answerText"
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise TransferError("the passphrase prompt was cancelled or unavailable")
    return result.stdout.rstrip("\r\n")


def prompt_windows(message: str) -> str:
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Agentic Workflows encrypted transfer'
$form.Width = 470
$form.Height = 170
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = $args[0]
$label.Left = 15
$label.Top = 15
$label.Width = 420
$box = New-Object System.Windows.Forms.TextBox
$box.Left = 15
$box.Top = 45
$box.Width = 420
$box.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Continue'
$ok.Left = 270
$ok.Top = 80
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 360
$cancel.Top = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label,$box,$ok,$cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 2 }
[Console]::Out.Write($box.Text)
"""
    executable = "powershell.exe"
    result = subprocess.run(
        [executable, "-NoProfile", "-NonInteractive", "-Command", script, message],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise TransferError("the passphrase prompt was cancelled or unavailable")
    return result.stdout


def get_passphrase(*, confirm: bool, use_stdin: bool) -> bytes:
    def read_once(message: str) -> str:
        if use_stdin:
            value = sys.stdin.readline()
            if value == "":
                raise TransferError("the local passphrase input ended unexpectedly")
            return value.rstrip("\r\n")
        if sys.stdin.isatty():
            return getpass.getpass(message + ": ")
        system = platform.system()
        if system == "Darwin":
            return prompt_macos(message)
        if system == "Windows":
            return prompt_windows(message)
        raise TransferError(
            "no trusted local passphrase prompt is available; run this helper "
            "in an interactive terminal"
        )

    first = read_once("Enter portable transfer passphrase")
    if confirm:
        second = read_once("Confirm portable transfer passphrase")
        if not secrets.compare_digest(first, second):
            raise TransferError("the passphrase confirmation did not match")
    return normalize_passphrase(first)


def macos_local_key(*, create: bool) -> bytes:
    import ctypes
    import ctypes.util

    framework_path = ctypes.util.find_library("Security")
    if framework_path is None:
        raise TransferError("the macOS Security framework is unavailable")
    security_framework = ctypes.CDLL(framework_path)
    service = KEYCHAIN_SERVICE.encode("utf-8")
    account = KEYCHAIN_ACCOUNT.encode("utf-8")
    password_length = ctypes.c_uint32()
    password_data = ctypes.c_void_p()
    item_ref = ctypes.c_void_p()
    status = security_framework.SecKeychainFindGenericPassword(
        None,
        len(service),
        service,
        len(account),
        account,
        ctypes.byref(password_length),
        ctypes.byref(password_data),
        ctypes.byref(item_ref),
    )
    if status == 0:
        try:
            key = ctypes.string_at(password_data, password_length.value)
        finally:
            security_framework.SecKeychainItemFreeContent(None, password_data)
        if len(key) != KEY_BYTES:
            raise TransferError("the local transfer key is invalid")
        return key
    if not create:
        raise TransferError(
            "this local-session export belongs to another OS account or machine"
        )
    key = secrets.token_bytes(KEY_BYTES)
    key_buffer = ctypes.create_string_buffer(key)
    status = security_framework.SecKeychainAddGenericPassword(
        None,
        len(service),
        service,
        len(account),
        account,
        len(key),
        key_buffer,
        None,
    )
    if status != 0:
        raise TransferError("the local transfer key could not be stored in Keychain")
    return key


def windows_local_key(*, create: bool) -> bytes:
    key_path = (
        Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        / "Agentic Workflows"
        / "AgenticWorkflows"
        / "transfer-key.dpapi"
    )
    script = r"""
$path = $args[0]
$create = $args[1] -eq '1'
Add-Type -AssemblyName System.Security
if (Test-Path -LiteralPath $path) {
  $cipher = [IO.File]::ReadAllBytes($path)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  exit 0
}
if (-not $create) { exit 3 }
$plain = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($plain)
$cipher = [Security.Cryptography.ProtectedData]::Protect(
  $plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
[IO.File]::WriteAllBytes($path, $cipher)
[Console]::Out.Write([Convert]::ToBase64String($plain))
"""
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            str(key_path),
            "1" if create else "0",
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise TransferError(
            "the Windows local transfer key is unavailable for this OS user"
        )
    try:
        key = base64.b64decode(result.stdout, validate=True)
    except ValueError as error:
        raise TransferError("the Windows local transfer key is invalid") from error
    if len(key) != KEY_BYTES:
        raise TransferError("the Windows local transfer key is invalid")
    return key


def local_key(*, create: bool) -> bytes:
    system = platform.system()
    if system == "Darwin":
        return macos_local_key(create=create)
    if system == "Windows":
        return windows_local_key(create=create)
    raise TransferError("local-session mode is not supported on this operating system")


def derive_key(passphrase: bytes, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=KEY_BYTES, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(
        passphrase
    )


def validate_preferences(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {
            "preferred_workflow_ids": [],
            "default_workflow_id": None,
            "response_language": None,
        }
    expected = {"preferred_workflow_ids", "default_workflow_id", "response_language"}
    if not isinstance(payload, dict) or set(payload) != expected:
        raise TransferError("workflow preferences contain unknown or missing fields")
    preferred = payload["preferred_workflow_ids"]
    default = payload["default_workflow_id"]
    language = payload["response_language"]
    if (
        not isinstance(preferred, list)
        or len(preferred) > len(WORKFLOW_IDS)
        or len(set(preferred)) != len(preferred)
        or any(item not in WORKFLOW_IDS for item in preferred)
    ):
        raise TransferError("preferred workflow IDs are invalid")
    if default is not None and default not in WORKFLOW_IDS:
        raise TransferError("the default workflow ID is invalid")
    if default is not None and default not in preferred:
        raise TransferError("the default workflow must also be preferred")
    if language is not None and (
        not isinstance(language, str) or not LANGUAGE_PATTERN.fullmatch(language)
    ):
        raise TransferError("the response language tag is invalid")
    return {
        "preferred_workflow_ids": preferred,
        "default_workflow_id": default,
        "response_language": language,
    }


def load_preferences(path: Path) -> dict[str, Any]:
    if not path.exists():
        return validate_preferences(None)
    try:
        validate_private_file(path)
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (CredentialError, OSError, UnicodeError, json.JSONDecodeError) as error:
        raise TransferError("local workflow preferences are invalid") from error
    return validate_preferences(payload)


def validate_payload(payload: Any) -> dict[str, Any]:
    """Accept preferences only; reject legacy provider tokens before any write."""
    if (not isinstance(payload, dict)
            or not isinstance(payload.get("schema_version"), int)
            or isinstance(payload.get("schema_version"), bool)):
        raise TransferError("the decrypted transfer payload has an invalid schema")
    version = payload["schema_version"]
    if version == 1:
        if set(payload) != {"schema_version", "preferences", "credentials"}:
            raise TransferError("the legacy transfer payload has an invalid schema")
        if payload["credentials"] != {}:
            raise TransferError(
                "legacy provider credentials are no longer imported; reconnect through Codex "
                "and export a new preferences-only file"
            )
    elif version == PAYLOAD_VERSION:
        if set(payload) != {"schema_version", "preferences"}:
            raise TransferError("preferences-only transfers cannot contain credentials or unknown fields")
    else:
        raise TransferError("the decrypted transfer payload version is unsupported")
    return {
        "schema_version": PAYLOAD_VERSION,
        "preferences": validate_preferences(payload.get("preferences")),
    }


def header_for(mode: str, salt: bytes) -> dict[str, Any]:
    kdf: dict[str, Any]
    if mode == "portable-passphrase":
        kdf = {
            "name": "scrypt",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "salt": b64encode(salt),
        }
    else:
        kdf = {"name": "local-os-credential-store-v1"}
    return {
        "format": FORMAT_ID,
        "envelope_version": ENVELOPE_VERSION,
        "origin_plugin": "agentic-workflows",
        "mode": mode,
        "kdf": kdf,
        "cipher": {"name": "AES-256-GCM"},
    }


def encrypt_payload(payload: dict[str, Any], mode: str, passphrase: bytes | None) -> dict[str, Any]:
    salt = secrets.token_bytes(SALT_BYTES) if mode == "portable-passphrase" else b""
    if mode == "portable-passphrase":
        if passphrase is None:
            raise TransferError("portable mode requires a local passphrase")
        key = derive_key(passphrase, salt)
    elif mode == "local-session":
        key = local_key(create=True)
    else:
        raise TransferError("the transfer mode is unsupported")
    header = header_for(mode, salt)
    nonce = secrets.token_bytes(NONCE_BYTES)
    ciphertext = AESGCM(key).encrypt(nonce, canonical_json(payload), canonical_json(header))
    return {**header, "nonce": b64encode(nonce), "ciphertext": b64encode(ciphertext)}


def decrypt_envelope(
    envelope: Any,
    *,
    passphrase_provider: Callable[[], bytes] | None = None,
) -> dict[str, Any]:
    expected = {
        "format",
        "envelope_version",
        "origin_plugin",
        "mode",
        "kdf",
        "cipher",
        "nonce",
        "ciphertext",
    }
    if not isinstance(envelope, dict) or set(envelope) != expected:
        raise TransferError("the transfer envelope has unknown or missing fields")
    if (
        envelope.get("format") != FORMAT_ID
        or envelope.get("envelope_version") != ENVELOPE_VERSION
        or envelope.get("origin_plugin") != "agentic-workflows"
        or envelope.get("cipher") != {"name": "AES-256-GCM"}
    ):
        raise TransferError("the transfer envelope version or cipher is unsupported")
    mode = envelope.get("mode")
    kdf = envelope.get("kdf")
    if mode == "portable-passphrase":
        expected_kdf = {"name", "n", "r", "p", "salt"}
        if (
            not isinstance(kdf, dict)
            or set(kdf) != expected_kdf
            or kdf.get("name") != "scrypt"
            or kdf.get("n") != SCRYPT_N
            or kdf.get("r") != SCRYPT_R
            or kdf.get("p") != SCRYPT_P
        ):
            raise TransferError("the portable KDF parameters are unsupported")
        salt = b64decode(kdf.get("salt"), "kdf.salt")
        if len(salt) != SALT_BYTES:
            raise TransferError("the portable KDF salt length is invalid")
        if passphrase_provider is None:
            raise TransferError("portable mode requires a local passphrase")
        key = derive_key(passphrase_provider(), salt)
    elif mode == "local-session":
        if kdf != {"name": "local-os-credential-store-v1"}:
            raise TransferError("the local key-store metadata is invalid")
        key = local_key(create=False)
    else:
        raise TransferError("the transfer mode is unsupported")
    nonce = b64decode(envelope.get("nonce"), "nonce")
    ciphertext = b64decode(envelope.get("ciphertext"), "ciphertext")
    if len(nonce) != NONCE_BYTES or len(ciphertext) < 16:
        raise TransferError("the encrypted transfer dimensions are invalid")
    header = {key_name: envelope[key_name] for key_name in expected - {"nonce", "ciphertext"}}
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, canonical_json(header))
    except InvalidTag as error:
        raise TransferError(
            "the passphrase/key is wrong or the encrypted transfer was modified"
        ) from error
    try:
        payload = json.loads(plaintext)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise TransferError("the decrypted transfer payload is invalid JSON") from error
    return validate_payload(payload)


def read_envelope(path: Path) -> dict[str, Any]:
    expanded = Path(os.path.abspath(path.expanduser()))
    try:
        file_stat = expanded.lstat()
    except OSError as error:
        raise TransferError("the selected transfer file cannot be inspected") from error
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(file_stat.st_mode):
        raise TransferError("the selected transfer must be a regular file, not a symlink")
    if expanded.suffix.lower() != ".agenticx":
        raise TransferError("the selected transfer must use the .agenticx suffix")
    if file_stat.st_size == 0 or file_stat.st_size > MAX_ENVELOPE_BYTES:
        raise TransferError("the selected transfer size is invalid")
    try:
        payload = json.loads(expanded.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise TransferError("the selected transfer is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise TransferError("the selected transfer envelope must be an object")
    return payload


def write_export(path: Path, envelope: dict[str, Any]) -> None:
    if path.suffix.lower() != ".agenticx":
        raise TransferError("export output must use the .agenticx suffix")
    expanded = Path(os.path.abspath(path.expanduser()))
    if git_container(expanded) is not None:
        raise TransferError("export output must remain outside Git")
    try:
        parent_stat = expanded.parent.lstat()
    except OSError as error:
        raise TransferError("the export output directory cannot be inspected") from error
    if stat.S_ISLNK(parent_stat.st_mode) or not stat.S_ISDIR(parent_stat.st_mode):
        raise TransferError("the export output directory is not a regular directory")
    if hasattr(os, "getuid") and parent_stat.st_uid != os.getuid():
        raise TransferError("the export output directory is not owned by the current user")
    if expanded.exists() or expanded.is_symlink():
        raise TransferError("the export output already exists")
    data = canonical_json(envelope) + b"\n"
    descriptor = -1
    temporary: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{expanded.name}.",
            suffix=".tmp",
            dir=expanded.parent,
        )
        temporary = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o600)
        os.replace(temporary, expanded)
        temporary = None
    except OSError as error:
        raise TransferError("the encrypted export could not be written atomically") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
    if stat.S_IMODE(expanded.stat().st_mode) != 0o600:
        raise TransferError("the encrypted export failed its mode verification")


def apply_payload(
    payload: dict[str, Any],
    *,
    preferences_path: Path = PREFERENCES,
) -> None:
    payload = validate_payload(payload)
    existing = preferences_path.exists() or preferences_path.is_symlink()
    if existing:
        validate_private_file(preferences_path)
    try:
        atomic_private_write(
            preferences_path, canonical_json(payload["preferences"]) + b"\n",
            replace=existing, exclusive=not existing,
        )
    except (CredentialError, OSError) as error:
        raise TransferError("preference import failed; inspect local state before retrying") from error


def sanitized_preview(payload: dict[str, Any]) -> dict[str, Any]:
    payload = validate_payload(payload)
    return {"preference_fields": sorted(payload["preferences"])}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--output", required=True, type=Path)
    export_parser.add_argument(
        "--mode",
        choices=("local-session", "portable-passphrase"),
        default="local-session",
    )
    export_parser.add_argument("--preferences-file", type=Path, default=PREFERENCES)
    export_parser.add_argument("--passphrase-stdin", action="store_true", help=argparse.SUPPRESS)
    import_parser = subparsers.add_parser("import")
    import_parser.add_argument("source", type=Path)
    import_parser.add_argument("--preferences-file", type=Path, default=PREFERENCES)
    import_parser.add_argument("--passphrase-stdin", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.command == "export":
            passphrase = (
                get_passphrase(confirm=True, use_stdin=args.passphrase_stdin)
                if args.mode == "portable-passphrase"
                else None
            )
            payload = validate_payload(
                {
                    "schema_version": PAYLOAD_VERSION,
                    "preferences": load_preferences(args.preferences_file),
                }
            )
            envelope = encrypt_payload(payload, args.mode, passphrase)
            write_export(args.output, envelope)
            verified = decrypt_envelope(
                read_envelope(args.output),
                passphrase_provider=(lambda: passphrase) if passphrase is not None else None,
            )
            if verified != payload:
                raise TransferError("export self-verification failed")
            print(
                json.dumps(
                    {
                        "exported": str(args.output.resolve()),
                        "mode": args.mode,
                        "preference_fields": sorted(payload["preferences"]),
                    },
                    sort_keys=True,
                )
            )
        else:
            envelope = read_envelope(args.source)
            attempts = 0

            def provide_passphrase() -> bytes:
                nonlocal attempts
                attempts += 1
                if attempts > 3:
                    raise TransferError("the portable passphrase attempt limit was reached")
                return get_passphrase(confirm=False, use_stdin=args.passphrase_stdin)

            payload = decrypt_envelope(envelope, passphrase_provider=provide_passphrase)
            print(json.dumps({"preview": sanitized_preview(payload)}, sort_keys=True))
            apply_payload(
                payload,
                preferences_path=args.preferences_file,
            )
            print(
                json.dumps(
                    {
                        "imported": True,
                        "preference_fields": sorted(payload["preferences"]),
                    },
                    sort_keys=True,
                )
            )
    except (TransferError, CredentialError) as error:
        print(f"Agentic Workflows config transfer failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
