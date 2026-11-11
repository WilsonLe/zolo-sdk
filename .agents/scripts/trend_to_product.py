#!/usr/bin/env python3
"""Dependency-free project artifact manager for Trend to Product."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
DEFAULT_ROOT = Path("artifacts/trend-to-product")
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
PROHIBITED_KEYS = {
    "access_token", "api_key", "authorization", "browser_profile", "cookie",
    "cookies", "device_id", "password", "raw_headers", "refresh_token",
    "session_id", "signed_url", "token",
}


class TrendError(RuntimeError):
    """Stable, sanitized workflow failure."""

    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def output(payload: object) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))


def load(path: Path) -> Any:
    try:
        if path.is_symlink() or not path.is_file():
            raise TrendError("invalid_input", "input must be a regular file")
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise TrendError("invalid_input", f"invalid JSON at line {error.lineno}") from error
    except OSError as error:
        raise TrendError("invalid_input", "input cannot be read") from error


def dump(path: Path, payload: object, *, exclusive: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    if exclusive:
        try:
            with path.open("x", encoding="utf-8") as handle:
                handle.write(data)
        except FileExistsError as error:
            raise TrendError("immutable_collision", "record already exists") from error
    else:
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temporary.write_text(data, encoding="utf-8")
        temporary.replace(path)


def validate_id(value: str, label: str) -> str:
    if not SAFE_ID.fullmatch(value):
        raise TrendError("invalid_input", f"{label} is invalid")
    return value


def scan_prohibited(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = key.lower().replace("-", "_")
            if normalized in PROHIBITED_KEYS:
                raise TrendError("prohibited_data", f"prohibited field at {path}.{key}")
            scan_prohibited(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            scan_prohibited(child, f"{path}[{index}]")


def validate_record(record: Any, expected: str | None = None) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise TrendError("schema_failure", "record must be an object")
    scan_prohibited(record)
    if record.get("schema_version") != SCHEMA_VERSION:
        raise TrendError("schema_failure", "schema_version must be 1")
    kind = record.get("record_type")
    if not isinstance(kind, str) or (expected and kind != expected):
        raise TrendError("schema_failure", "record_type is invalid")
    for field in ("limitations",):
        if field in record and (
            not isinstance(record[field], list)
            or not all(isinstance(item, str) for item in record[field])
        ):
            raise TrendError("schema_failure", f"{field} must be a string list")
    if kind == "evidence":
        required = ("evidence_id", "source_id", "observed_at", "signal_type", "metrics", "limitations")
        if any(field not in record for field in required):
            raise TrendError("schema_failure", "evidence is incomplete")
        if not isinstance(record["metrics"], list):
            raise TrendError("schema_failure", "evidence metrics must be a list")
        for metric in record["metrics"]:
            required_metric = {"name", "value", "unit", "window", "measurement_type"}
            if not isinstance(metric, dict) or not required_metric.issubset(metric):
                raise TrendError("schema_failure", "evidence metric is incomplete")
            if metric["measurement_type"] not in {"observed", "calculated", "inferred"}:
                raise TrendError("schema_failure", "measurement_type is invalid")
            if not isinstance(metric["value"], (int, float)):
                raise TrendError("schema_failure", "metric value must be numeric")
    return record


def resolve_project(project: str, *, require: bool = True) -> tuple[Path, Path]:
    root = Path(project).expanduser().resolve()
    if not root.is_dir():
        raise TrendError("project_path_failure", "project must be an existing directory")
    contract_path = root / DEFAULT_ROOT / "contract.json"
    if require:
        contract = validate_record(load(contract_path), "project")
        relative = Path(contract["artifact_root"])
        if relative.is_absolute() or ".." in relative.parts:
            raise TrendError("project_path_failure", "artifact root is unsafe")
        artifact = (root / relative).resolve()
    else:
        artifact = (root / DEFAULT_ROOT).resolve()
    try:
        artifact.relative_to(root)
    except ValueError as error:
        raise TrendError("project_path_failure", "artifact root escapes project") from error
    cursor = root
    for part in artifact.relative_to(root).parts:
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise TrendError("project_path_failure", "artifact path contains a symlink")
    return root, artifact


def collection(artifact: Path, kind: str) -> Path:
    return artifact / kind


def manifest_for(directory: Path) -> dict[str, Any]:
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_file() and not path.is_symlink() and path.name != "manifest.json":
            files.append({
                "path": path.relative_to(directory).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
            })
    return {
        "schema_version": 1, "record_type": "manifest",
        "created_at": now(), "files": files, "limitations": [],
    }


def project_init(args: argparse.Namespace) -> dict[str, Any]:
    root = Path(args.project).expanduser().resolve()
    if not root.is_dir():
        raise TrendError("project_path_failure", "project must be an existing directory")
    relative = Path(args.artifact_root)
    if relative.is_absolute() or ".." in relative.parts:
        raise TrendError("project_path_failure", "artifact root must be project-relative")
    artifact = (root / relative).resolve()
    try:
        artifact.relative_to(root)
    except ValueError as error:
        raise TrendError("project_path_failure", "artifact root escapes project") from error
    if artifact.exists() and any(artifact.iterdir()):
        raise TrendError("immutable_collision", "artifact root is not empty")
    artifact.mkdir(parents=True, exist_ok=True)
    for directory_name in ("audiences", "sources/registry", "tracking", "runs", "failed-runs"):
        (artifact / directory_name).mkdir(parents=True, exist_ok=True)
    contract = {
        "schema_version": 1, "record_type": "project",
        "project_id": hashlib.sha256(str(root).encode()).hexdigest()[:16],
        "artifact_root": relative.as_posix(), "git_policy": args.git_policy,
        "trend_weights": {
            "momentum": 20, "cross_platform_spread": 15, "target_relevance": 10,
            "remixability": 10, "product_visual_suitability": 15,
            "shopping_intent": 10, "competition_gap": 10,
            "useful_lifespan": 5, "evidence_quality": 5,
        },
        "product_fit_weights": {
            "audience_resonance": 15, "recognizability": 15,
            "product_context": 15, "commercial_gap": 15, "margin": 10,
            "manufacturability": 10, "speed": 10, "extensibility": 5,
            "testability": 5,
        },
        "created_at": now(), "limitations": [],
    }
    dump(artifact / "contract.json", contract, exclusive=True)
    reindex_artifact(artifact)
    return {"status": "initialized", "project": str(root), "artifact_root": str(artifact)}


def audience_create(args: argparse.Namespace, *, revision: bool = False) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    record = validate_record(load(Path(args.input)), "audience")
    audience_id = validate_id(record["audience_id"], "audience_id")
    root = collection(artifact, "audiences") / audience_id / "revisions"
    existing = sorted(root.glob("*.json"))
    number = len(existing) + 1
    if not revision and existing:
        raise TrendError("immutable_collision", "audience already exists; use audience-revise")
    record = {**record, "revision": number, "created_at": now()}
    dump(root / f"{number:04d}.json", record, exclusive=True)
    return {"audience_id": audience_id, "revision": number}


def source_write(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    record = validate_record(load(Path(args.input)), "source")
    source_id = validate_id(record["source_id"], "source_id")
    operations = record.get("permitted_operations", [])
    if operations != ["read"]:
        raise TrendError("prohibited_data", "sources must declare read-only operation")
    record = {**record, "status": "configured", "configured_at": now()}
    dump(collection(artifact, "sources/registry") / f"{source_id}.json", record, exclusive=True)
    return {"source_id": source_id, "status": "configured"}


def source_state(args: argparse.Namespace, status: str) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    source_id = validate_id(args.source_id, "source_id")
    path = collection(artifact, "sources/registry") / f"{source_id}.json"
    record = validate_record(load(path), "source")
    record.update({"status": status, "updated_at": now()})
    dump(path, record)
    return {"source_id": source_id, "status": status}


def normalize_items(source_id: str, payload: Any, observed_at: str) -> list[dict[str, Any]]:
    items = payload if isinstance(payload, list) else payload.get("records", [])
    if not isinstance(items, list):
        raise TrendError("parse_failure", "import must contain a record list")
    normalized = []
    seen = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise TrendError("parse_failure", "import row must be an object")
        digest = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
        identity = str(item.get("source_item_id") or item.get("url") or digest)
        if identity in seen:
            continue
        seen.add(identity)
        metric = item.get("metric")
        metrics = item.get("metrics", [])
        if metric is not None:
            metrics = [{"name": "signal", "value": metric, "unit": "index", "window": "P1D", "measurement_type": "observed"}]
        record = {
            "schema_version": 1, "record_type": "evidence",
            "evidence_id": f"ev-{digest[:16]}", "source_id": source_id,
            "source_class": item.get("source_class", "user_supplied"),
            "observed_at": item.get("observed_at", observed_at),
            "published_at": item.get("published_at"),
            "market": item.get("market", "unknown"),
            "region_status": item.get("region_status", "unknown"),
            "languages": item.get("languages", []),
            "signal_type": item.get("signal_type", "supplied_evidence"),
            "topic_entities": item.get("topic_entities", []),
            "metrics": metrics, "source_url": item.get("url"),
            "source_item_id": item.get("source_item_id"),
            "summary": item.get("summary", ""), "content_digest": f"sha256:{digest}",
            "confidence": item.get("confidence", "unknown"),
            "rights_status": item.get("rights_status", "metadata_and_summary_only"),
            "personal_data_status": "none_retained",
            "limitations": item.get("limitations", ["User-supplied evidence; representativeness not established"]),
        }
        validate_record(record, "evidence")
        normalized.append(record)
    return normalized


def source_import(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    source_id = validate_id(args.source_id, "source_id")
    source = validate_record(load(collection(artifact, "sources/registry") / f"{source_id}.json"), "source")
    if source.get("status") != "ready":
        raise TrendError("source_not_ready", "source must be enabled before import")
    input_path = Path(args.input)
    if input_path.suffix.lower() == ".csv":
        with input_path.open(encoding="utf-8", newline="") as handle:
            payload = list(csv.DictReader(handle))
    elif input_path.suffix.lower() == ".ndjson":
        payload = [json.loads(line) for line in input_path.read_text().splitlines() if line.strip()]
    else:
        payload = load(input_path)
    records = normalize_items(source_id, payload, args.observed_at or now())
    return {"source_id": source_id, "accepted": len(records), "records": records}


def tracking_create(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    tracking_id = validate_id(args.tracking_id, "tracking_id")
    record = {
        "schema_version": 1, "record_type": "tracking",
        "tracking_id": tracking_id, "audience_id": validate_id(args.audience_id, "audience_id"),
        "cadence": args.cadence, "status": "configured",
        "scheduler_id": None, "created_at": now(), "limitations": [],
    }
    dump(collection(artifact, "tracking") / f"{tracking_id}.json", record, exclusive=True)
    return record


def tracking_bind(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    path = collection(artifact, "tracking") / f"{validate_id(args.tracking_id, 'tracking_id')}.json"
    record = validate_record(load(path), "tracking")
    record.update({"scheduler_id": args.scheduler_id, "status": "active", "updated_at": now()})
    dump(path, record)
    return record


def score(values: dict[str, Any], weights: dict[str, int]) -> tuple[int, dict[str, int]]:
    components = {}
    total = 0
    for name, weight in weights.items():
        raw = values.get(name)
        if not isinstance(raw, (int, float)) or not 0 <= raw <= 1:
            raise TrendError("schema_failure", f"score {name} must be between 0 and 1")
        points = round(raw * weight)
        components[name] = points
        total += points
    return total, components


def run_create(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    tracking = validate_record(load(collection(artifact, "tracking") / f"{validate_id(args.tracking_id, 'tracking_id')}.json"), "tracking")
    payload = load(Path(args.input))
    scan_prohibited(payload)
    if not isinstance(payload, dict):
        raise TrendError("schema_failure", "run input must be an object")
    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    validate_id(run_id.lower(), "run_id")
    date_path = datetime.now(timezone.utc).strftime("%Y/%m/%d")
    final = collection(artifact, "runs") / date_path / run_id
    if final.exists():
        raise TrendError("immutable_collision", "run already exists")
    temporary_parent = collection(artifact, "runs") / ".in-progress"
    temporary_parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f"{run_id}-", dir=temporary_parent))
    try:
        request = {
            "schema_version": 1, "record_type": "request", "run_id": run_id,
            "tracking_id": tracking["tracking_id"], "audience_id": tracking["audience_id"],
            "trigger_type": args.trigger_type, "scheduler_id": tracking.get("scheduler_id"),
            "created_at": now(), "limitations": payload.get("limitations", []),
        }
        dump(temporary / "request.json", request)
        evidence = [validate_record(item, "evidence") for item in payload.get("evidence", [])]
        (temporary / "evidence.ndjson").write_text(
            "".join(json.dumps(item, sort_keys=True) + "\n" for item in evidence),
            encoding="utf-8",
        )
        contract = validate_record(load(artifact / "contract.json"), "project")
        trends = payload.get("trends", [])
        for trend in trends:
            trend["schema_version"] = 1
            trend["record_type"] = "trend"
            trend["score"], trend["score_components"] = score(trend.pop("score_inputs"), contract["trend_weights"])
            trend["decision"] = (
                "launch_candidate" if trend["score"] >= 80
                else "design_test" if trend["score"] >= 70
                else "watch" if trend["score"] >= 60
                else "ignore"
            )
            trend.setdefault("limitations", [])
        opportunities = payload.get("opportunities", [])
        for opportunity in opportunities:
            opportunity["schema_version"] = 1
            opportunity["record_type"] = "opportunity"
            hard_gates = opportunity.get("hard_gates", {})
            required_gates = {
                "rights", "likeness", "sensitive_topic", "known_margin",
                "manufacturable", "fulfilment",
            }
            opportunity["gate_status"] = (
                "blocked" if not required_gates.issubset(hard_gates)
                else "rejected" if any(hard_gates[name] is False for name in required_gates)
                else "passed"
            )
            opportunity["product_fit_score"], opportunity["score_components"] = score(
                opportunity.pop("score_inputs"), contract["product_fit_weights"]
            )
            opportunity.setdefault("limitations", [])
            opportunity["decision"] = (
                opportunity["gate_status"] if opportunity["gate_status"] != "passed"
                else "design_exploration" if opportunity["product_fit_score"] >= 80
                else "concept_test" if opportunity["product_fit_score"] >= 70
                else "do_not_generate"
            )
        dump(temporary / "trends.json", trends)
        dump(temporary / "opportunities.json", opportunities)
        dump(temporary / "concepts.json", payload.get("concepts", []))
        dump(temporary / "manifest.json", manifest_for(temporary))
        final.parent.mkdir(parents=True, exist_ok=True)
        temporary.replace(final)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    reindex_artifact(artifact)
    return {"run_id": run_id, "path": str(final), "evidence": len(evidence)}


def find_runs(artifact: Path) -> list[Path]:
    return sorted(path.parent for path in collection(artifact, "runs").glob("*/*/*/*/manifest.json"))


def verify_directory(directory: Path) -> dict[str, Any]:
    manifest = validate_record(load(directory / "manifest.json"), "manifest")
    for item in manifest.get("files", []):
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise TrendError("manifest_failure", "manifest path is unsafe")
        path = directory / relative
        if not path.is_file() or path.is_symlink():
            raise TrendError("manifest_failure", "manifest file is missing")
        if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise TrendError("manifest_failure", "artifact digest mismatch")
    return {"status": "verified", "path": str(directory), "files": len(manifest.get("files", []))}


def reindex_artifact(artifact: Path) -> dict[str, Any]:
    runs = []
    for directory in find_runs(artifact):
        request = load(directory / "request.json")
        runs.append({"run_id": request["run_id"], "tracking_id": request["tracking_id"], "path": str(directory.relative_to(artifact))})
    index = {"schema_version": 1, "record_type": "index", "updated_at": now(), "runs": runs, "limitations": []}
    dump(artifact / "index.json", index)
    return index


def list_records(artifact: Path, relative: str) -> list[Any]:
    return [load(path) for path in sorted((artifact / relative).glob("*.json"))]


def design_brief(args: argparse.Namespace) -> dict[str, Any]:
    _, artifact = resolve_project(args.project)
    run = next((path for path in find_runs(artifact) if path.name == args.run_id), None)
    if run is None:
        raise TrendError("unknown_run", "run does not exist")
    brief = validate_record(load(Path(args.input)), "design_brief")
    if brief.get("approval_status") != "approved":
        raise TrendError("approval_required", "design brief must be approved")
    concept_id = validate_id(brief["concept_id"], "concept_id")
    opportunity_id = validate_id(brief["opportunity_id"], "opportunity_id")
    opportunities = load(run / "opportunities.json")
    concepts = load(run / "concepts.json")
    if not any(item.get("opportunity_id") == opportunity_id for item in opportunities):
        raise TrendError("unknown_opportunity", "opportunity does not exist in the run")
    if not any(item.get("concept_id") == concept_id for item in concepts):
        raise TrendError("unknown_concept", "concept does not exist in the run")
    revision = str(brief.get("design_revision", 1)).zfill(4)
    target = run / "derived/designs" / concept_id / revision
    if target.exists():
        raise TrendError("immutable_collision", "design revision exists")
    target.mkdir(parents=True)
    dump(target / "brief.json", brief)
    dump(target / "production-readiness.json", {
        "schema_version": 1, "record_type": "concept",
        "status": "concept_only", "blockers": ["Image generation does not establish print readiness"],
        "created_at": now(), "limitations": [],
    })
    dump(target / "manifest.json", manifest_for(target))
    return {"concept_id": concept_id, "design_revision": revision, "path": str(target)}


def simple_read(args: argparse.Namespace, kind: str) -> object:
    _, artifact = resolve_project(args.project)
    if kind == "run-list":
        return reindex_artifact(artifact)
    if kind == "reindex":
        return reindex_artifact(artifact)
    if kind == "audience-list":
        return [{"audience_id": path.parent.parent.name, "revision": path.stem} for path in sorted((artifact / "audiences").glob("*/revisions/*.json"))]
    if kind == "source-list":
        return list_records(artifact, "sources/registry")
    if kind == "tracking-list":
        return list_records(artifact, "tracking")
    if kind == "validate":
        validate_record(load(artifact / "contract.json"), "project")
        return {"status": "valid", "artifact_root": str(artifact)}
    if kind in {"run-read", "latest"}:
        runs = find_runs(artifact)
        if not runs:
            raise TrendError("unknown_run", "no runs exist")
        run = runs[-1] if kind == "latest" else next((path for path in runs if path.name == args.run_id), None)
        if run is None:
            raise TrendError("unknown_run", "run does not exist")
        section = getattr(args, "section", None)
        if section:
            allowed = {"request", "trends", "opportunities", "concepts"}
            if section not in allowed:
                raise TrendError("invalid_input", "section is invalid")
            return load(run / f"{section}.json")
        return {"run_id": run.name, "path": str(run)}
    if kind == "verify":
        target = Path(args.path).resolve() if args.path else next((path for path in find_runs(artifact) if path.name == args.run_id), None)
        if target is None:
            raise TrendError("unknown_run", "run does not exist")
        return verify_directory(target)
    raise TrendError("unsupported_command", "command is not implemented")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    command = commands.add_parser("project-init")
    command.add_argument("--project", required=True)
    command.add_argument("--artifact-root", default=str(DEFAULT_ROOT))
    command.add_argument("--git-policy", choices=("tracked", "ignored", "mixed"), required=True)
    for name in ("audience-create", "audience-revise", "source-add", "design-brief"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
        command.add_argument("--input", required=True)
        if name == "design-brief":
            command.add_argument("--run-id", required=True)
    for name in ("audience-list", "source-list", "tracking-list", "run-list", "validate", "reindex"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
    for name in ("source-enable", "source-disable", "source-test", "source-status", "source-sample"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
        command.add_argument("--source-id", required=True)
    command = commands.add_parser("source-import")
    command.add_argument("--project", required=True)
    command.add_argument("--source-id", required=True)
    command.add_argument("--input", required=True)
    command.add_argument("--observed-at")
    command = commands.add_parser("tracking-create")
    command.add_argument("--project", required=True)
    command.add_argument("--tracking-id", required=True)
    command.add_argument("--audience-id", required=True)
    command.add_argument("--cadence", required=True)
    command = commands.add_parser("tracking-bind-automation")
    command.add_argument("--project", required=True)
    command.add_argument("--tracking-id", required=True)
    command.add_argument("--scheduler-id", required=True)
    command = commands.add_parser("run")
    command.add_argument("--project", required=True)
    command.add_argument("--tracking-id", required=True)
    command.add_argument("--input", required=True)
    command.add_argument("--run-id")
    command.add_argument("--trigger-type", choices=("manual", "automation"), default="manual")
    for name in ("run-read", "latest"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
        if name == "run-read":
            command.add_argument("--run-id", required=True)
        command.add_argument("--section", choices=("request", "trends", "opportunities", "concepts"))
    command = commands.add_parser("verify")
    command.add_argument("--project", required=True)
    command.add_argument("--run-id")
    command.add_argument("--path")
    for name in ("evidence-normalize", "opportunity-explain", "design-generate", "design-review", "design-readiness", "concept-packet", "launch-packet", "result-summary"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
    return root


def dispatch(args: argparse.Namespace) -> object:
    if args.command == "project-init":
        return project_init(args)
    if args.command == "audience-create":
        return audience_create(args)
    if args.command == "audience-revise":
        return audience_create(args, revision=True)
    if args.command == "source-add":
        return source_write(args)
    if args.command == "source-enable":
        return source_state(args, "ready")
    if args.command == "source-disable":
        return source_state(args, "disabled")
    if args.command in {"source-test", "source-sample", "source-status"}:
        _, artifact = resolve_project(args.project)
        record = validate_record(load(artifact / "sources/registry" / f"{validate_id(args.source_id, 'source_id')}.json"), "source")
        return {"source_id": args.source_id, "status": record["status"], "operation": args.command, "read_only": True}
    if args.command == "source-import":
        return source_import(args)
    if args.command == "tracking-create":
        return tracking_create(args)
    if args.command == "tracking-bind-automation":
        return tracking_bind(args)
    if args.command == "run":
        return run_create(args)
    if args.command == "design-brief":
        return design_brief(args)
    if args.command == "design-generate":
        return {"status": "image_capability_unavailable", "message": "Use the host image capability with an approved persisted brief"}
    if args.command in {"evidence-normalize", "opportunity-explain", "design-review", "design-readiness", "concept-packet", "launch-packet", "result-summary"}:
        raise TrendError("missing_input", f"{args.command} requires a persisted target in a future derived-artifact revision")
    return simple_read(args, args.command)


def main() -> int:
    try:
        output(dispatch(parser().parse_args()))
        return 0
    except TrendError as error:
        output({"status": "error", "category": error.category, "message": str(error)})
        return 2
    except (OSError, KeyError, TypeError, ValueError) as error:
        output({"status": "error", "category": "unexpected_input", "message": error.__class__.__name__})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
