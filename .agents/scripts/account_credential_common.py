#!/usr/bin/env python3
"""Shared protected-file primitives for private workflow preferences and artifacts."""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path


class CredentialError(RuntimeError):
    """A sanitized credential lifecycle failure."""


def _current_uid() -> int | None:
    return os.getuid() if hasattr(os, "getuid") else None


def _owned_by_current_user(file_stat: os.stat_result) -> bool:
    uid = _current_uid()
    return uid is None or file_stat.st_uid == uid


def git_container(path: Path) -> Path | None:
    """Return the enclosing Git worktree, if any."""
    resolved = path.expanduser().resolve(strict=False)
    start = resolved if resolved.is_dir() else resolved.parent
    for candidate in (start, *start.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def prepare_private_directory(path: Path) -> Path:
    """Create and verify a private directory."""
    expanded = Path(os.path.abspath(path.expanduser()))
    try:
        expanded.mkdir(parents=True, mode=0o700, exist_ok=True)
        directory_stat = expanded.lstat()
    except OSError as error:
        raise CredentialError("the protected directory cannot be created") from error
    if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
        raise CredentialError("the protected path is not a regular directory")
    if not _owned_by_current_user(directory_stat):
        raise CredentialError("the protected directory is not owned by the current user")
    try:
        expanded.chmod(0o700)
    except OSError as error:
        raise CredentialError("the protected directory cannot be secured") from error
    return expanded


def validate_private_file(
    path: Path, *, mode: int = 0o400,
) -> Path:
    """Validate an existing protected regular file."""
    expanded = Path(os.path.abspath(path.expanduser()))
    if git_container(expanded) is not None:
        raise CredentialError("protected files must remain outside Git")
    try:
        parent_stat = expanded.parent.lstat()
        file_stat = expanded.lstat()
    except FileNotFoundError as error:
        raise CredentialError("protected credentials are not configured") from error
    except OSError as error:
        raise CredentialError("protected credentials cannot be inspected") from error
    if (
        stat.S_ISLNK(parent_stat.st_mode)
        or not stat.S_ISDIR(parent_stat.st_mode)
        or not _owned_by_current_user(parent_stat)
        or stat.S_IMODE(parent_stat.st_mode) != 0o700
    ):
        raise CredentialError(
            "credential directory must be owned by the current user with mode 0700"
        )
    if (
        stat.S_ISLNK(file_stat.st_mode)
        or not stat.S_ISREG(file_stat.st_mode)
        or not _owned_by_current_user(file_stat)
        or stat.S_IMODE(file_stat.st_mode) != mode
    ):
        raise CredentialError(
            f"credential file must be owned by the current user with mode {mode:04o}"
        )
    return expanded


def atomic_private_write(
    path: Path,
    data: bytes,
    *,
    mode: int = 0o400,
    replace: bool = False,
    exclusive: bool = False,
) -> None:
    """Atomically write a private file, optionally requiring exclusive publication."""
    if exclusive and replace:
        raise CredentialError("exclusive credential publication cannot replace a file")
    expanded = Path(os.path.abspath(path.expanduser()))
    if git_container(expanded) is not None:
        raise CredentialError("protected files must remain outside Git")
    prepare_private_directory(expanded.parent)
    try:
        existing = expanded.lstat()
    except FileNotFoundError:
        existing = None
    except OSError as error:
        raise CredentialError("the protected destination cannot be inspected") from error
    if existing is not None:
        if not replace:
            raise CredentialError("protected credentials already exist")
        if (
            stat.S_ISLNK(existing.st_mode)
            or not stat.S_ISREG(existing.st_mode)
            or not _owned_by_current_user(existing)
            or stat.S_IMODE(existing.st_mode) != mode
        ):
            raise CredentialError("the existing protected file is unsafe to replace")

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
        temporary.chmod(mode)
        if exclusive:
            os.link(temporary, expanded)
            temporary.unlink()
        else:
            os.replace(temporary, expanded)
        temporary = None
        if os.name != "nt":
            directory_descriptor = os.open(expanded.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except OSError as error:
        raise CredentialError("the protected file could not be written atomically") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass
    validate_private_file(expanded, mode=mode)
