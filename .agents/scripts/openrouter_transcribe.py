#!/usr/bin/env python3
"""Send one short, selected audio stream to OpenRouter and save a source-clock transcript."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any
import urllib.error
import urllib.request
import wave

# Isolated Python omits the script directory. Append it for the shared credential primitives.
sys.path.append(str(Path(__file__).resolve().parent))
import account_credential_common as credentials  # noqa: E402


ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"
MODEL = "openai/whisper-large-v3-turbo"
MAX_DURATION = 60
SAMPLE_RATE = 16_000
ROUNDING_TOLERANCE = 0.05
MAX_RESPONSE_BYTES = 2_000_000
MAX_WAV_BYTES = (MAX_DURATION + 1) * SAMPLE_RATE * 2
ATTEMPT_NAME = "openrouter-attempt.json"
RESPONSE_NAME = "openrouter-response.json"
TRANSCRIPT_NAME = "transcript.json"
# Exclude playlists, concat scripts and other demuxers that can open additional files.
LOCAL_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,wav,flac,mp3,aac,ogg"
ISO_CODE = re.compile(r"[a-z]{2}")
HEX_DIGEST = re.compile(r"[a-f0-9]{64}")


class TranscriptionError(ValueError):
    """A safe diagnostic that never includes media, credentials or provider response text."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A credential and the selected audio are authorized for one endpoint."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def is_finite_number(value: object) -> bool:
    if isinstance(value, bool):
        return False
    return isinstance(value, int) or (isinstance(value, float) and math.isfinite(value))


