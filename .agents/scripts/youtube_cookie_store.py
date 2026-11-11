#!/usr/bin/env python3
"""Manage protected YouTube exports and temporary Codex browser cookie files."""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

MAX_COOKIE_FILE_BYTES = 1024 * 1024
ALLOWED_HEADERS = {"# HTTP Cookie File", "# Netscape HTTP Cookie File"}
YOUTUBE_DOMAIN = "youtube.com"
REVOKE_CONFIRMATION = "I_APPROVE_YOUTUBE_COOKIE_REVOKE"


class CookieStoreError(RuntimeError):
    """Raised when cookie material or protected storage is unsafe."""


@dataclass(frozen=True)
class CookieSummary:
    record_count: int
    session_records: int
    unexpired_records: int
    expired_records: int

    def public(self) -> dict[str, int | list[str]]:
        return {
            "record_count": self.record_count,
            "session_records": self.session_records,
            "unexpired_records": self.unexpired_records,
            "expired_records": self.expired_records,
            "domains": [YOUTUBE_DOMAIN],
        }


def config_directory() -> Path:
    override = os.environ.get("AGENTIC_WORKFLOWS_YOUTUBE_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".config" / "agentic-workflows" / "youtube"


def cookie_path() -> Path:
    return config_directory() / "cookies.txt"


def _regular_source(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise CookieStoreError(f"cookie export cannot be inspected: {error.strerror}") from error
    if stat.S_ISLNK(info.st_mode):
        raise CookieStoreError("cookie export must not be a symbolic link")
    if not stat.S_ISREG(info.st_mode):
        raise CookieStoreError("cookie export must be a regular file")
    if info.st_size <= 0 or info.st_size > MAX_COOKIE_FILE_BYTES:
        raise CookieStoreError("cookie export size is outside the allowed range")
    if hasattr(os, "getuid") and info.st_uid != os.getuid():
        raise CookieStoreError("cookie export must be owned by the current user")
    if info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise CookieStoreError("cookie export must not be group- or world-writable")
    return info


def codex_cookie_bytes(payload: bytes, urls: list[str]) -> bytes:
    """Validate a concealed CDP response and restrict it to requested HTTPS sites."""
    if not payload or len(payload) > MAX_COOKIE_FILE_BYTES:
        raise CookieStoreError("Codex cookie response size is outside the allowed range")
    try:
        data = json.loads(payload)
    except (ValueError, UnicodeError) as error:
        raise CookieStoreError("Codex cookie response must be JSON") from error
    origins = {f"{urlsplit(url).scheme}://{urlsplit(url).netloc}" for url in urls}
    if len(origins) != 1 or any(urlsplit(url).scheme != "https" for url in urls):
        raise CookieStoreError("Codex cookies require URLs from exactly one HTTPS origin")
    host = urlsplit(urls[0]).hostname or ""
    if not isinstance(data, dict) or not isinstance(data.get("cookies"), list):
        raise CookieStoreError("Codex cookie response must contain cookies")
    lines = ["# Netscape HTTP Cookie File"]
    for cookie in data["cookies"]:
        if not isinstance(cookie, dict):
            raise CookieStoreError("Codex cookie record is invalid")
        domain, name, value, path = (cookie.get(key) for key in ("domain", "name", "value", "path"))
        if any(not isinstance(item, str) for item in (domain, name, value, path)):
            raise CookieStoreError("Codex cookie fields are invalid")
        if any(ord(char) < 32 or ord(char) == 127 for item in (domain, name, value, path) for char in item):
            raise CookieStoreError("Codex cookie contains a control character")
        scope = domain.lstrip(".").lower()
        if not scope or not (
            scope == host or (domain.startswith(".") and "." in scope and host.endswith("." + scope))
        ):
            raise CookieStoreError("Codex cookie domain is outside the requested site")
        # Chromium uses partitionKeyOpaque=False for some nonce-based partitions.
        # Presence of either marker cannot be represented by Netscape cookies.
        if "partitionKey" in cookie or "partitionKeyOpaque" in cookie:
            raise CookieStoreError("partitioned Codex cookies cannot be exported safely")
        secure, http_only, expiry = (cookie.get("secure"), cookie.get("httpOnly"), cookie.get("expires"))
        if not isinstance(secure, bool) or not isinstance(http_only, bool):
            raise CookieStoreError("Codex cookie flags are invalid")
        if not isinstance(expiry, (int, float)) or isinstance(expiry, bool):
            raise CookieStoreError("Codex cookie expiry is invalid")
        if not name or not path.startswith("/"):
            raise CookieStoreError("Codex cookie name or path is invalid")
        if expiry < 0 and expiry != -1:
            raise CookieStoreError("Codex cookie expiry is invalid")
        try:
            expiry = 0 if expiry == -1 else int(expiry)
        except (OverflowError, ValueError) as error:
            raise CookieStoreError("Codex cookie expiry is invalid") from error
        if expiry < 0:
            raise CookieStoreError("Codex cookie expiry is invalid")
        if expiry and expiry <= int(time.time()):
            continue
        prefix = "#HttpOnly_" if http_only else ""
        lines.append("\t".join((
            prefix + domain, "TRUE" if domain.startswith(".") else "FALSE", path,
            "TRUE" if secure else "FALSE", str(expiry), name, value,
        )))
    if len(lines) == 1:
        raise CookieStoreError("Codex browser has no usable cookies for the requested site")
    return ("\n".join(lines) + "\n").encode("utf-8")


@contextmanager
def codex_cookie_file(payload: bytes, urls: list[str]) -> Iterator[Path]:
    """Keep plaintext only in an owner-only, short-lived directory for yt-dlp."""
    if os.name != "posix":
        raise CookieStoreError("temporary Codex cookie protection currently requires POSIX")
    contents = codex_cookie_bytes(payload, urls)
    with tempfile.TemporaryDirectory(prefix="agentic-codex-cookies-") as directory:
        root = Path(directory)
        root.chmod(0o700)
        destination = root / "cookies.txt"
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(contents)
        yield destination


def _normalized_domain(raw: str) -> str:
    domain = raw.removeprefix("#HttpOnly_").lstrip(".").lower()
    if domain != YOUTUBE_DOMAIN and not domain.endswith(f".{YOUTUBE_DOMAIN}"):
        raise CookieStoreError("cookie export contains a non-YouTube domain")
    return domain


def validate_cookie_bytes(payload: bytes, *, now: int | None = None) -> CookieSummary:
    if not payload or len(payload) > MAX_COOKIE_FILE_BYTES:
        raise CookieStoreError("cookie export size is outside the allowed range")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CookieStoreError("cookie export must be UTF-8 text") from error
    lines = text.splitlines()
    if not lines or lines[0].lstrip("\ufeff") not in ALLOWED_HEADERS:
        raise CookieStoreError("cookie export is missing a Netscape cookie header")
    current = int(time.time()) if now is None else now
    records = session = unexpired = expired = 0
    for line_number, line in enumerate(lines[1:], start=2):
        if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        fields = line.split("\t")
        if len(fields) != 7:
            raise CookieStoreError(f"cookie export record {line_number} is malformed")
        domain, include_subdomains, path, secure, expires, name, value = fields
        _normalized_domain(domain)
        if include_subdomains not in {"TRUE", "FALSE"}:
            raise CookieStoreError(f"cookie export record {line_number} has invalid scope")
        if secure not in {"TRUE", "FALSE"}:
            raise CookieStoreError(f"cookie export record {line_number} has invalid security flag")
        if not path.startswith("/"):
            raise CookieStoreError(f"cookie export record {line_number} has invalid path")
        try:
            expiry = int(expires)
        except ValueError as error:
            raise CookieStoreError(
                f"cookie export record {line_number} has invalid expiry"
            ) from error
        if not name or any(character in name for character in "\r\n\t"):
            raise CookieStoreError(f"cookie export record {line_number} has invalid name")
        if any(character in value for character in "\r\n"):
            raise CookieStoreError(f"cookie export record {line_number} has invalid value")
        records += 1
        if expiry == 0:
            session += 1
        elif expiry > current:
            unexpired += 1
        else:
            expired += 1
    if records == 0:
        raise CookieStoreError("cookie export contains no cookie records")
    if session + unexpired == 0:
        raise CookieStoreError("cookie export contains only expired records")
    return CookieSummary(records, session, unexpired, expired)


def validate_cookie_file(path: Path) -> tuple[bytes, CookieSummary]:
    info = _regular_source(path)
    try:
        with path.open("rb") as handle:
            payload = handle.read(MAX_COOKIE_FILE_BYTES + 1)
            final_info = os.fstat(handle.fileno())
    except OSError as error:
        raise CookieStoreError(f"cookie export cannot be read: {error.strerror}") from error
    if (info.st_dev, info.st_ino) != (final_info.st_dev, final_info.st_ino):
        raise CookieStoreError("cookie export changed while it was being opened")
    return payload, validate_cookie_bytes(payload)


def _protect_directory(directory: Path) -> None:
    if directory.exists() and directory.is_symlink():
        raise CookieStoreError("credential directory must not be a symbolic link")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        directory.chmod(0o700)


def _protect_windows(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        identity = subprocess.run(
            ["whoami"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{identity}:(R)"],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CookieStoreError("cannot apply an owner-restricted Windows ACL") from error


def _atomic_write(destination: Path, payload: bytes) -> None:
    _protect_directory(destination.parent)
    temporary_name: str | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".cookies.",
            suffix=".tmp",
            dir=destination.parent,
        )
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary = Path(temporary_name)
        if os.name == "posix":
            temporary.chmod(0o400)
        _protect_windows(temporary)
        os.replace(temporary, destination)
        temporary_name = None
        if os.name == "posix":
            destination.chmod(0o400)
        _protect_windows(destination)
    finally:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)


def install(source: Path) -> CookieSummary:
    payload, summary = validate_cookie_file(source)
    _atomic_write(cookie_path(), payload)
    return summary


def status() -> dict[str, object]:
    destination = cookie_path()
    if not destination.exists():
        return {"configured": False}
    payload, summary = validate_cookie_file(destination)
    result: dict[str, object] = {"configured": True, **summary.public()}
    result["protected"] = True
    if os.name == "posix":
        result["protected"] = stat.S_IMODE(destination.stat().st_mode) == 0o400
        result["directory_protected"] = (
            stat.S_IMODE(destination.parent.stat().st_mode) == 0o700
        )
    del payload
    return result


def _safe_environment() -> dict[str, str]:
    allowed = {
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "SYSTEMROOT",
        "WINDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "USERPROFILE",
    }
    return {key: value for key, value in os.environ.items() if key in allowed}


def verify(url: str, *, yt_dlp: str = "yt-dlp") -> None:
    try:
        parsed = urlsplit(url)
    except ValueError as error:
        raise CookieStoreError("verification URL is invalid") from error
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower()
        not in {
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
            "www.youtube-nocookie.com",
        }
        or parsed.username
        or parsed.password
    ):
        raise CookieStoreError("verification requires a credential-free HTTPS YouTube URL")
    destination = cookie_path()
    current = status()
    if not current.get("configured") or not current.get("protected"):
        raise CookieStoreError("protected YouTube cookies are not ready")
    command = [
        yt_dlp,
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--cookies",
        str(destination),
        "--simulate",
        "--no-playlist",
        "--print",
        "id",
        url,
    ]
    try:
        completed = subprocess.run(
            command,
            env=_safe_environment(),
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CookieStoreError("yt-dlp cookie verification could not run") from error
    if completed.returncode != 0:
        raise CookieStoreError("yt-dlp did not verify the protected cookie file")


def rotate(source: Path, *, verify_url: str | None, yt_dlp: str) -> CookieSummary:
    destination = cookie_path()
    previous = destination.read_bytes() if destination.is_file() else None
    previous_mode = stat.S_IMODE(destination.stat().st_mode) if destination.is_file() else None
    try:
        summary = install(source)
        if verify_url:
            verify(verify_url, yt_dlp=yt_dlp)
        return summary
    except Exception:
        if previous is None:
            destination.unlink(missing_ok=True)
        else:
            _atomic_write(destination, previous)
            if os.name == "posix" and previous_mode is not None:
                destination.chmod(previous_mode)
        raise


def revoke(confirmation: str) -> bool:
    if confirmation != REVOKE_CONFIRMATION:
        raise CookieStoreError(
            f"revocation requires exact confirmation {REVOKE_CONFIRMATION}"
        )
    destination = cookie_path()
    existed = destination.exists()
    destination.unlink(missing_ok=True)
    return existed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    install_parser = commands.add_parser("install")
    install_parser.add_argument("source", type=Path)
    status_parser = commands.add_parser("status")
    status_parser.set_defaults(command="status")
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("url")
    verify_parser.add_argument("--yt-dlp", default="yt-dlp")
    rotate_parser = commands.add_parser("rotate")
    rotate_parser.add_argument("source", type=Path)
    rotate_parser.add_argument("--verify-url")
    rotate_parser.add_argument("--yt-dlp", default="yt-dlp")
    revoke_parser = commands.add_parser("revoke")
    revoke_parser.add_argument("--confirm", required=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "install":
            result = {"installed": True, **install(arguments.source).public()}
        elif arguments.command == "status":
            result = status()
        elif arguments.command == "verify":
            verify(arguments.url, yt_dlp=arguments.yt_dlp)
            result = {"verified": True}
        elif arguments.command == "rotate":
            result = {
                "rotated": True,
                **rotate(
                    arguments.source,
                    verify_url=arguments.verify_url,
                    yt_dlp=arguments.yt_dlp,
                ).public(),
            }
        else:
            result = {"revoked": revoke(arguments.confirm)}
    except CookieStoreError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    print(json.dumps({"ok": True, **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
