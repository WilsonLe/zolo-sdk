#!/usr/bin/env python3
"""Run bounded yt-dlp inspection and authorized retrieval across supported sites."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

# `python -I` omits this directory from sys.path; append it so sibling helpers
# import without letting it shadow the standard library.
sys.path.append(str(Path(__file__).resolve().parent))

import youtube_cookie_store  # noqa: E402

ALLOWED_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
}
OPERATIONS = {"inspect", "download", "sync"}
AUTH_MODES = {"public", "browser_cookie_file", "codex_browser"}
RIGHTS_BASES = {
    "own_upload",
    "service_authorized",
    "rights_holder_permission",
    "public_domain",
    "open_license",
    "other_lawful_basis",
}
AUDIO_FORMATS = {"best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav"}
SUBTITLE_FORMATS = {"best", "srt", "vtt", "ass", "lrc"}
SPONSORBLOCK_CATEGORIES = {
    "sponsor",
    "intro",
    "outro",
    "selfpromo",
    "preview",
    "filler",
    "interaction",
    "music_offtopic",
    "hook",
    "poi_highlight",
}
REQUEST_FIELDS = {
    "schema_version",
    "operation",
    "urls",
    "auth_mode",
    "rights_basis",
    "output_root",
    "playlist_policy",
    "playlist_items",
    "max_items",
    "media_mode",
    "max_resolution",
    "max_filesize",
    "audio_format",
    "subtitle_languages",
    "subtitle_format",
    "automatic_subtitles",
    "write_thumbnail",
    "embed_thumbnail",
    "embed_metadata",
    "embed_chapters",
    "split_chapters",
    "sections",
    "sponsorblock_mark",
    "sponsorblock_remove",
    "experimental_live_from_start",
    "overwrite",
    "rate_limit",
    "concurrent_fragments",
    "sleep_requests",
    "timeout",
}
SAFE_INFO_FIELDS = {
    "id",
    "title",
    "description",
    "channel",
    "channel_id",
    "uploader",
    "uploader_id",
    "duration",
    "upload_date",
    "release_date",
    "timestamp",
    "live_status",
    "is_live",
    "was_live",
    "availability",
    "age_limit",
    "playlist_id",
    "playlist_title",
    "playlist_index",
    "webpage_url",
    "original_url",
    "ext",
    "extractor_key",
    "format_id",
    "format_note",
    "width",
    "height",
    "fps",
    "vcodec",
    "acodec",
    "filesize",
    "filesize_approx",
}


class YouTubeOperationError(RuntimeError):
    """Raised when a request or yt-dlp result violates the contract."""


def _require_type(value: object, expected: type, field: str) -> None:
    if not isinstance(value, expected) or isinstance(value, bool) != (expected is bool):
        raise YouTubeOperationError(f"{field} has an invalid type")


def canonical_url(raw: str) -> str:
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise YouTubeOperationError("invalid media URL") from error
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or not re.fullmatch(r"[a-z0-9._:\[\]-]+", host)
        or port == 0
        or parsed.username
        or parsed.password
        or any(ord(character) <= 32 or ord(character) == 127 for character in raw)
    ):
        raise YouTubeOperationError("only credential-free HTTP(S) media URLs are allowed")
    return urlunsplit((parsed.scheme, parsed.netloc.lower(), parsed.path, parsed.query, parsed.fragment))


def _bounded_strings(
    value: object,
    field: str,
    *,
    allowed: set[str] | None = None,
    maximum: int = 20,
) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise YouTubeOperationError(f"{field} must be a bounded list")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 100:
            raise YouTubeOperationError(f"{field} contains an invalid value")
        if allowed is not None and item not in allowed:
            raise YouTubeOperationError(f"{field} contains an unsupported value")
        result.append(item)
    return result


def validate_request(payload: object, expected_operation: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise YouTubeOperationError("request must contain an object")
    unknown = set(payload) - REQUEST_FIELDS
    if unknown:
        raise YouTubeOperationError(f"request contains unknown fields: {sorted(unknown)}")
    if payload.get("schema_version") != 1:
        raise YouTubeOperationError("schema_version must be 1")
    operation = payload.get("operation")
    if operation not in OPERATIONS or (expected_operation and operation != expected_operation):
        raise YouTubeOperationError("operation is invalid")
    urls = payload.get("urls")
    if not isinstance(urls, list) or not 1 <= len(urls) <= 20:
        raise YouTubeOperationError("urls must contain between 1 and 20 entries")
    normalized = dict(payload)
    normalized["urls"] = [canonical_url(url) for url in urls if isinstance(url, str)]
    if len(normalized["urls"]) != len(urls):
        raise YouTubeOperationError("each URL must be a string")
    auth_mode = payload.get("auth_mode", "public")
    if auth_mode not in AUTH_MODES:
        raise YouTubeOperationError("auth_mode is invalid")
    normalized["auth_mode"] = auth_mode
    if auth_mode == "codex_browser":
        origins = {(urlsplit(url).scheme, urlsplit(url).netloc) for url in normalized["urls"]}
        if len(origins) != 1 or next(iter(origins))[0] != "https":
            raise YouTubeOperationError("Codex cookies require URLs from exactly one HTTPS origin")
    if auth_mode == "browser_cookie_file" and any(
        urlsplit(url).hostname not in ALLOWED_HOSTS for url in normalized["urls"]
    ):
        raise YouTubeOperationError("protected cookie-file mode supports only YouTube URLs")
    if operation != "inspect":
        rights = payload.get("rights_basis")
        if not isinstance(rights, dict) or set(rights) != {"category", "statement"}:
            raise YouTubeOperationError("media operations require an exact rights_basis")
        if rights["category"] not in RIGHTS_BASES:
            raise YouTubeOperationError("rights_basis category is invalid")
        if not isinstance(rights["statement"], str) or not rights["statement"].strip():
            raise YouTubeOperationError("rights_basis statement is required")
        if len(rights["statement"]) > 500:
            raise YouTubeOperationError("rights_basis statement is too long")
    output_root = payload.get("output_root")
    if operation != "inspect" and not isinstance(output_root, str):
        raise YouTubeOperationError("media operations require output_root")
    normalized["playlist_policy"] = payload.get("playlist_policy", "single")
    if normalized["playlist_policy"] not in {"single", "playlist"}:
        raise YouTubeOperationError("playlist_policy is invalid")
    if operation == "sync" and normalized["playlist_policy"] != "playlist":
        raise YouTubeOperationError("sync requires playlist_policy=playlist")
    maximum = payload.get("max_items", 1 if normalized["playlist_policy"] == "single" else 20)
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= 100:
        raise YouTubeOperationError("max_items must be between 1 and 100")
    if normalized["playlist_policy"] == "playlist" and len(normalized["urls"]) != 1:
        raise YouTubeOperationError("playlist operations require exactly one URL")
    if normalized["playlist_policy"] == "single" and maximum < len(normalized["urls"]):
        raise YouTubeOperationError("max_items must cover every explicit URL")
    normalized["max_items"] = maximum
    if "playlist_items" in payload:
        if not isinstance(payload["playlist_items"], str) or not re.fullmatch(
            r"[-0-9,:]+", payload["playlist_items"]
        ):
            raise YouTubeOperationError("playlist_items has an invalid form")
    media_mode = payload.get("media_mode", "video")
    if media_mode not in {"video", "audio", "section", "live"}:
        raise YouTubeOperationError("media_mode is invalid")
    normalized["media_mode"] = media_mode
    resolution = payload.get("max_resolution", 1080)
    if not isinstance(resolution, int) or isinstance(resolution, bool) or resolution not in {
        144,
        240,
        360,
        480,
        720,
        1080,
        1440,
        2160,
        4320,
    }:
        raise YouTubeOperationError("max_resolution is invalid")
    normalized["max_resolution"] = resolution
    audio_format = payload.get("audio_format", "best")
    if audio_format not in AUDIO_FORMATS:
        raise YouTubeOperationError("audio_format is invalid")
    normalized["audio_format"] = audio_format
    subtitle_format = payload.get("subtitle_format", "vtt")
    if subtitle_format not in SUBTITLE_FORMATS:
        raise YouTubeOperationError("subtitle_format is invalid")
    normalized["subtitle_format"] = subtitle_format
    normalized["subtitle_languages"] = _bounded_strings(
        payload.get("subtitle_languages", []), "subtitle_languages", maximum=10
    )
    normalized["sections"] = _bounded_strings(payload.get("sections", []), "sections", maximum=10)
    normalized["sponsorblock_mark"] = _bounded_strings(
        payload.get("sponsorblock_mark", []),
        "sponsorblock_mark",
        allowed=SPONSORBLOCK_CATEGORIES,
    )
    normalized["sponsorblock_remove"] = _bounded_strings(
        payload.get("sponsorblock_remove", []),
        "sponsorblock_remove",
        allowed=SPONSORBLOCK_CATEGORIES,
    )
    for field in (
        "automatic_subtitles",
        "write_thumbnail",
        "embed_thumbnail",
        "embed_metadata",
        "embed_chapters",
        "split_chapters",
        "experimental_live_from_start",
        "overwrite",
    ):
        value = payload.get(field, False)
        _require_type(value, bool, field)
        normalized[field] = value
    if normalized["overwrite"]:
        raise YouTubeOperationError("overwrite is not supported")
    if media_mode == "live" and not normalized["experimental_live_from_start"]:
        raise YouTubeOperationError("live mode requires explicit experimental_live_from_start")
    concurrent = payload.get("concurrent_fragments", 1)
    if not isinstance(concurrent, int) or isinstance(concurrent, bool) or not 1 <= concurrent <= 4:
        raise YouTubeOperationError("concurrent_fragments must be between 1 and 4")
    normalized["concurrent_fragments"] = concurrent
    sleep_requests = payload.get("sleep_requests", 5 if auth_mode != "public" else 1)
    if (
        not isinstance(sleep_requests, (int, float))
        or isinstance(sleep_requests, bool)
        or not 0 <= sleep_requests <= 30
    ):
        raise YouTubeOperationError("sleep_requests must be between 0 and 30")
    normalized["sleep_requests"] = sleep_requests
    timeout = payload.get("timeout", 300)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 30 <= timeout <= 86400:
        raise YouTubeOperationError("timeout must be between 30 and 86400")
    normalized["timeout"] = timeout
    if "rate_limit" in payload and (
        not isinstance(payload["rate_limit"], str)
        or not re.fullmatch(r"[1-9][0-9]*(?:\.[0-9]+)?[KMG]?", payload["rate_limit"])
    ):
        raise YouTubeOperationError("rate_limit has an invalid form")
    if "max_filesize" in payload and (
        not isinstance(payload["max_filesize"], str)
        or not re.fullmatch(r"[1-9][0-9]*(?:\.[0-9]+)?[KMG]?", payload["max_filesize"])
    ):
        raise YouTubeOperationError("max_filesize has an invalid form")
    return normalized


def _safe_root(raw: str, *, create: bool) -> Path:
    root = Path(raw).expanduser()
    if root.exists() and root.is_symlink():
        raise YouTubeOperationError("output_root must not be a symbolic link")
    if create:
        root.mkdir(parents=True, exist_ok=True)
    root = root.resolve()
    if create:
        for path in root.rglob("*"):
            if path.is_symlink():
                raise YouTubeOperationError("output_root contains a symbolic link")
    return root


def _base_command(yt_dlp: str) -> list[str]:
    return [
        yt_dlp,
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--no-mark-watched",
        "--no-write-comments",
        "--no-exec",
        "--newline",
        "--retries",
        "10",
        "--fragment-retries",
        "10",
        "--retry-sleep",
        "http:exp=1:20",
        "--retry-sleep",
        "fragment:exp=1:20",
    ]


def build_command(
    request: dict[str, Any],
    *,
    yt_dlp: str = "yt-dlp",
    create_output: bool = False,
    codex_cookie_path: Path | None = None,
) -> list[str]:
    command = _base_command(yt_dlp)
    for runtime in ("deno", "node"):
        runtime_path = shutil.which(runtime)
        if runtime_path:
            command.extend(["--js-runtimes", f"{runtime}:{runtime_path}"])
            break
    if request["auth_mode"] == "browser_cookie_file":
        state = youtube_cookie_store.status()
        if not state.get("configured") or not state.get("protected"):
            raise YouTubeOperationError("protected YouTube cookies are not ready")
        command.extend(["--cookies", str(youtube_cookie_store.cookie_path())])
    if request["auth_mode"] == "codex_browser":
        command.extend(["--cookies", str(codex_cookie_path or "<codex-browser-cookie-file>")])
    command.extend(["--sleep-requests", str(request["sleep_requests"])])
    command.extend(["--concurrent-fragments", str(request["concurrent_fragments"])])
    if "rate_limit" in request:
        command.extend(["--limit-rate", request["rate_limit"]])
    if "max_filesize" in request:
        command.extend(["--max-filesize", request["max_filesize"]])
    if request["playlist_policy"] == "single":
        command.append("--no-playlist")
    else:
        command.append("--yes-playlist")
        command.extend(["--playlist-end", str(request["max_items"])])
        if "playlist_items" in request:
            command.extend(["--playlist-items", request["playlist_items"]])
    if request["operation"] == "inspect":
        command.extend(["--simulate", "--dump-single-json"])
        if request["playlist_policy"] == "playlist":
            command.append("--flat-playlist")
    else:
        root = _safe_root(request["output_root"], create=create_output)
        # Keep existing YouTube library paths, but avoid cross-site ID collisions.
        platform_prefix = "" if all(
            urlsplit(url).hostname in ALLOWED_HOSTS for url in request["urls"]
        ) else "%(extractor_key|unknown)s/"
        command.extend(
            [
                "--paths",
                f"home:{root}",
                "--output",
                (
                    platform_prefix + "%(uploader_id|unknown)s/%(playlist_id|single)s/"
                    "%(upload_date>%Y-%m-%d,release_date>%Y-%m-%d|unknown)s - "
                    "%(title).180B [%(id)s].%(ext)s"
                ),
                "--no-overwrites",
                "--continue",
                "--part",
                "--print-json",
            ]
        )
        if request["operation"] == "sync":
            command.extend(["--download-archive", str(root / ".youtube-download-archive.txt")])
        if request["media_mode"] == "audio":
            command.extend(["--extract-audio", "--audio-format", request["audio_format"]])
        else:
            height = request["max_resolution"]
            command.extend(
                [
                    "--format",
                    f"bv*[height<=?{height}]+ba/b[height<=?{height}]",
                ]
            )
        if request["subtitle_languages"]:
            command.extend(
                [
                    "--write-subs",
                    "--sub-langs",
                    ",".join(request["subtitle_languages"]),
                    "--sub-format",
                    request["subtitle_format"],
                ]
            )
            if request["automatic_subtitles"]:
                command.append("--write-auto-subs")
        if request["write_thumbnail"]:
            command.append("--write-thumbnail")
        if request["embed_thumbnail"]:
            command.append("--embed-thumbnail")
        if request["embed_metadata"]:
            command.append("--embed-metadata")
        if request["embed_chapters"]:
            command.append("--embed-chapters")
        if request["split_chapters"]:
            command.append("--split-chapters")
        for section in request["sections"]:
            command.extend(["--download-sections", section])
        if request["sponsorblock_mark"]:
            command.extend(["--sponsorblock-mark", ",".join(request["sponsorblock_mark"])])
        if request["sponsorblock_remove"]:
            command.extend(["--sponsorblock-remove", ",".join(request["sponsorblock_remove"])])
        if request["experimental_live_from_start"]:
            command.append("--live-from-start")
    command.extend(request["urls"])
    return command


def redacted_command(command: list[str]) -> list[str]:
    redacted = list(command)
    for index, value in enumerate(redacted[:-1]):
        if value == "--cookies":
            redacted[index + 1] = "<protected-browser-cookie-file>"
    for index, value in enumerate(redacted):
        if value.startswith(("https://", "http://")):
            redacted[index] = _sanitize_url(value)
    return redacted


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


def _sanitize_url(value: str) -> str:
    try:
        parsed = urlsplit(canonical_url(value))
    except YouTubeOperationError:
        return "<redacted-url>"
    # Preserve the historical YouTube metadata shape; other platforms can put
    # bearer tokens in query parameters, so omit their query from evidence.
    query = parsed.query if parsed.hostname in ALLOWED_HOSTS else ""
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


def sanitize_info(value: object, *, depth: int = 0) -> object:
    if depth > 5:
        return None
    if isinstance(value, list):
        return [sanitize_info(item, depth=depth + 1) for item in value[:100]]
    if not isinstance(value, dict):
        return value
    result: dict[str, object] = {}
    for key in SAFE_INFO_FIELDS:
        item = value.get(key)
        if item is None:
            continue
        if key in {"webpage_url", "original_url"} and isinstance(item, str):
            result[key] = _sanitize_url(item)
        else:
            result[key] = sanitize_info(item, depth=depth + 1)
    chapters = value.get("chapters")
    if isinstance(chapters, list):
        result["chapters"] = [
            {
                key: chapter.get(key)
                for key in ("title", "start_time", "end_time")
                if isinstance(chapter, dict) and chapter.get(key) is not None
            }
            for chapter in chapters[:500]
            if isinstance(chapter, dict)
        ]
    for source, target in (
        ("subtitles", "subtitle_languages"),
        ("automatic_captions", "automatic_caption_languages"),
    ):
        mapping = value.get(source)
        if isinstance(mapping, dict):
            result[target] = sorted(str(key) for key in mapping)[:100]
    formats = value.get("formats")
    if isinstance(formats, list):
        result["formats"] = [
            {
                key: item.get(key)
                for key in (
                    "format_id",
                    "format_note",
                    "ext",
                    "width",
                    "height",
                    "fps",
                    "vcodec",
                    "acodec",
                    "filesize",
                    "filesize_approx",
                )
                if isinstance(item, dict) and item.get(key) is not None
            }
            for item in formats[:500]
            if isinstance(item, dict)
        ]
    entries = value.get("entries")
    if isinstance(entries, list):
        result["entries"] = [sanitize_info(item, depth=depth + 1) for item in entries[:100]]
    return result


def _failure_category(stderr: str) -> str:
    text = stderr.lower()
    patterns = (
        ("unsupported_url", ("unsupported url", "no suitable extractor")),
        ("po_token", ("po token", "proof of origin")),
        ("rate_limited", ("http error 429", "rate limit")),
        ("authentication_required", ("sign in", "members-only", "private video")),
        ("cookie_invalid", ("cookie", "login_required")),
        ("unavailable", ("video unavailable", "has been removed", "not available")),
        ("ffmpeg_missing", ("ffmpeg", "ffprobe")),
        ("filesystem", ("no space left", "permission denied", "file exists")),
    )
    for category, needles in patterns:
        if any(needle in text for needle in needles):
            return category
    return "yt_dlp_failed"


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _file_manifest(root: Path) -> list[dict[str, object]]:
    files: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        resolved = path.resolve()
        try:
            relative = resolved.relative_to(root)
        except ValueError as error:
            raise YouTubeOperationError("download escaped output_root") from error
        if path.name == ".youtube-download-archive.txt":
            continue
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        files.append(
            {
                "path": str(relative),
                "size": path.stat().st_size,
                "sha256": digest.hexdigest(),
            }
        )
    return files


def execute(
    request: dict[str, Any],
    *,
    yt_dlp: str = "yt-dlp",
    result_file: Path | None = None,
    codex_cookie_payload: bytes | None = None,
) -> dict[str, object]:
    if request["auth_mode"] == "codex_browser" and codex_cookie_payload is None:
        raise YouTubeOperationError("Codex cookies require the concealed browser bridge")
    if request["auth_mode"] != "codex_browser" and codex_cookie_payload is not None:
        raise YouTubeOperationError("Codex cookie input requires auth_mode=codex_browser")
    context = (
        youtube_cookie_store.codex_cookie_file(codex_cookie_payload, request["urls"])
        if codex_cookie_payload is not None else nullcontext(None)
    )
    with context as cookie_path:
        command = build_command(
            request, yt_dlp=yt_dlp, create_output=request["operation"] != "inspect",
            codex_cookie_path=cookie_path,
        )
        try:
            completed = subprocess.run(
                command,
                env=_safe_environment(),
                capture_output=True,
                text=True,
                timeout=request["timeout"],
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise YouTubeOperationError("yt-dlp operation timed out") from error
        except OSError as error:
            raise YouTubeOperationError("yt-dlp executable could not be started") from error
        if completed.returncode != 0:
            raise YouTubeOperationError(_failure_category(completed.stderr))
    # Remove transient credentials before parsing metadata or scanning outputs.
    records: list[object] = []
    for line in completed.stdout.splitlines():
        if not line.strip():
            continue
        try:
            records.append(sanitize_info(json.loads(line)))
        except json.JSONDecodeError as error:
            raise YouTubeOperationError("yt-dlp returned non-JSON output") from error
    if not records:
        raise YouTubeOperationError("yt-dlp returned no result records")
    result: dict[str, object] = {
        "schema_version": 1,
        "ok": True,
        "operation": request["operation"],
        "auth_mode": request["auth_mode"],
        "command": redacted_command(command),
        "records": records,
    }
    if request["operation"] != "inspect":
        root = _safe_root(request["output_root"], create=False)
        result["files"] = _file_manifest(root)
    if result_file is not None:
        _atomic_json(result_file, result)
    return result


def preflight(yt_dlp: str) -> dict[str, object]:
    executables: dict[str, object] = {}
    for name in (yt_dlp, "ffmpeg", "ffprobe", "deno", "node"):
        resolved = shutil.which(name) if name == yt_dlp else shutil.which(name)
        executables[name] = {"available": bool(resolved)}
        if not resolved:
            continue
        try:
            version = subprocess.run(
                [resolved, "--version"],
                env=_safe_environment(),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        line = (version.stdout or version.stderr).splitlines()
        executables[name]["version"] = line[0][:200] if line else "unknown"
    return {
        "ready": bool(executables[yt_dlp]["available"])
        and bool(executables["ffmpeg"]["available"])
        and bool(executables["ffprobe"]["available"])
        and bool(executables["deno"]["available"] or executables["node"]["available"]),
        "executables": executables,
        "cookie_status": youtube_cookie_store.status(),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yt-dlp", default="yt-dlp")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("preflight")
    for name in ("plan", "inspect", "download", "sync"):
        command = commands.add_parser(name)
        command.add_argument("request", type=Path)
        command.add_argument("--result-file", type=Path)
        command.add_argument("--codex-cookie-stdin", action="store_true")
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    try:
        if arguments.command == "preflight":
            result: object = preflight(arguments.yt_dlp)
        else:
            payload = json.loads(arguments.request.read_text(encoding="utf-8"))
            expected = None if arguments.command == "plan" else arguments.command
            request = validate_request(payload, expected)
            if arguments.command == "plan":
                if arguments.codex_cookie_stdin:
                    raise YouTubeOperationError("plan never reads browser cookies")
                result = {
                    "schema_version": 1,
                    "ok": True,
                    "operation": request["operation"],
                    "auth_mode": request["auth_mode"],
                    "command": redacted_command(
                        build_command(request, yt_dlp=arguments.yt_dlp)
                    ),
                }
            else:
                result = execute(
                    request,
                    yt_dlp=arguments.yt_dlp,
                    result_file=arguments.result_file,
                    codex_cookie_payload=(
                        sys.stdin.buffer.read(youtube_cookie_store.MAX_COOKIE_FILE_BYTES + 1)
                        if arguments.codex_cookie_stdin else None
                    ),
                )
    except (OSError, ValueError, json.JSONDecodeError, YouTubeOperationError, youtube_cookie_store.CookieStoreError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, sort_keys=True))
        return 2
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