def is_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_language(value: str) -> str:
    if value != "auto" and not ISO_CODE.fullmatch(value):
        raise TranscriptionError("language must be auto or a lowercase ISO 639-1 code")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_media_tool(args: list[str], *, timeout: int, operation: str) -> bytes:
    try:
        result = subprocess.run(
            args, capture_output=True, check=False, timeout=timeout,
            env={name: value for name, value in os.environ.items() if name != "OPENROUTER_API_KEY"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TranscriptionError(f"could not {operation}; check the local media tools") from error
    if result.returncode:
        raise TranscriptionError(f"could not {operation}; check the selected local media")
    return result.stdout


def probe_source(source: Path) -> tuple[int, float]:
    raw = run_media_tool(
        [
            "ffprobe", "-v", "error", "-protocol_whitelist", "file",
            "-format_whitelist", LOCAL_FORMATS, "-show_entries",
            "format=format_name,start_time,duration:stream=index,codec_type,start_time",
            "-of", "json", str(source),
        ],
        timeout=20,
        operation="inspect the source",
    )
    try:
        metadata = json.loads(raw)
        container = metadata["format"]
        audio = [stream for stream in metadata["streams"] if stream["codec_type"] == "audio"]
        duration = float(container["duration"])
    except (UnicodeError, ValueError, KeyError, TypeError) as error:
        raise TranscriptionError("source duration and audio stream could not be established") from error
    if len(audio) != 1 or not is_integer(audio[0].get("index")) or audio[0]["index"] < 0:
        raise TranscriptionError("select a source with exactly one audio stream")
    if not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise TranscriptionError("select a source with a measured duration of at most 60 seconds")
    # FFprobe can omit start time for self-contained WAV/FLAC streams.
    untimestamped = container.get("format_name") in ("wav", "flac") and len(metadata["streams"]) == 1
    try:
        if any(
            not (start is None and untimestamped) and float(start) != 0
            for start in (container.get("start_time"), audio[0].get("start_time"))
        ):
            raise TranscriptionError("the source container and audio stream must both start at zero")
    except (TypeError, ValueError) as error:
        raise TranscriptionError("the source container and audio stream must both start at zero") from error
    return audio[0]["index"], duration


def prepare_audio(source: Path, stream_index: int) -> tuple[bytes, float]:
    with tempfile.TemporaryDirectory(prefix="agentic-openrouter-audio-") as scratch:
        target = Path(scratch) / "analysis.wav"
        run_media_tool(
            [
                "ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file",
                "-format_whitelist", LOCAL_FORMATS, "-i", str(source), "-map", f"0:{stream_index}",
                "-vn", "-map_metadata", "-1", "-map_chapters", "-1",
                "-af", f"aresample={SAMPLE_RATE}:async=1:first_pts=0", "-ac", "1",
                "-c:a", "pcm_s16le", "-t", str(MAX_DURATION + ROUNDING_TOLERANCE), str(target),
            ],
            timeout=45,
            operation="extract the selected audio",
        )
        try:
            if target.stat().st_size > MAX_WAV_BYTES:
                raise TranscriptionError("decoded audio exceeds the one-minute request limit")
            with wave.open(str(target), "rb") as handle:
                if (handle.getframerate(), handle.getnchannels(), handle.getsampwidth()) != (SAMPLE_RATE, 1, 2):
                    raise TranscriptionError("the analysis copy is not mono 16 kHz PCM")
                duration = handle.getnframes() / SAMPLE_RATE
            if not 0 < duration <= MAX_DURATION:
                raise TranscriptionError("decoded audio must be nonempty and at most 60 seconds")
            return target.read_bytes(), duration
        except (OSError, wave.Error, EOFError) as error:
            raise TranscriptionError("the local WAV analysis copy could not be read") from error


def request_transcription(wav: bytes, key: str, language: str) -> bytes:
    payload = {
        "model": MODEL,
        "input_audio": {"data": base64.b64encode(wav).decode("ascii"), "format": "wav"},
        "provider": {"data_collection": "deny"},
        "temperature": 0,
        "response_format": "verbose_json",
        "timestamp_granularities": ["word"],
    }
    if language != "auto":
        payload["language"] = language
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json",
            "Accept": "application/json", "User-Agent": "agentic-workflows/1",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=75) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise TranscriptionError(f"OpenRouter returned HTTP {error.code}; request was not retried") from error
    except (TimeoutError, OSError) as error:
        raise TranscriptionError("OpenRouter request did not complete; it may have been billed and was not retried") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise TranscriptionError("OpenRouter returned an oversized response; request was not retried")
    return raw


def valid_range(item: object, bound: float) -> bool:
    if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
        return False
    start, end = item.get("start_seconds"), item.get("end_seconds")
    return is_finite_number(start) and is_finite_number(end) and 0 <= start < end <= bound


def validate_transcript(data: object) -> dict[str, Any]:
    """Validate the schema v1 OpenRouter output without reading files or performing work."""
    if (
        not isinstance(data, dict)
        or not is_integer(data.get("schema_version"))
        or data["schema_version"] != 1
        or not isinstance(data.get("asset_id"), str)
        or not data["asset_id"].startswith("sha256:")
        or not HEX_DIGEST.fullmatch(data["asset_id"][7:])
        or data.get("runtime") != "openrouter"
        or data.get("model") != MODEL
        or data.get("timestamp_granularity") != "word"
        or not isinstance(data.get("provider_response_sha256"), str)
        or not HEX_DIGEST.fullmatch(data["provider_response_sha256"])
    ):
        raise TranscriptionError("not a schema v1 OpenRouter word transcript")
    language, requested = data.get("language"), data.get("requested_language")
    if language is not None and (not isinstance(language, str) or not ISO_CODE.fullmatch(language)):
        raise TranscriptionError("observed transcript language is invalid")
    if not isinstance(requested, str):
        raise TranscriptionError("requested transcript language is missing")
    validate_language(requested)
    source, mapping = data.get("source"), data.get("analysis_to_source")
    if (
        not isinstance(source, dict) or not isinstance(source.get("path"), str)
        or not Path(source["path"]).is_absolute()
        or not is_integer(source.get("stream_index")) or source["stream_index"] < 0
        or not is_finite_number(source.get("duration_seconds"))
        or not 0 < source["duration_seconds"] <= MAX_DURATION
        or not isinstance(mapping, dict) or not is_finite_number(mapping.get("offset_seconds"))
        or mapping["offset_seconds"] != 0
        or not is_finite_number(mapping.get("analysis_duration_seconds"))
        or not 0 < mapping["analysis_duration_seconds"] <= MAX_DURATION
        or not isinstance(mapping.get("audio_sha256"), str)
        or not HEX_DIGEST.fullmatch(mapping["audio_sha256"])
        or mapping.get("rounding_tolerance_seconds") != ROUNDING_TOLERANCE
    ):
        raise TranscriptionError("transcript source identity or zero-origin audio mapping is invalid")
    segments = data.get("segments")
    if not isinstance(segments, list) or not segments:
        raise TranscriptionError("transcript has no usable timed speech")
    bound = min(source["duration_seconds"], mapping["analysis_duration_seconds"])
    previous_segment_start = previous_word_start = -1.0
    for segment in segments:
        if not valid_range(segment, bound) or segment["start_seconds"] < previous_segment_start:
            raise TranscriptionError("transcript segment timing is invalid")
        previous_segment_start = segment["start_seconds"]
        words = segment.get("words")
        if not isinstance(words, list) or not words:
            raise TranscriptionError("transcript segment lacks word timings")
        for word in words:
            if (
                not valid_range(word, bound)
                or not segment["start_seconds"] <= word["start_seconds"] < word["end_seconds"] <= segment["end_seconds"]
                or word["start_seconds"] < previous_word_start
            ):
                raise TranscriptionError("transcript word timing is invalid")
            confidence = word.get("confidence")
            if confidence is not None and (not is_finite_number(confidence) or not 0 <= confidence <= 1):
                raise TranscriptionError("transcript word confidence is invalid")
            previous_word_start = word["start_seconds"]
    return data


def normalize_transcript(
    payload: dict[str, Any],
    *,
    source: dict[str, Any],
    source_sha256: str,
    wav_sha256: str,
    analysis_duration: float,
    requested_language: str,
    response_sha256: str,
) -> dict[str, Any]:
    provider_words = payload.get("words")
    if not isinstance(provider_words, list) or not provider_words:
        raise TranscriptionError("OpenRouter did not return usable word-level timestamps")
    words = []
    bound = min(source["duration_seconds"], analysis_duration)
    for item in provider_words:
        if not isinstance(item, dict) or not isinstance(item.get("word"), str) or not item["word"].strip():
            raise TranscriptionError("OpenRouter returned an invalid timed word")
        start, end = item.get("start"), item.get("end")
        if not is_finite_number(start) or not is_finite_number(end) or not 0 <= start < end <= bound + ROUNDING_TOLERANCE:
            raise TranscriptionError("OpenRouter word times are outside the selected audio")
        confidence = item.get("confidence")
        words.append({
            "text": item["word"].strip(), "start_seconds": start, "end_seconds": min(end, bound),
            "confidence": confidence if is_finite_number(confidence) and 0 <= confidence <= 1 else None,
        })
    reported = payload.get("language")
    language = reported.strip().lower() if isinstance(reported, str) else ""
    if language == "english":
        language = "en"
    observed_language = language if ISO_CODE.fullmatch(language) else None
    usage = payload.get("usage")
    cost = usage.get("cost") if isinstance(usage, dict) else None
    # Some providers return words without segments. Group the observed words mechanically
    # without claiming a spoken sentence boundary or adding timing data.
    segment = {
        "text": " ".join(word["text"] for word in words),
        "start_seconds": words[0]["start_seconds"],
        "end_seconds": max(word["end_seconds"] for word in words),
        "words": words,
    }
    return validate_transcript({
        "schema_version": 1, "asset_id": f"sha256:{source_sha256}", "source": source,
        "language": observed_language, "requested_language": requested_language,
        "runtime": "openrouter", "runtime_version": None, "model": MODEL, "timestamp_granularity": "word",
        "analysis_to_source": {
            "offset_seconds": 0.0, "analysis_duration_seconds": analysis_duration,
            "audio_sha256": wav_sha256, "rounding_tolerance_seconds": ROUNDING_TOLERANCE,
        },
        "provider_response_sha256": response_sha256,
        "usage_cost_usd": cost if is_finite_number(cost) and cost >= 0 else None,
        "segment_grouping": "word_span", "segments": [segment],
    })


def reject_nonfinite(_value: str) -> None:
    raise TranscriptionError("OpenRouter returned invalid JSON numbers")


def private_json(path: Path, value: object, *, replace: bool = False) -> None:
    data = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n").encode("utf-8")
    credentials.atomic_private_write(path, data, mode=0o600, replace=replace, exclusive=not replace)


def resolve_output(output_dir: Path) -> Path:
    output_dir = output_dir.expanduser()
    output_dir = output_dir.parent.resolve(strict=True) / output_dir.name
    if credentials.git_container(output_dir) is not None:
        raise TranscriptionError("use a new task-owned output directory outside Git for private transcription files")
    return output_dir


def prepare_request(
    source: Path, language: str, *, approved_source_sha256: str | None = None,
) -> tuple[Path, bytes, dict[str, Any]]:
    source = source.expanduser().resolve(strict=True)
    if not source.is_file() or source.stat().st_size == 0:
        raise TranscriptionError("select one nonempty local media file")
    # FFmpeg must open the same bytes that pass the approval check, even if a
    # capture or export process replaces the original path during extraction.
    with tempfile.TemporaryDirectory(prefix="agentic-openrouter-source-") as scratch:
        snapshot = Path(scratch) / f"source{source.suffix}"
        shutil.copyfile(source, snapshot)
        source_sha = sha256_file(snapshot)
        if approved_source_sha256 is not None and source_sha != approved_source_sha256:
            raise TranscriptionError("the selected source no longer matches the approved SHA-256")
        stream_index, source_duration = probe_source(snapshot)
        wav, analysis_duration = prepare_audio(snapshot, stream_index)
    if analysis_duration > source_duration + ROUNDING_TOLERANCE:
        raise TranscriptionError("the analysis audio exceeds the measured source clock")
    if sha256_file(source) != source_sha:
        raise TranscriptionError("the source changed during audio preparation")
    source_record = {"path": str(source), "stream_index": stream_index, "duration_seconds": source_duration}
    return source, wav, {
        "schema_version": 1, "state": "submission_reserved", "asset_id": f"sha256:{source_sha}",
        "source": source_record, "analysis_audio_sha256": hashlib.sha256(wav).hexdigest(),
        "analysis_duration_seconds": analysis_duration,
        "model": MODEL, "requested_language": language,
    }


def decode_response(raw: bytes, key: str | None = None) -> dict[str, Any]:
    try:
        payload = json.loads(raw, parse_constant=reject_nonfinite)
        decoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError) as error:
        raise TranscriptionError("OpenRouter did not return valid JSON; request was not retried") from error
    if key and any(key.encode("utf-8") in body for body in (raw, decoded)):
        raise TranscriptionError("OpenRouter returned unsafe content; response was not saved")
    if not isinstance(payload, dict):
        raise TranscriptionError("OpenRouter did not return a transcript object")
    return payload


