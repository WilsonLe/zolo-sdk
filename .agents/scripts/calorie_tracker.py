#!/usr/bin/env python3
"""Safe local primitives for the Agentic Workflows Calorie Tracker workflow.

The helper never analyzes pixels, uploads files, or writes Google data. The host agent
performs image understanding and invokes the installed Google Drive connector. This
module provides deterministic validation, nutrition normalization, bounded public API
reads, protected local configuration, typed Sheets payload construction, and an
idempotency journal for those host-controlled operations.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

SCHEMA_VERSION = 1
MAX_PROVIDER_REQUESTS = 20
MAX_ITEMS = 8
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
CACHE_TTL = timedelta(days=30)
HTTP_TIMEOUT_SECONDS = 15
OFF_USER_AGENT = (
    "Agentic Workflows-Calorie-Tracker/0.1 "
    "(https://github.com/anhminhsoft/agentic-workflows)"
)

GOOGLE_ID = re.compile(r"^[A-Za-z0-9_-]{10,200}$")
BARCODE = re.compile(r"^[0-9]{8,14}$")
FDC_ID = re.compile(r"^[0-9]{1,12}$")
API_KEY = re.compile(r"^[A-Za-z0-9_-]{20,200}$")
SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

MEAL_COLUMNS = (
    "schema_version",
    "entry_id",
    "observed_at",
    "timezone",
    "meal_label",
    "image_drive_url",
    "image_drive_file_id",
    "image_sha256",
    "serving_g_estimate",
    "calories_kcal",
    "calories_low_kcal",
    "calories_high_kcal",
    "protein_g",
    "carbohydrate_g",
    "fat_g",
    "fiber_g",
    "total_sugar_g",
    "sodium_mg",
    "confidence",
    "assumptions",
    "source_summary",
    "recorded_at",
)

ITEM_COLUMNS = (
    "schema_version",
    "entry_id",
    "item_index",
    "description",
    "amount_g_estimate",
    "amount_low_g",
    "amount_high_g",
    "provider",
    "provider_food_id",
    "provider_url",
    "retrieved_at",
    "calories_kcal",
    "protein_g",
    "carbohydrate_g",
    "fat_g",
    "fiber_g",
    "total_sugar_g",
    "sodium_mg",
    "match_confidence",
    "match_reason",
)

MACRO_FIELDS = (
    "calories_kcal",
    "protein_g",
    "carbohydrate_g",
    "fat_g",
    "fiber_g",
    "total_sugar_g",
    "sodium_mg",
    "saturated_fat_g",
)

CONTRACT_INPUT_FIELDS = {
    "google_provider",
    "spreadsheet_id",
    "meals_tab",
    "meals_sheet_id",
    "items_tab",
    "items_sheet_id",
    "drive_folder_id",
    "timezone",
    "column_schema_version",
    "write_mode",
    "image_link_policy",
    "verified_at",
}

CONTRACT_STORED_FIELDS = CONTRACT_INPUT_FIELDS | {
    "schema_version",
    "contract_revision",
    "created_at",
    "updated_at",
}

ANALYSIS_FIELDS = {
    "schema_version",
    "record_type",
    "intent",
    "observed_at",
    "timezone",
    "meal_label",
    "image",
    "items",
    "assumptions",
    "confidence",
}

ITEM_INPUT_FIELDS = {
    "item_index",
    "description",
    "amount_g_estimate",
    "amount_low_g",
    "amount_high_g",
    "evidence",
    "provider",
    "provider_food_id",
    "provider_url",
    "retrieved_at",
    "macros_per_100g",
    "match_confidence",
    "match_reason",
}


class TrackerError(RuntimeError):
    """Stable, sanitized failure safe to show to the user."""

    def __init__(
        self,
        category: str,
        message: str,
        *,
        status: int | None = None,
        retry_after: str | None = None,
    ):
        super().__init__(message)
        self.category = category
        self.status = status
        self.retry_after = retry_after

    def payload(self) -> dict[str, object]:
        result: dict[str, object] = {
            "ok": False,
            "error": {"category": self.category, "message": str(self)},
        }
        if self.status is not None:
            result["error"]["status"] = self.status
        if self.retry_after is not None:
            result["error"]["retry_after"] = self.retry_after
        return result


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def parse_timestamp(value: object, path: str) -> str:
    text = require_string(value, path)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise TrackerError("invalid_input", f"{path} must be an ISO 8601 timestamp") from error
    if parsed.tzinfo is None:
        raise TrackerError("invalid_input", f"{path} must include a timezone")
    return text


def parse_timestamp_value(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def canonical_json(payload: object) -> bytes:
    return (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def digest_payload(payload: object) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(payload)).hexdigest()


def require_object(value: object, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TrackerError("invalid_input", f"{path} must be an object")
    return value


def require_list(value: object, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise TrackerError("invalid_input", f"{path} must be an array")
    return value


def require_string(value: object, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TrackerError("invalid_input", f"{path} must be a non-empty string")
    return value


def require_number(value: object, path: str, *, minimum: float = 0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrackerError("invalid_input", f"{path} must be numeric")
    number = float(value)
    if number != number or number in {float("inf"), float("-inf")} or number < minimum:
        raise TrackerError("invalid_input", f"{path} must be finite and at least {minimum}")
    return number


def strict_fields(record: Mapping[str, object], expected: set[str], path: str) -> None:
    missing = sorted(expected - set(record))
    unknown = sorted(set(record) - expected)
    if missing:
        raise TrackerError("invalid_input", f"{path} is missing: {', '.join(missing)}")
    if unknown:
        raise TrackerError("invalid_input", f"{path} has unknown fields: {', '.join(unknown)}")


def load_json(path: Path, *, max_bytes: int = MAX_RESPONSE_BYTES) -> Any:
    try:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise TrackerError("unsafe_path", "input must be a regular non-symlink file")
        if metadata.st_size > max_bytes:
            raise TrackerError("invalid_input", "input exceeds the allowed size")
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise TrackerError(
            "invalid_input", f"input contains invalid JSON at line {error.lineno}"
        ) from error
    except OSError as error:
        raise TrackerError("unsafe_path", "input could not be read") from error


def load_private_json(
    path: Path,
    *,
    max_bytes: int,
    platform: str | None = None,
) -> Any:
    """Read a managed private record only while its protection still holds."""

    platform = platform or sys.platform
    try:
        metadata = path.lstat()
    except OSError as error:
        raise TrackerError("unsafe_path", "protected record could not be inspected") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise TrackerError("unsafe_path", "protected record must be a regular non-symlink file")
    if not platform.startswith("win"):
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise TrackerError("permission_failure", "protected record must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise TrackerError("permission_failure", "protected record permissions are too broad")
    return load_json(path, max_bytes=max_bytes)


def _protect_windows(path: Path, *, directory: bool) -> None:
    user = getpass.getuser()
    grant = f"{user}:(OI)(CI)F" if directory else f"{user}:F"
    try:
        result = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", grant],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise TrackerError("permission_failure", "could not apply owner-only ACL") from error
    if result.returncode != 0:
        raise TrackerError("permission_failure", "could not apply owner-only ACL")


def _prepare_private_directory(path: Path, *, platform: str | None = None) -> None:
    platform = platform or sys.platform
    if path.is_symlink():
        raise TrackerError("unsafe_path", "private directory must not be a symlink")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if platform.startswith("win"):
        _protect_windows(path, directory=True)
    else:
        path.chmod(0o700)


def atomic_write_json(
    path: Path,
    payload: object,
    *,
    exclusive: bool = False,
    platform: str | None = None,
) -> None:
    platform = platform or sys.platform
    _prepare_private_directory(path.parent, platform=platform)
    if path.is_symlink():
        raise TrackerError("unsafe_path", "target file must not be a symlink")
    if path.exists() and not path.is_file():
        raise TrackerError("unsafe_path", "target must be a regular file")
    if exclusive and path.exists():
        raise TrackerError("immutable_collision", "record already exists")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True).encode())
            handle.write(b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        if platform.startswith("win"):
            _protect_windows(temporary, directory=False)
        if exclusive:
            try:
                os.link(temporary, path)
            except FileExistsError as error:
                raise TrackerError("immutable_collision", "record already exists") from error
        else:
            os.replace(temporary, path)
        if platform.startswith("win"):
            _protect_windows(path, directory=False)
        else:
            path.chmod(0o600)
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except TrackerError:
        raise
    except OSError as error:
        raise TrackerError("write_failure", "protected record could not be written atomically") from error
    finally:
        if temporary.exists():
            temporary.unlink()


def resolve_config_root(
    *,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    env = env or os.environ
    platform = platform or sys.platform
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA")
        if not base:
            raise TrackerError("configuration_failure", "LOCALAPPDATA is unavailable")
        return Path(base) / "Agentic Workflows" / "calorie-tracker"
    base = env.get("XDG_CONFIG_HOME")
    return (Path(base) if base else (home or Path.home()) / ".config") / "agentic-workflows" / "calorie-tracker"


def resolve_cache_root(
    *,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    env = env or os.environ
    platform = platform or sys.platform
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA")
        if not base:
            raise TrackerError("configuration_failure", "LOCALAPPDATA is unavailable")
        return Path(base) / "Agentic Workflows" / "calorie-tracker" / "cache"
    base = env.get("XDG_CACHE_HOME")
    return (Path(base) if base else (home or Path.home()) / ".cache") / "agentic-workflows" / "calorie-tracker"


def resolve_state_root(
    *,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
    home: Path | None = None,
) -> Path:
    env = env or os.environ
    platform = platform or sys.platform
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA")
        if not base:
            raise TrackerError("configuration_failure", "LOCALAPPDATA is unavailable")
        return Path(base) / "Agentic Workflows" / "calorie-tracker" / "state"
    base = env.get("XDG_STATE_HOME")
    return (Path(base) if base else (home or Path.home()) / ".local" / "state") / "agentic-workflows" / "calorie-tracker"


def _credential_path(root: Path | None = None) -> Path:
    return (root or resolve_config_root()) / "usda-credential.json"


def _contract_path(root: Path | None = None) -> Path:
    return (root or resolve_config_root()) / "storage-contract.json"


def parse_usda_key_source(path: Path, *, platform: str | None = None) -> str:
    platform = platform or sys.platform
    try:
        metadata = path.lstat()
    except OSError as error:
        raise TrackerError("credential_failure", "credential source cannot be read") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise TrackerError("unsafe_path", "credential source must be a regular non-symlink file")
    if metadata.st_size > 4096:
        raise TrackerError("credential_failure", "credential source is unexpectedly large")
    if not platform.startswith("win"):
        if hasattr(os, "getuid") and metadata.st_uid != os.getuid():
            raise TrackerError("permission_failure", "credential source must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise TrackerError("permission_failure", "credential source must be owner-readable only")
    try:
        text = path.read_text(encoding="utf-8").strip()
    except (OSError, UnicodeError) as error:
        raise TrackerError("credential_failure", "credential source cannot be read") from error
    if text.startswith("{"):
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as error:
            raise TrackerError("credential_failure", "credential JSON is invalid") from error
        if not isinstance(payload, dict) or set(payload) != {"api_key"}:
            raise TrackerError("credential_failure", "credential JSON must contain only api_key")
        text = payload["api_key"]
    if not isinstance(text, str) or text == "DEMO_KEY" or not API_KEY.fullmatch(text):
        raise TrackerError("credential_failure", "USDA API key format is invalid")
    return text


def install_usda_credential(
    source: Path,
    *,
    root: Path | None = None,
    platform: str | None = None,
    timestamp: str | None = None,
) -> dict[str, object]:
    key = parse_usda_key_source(source, platform=platform)
    updated_at = timestamp or utc_now()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "provider": "usda-fooddata-central",
        "api_key": key,
        "updated_at": updated_at,
    }
    atomic_write_json(_credential_path(root), payload, platform=platform)
    return {"configured": True, "provider": payload["provider"], "updated_at": updated_at}


def load_usda_key(*, root: Path | None = None) -> str:
    path = _credential_path(root)
    payload = require_object(load_private_json(path, max_bytes=4096), "credential")
    if set(payload) != {"schema_version", "provider", "api_key", "updated_at"}:
        raise TrackerError("credential_failure", "stored USDA credential is invalid")
    if payload.get("schema_version") != 1 or payload.get("provider") != "usda-fooddata-central":
        raise TrackerError("credential_failure", "stored USDA credential version is unsupported")
    key = payload.get("api_key")
    if not isinstance(key, str) or not API_KEY.fullmatch(key) or key == "DEMO_KEY":
        raise TrackerError("credential_failure", "stored USDA credential is invalid")
    return key


def usda_credential_status(*, root: Path | None = None) -> dict[str, object]:
    path = _credential_path(root)
    if not path.exists():
        return {"configured": False, "provider": "usda-fooddata-central"}
    payload = require_object(load_private_json(path, max_bytes=4096), "credential")
    load_usda_key(root=root)
    return {
        "configured": True,
        "provider": "usda-fooddata-central",
        "updated_at": payload["updated_at"],
    }


def revoke_usda_credential(*, root: Path | None = None, confirm: bool = False) -> dict[str, object]:
    if not confirm:
        raise TrackerError("approval_required", "credential revocation requires confirmation")
    path = _credential_path(root)
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise TrackerError("unsafe_path", "credential target is unsafe")
        path.unlink()
    return {"configured": False, "provider": "usda-fooddata-central"}


def validate_contract_input(value: object) -> dict[str, Any]:
    record = require_object(value, "storage_contract_input")
    strict_fields(record, CONTRACT_INPUT_FIELDS, "storage_contract_input")
    if record["google_provider"] != "google-drive-connector":
        raise TrackerError("invalid_input", "google_provider must be google-drive-connector")
    for field in ("spreadsheet_id", "drive_folder_id"):
        if not isinstance(record[field], str) or not GOOGLE_ID.fullmatch(record[field]):
            raise TrackerError("invalid_input", f"{field} is invalid")
    for field in ("meals_tab", "items_tab", "timezone"):
        require_string(record[field], field)
    if record["meals_tab"] == record["items_tab"]:
        raise TrackerError("invalid_input", "meal and item tabs must be different")
    for field in ("meals_sheet_id", "items_sheet_id"):
        if isinstance(record[field], bool) or not isinstance(record[field], int) or record[field] < 0:
            raise TrackerError("invalid_input", f"{field} must be a non-negative integer")
    if record["meals_sheet_id"] == record["items_sheet_id"]:
        raise TrackerError("invalid_input", "meal and item numeric sheet IDs must differ")
    if record["column_schema_version"] != 1:
        raise TrackerError("invalid_input", "column_schema_version must be 1")
    if record["write_mode"] != "append-only":
        raise TrackerError("invalid_input", "write_mode must be append-only")
    if record["image_link_policy"] != "private-drive-url":
        raise TrackerError("invalid_input", "image_link_policy must be private-drive-url")
    parse_timestamp(record["verified_at"], "verified_at")
    return record


def validate_stored_contract(value: object) -> dict[str, Any]:
    record = require_object(value, "storage_contract")
    strict_fields(record, CONTRACT_STORED_FIELDS, "storage_contract")
    if record["schema_version"] != 1:
        raise TrackerError("contract_version", "storage contract schema is unsupported")
    if isinstance(record["contract_revision"], bool) or not isinstance(record["contract_revision"], int) or record["contract_revision"] < 1:
        raise TrackerError("invalid_input", "contract_revision must be a positive integer")
    validate_contract_input({field: record[field] for field in CONTRACT_INPUT_FIELDS})
    parse_timestamp(record["created_at"], "created_at")
    parse_timestamp(record["updated_at"], "updated_at")
    return record


def set_storage_contract(
    candidate: object,
    *,
    root: Path | None = None,
    confirm: bool = False,
    platform: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    if not confirm:
        raise TrackerError("approval_required", "setting the active storage contract requires confirmation")
    candidate_record = validate_contract_input(candidate)
    path = _contract_path(root)
    now = timestamp or utc_now()
    if path.exists():
        previous = validate_stored_contract(load_private_json(path, max_bytes=32_768))
        revision = previous["contract_revision"] + 1
        created_at = previous["created_at"]
    else:
        revision = 1
        created_at = now
    stored = {
        "schema_version": 1,
        "contract_revision": revision,
        **candidate_record,
        "created_at": created_at,
        "updated_at": now,
    }
    validate_stored_contract(stored)
    atomic_write_json(path, stored, platform=platform)
    return stored


def show_storage_contract(*, root: Path | None = None) -> dict[str, Any]:
    path = _contract_path(root)
    if not path.exists():
        raise TrackerError("contract_missing", "no active storage contract is configured")
    return validate_stored_contract(load_private_json(path, max_bytes=32_768))


def clear_storage_contract(*, root: Path | None = None, confirm: bool = False) -> dict[str, object]:
    if not confirm:
        raise TrackerError("approval_required", "clearing the active contract requires confirmation")
    path = _contract_path(root)
    if path.exists():
        if path.is_symlink() or not path.is_file():
            raise TrackerError("unsafe_path", "storage contract target is unsafe")
        path.unlink()
    return {"configured": False}


def _round(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def energy_consistency(macros: Mapping[str, float | None]) -> dict[str, object]:
    required = [macros.get("protein_g"), macros.get("carbohydrate_g"), macros.get("fat_g")]
    if any(value is None for value in required) or macros.get("calories_kcal") is None:
        return {"status": "not_available", "macro_derived_kcal": None, "difference_kcal": None}
    derived = float(required[0]) * 4 + float(required[1]) * 4 + float(required[2]) * 9
    stated = float(macros["calories_kcal"])
    difference = stated - derived
    threshold = max(20.0, abs(stated) * 0.10)
    return {
        "status": "flag" if abs(difference) > threshold else "plausible",
        "macro_derived_kcal": round(derived, 2),
        "difference_kcal": round(difference, 2),
        "note": "Plausibility signal only; stated energy is preserved.",
    }


def _fdc_nutrient_entries(record: Mapping[str, object]) -> list[Mapping[str, object]]:
    entries = record.get("foodNutrients", [])
    if not isinstance(entries, list):
        raise TrackerError("provider_response", "USDA nutrient collection is invalid")
    return [entry for entry in entries if isinstance(entry, dict)]


def _fdc_value(record: Mapping[str, object], numbers: set[str], names: tuple[str, ...]) -> tuple[float, str] | None:
    for entry in _fdc_nutrient_entries(record):
        nutrient = entry.get("nutrient") if isinstance(entry.get("nutrient"), dict) else {}
        number = str(entry.get("nutrientNumber") or nutrient.get("number") or "")
        name = str(entry.get("nutrientName") or nutrient.get("name") or "").lower()
        raw = entry.get("value") if "value" in entry else entry.get("amount")
        unit = str(entry.get("unitName") or nutrient.get("unitName") or "").upper()
        if number in numbers or any(marker in name for marker in names):
            if isinstance(raw, bool) or not isinstance(raw, (int, float)):
                continue
            return float(raw), unit
    return None


def normalize_usda_record(
    record: object,
    amount_g: float,
    *,
    retrieved_at: str | None = None,
) -> dict[str, Any]:
    item = require_object(record, "usda_record")
    amount = require_number(amount_g, "amount_g", minimum=0.01)
    fdc_id = str(item.get("fdcId") or item.get("fdc_id") or "")
    if not FDC_ID.fullmatch(fdc_id):
        raise TrackerError("provider_response", "USDA record has no valid FDC ID")
    definitions = {
        "calories_kcal": ({"208"}, ("energy",)),
        "protein_g": ({"203"}, ("protein",)),
        "carbohydrate_g": ({"205"}, ("carbohydrate",)),
        "fat_g": ({"204"}, ("total lipid", "total fat")),
        "fiber_g": ({"291"}, ("fiber",)),
        "total_sugar_g": ({"269"}, ("sugars, total", "total sugars")),
        "sodium_mg": ({"307"}, ("sodium",)),
        "saturated_fat_g": ({"606"}, ("fatty acids, total saturated", "saturated fat")),
    }
    per_100g: dict[str, float | None] = {}
    for field, (numbers, names) in definitions.items():
        found = _fdc_value(item, numbers, names)
        if found is None:
            per_100g[field] = None
            continue
        value, unit = found
        if field == "calories_kcal":
            if unit in {"KJ", "KILOJOULE", "KILOJOULES"}:
                value /= 4.184
            elif unit not in {"KCAL", "KCALORIES", ""}:
                raise TrackerError("provider_response", "USDA energy unit is unsupported")
        elif field == "sodium_mg":
            if unit in {"G", "GRAM", "GRAMS"}:
                value *= 1000
            elif unit not in {"MG", "MILLIGRAM", "MILLIGRAMS", ""}:
                raise TrackerError("provider_response", "USDA sodium unit is unsupported")
        elif unit not in {"G", "GRAM", "GRAMS", ""}:
            raise TrackerError("provider_response", f"USDA unit for {field} is unsupported")
        per_100g[field] = _round(value)
    for required in ("calories_kcal", "protein_g", "carbohydrate_g", "fat_g"):
        if per_100g[required] is None:
            raise TrackerError("provider_response", f"USDA record is missing required {required}")
    scaled = scale_macros(per_100g, amount)
    return {
        "provider": "usda",
        "provider_food_id": fdc_id,
        "provider_url": f"https://fdc.nal.usda.gov/fdc-app.html#/food-details/{fdc_id}/nutrients",
        "description": str(item.get("description") or "USDA food"),
        "amount_g": amount,
        "basis": "per_100_g",
        "retrieved_at": retrieved_at or utc_now(),
        "macros_per_100g": per_100g,
        "macros_for_amount": scaled,
        "energy_consistency": energy_consistency(per_100g),
    }


def _off_number(nutriments: Mapping[str, object], key: str) -> float | None:
    value = nutriments.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrackerError("provider_response", f"Open Food Facts {key} is not numeric")
    return float(value)


def normalize_off_record(
    response: object,
    amount_g: float,
    *,
    retrieved_at: str | None = None,
) -> dict[str, Any]:
    payload = require_object(response, "open_food_facts_response")
    if payload.get("status") in {0, "failure"}:
        raise TrackerError("provider_no_result", "Open Food Facts product was not found")
    product = payload.get("product", payload)
    product = require_object(product, "open_food_facts_product")
    barcode = str(payload.get("code") or product.get("code") or "")
    if not BARCODE.fullmatch(barcode):
        raise TrackerError("provider_response", "Open Food Facts barcode is invalid")
    nutriments = require_object(product.get("nutriments"), "nutriments")
    per_100g = {
        "calories_kcal": _off_number(nutriments, "energy-kcal_100g"),
        "protein_g": _off_number(nutriments, "proteins_100g"),
        "carbohydrate_g": _off_number(nutriments, "carbohydrates_100g"),
        "fat_g": _off_number(nutriments, "fat_100g"),
        "fiber_g": _off_number(nutriments, "fiber_100g"),
        "total_sugar_g": _off_number(nutriments, "sugars_100g"),
        "sodium_mg": _off_number(nutriments, "sodium_100g"),
        "saturated_fat_g": _off_number(nutriments, "saturated-fat_100g"),
    }
    if per_100g["sodium_mg"] is not None:
        per_100g["sodium_mg"] *= 1000
    per_100g = {key: _round(value) for key, value in per_100g.items()}
    for required in ("calories_kcal", "protein_g", "carbohydrate_g", "fat_g"):
        if per_100g[required] is None:
            raise TrackerError("provider_response", f"Open Food Facts record is missing required {required}")
    amount = require_number(amount_g, "amount_g", minimum=0.01)
    return {
        "provider": "open_food_facts",
        "provider_food_id": barcode,
        "provider_url": f"https://world.openfoodfacts.org/product/{barcode}",
        "description": str(product.get("product_name") or "Packaged food"),
        "amount_g": amount,
        "basis": "per_100_g",
        "retrieved_at": retrieved_at or utc_now(),
        "macros_per_100g": per_100g,
        "macros_for_amount": scale_macros(per_100g, amount),
        "energy_consistency": energy_consistency(per_100g),
    }


def scale_macros(macros: Mapping[str, float | None], amount_g: float) -> dict[str, float | None]:
    factor = amount_g / 100
    return {field: _round(None if macros.get(field) is None else float(macros[field]) * factor) for field in MACRO_FIELDS}


class RequestBudget:
    def __init__(self, limit: int = MAX_PROVIDER_REQUESTS):
        if not 1 <= limit <= MAX_PROVIDER_REQUESTS:
            raise TrackerError("invalid_input", "provider request budget must be between 1 and 20")
        self.limit = limit
        self.used = 0

    def consume(self) -> None:
        if self.used >= self.limit:
            raise TrackerError("request_budget", "provider request budget is exhausted")
        self.used += 1


class ProviderCache:
    def __init__(self, root: Path | None = None, now: Callable[[], str] = utc_now):
        self.root = root or resolve_cache_root()
        self.now = now

    def key(self, descriptor: Mapping[str, object]) -> str:
        return hashlib.sha256(canonical_json(descriptor)).hexdigest()

    def get(self, descriptor: Mapping[str, object]) -> dict[str, Any] | None:
        path = self.root / "provider-records" / f"{self.key(descriptor)}.json"
        if not path.exists():
            return None
        try:
            record = require_object(load_json(path), "cache")
            if record.get("descriptor") != descriptor:
                return None
            expires_at = parse_timestamp_value(require_string(record.get("expires_at"), "expires_at"))
            if expires_at <= parse_timestamp_value(self.now()):
                return None
            response = record.get("response")
            if not isinstance(response, dict):
                return None
            return record
        except (TrackerError, ValueError):
            return None

    def put(self, descriptor: Mapping[str, object], response: dict[str, Any], retrieved_at: str) -> None:
        expires_at = (
            parse_timestamp_value(retrieved_at) + CACHE_TTL
        ).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        atomic_write_json(
            self.root / "provider-records" / f"{self.key(descriptor)}.json",
            {
                "schema_version": 1,
                "descriptor": descriptor,
                "retrieved_at": retrieved_at,
                "expires_at": expires_at,
                "response": response,
            },
        )


class StrictRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str]):
        super().__init__()
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname not in self.allowed_hosts:
            raise TrackerError("network_policy", "provider redirect target is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], tuple[int, Mapping[str, str], bytes]]


def production_transport(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout: float,
) -> tuple[int, Mapping[str, str], bytes]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in {
        "api.nal.usda.gov",
        "world.openfoodfacts.org",
    }:
        raise TrackerError("network_policy", "provider host is not allowed")
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    opener = urllib.request.build_opener(StrictRedirectHandler({parsed.hostname}))
    try:
        with opener.open(request, timeout=timeout) as response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
            return response.status, dict(response.headers.items()), data
    except urllib.error.HTTPError as error:
        data = error.read(MAX_RESPONSE_BYTES + 1)
        return error.code, dict(error.headers.items()), data


class ProviderClient:
    def __init__(
        self,
        *,
        credential_root: Path | None = None,
        cache_root: Path | None = None,
        transport: Transport = production_transport,
        now: Callable[[], str] = utc_now,
        budget: int = MAX_PROVIDER_REQUESTS,
    ):
        self.credential_root = credential_root
        self.cache = ProviderCache(cache_root, now=now)
        self.transport = transport
        self.now = now
        self.budget = RequestBudget(budget)

    def execute(self, plan: object, *, force_refresh: bool = False) -> dict[str, Any]:
        payload = require_object(plan, "provider_plan")
        if set(payload) != {"schema_version", "requests"} or payload.get("schema_version") != 1:
            raise TrackerError("invalid_input", "provider plan schema is invalid")
        requests = require_list(payload["requests"], "requests")
        if not 1 <= len(requests) <= MAX_PROVIDER_REQUESTS:
            raise TrackerError("request_budget", "provider plan must contain 1 to 20 requests")
        results = [self._execute_one(request, force_refresh=force_refresh) for request in requests]
        return {
            "schema_version": 1,
            "request_count": self.budget.used,
            "request_limit": self.budget.limit,
            "results": results,
        }

    def _execute_one(self, value: object, *, force_refresh: bool) -> dict[str, Any]:
        request = require_object(value, "provider_request")
        provider = request.get("provider")
        operation = request.get("operation")
        method: str
        url: str
        headers = {"Accept": "application/json"}
        body: bytes | None = None
        if provider == "usda" and operation == "search":
            allowed = {"provider", "operation", "query", "data_types"}
            if not set(request).issubset(allowed) or not {"provider", "operation", "query"}.issubset(request):
                raise TrackerError("invalid_input", "USDA search request fields are invalid")
            query = require_string(request["query"], "query").strip()
            if len(query) > 120:
                raise TrackerError("invalid_input", "USDA query is too long")
            data_types = request.get("data_types", ["Foundation", "Survey (FNDDS)", "Branded"])
            if not isinstance(data_types, list) or not data_types or not set(data_types).issubset(
                {"Foundation", "Survey (FNDDS)", "SR Legacy", "Branded"}
            ):
                raise TrackerError("invalid_input", "USDA data_types are invalid")
            descriptor = {"provider": provider, "operation": operation, "query": query, "data_types": data_types}
            key = load_usda_key(root=self.credential_root)
            url = "https://api.nal.usda.gov/fdc/v1/foods/search?" + urllib.parse.urlencode({"api_key": key})
            body = json.dumps({"query": query, "pageSize": 3, "dataType": data_types}).encode()
            headers["Content-Type"] = "application/json"
            method = "POST"
        elif provider == "usda" and operation == "food":
            if set(request) != {"provider", "operation", "fdc_id"}:
                raise TrackerError("invalid_input", "USDA food request fields are invalid")
            fdc_id = str(request["fdc_id"])
            if not FDC_ID.fullmatch(fdc_id):
                raise TrackerError("invalid_input", "fdc_id is invalid")
            descriptor = {"provider": provider, "operation": operation, "fdc_id": fdc_id}
            key = load_usda_key(root=self.credential_root)
            url = f"https://api.nal.usda.gov/fdc/v1/food/{fdc_id}?" + urllib.parse.urlencode({"api_key": key})
            method = "GET"
        elif provider == "open_food_facts" and operation == "product":
            if set(request) != {"provider", "operation", "barcode"}:
                raise TrackerError("invalid_input", "Open Food Facts request fields are invalid")
            barcode = str(request["barcode"])
            if not BARCODE.fullmatch(barcode):
                raise TrackerError("invalid_input", "barcode is invalid")
            descriptor = {"provider": provider, "operation": operation, "barcode": barcode}
            fields = "code,product_name,brands,quantity,serving_size,nutriments"
            url = f"https://world.openfoodfacts.org/api/v3.6/product/{barcode}.json?" + urllib.parse.urlencode({"fields": fields})
            headers["User-Agent"] = OFF_USER_AGENT
            method = "GET"
        else:
            raise TrackerError("invalid_input", "provider operation is unsupported")

        if not force_refresh:
            cached = self.cache.get(descriptor)
            if cached is not None:
                return {
                    "descriptor": descriptor,
                    "cache": "hit",
                    "retrieved_at": cached["retrieved_at"],
                    "response": cached["response"],
                }
        response, retrieved_at = self._request(method, url, headers, body)
        self.cache.put(descriptor, response, retrieved_at)
        return {
            "descriptor": descriptor,
            "cache": "miss" if not force_refresh else "refreshed",
            "retrieved_at": retrieved_at,
            "response": response,
        }

    def _request(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> tuple[dict[str, Any], str]:
        last_transport_error: Exception | None = None
        for attempt in range(2):
            self.budget.consume()
            try:
                status, response_headers, data = self.transport(
                    method, url, headers, body, HTTP_TIMEOUT_SECONDS
                )
            except TrackerError:
                raise
            except (OSError, TimeoutError) as error:
                last_transport_error = error
                if attempt == 0:
                    time.sleep(0.25)
                    continue
                raise TrackerError("provider_unavailable", "provider transport failed after one retry") from error
            if len(data) > MAX_RESPONSE_BYTES:
                raise TrackerError("provider_response", "provider response exceeds the size limit")
            normalized_headers = {str(key).lower(): str(value) for key, value in response_headers.items()}
            if status == 429:
                retry_after = normalized_headers.get("retry-after")
                raise TrackerError(
                    "rate_limited",
                    "provider rate limit reached; do not retry immediately",
                    status=429,
                    retry_after=retry_after,
                )
            if 500 <= status <= 599 and attempt == 0:
                time.sleep(0.25)
                continue
            if status < 200 or status >= 300:
                raise TrackerError("provider_http", "provider request failed", status=status)
            content_type = normalized_headers.get("content-type", "")
            if "json" not in content_type.lower():
                raise TrackerError("provider_response", "provider response is not JSON")
            try:
                payload = json.loads(data.decode("utf-8"))
            except (UnicodeError, json.JSONDecodeError) as error:
                raise TrackerError("provider_response", "provider returned malformed JSON") from error
            if not isinstance(payload, dict):
                raise TrackerError("provider_response", "provider response must be an object")
            return payload, self.now()
        raise TrackerError("provider_unavailable", "provider transport failed") from last_transport_error


def validate_analysis(value: object) -> dict[str, Any]:
    record = require_object(value, "meal_analysis")
    strict_fields(record, ANALYSIS_FIELDS, "meal_analysis")
    if record["schema_version"] != 1 or record["record_type"] != "meal_analysis":
        raise TrackerError("invalid_input", "meal analysis schema is invalid")
    if record["intent"] not in {"analyze", "track"}:
        raise TrackerError("invalid_input", "intent must be analyze or track")
    parse_timestamp(record["observed_at"], "observed_at")
    require_string(record["timezone"], "timezone")
    require_string(record["meal_label"], "meal_label")
    confidence = require_number(record["confidence"], "confidence")
    if confidence > 1:
        raise TrackerError("invalid_input", "confidence must be between 0 and 1")
    assumptions = require_list(record["assumptions"], "assumptions")
    if not all(isinstance(item, str) and item.strip() for item in assumptions):
        raise TrackerError("invalid_input", "assumptions must contain non-empty strings")
    image = require_object(record["image"], "image")
    strict_fields(image, {"sha256", "authorized", "storage_authorized"}, "image")
    if not isinstance(image["sha256"], str) or not SHA256.fullmatch(image["sha256"]):
        raise TrackerError("invalid_input", "image.sha256 is invalid")
    if not isinstance(image["authorized"], bool) or not image["authorized"]:
        raise TrackerError("approval_required", "image analysis requires ownership or authorization")
    if not isinstance(image["storage_authorized"], bool):
        raise TrackerError("invalid_input", "image.storage_authorized must be boolean")
    if record["intent"] == "track" and not image["storage_authorized"]:
        raise TrackerError("approval_required", "tracking requires explicit image-storage authorization")
    items = require_list(record["items"], "items")
    if not 1 <= len(items) <= MAX_ITEMS:
        raise TrackerError("invalid_input", "meal analysis must contain 1 to 8 items")
    indexes: set[int] = set()
    for position, value in enumerate(items):
        item = require_object(value, f"items[{position}]")
        strict_fields(item, ITEM_INPUT_FIELDS, f"items[{position}]")
        index = item["item_index"]
        if isinstance(index, bool) or not isinstance(index, int) or index < 1 or index in indexes:
            raise TrackerError("invalid_input", "item_index values must be unique positive integers")
        indexes.add(index)
        require_string(item["description"], f"items[{position}].description")
        estimate = require_number(item["amount_g_estimate"], "amount_g_estimate", minimum=0.01)
        low = require_number(item["amount_low_g"], "amount_low_g", minimum=0.01)
        high = require_number(item["amount_high_g"], "amount_high_g", minimum=0.01)
        if not low <= estimate <= high:
            raise TrackerError("invalid_input", "amount range must contain the estimate")
        evidence = require_list(item["evidence"], f"items[{position}].evidence")
        if not evidence:
            raise TrackerError("invalid_input", "each item requires evidence")
        evidence_types = set()
        for evidence_index, evidence_value in enumerate(evidence):
            evidence_item = require_object(evidence_value, f"evidence[{evidence_index}]")
            strict_fields(evidence_item, {"type", "statement"}, "evidence")
            if evidence_item["type"] not in {"visible", "user", "provider", "inference"}:
                raise TrackerError("invalid_input", "evidence type is unsupported")
            require_string(evidence_item["statement"], "evidence.statement")
            evidence_types.add(evidence_item["type"])
        if not evidence_types.intersection({"visible", "user"}):
            raise TrackerError("invalid_input", "each item requires visible or user-supplied evidence")
        if item["provider"] not in {"visible_label", "open_food_facts", "usda", "manual"}:
            raise TrackerError("invalid_input", "item provider is unsupported")
        provider = item["provider"]
        if provider == "manual":
            if any(item[field] is not None for field in ("provider_food_id", "provider_url", "retrieved_at")):
                raise TrackerError("invalid_input", "manual estimates must not invent provider lineage")
        elif provider == "visible_label":
            if item["provider_food_id"] is not None:
                require_string(item["provider_food_id"], "provider_food_id")
            if item["provider_url"] is not None or item["retrieved_at"] is not None:
                raise TrackerError("invalid_input", "visible labels must not invent external provider lineage")
        else:
            provider_food_id = require_string(item["provider_food_id"], "provider_food_id")
            if provider == "usda" and not FDC_ID.fullmatch(provider_food_id):
                raise TrackerError("invalid_input", "USDA provider_food_id must be an FDC ID")
            if provider == "open_food_facts" and not BARCODE.fullmatch(provider_food_id):
                raise TrackerError("invalid_input", "Open Food Facts provider_food_id must be a barcode")
            url = require_string(item["provider_url"], "provider_url")
            parsed = urllib.parse.urlsplit(url)
            expected_host = {
                "usda": "fdc.nal.usda.gov",
                "open_food_facts": "world.openfoodfacts.org",
            }[provider]
            if (
                parsed.scheme != "https"
                or parsed.hostname != expected_host
                or parsed.username
                or parsed.password
            ):
                raise TrackerError("invalid_input", "provider_url does not match the selected provider")
            parse_timestamp(item["retrieved_at"], "retrieved_at")
            if "provider" not in evidence_types:
                raise TrackerError("invalid_input", "external provider records require provider evidence")
        macros = require_object(item["macros_per_100g"], "macros_per_100g")
        strict_fields(macros, set(MACRO_FIELDS), "macros_per_100g")
        for field in MACRO_FIELDS:
            if macros[field] is None:
                if field in {"calories_kcal", "protein_g", "carbohydrate_g", "fat_g"}:
                    raise TrackerError("invalid_input", f"required macro {field} is missing")
            else:
                require_number(macros[field], field)
        match_confidence = require_number(item["match_confidence"], "match_confidence")
        if match_confidence > 1:
            raise TrackerError("invalid_input", "match_confidence must be between 0 and 1")
        require_string(item["match_reason"], "match_reason")
    return record


def build_meal_record(value: object, *, entry_id: str | None = None, timestamp: str | None = None) -> dict[str, Any]:
    analysis = validate_analysis(value)
    entry_id = entry_id or str(uuid.uuid4())
    if not UUID.fullmatch(entry_id):
        raise TrackerError("invalid_input", "entry_id must be a UUID")
    recorded_at = timestamp or utc_now()
    parse_timestamp(recorded_at, "recorded_at")
    item_rows = []
    for item in analysis["items"]:
        macros = scale_macros(item["macros_per_100g"], item["amount_g_estimate"])
        row = {
            "schema_version": 1,
            "entry_id": entry_id,
            "item_index": item["item_index"],
            "description": item["description"],
            "amount_g_estimate": item["amount_g_estimate"],
            "amount_low_g": item["amount_low_g"],
            "amount_high_g": item["amount_high_g"],
            "provider": item["provider"],
            "provider_food_id": item["provider_food_id"],
            "provider_url": item["provider_url"],
            "retrieved_at": item["retrieved_at"],
            **{field: macros[field] for field in MACRO_FIELDS if field != "saturated_fat_g"},
            "match_confidence": item["match_confidence"],
            "match_reason": item["match_reason"],
            "energy_consistency": energy_consistency(item["macros_per_100g"]),
        }
        item_rows.append(row)

    def total(field: str) -> float | None:
        values = [row[field] for row in item_rows]
        if all(value is None for value in values):
            return None
        return _round(sum(float(value) for value in values if value is not None))

    calories_low = sum(
        float(item["macros_per_100g"]["calories_kcal"]) * item["amount_low_g"] / 100
        for item in analysis["items"]
    )
    calories_high = sum(
        float(item["macros_per_100g"]["calories_kcal"]) * item["amount_high_g"] / 100
        for item in analysis["items"]
    )
    meal = {
        "schema_version": 1,
        "entry_id": entry_id,
        "observed_at": analysis["observed_at"],
        "timezone": analysis["timezone"],
        "meal_label": analysis["meal_label"],
        "image_drive_url": None,
        "image_drive_file_id": None,
        "image_sha256": analysis["image"]["sha256"],
        "serving_g_estimate": _round(sum(item["amount_g_estimate"] for item in analysis["items"])),
        "calories_kcal": total("calories_kcal"),
        "calories_low_kcal": _round(calories_low),
        "calories_high_kcal": _round(calories_high),
        "protein_g": total("protein_g"),
        "carbohydrate_g": total("carbohydrate_g"),
        "fat_g": total("fat_g"),
        "fiber_g": total("fiber_g"),
        "total_sugar_g": total("total_sugar_g"),
        "sodium_mg": total("sodium_mg"),
        "confidence": analysis["confidence"],
        "assumptions": " | ".join(analysis["assumptions"]),
        "source_summary": "; ".join(
            f"{item['provider']}:"
            f"{item['provider_food_id'] or ('label' if item['provider'] == 'visible_label' else 'manual')}"
            for item in analysis["items"]
        ),
        "recorded_at": recorded_at,
    }
    return {
        "schema_version": 1,
        "record_type": "meal_record",
        "intent": analysis["intent"],
        "entry_id": entry_id,
        "meal": meal,
        "items": item_rows,
        "record_digest": digest_payload({"meal": meal, "items": item_rows}),
    }


def bind_drive_image(record_value: object, file_id: str, drive_url: str) -> dict[str, Any]:
    record = validate_meal_record(record_value)
    if record["intent"] != "track":
        raise TrackerError("approval_required", "analysis-only records cannot be bound to Drive")
    if not GOOGLE_ID.fullmatch(file_id):
        raise TrackerError("invalid_input", "Drive file ID is invalid")
    parsed = urllib.parse.urlsplit(drive_url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in {"drive.google.com", "docs.google.com"}
        or parsed.username
        or parsed.password
    ):
        raise TrackerError("invalid_input", "Drive URL is invalid")
    updated = json.loads(json.dumps(record))
    updated["meal"]["image_drive_file_id"] = file_id
    updated["meal"]["image_drive_url"] = drive_url
    updated["record_digest"] = digest_payload({"meal": updated["meal"], "items": updated["items"]})
    return updated


def validate_meal_record(value: object) -> dict[str, Any]:
    record = require_object(value, "meal_record")
    if set(record) != {"schema_version", "record_type", "intent", "entry_id", "meal", "items", "record_digest"}:
        raise TrackerError("invalid_input", "meal record fields are invalid")
    if record["schema_version"] != 1 or record["record_type"] != "meal_record" or record["intent"] not in {"analyze", "track"}:
        raise TrackerError("invalid_input", "meal record schema is invalid")
    if not isinstance(record["entry_id"], str) or not UUID.fullmatch(record["entry_id"]):
        raise TrackerError("invalid_input", "meal record entry_id is invalid")
    meal = require_object(record["meal"], "meal")
    if set(meal) != set(MEAL_COLUMNS):
        raise TrackerError("invalid_input", "meal row does not match schema v1")
    if meal["schema_version"] != 1 or meal["entry_id"] != record["entry_id"]:
        raise TrackerError("invalid_input", "meal row identity differs from its record")
    parse_timestamp(meal["observed_at"], "meal.observed_at")
    parse_timestamp(meal["recorded_at"], "meal.recorded_at")
    for field in ("timezone", "meal_label", "assumptions", "source_summary"):
        require_string(meal[field], f"meal.{field}")
    if not isinstance(meal["image_sha256"], str) or not SHA256.fullmatch(meal["image_sha256"]):
        raise TrackerError("invalid_input", "meal image digest is invalid")
    drive_file_id = meal["image_drive_file_id"]
    drive_url = meal["image_drive_url"]
    if (drive_file_id is None) != (drive_url is None):
        raise TrackerError("invalid_input", "Drive file ID and URL must be present together")
    if drive_file_id is not None:
        if not isinstance(drive_file_id, str) or not GOOGLE_ID.fullmatch(drive_file_id):
            raise TrackerError("invalid_input", "meal Drive file ID is invalid")
        parsed = urllib.parse.urlsplit(require_string(drive_url, "meal.image_drive_url"))
        if (
            parsed.scheme != "https"
            or parsed.hostname not in {"drive.google.com", "docs.google.com"}
            or parsed.username
            or parsed.password
        ):
            raise TrackerError("invalid_input", "meal Drive URL is invalid")
    if record["intent"] == "analyze" and drive_file_id is not None:
        raise TrackerError("approval_required", "analysis-only records cannot contain Drive data")
    required_numbers = {
        "serving_g_estimate",
        "calories_kcal",
        "calories_low_kcal",
        "calories_high_kcal",
        "protein_g",
        "carbohydrate_g",
        "fat_g",
        "confidence",
    }
    optional_numbers = {"fiber_g", "total_sugar_g", "sodium_mg"}
    for field in required_numbers:
        require_number(meal[field], f"meal.{field}")
    for field in optional_numbers:
        if meal[field] is not None:
            require_number(meal[field], f"meal.{field}")
    if float(meal["confidence"]) > 1:
        raise TrackerError("invalid_input", "meal confidence must be between 0 and 1")
    if not float(meal["calories_low_kcal"]) <= float(meal["calories_kcal"]) <= float(meal["calories_high_kcal"]):
        raise TrackerError("invalid_input", "meal calorie range must contain the estimate")
    items = require_list(record["items"], "items")
    if not items:
        raise TrackerError("invalid_input", "meal record has no items")
    for item in items:
        row = require_object(item, "item")
        if set(row) != set(ITEM_COLUMNS) | {"energy_consistency"}:
            raise TrackerError("invalid_input", "item row does not match schema v1")
        if row["entry_id"] != record["entry_id"]:
            raise TrackerError("invalid_input", "item entry_id differs from meal record")
        if row["schema_version"] != 1:
            raise TrackerError("invalid_input", "item schema version is invalid")
    expected = digest_payload({"meal": meal, "items": items})
    if not isinstance(record["record_digest"], str) or not SHA256.fullmatch(record["record_digest"]):
        raise TrackerError("integrity_failure", "meal record digest format is invalid")
    if record["record_digest"] != expected:
        raise TrackerError("integrity_failure", "meal record digest does not match content")
    return record


def _cell(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, bool):
        return {"userEnteredValue": {"boolValue": value}}
    if isinstance(value, (int, float)):
        return {"userEnteredValue": {"numberValue": value}}
    return {"userEnteredValue": {"stringValue": str(value)}}


def build_sheet_batch(record_value: object, contract_value: object) -> dict[str, Any]:
    record = validate_meal_record(record_value)
    contract = validate_stored_contract(contract_value)
    if record["intent"] != "track":
        raise TrackerError("approval_required", "analysis-only records cannot create a Sheet write")
    if not record["meal"]["image_drive_file_id"] or not record["meal"]["image_drive_url"]:
        raise TrackerError("operation_order", "Drive image must be bound before Sheet payload creation")
    meal_values = [_cell(record["meal"][column]) for column in MEAL_COLUMNS]
    item_rows = [
        {"values": [_cell(item[column]) for column in ITEM_COLUMNS]}
        for item in record["items"]
    ]
    requests = [
        {
            "appendCells": {
                "sheetId": contract["meals_sheet_id"],
                "rows": [{"values": meal_values}],
                "fields": "userEnteredValue",
            }
        },
        {
            "appendCells": {
                "sheetId": contract["items_sheet_id"],
                "rows": item_rows,
                "fields": "userEnteredValue",
            }
        },
    ]
    return {
        "spreadsheet_id": contract["spreadsheet_id"],
        "entry_id": record["entry_id"],
        "requests": requests,
        "batch_digest": digest_payload(requests),
    }


def image_digest(path: Path) -> dict[str, object]:
    try:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise TrackerError("unsafe_path", "image must be a regular non-symlink file")
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
    except OSError as error:
        raise TrackerError("unsafe_path", "image could not be read") from error
    return {"sha256": "sha256:" + hasher.hexdigest(), "bytes": metadata.st_size}


JOURNAL_TRANSITIONS = {
    "planned": {"image_uploaded", "failed_recoverable"},
    "image_uploaded": {"sheet_written_unverified", "failed_recoverable"},
    "sheet_written_unverified": {"verified", "failed_recoverable"},
    "failed_recoverable": {"image_uploaded", "sheet_written_unverified", "verified", "failed_recoverable"},
    "verified": set(),
}


def _journal_path(entry_id: str, root: Path | None = None) -> Path:
    if not UUID.fullmatch(entry_id):
        raise TrackerError("invalid_input", "entry_id must be a UUID")
    return (root or resolve_state_root()) / "operations" / f"{entry_id}.json"


def create_journal(
    record_value: object,
    contract_value: object,
    *,
    root: Path | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    record = validate_meal_record(record_value)
    contract = validate_stored_contract(contract_value)
    if record["intent"] != "track":
        raise TrackerError("approval_required", "analysis-only records cannot create an operation journal")
    now = timestamp or utc_now()
    journal = {
        "schema_version": 1,
        "entry_id": record["entry_id"],
        "state": "planned",
        "image_sha256": record["meal"]["image_sha256"],
        "record_digest": record["record_digest"],
        "spreadsheet_id": contract["spreadsheet_id"],
        "drive_folder_id": contract["drive_folder_id"],
        "drive_file_id": None,
        "drive_url": None,
        "sheet_batch_digest": None,
        "failure": None,
        "created_at": now,
        "updated_at": now,
    }
    atomic_write_json(_journal_path(record["entry_id"], root), journal, exclusive=True)
    return journal


def show_journal(entry_id: str, *, root: Path | None = None) -> dict[str, Any]:
    record = require_object(
        load_private_json(_journal_path(entry_id, root), max_bytes=32_768),
        "journal",
    )
    if record.get("schema_version") != 1 or record.get("entry_id") != entry_id or record.get("state") not in JOURNAL_TRANSITIONS:
        raise TrackerError("journal_failure", "operation journal is invalid")
    return record


def transition_journal(
    entry_id: str,
    state: str,
    *,
    root: Path | None = None,
    drive_file_id: str | None = None,
    drive_url: str | None = None,
    sheet_batch_digest: str | None = None,
    failure: str | None = None,
    timestamp: str | None = None,
) -> dict[str, Any]:
    journal = show_journal(entry_id, root=root)
    current = journal["state"]
    if state not in JOURNAL_TRANSITIONS[current]:
        raise TrackerError("journal_transition", f"cannot transition from {current} to {state}")
    if drive_file_id is not None:
        if not GOOGLE_ID.fullmatch(drive_file_id):
            raise TrackerError("invalid_input", "Drive file ID is invalid")
        journal["drive_file_id"] = drive_file_id
    if drive_url is not None:
        parsed = urllib.parse.urlsplit(drive_url)
        if (
            parsed.scheme != "https"
            or parsed.hostname not in {"drive.google.com", "docs.google.com"}
            or parsed.username
            or parsed.password
        ):
            raise TrackerError("invalid_input", "Drive URL is invalid")
        journal["drive_url"] = drive_url
    if sheet_batch_digest is not None:
        if not SHA256.fullmatch(sheet_batch_digest):
            raise TrackerError("invalid_input", "Sheet batch digest is invalid")
        journal["sheet_batch_digest"] = sheet_batch_digest
    if state in {"image_uploaded", "sheet_written_unverified", "verified"} and (
        not journal["drive_file_id"] or not journal["drive_url"]
    ):
        raise TrackerError("journal_transition", "Drive identity is required for this transition")
    if state in {"sheet_written_unverified", "verified"} and not journal["sheet_batch_digest"]:
        raise TrackerError("journal_transition", "Sheet batch digest is required for this transition")
    if failure is not None:
        if not isinstance(failure, str) or not failure.strip() or len(failure) > 256:
            raise TrackerError("invalid_input", "failure summary is invalid")
        lowered = failure.lower()
        if any(marker in lowered for marker in ("api_key", "authorization:", "bearer ", "?api_key=")):
            raise TrackerError("prohibited_data", "failure summary may contain credential material")
        journal["failure"] = failure
    elif state != "failed_recoverable":
        journal["failure"] = None
    journal["state"] = state
    journal["updated_at"] = timestamp or utc_now()
    atomic_write_json(_journal_path(entry_id, root), journal)
    return journal


def write_output(path: Path | None, payload: object) -> None:
    if path is None:
        print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
    else:
        atomic_write_json(path, payload)
        print(json.dumps({"ok": True, "output": str(path.resolve())}, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("credential-install")
    install.add_argument("--source", required=True, type=Path)
    sub.add_parser("credential-status")
    revoke = sub.add_parser("credential-revoke")
    revoke.add_argument("--confirm", action="store_true")

    contract_set = sub.add_parser("contract-set")
    contract_set.add_argument("--input", required=True, type=Path)
    contract_set.add_argument("--confirm", action="store_true")
    sub.add_parser("contract-show")
    contract_clear = sub.add_parser("contract-clear")
    contract_clear.add_argument("--confirm", action="store_true")

    provider = sub.add_parser("provider-fetch")
    provider.add_argument("--input", required=True, type=Path)
    provider.add_argument("--force-refresh", action="store_true")
    provider.add_argument("--budget", type=int, default=MAX_PROVIDER_REQUESTS)

    for name in ("normalize-usda", "normalize-off"):
        normalize = sub.add_parser(name)
        normalize.add_argument("--input", required=True, type=Path)
        normalize.add_argument("--amount-g", required=True, type=float)

    digest = sub.add_parser("image-digest")
    digest.add_argument("--image", required=True, type=Path)

    build = sub.add_parser("record-build")
    build.add_argument("--input", required=True, type=Path)
    build.add_argument("--entry-id")
    build.add_argument("--output", type=Path)

    bind = sub.add_parser("record-bind-image")
    bind.add_argument("--record", required=True, type=Path)
    bind.add_argument("--drive-file-id", required=True)
    bind.add_argument("--drive-url", required=True)
    bind.add_argument("--output", type=Path)

    batch = sub.add_parser("sheet-batch")
    batch.add_argument("--record", required=True, type=Path)
    batch.add_argument("--contract", type=Path)
    batch.add_argument("--output", type=Path)

    journal_create = sub.add_parser("journal-create")
    journal_create.add_argument("--record", required=True, type=Path)
    journal_create.add_argument("--contract", type=Path)

    journal_show = sub.add_parser("journal-show")
    journal_show.add_argument("--entry-id", required=True)

    journal_transition = sub.add_parser("journal-transition")
    journal_transition.add_argument("--entry-id", required=True)
    journal_transition.add_argument("--state", required=True, choices=sorted(JOURNAL_TRANSITIONS))
    journal_transition.add_argument("--drive-file-id")
    journal_transition.add_argument("--drive-url")
    journal_transition.add_argument("--sheet-batch-digest")
    journal_transition.add_argument("--failure")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "credential-install":
            result = install_usda_credential(args.source)
        elif args.command == "credential-status":
            result = usda_credential_status()
        elif args.command == "credential-revoke":
            result = revoke_usda_credential(confirm=args.confirm)
        elif args.command == "contract-set":
            result = set_storage_contract(load_json(args.input), confirm=args.confirm)
        elif args.command == "contract-show":
            result = show_storage_contract()
        elif args.command == "contract-clear":
            result = clear_storage_contract(confirm=args.confirm)
        elif args.command == "provider-fetch":
            result = ProviderClient(budget=args.budget).execute(
                load_json(args.input), force_refresh=args.force_refresh
            )
        elif args.command == "normalize-usda":
            result = normalize_usda_record(load_json(args.input), args.amount_g)
        elif args.command == "normalize-off":
            result = normalize_off_record(load_json(args.input), args.amount_g)
        elif args.command == "image-digest":
            result = image_digest(args.image)
        elif args.command == "record-build":
            result = build_meal_record(load_json(args.input), entry_id=args.entry_id)
            write_output(args.output, result)
            return 0
        elif args.command == "record-bind-image":
            result = bind_drive_image(
                load_json(args.record), args.drive_file_id, args.drive_url
            )
            write_output(args.output, result)
            return 0
        elif args.command == "sheet-batch":
            contract = load_json(args.contract) if args.contract else show_storage_contract()
            result = build_sheet_batch(load_json(args.record), contract)
            write_output(args.output, result)
            return 0
        elif args.command == "journal-create":
            contract = load_json(args.contract) if args.contract else show_storage_contract()
            result = create_journal(load_json(args.record), contract)
        elif args.command == "journal-show":
            result = show_journal(args.entry_id)
        elif args.command == "journal-transition":
            result = transition_journal(
                args.entry_id,
                args.state,
                drive_file_id=args.drive_file_id,
                drive_url=args.drive_url,
                sheet_batch_digest=args.sheet_batch_digest,
                failure=args.failure,
            )
        else:
            raise TrackerError("invalid_input", "unsupported command")
        print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
        return 0
    except TrackerError as error:
        print(json.dumps(error.payload(), ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