def normalized_response(payload: dict[str, Any], raw: bytes, receipt: dict[str, Any]) -> dict[str, Any]:
    return normalize_transcript(
        payload, source=receipt["source"], source_sha256=receipt["asset_id"][7:],
        wav_sha256=receipt["analysis_audio_sha256"], analysis_duration=receipt["analysis_duration_seconds"],
        requested_language=receipt["requested_language"],
        response_sha256=hashlib.sha256(raw).hexdigest(),
    )


def completed_receipt(receipt: dict[str, Any], raw: bytes) -> dict[str, Any]:
    return {**receipt, "state": "response_saved", "provider_response_sha256": hashlib.sha256(raw).hexdigest()}


def publish_transcript(output_dir: Path, transcript: dict[str, Any]) -> dict[str, Any]:
    private_json(output_dir / TRANSCRIPT_NAME, transcript)
    return {
        "asset_id": transcript["asset_id"], "model": MODEL, "language": transcript["language"],
        "audio_seconds": transcript["analysis_to_source"]["analysis_duration_seconds"],
        "word_count": len(transcript["segments"][0]["words"]),
        "usage_cost_usd": transcript["usage_cost_usd"], "transcript": str(output_dir / TRANSCRIPT_NAME),
        "response": str(output_dir / RESPONSE_NAME), "attempt": str(output_dir / ATTEMPT_NAME),
    }


def load_api_key() -> str:
    """Read the explicitly configured runtime environment, never a checkout or connector."""
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key or len(key) > 65_536 or any(not 33 <= ord(char) <= 126 for char in key):
        raise TranscriptionError("configure a valid OPENROUTER_API_KEY privately in the runtime environment")
    return key


def transcribe(
    source: Path, output_dir: Path, language: str, *, approved_source_sha256: str,
) -> dict[str, Any]:
    language = validate_language(language)
    if not HEX_DIGEST.fullmatch(approved_source_sha256):
        raise TranscriptionError("the approved source SHA-256 must be 64 lowercase hexadecimal characters")
    output_dir = resolve_output(output_dir)
    if output_dir.exists() or output_dir.is_symlink():
        raise TranscriptionError("output directory already exists; inspect any saved receipt before retrying")
    source, wav, receipt = prepare_request(source, language, approved_source_sha256=approved_source_sha256)
    key = load_api_key()
    # Exclusive directory creation prevents parallel submissions for this output.
    output_dir.mkdir(mode=0o700)
    private_json(output_dir / ATTEMPT_NAME, receipt)
    raw = request_transcription(wav, key, language)
    payload = decode_response(raw, key)
    credentials.atomic_private_write(output_dir / RESPONSE_NAME, raw, mode=0o600, exclusive=True)
    private_json(output_dir / ATTEMPT_NAME, completed_receipt(receipt, raw), replace=True)
    if sha256_file(source) != receipt["asset_id"][7:]:
        raise TranscriptionError("the source changed during transcription; the raw response was kept")
    return publish_transcript(output_dir, normalized_response(payload, raw, receipt))


def read_private_artifact(path: Path, limit: int) -> bytes:
    path = credentials.validate_private_file(path, mode=0o600)
    with path.open("rb") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise TranscriptionError("saved OpenRouter artifact exceeds the allowed size")
    return value


def recover_final_word_end(source: Path, output_dir: Path, language: str, reviewed_end: float) -> dict[str, Any]:
    """Repair one measured endpoint from an existing receipt without a credential or request."""
    language = validate_language(language)
    output_dir = resolve_output(output_dir)
    if (output_dir / TRANSCRIPT_NAME).exists() or (output_dir / TRANSCRIPT_NAME).is_symlink():
        raise TranscriptionError("a normalized transcript already exists; it was preserved")
    saved_receipt = read_private_artifact(output_dir / ATTEMPT_NAME, 8192)
    raw = read_private_artifact(output_dir / RESPONSE_NAME, MAX_RESPONSE_BYTES)
    source, _, receipt = prepare_request(source, language)
    try:
        if json.loads(saved_receipt) != completed_receipt(receipt, raw):
            raise TranscriptionError("saved attempt does not match the source, analysis WAV, language, or response")
    except (UnicodeError, json.JSONDecodeError) as error:
        raise TranscriptionError("saved attempt is not a valid private receipt") from error
    payload = decode_response(raw)
    words = payload.get("words")
    if not isinstance(words, list) or not words or not isinstance(words[-1], dict):
        raise TranscriptionError("saved response has no final timed word to recover")
    last = words[-1]
    start, original_end = last.get("start"), last.get("end")
    bound = min(receipt["analysis_duration_seconds"], receipt["source"]["duration_seconds"])
    if not is_finite_number(original_end) or original_end <= bound + ROUNDING_TOLERANCE:
        raise TranscriptionError("only a final endpoint beyond the shared source and audio tolerance can be recovered")
    if not (is_finite_number(start) and is_finite_number(reviewed_end)
            and 0 <= start < reviewed_end <= bound):
        raise TranscriptionError("the reviewed final endpoint must be after its start and inside both measured clocks")
    last["end"] = reviewed_end
    transcript = normalized_response(payload, raw, receipt)
    transcript["timing_corrections"] = [{
        "kind": "reviewed_final_word_end", "word_index": len(words) - 1,
        "original_end_seconds": original_end, "corrected_end_seconds": reviewed_end,
    }]
    if sha256_file(source) != receipt["asset_id"][7:]:
        raise TranscriptionError("the source changed during offline recovery; the raw response was kept")
    return publish_transcript(output_dir, transcript)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="one local zero-origin source with a single audio stream")
    parser.add_argument("--approved-source-sha256", metavar="HEX",
                        help="approved source SHA-256, required before sending any audio")
    parser.add_argument("--output-dir", required=True, type=Path, help="new private output directory, or existing saved attempt for recovery")
    parser.add_argument("--language", default="auto", help="auto or a lowercase ISO 639-1 source language code")
    parser.add_argument("--recover-final-word-end", type=float, metavar="SECONDS",
                        help="offline repair of an overflowing final endpoint using a reviewed time and the saved attempt")
    args = parser.parse_args(argv)
    try:
        if args.recover_final_word_end is None:
            if args.approved_source_sha256 is None:
                parser.error("--approved-source-sha256 is required for a new request")
            summary = transcribe(
                args.source, args.output_dir, args.language,
                approved_source_sha256=args.approved_source_sha256,
            )
        else:
            summary = recover_final_word_end(args.source, args.output_dir, args.language, args.recover_final_word_end)
    except (TranscriptionError, credentials.CredentialError) as error:
        parser.exit(1, f"OpenRouter transcription failed: {error}\n")
    except OSError:
        parser.exit(1, "OpenRouter transcription could not access a required local file or directory.\n")
    print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
