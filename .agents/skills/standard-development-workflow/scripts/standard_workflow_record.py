#!/usr/bin/env python3
"""Validate and summarize Standard Development Workflow records."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SCHEMA_VERSION = 1
RECORD_KINDS = {"repository_profile", "task_run"}
APPLICABILITY_STATES = {"required", "optional", "not_applicable", "blocked"}
STEP_STATES = {
    "pending",
    "running",
    "passed",
    "failed",
    "skipped",
    "blocked",
}
OPERATION_STATES = {
    "planned",
    "running",
    "stalled",
    "failed",
    "cancelled",
    "completed_unverified",
    "verified",
}
FAILURE_CLASSES = {
    "product",
    "harness",
    "fixture_state",
    "environment",
    "platform_tooling",
    "external_dependency",
    "expected_behavior",
    "nondeterministic",
    "unknown",
}
CHANNEL_DECISIONS = {"primary", "equivalent", "partial", "diagnostic"}
RESOURCE_OWNERSHIP = {"task", "repository_shared", "host_shared", "external"}
COST_ORDER = {
    "integrity": 0,
    "static": 1,
    "focused": 2,
    "build": 3,
    "stateful": 4,
    "browser_manual": 5,
    "external": 6,
}
DELIVERABLE_STATES = {"required", "excluded", "unknown"}
DELIVERABLE_KINDS = {
    "outcome", "issue", "issue_first", "pull_request", "review", "merge",
    "deployment", "local_artifact", "explanation", "verification", "decision",
}
EXTERNAL_STATES = {"pending", "observed", "saved", "read_back", "flow_verified", "blocked"}
SOURCE_FAILURES = {
    "authentication_redirect", "permission", "stale_session", "unavailable_connector",
    "network", "unsupported_control", "other",
}
DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
SECRET_KEYS = {
    "api_key",
    "api_secret",
    "credential",
    "credential_value",
    "password",
    "secret",
    "token",
    "value",
}
SECRET_PATTERNS = (
    re.compile(r"\bgh[opusr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b", re.IGNORECASE),
    re.compile(r"https?://[^/\s:@]+:[^@\s/]+@", re.IGNORECASE),
)


class RecordError(ValueError):
    """A user-facing workflow-record validation failure."""


def canonical_bytes(value: Any) -> bytes:
    """Return canonical UTF-8 JSON with stable ordering and one final newline."""

    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def content_digest(value: Any) -> str:
    """Return the SHA-256 identity of canonical JSON."""

    return f"sha256:{hashlib.sha256(canonical_bytes(value)).hexdigest()}"


def file_digest(path: Path) -> str:
    """Return the SHA-256 digest for one regular file."""

    if not path.is_file() or path.is_symlink():
        raise RecordError(f"evidence path is not a regular file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def load_record(path: Path) -> dict[str, Any]:
    """Load one JSON object."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise RecordError(f"{path} is not valid UTF-8 JSON: {error}") from error
    if not isinstance(payload, dict):
        raise RecordError("workflow record must be a JSON object")
    return payload


def require_object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RecordError(f"{path} must be an object")
    return value


def require_list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        raise RecordError(f"{path} must be an array")
    return value


def require_text(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RecordError(f"{path} must be non-empty text")
    return value


def require_choice(value: Any, choices: set[str], path: str) -> str:
    if not isinstance(value, str) or value not in choices:
        raise RecordError(f"{path} has unsupported value")
    return value


def require_keys(payload: dict[str, Any], keys: set[str], path: str) -> None:
    missing = sorted(keys - payload.keys())
    if missing:
        raise RecordError(f"{path} is missing required keys: {', '.join(missing)}")


def reconcile_delivery_contract(contract_value: Any, update_value: Any) -> dict[str, Any]:
    """Apply one explicit correction without discarding unrelated requirements."""

    contract = json.loads(json.dumps(require_object(contract_value, "delivery_contract")))
    update = require_object(update_value, "contract update")
    require_keys(update, {"id", "kind", "target", "proof_source", "state", "authority", "source_ref"}, "contract update")
    requirement_id = require_text(update["id"], "contract update.id")
    require_choice(update["kind"], DELIVERABLE_KINDS, "contract update.kind")
    require_choice(update["state"], DELIVERABLE_STATES, "contract update.state")
    require_choice(update["authority"], {"explicit", "inferred"}, "contract update.authority")
    require_text(update["source_ref"], "contract update.source_ref")
    require_text(update["target"], "contract update.target")
    require_text(update["proof_source"], "contract update.proof_source")
    requirements = require_list(contract.get("requirements"), "delivery_contract.requirements")
    changes = require_list(contract.get("changes"), "delivery_contract.changes")
    existing = next((item for item in requirements if item.get("id") == requirement_id), None)
    if existing and existing["authority"] == "explicit" and update["authority"] == "inferred":
        raise RecordError("an inferred update cannot override an explicit user requirement")
    if existing and existing["kind"] != update["kind"]:
        raise RecordError("contract update cannot change a requirement kind")
    previous_state = existing["state"] if existing else None
    previous_target = existing["target"] if existing else None
    if (existing and previous_state == update["state"]
            and existing["authority"] == update["authority"]
            and previous_target == update["target"]
            and existing["proof_source"] == update["proof_source"]):
        return contract
    item = existing if existing else {"id": requirement_id, "kind": update["kind"]}
    item.update({
        "state": update["state"], "authority": update["authority"],
        "target": update["target"], "proof_source": update["proof_source"],
        "source_ref": update["source_ref"],
        "status": "not_applicable" if update["state"] == "excluded" else "pending",
        "evidence_ref": "",
    })
    if existing is None:
        requirements.append(item)
    changes.append({
        "sequence": len(changes) + 1, "id": requirement_id,
        "previous_state": previous_state, "new_state": update["state"],
        "previous_target": previous_target, "new_target": update["target"],
        "authority": update["authority"], "source_ref": update["source_ref"],
    })
    return contract


def validate_delivery_contract(value: Any, *, require_final: bool) -> None:
    contract = require_object(value, "delivery_contract")
    require_keys(contract, {"requirements", "changes"}, "delivery_contract")
    requirements: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(require_list(contract["requirements"], "delivery_contract.requirements")):
        item = require_object(raw, f"delivery_contract.requirements[{index}]")
        require_keys(item, {"id", "kind", "target", "proof_source", "state", "authority", "source_ref", "status", "evidence_ref"}, "delivery requirement")
        item_id = require_text(item["id"], "delivery requirement.id")
        if item_id in requirements:
            raise RecordError(f"duplicate delivery requirement: {item_id}")
        require_choice(item["kind"], DELIVERABLE_KINDS, f"delivery requirement {item_id}.kind")
        require_choice(item["state"], DELIVERABLE_STATES, f"delivery requirement {item_id}.state")
        require_choice(item["authority"], {"explicit", "inferred"}, f"delivery requirement {item_id}.authority")
        require_text(item["source_ref"], f"delivery requirement {item_id}.source_ref")
        require_text(item["target"], f"delivery requirement {item_id}.target")
        require_text(item["proof_source"], f"delivery requirement {item_id}.proof_source")
        require_choice(item["status"], {"pending", "complete", "blocked", "not_applicable"}, f"delivery requirement {item_id}.status")
        if item["state"] == "excluded" and item["status"] != "not_applicable":
            raise RecordError(f"excluded delivery requirement {item_id} cannot be performed")
        if item["status"] == "complete":
            require_text(item["evidence_ref"], f"delivery requirement {item_id}.evidence_ref")
        if require_final and item["state"] == "required" and item["status"] != "complete":
            raise RecordError(f"required delivery requirement {item_id} is incomplete")
        requirements[item_id] = item
    if require_final and not requirements:
        raise RecordError("final delivery contract has no outcome or deliverables")
    replayed: dict[str, tuple[str, str, str]] = {}
    for sequence, raw in enumerate(require_list(contract["changes"], "delivery_contract.changes"), 1):
        change = require_object(raw, f"delivery_contract.changes[{sequence - 1}]")
        require_keys(change, {"sequence", "id", "previous_state", "new_state", "previous_target", "new_target", "authority", "source_ref"}, "delivery change")
        change_id = require_text(change["id"], "delivery change.id")
        if change["sequence"] != sequence or change_id not in requirements:
            raise RecordError("delivery changes have invalid sequence or requirement id")
        require_choice(change["new_state"], DELIVERABLE_STATES, "delivery change.new_state")
        require_choice(change["authority"], {"explicit", "inferred"}, "delivery change.authority")
        require_text(change["source_ref"], "delivery change.source_ref")
        previous = replayed.get(change["id"])
        if change["previous_state"] != (previous[0] if previous else None):
            raise RecordError("delivery changes do not replay from the prior state")
        if change["previous_target"] != (previous[2] if previous else None):
            raise RecordError("delivery changes do not replay from the prior target")
        if previous and previous[1] == "explicit" and change["authority"] == "inferred":
            raise RecordError("delivery changes downgrade an explicit user requirement")
        require_text(change["new_target"], "delivery change.new_target")
        replayed[change["id"]] = (change["new_state"], change["authority"], change["new_target"])
    latest = {change["id"]: change for change in contract["changes"]}
    for item_id, change in latest.items():
        if (requirements[item_id]["state"] != change["new_state"]
                or requirements[item_id]["authority"] != change["authority"]
                or requirements[item_id]["target"] != change["new_target"]):
            raise RecordError(f"delivery requirement {item_id} disagrees with its latest change")
    if require_final and any(item["state"] == "unknown" for item in requirements.values()):
        raise RecordError("unresolved delivery requirements prevent final evidence")


def validate_plan_comment(
    plan_value: Any,
    *,
    issue_url: str,
    source_revision: str,
    task_status: str,
) -> None:
    plan = require_object(plan_value, "task.plan")
    require_keys(
        plan,
        {
            "comment_id",
            "comment_url",
            "marker",
            "pinned",
            "pinned_at",
            "canonical_comment_count",
            "last_reconciled_at",
            "reconciled_revision",
            "state",
            "findings_count",
        },
        "task.plan",
    )
    if isinstance(plan["comment_id"], bool) or not isinstance(plan["comment_id"], int):
        raise RecordError("task.plan.comment_id must be a positive integer")
    if plan["comment_id"] < 1:
        raise RecordError("task.plan.comment_id must be a positive integer")
    comment_url = require_text(plan["comment_url"], "task.plan.comment_url")
    expected_url = (
        f"{issue_url.rstrip('/')}#issuecomment-{plan['comment_id']}"
    )
    if comment_url != expected_url:
        raise RecordError("task.plan.comment_url does not belong to the task issue")
    if plan["marker"] != "<!-- standard-development-plan -->":
        raise RecordError("task.plan.marker is not the canonical plan marker")
    if plan["pinned"] is not True:
        raise RecordError("task.plan must be pinned")
    require_text(plan["pinned_at"], "task.plan.pinned_at")
    if plan["canonical_comment_count"] != 1:
        raise RecordError("task.plan requires exactly one canonical plan comment")
    require_text(plan["last_reconciled_at"], "task.plan.last_reconciled_at")
    if plan["reconciled_revision"] != source_revision:
        raise RecordError("task.plan is stale for the current source revision")
    if plan["state"] not in {
        "awaiting_approval",
        "approved",
        "reapproval_required",
        "implemented",
    }:
        raise RecordError("task.plan.state is unsupported")
    if (
        isinstance(plan["findings_count"], bool)
        or not isinstance(plan["findings_count"], int)
        or plan["findings_count"] < 0
    ):
        raise RecordError("task.plan.findings_count must be a non-negative integer")
    if task_status not in {"planned", "blocked"} and plan["state"] not in {
        "approved",
        "implemented",
    }:
        raise RecordError("execution requires an approved canonical plan comment")


def reject_secrets(value: Any, path: str = "$") -> None:
    """Reject credential-bearing fields and common secret-shaped values."""

    if isinstance(value, dict):
        for key, nested in value.items():
            if key.lower() in SECRET_KEYS:
                raise RecordError(f"{path}.{key} is a prohibited secret-bearing field")
            reject_secrets(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            reject_secrets(nested, f"{path}[{index}]")
    elif isinstance(value, str):
        for pattern in SECRET_PATTERNS:
            if pattern.search(value):
                raise RecordError(f"{path} appears to contain a secret value")


def validate_evidence_sources(
    sources: Any,
    *,
    source_root: Path | None,
) -> None:
    identifiers: set[str] = set()
    for index, source_value in enumerate(require_list(sources, "provenance.sources")):
        source = require_object(source_value, f"provenance.sources[{index}]")
        require_keys(
            source,
            {"id", "kind", "location", "digest", "freshness", "checked_at"},
            f"provenance.sources[{index}]",
        )
        source_id = require_text(source["id"], f"provenance.sources[{index}].id")
        if source_id in identifiers:
            raise RecordError(f"duplicate provenance source id: {source_id}")
        identifiers.add(source_id)
        digest = require_text(
            source["digest"], f"provenance.sources[{index}].digest"
        )
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise RecordError(
                f"provenance.sources[{index}].digest must be a SHA-256 identity"
            )
        freshness = source["freshness"]
        if freshness not in {"revision_bound", "transient"}:
            raise RecordError(
                f"provenance.sources[{index}].freshness is not supported"
            )
        if freshness == "transient":
            require_text(
                source.get("expires_at"),
                f"provenance.sources[{index}].expires_at",
            )
        if source_root is not None and source["kind"] == "repository_file":
            location = Path(
                require_text(
                    source["location"], f"provenance.sources[{index}].location"
                )
            )
            if location.is_absolute() or ".." in location.parts:
                raise RecordError(
                    f"provenance.sources[{index}].location must be repository-relative"
                )
            resolved_root = source_root.resolve()
            resolved_source = (resolved_root / location).resolve()
            if not resolved_source.is_relative_to(resolved_root):
                raise RecordError(
                    f"provenance source escapes the repository: {source['location']}"
                )
            if file_digest(resolved_source) != digest:
                raise RecordError(
                    f"provenance source drifted: {source['location']}"
                )


def validate_applicability(value: Any) -> None:
    capabilities = require_object(value, "applicability")
    if not capabilities:
        raise RecordError("applicability must contain at least one capability")
    for name, capability_value in capabilities.items():
        capability = require_object(capability_value, f"applicability.{name}")
        require_keys(capability, {"state", "reason", "evidence_refs"}, f"applicability.{name}")
        if capability["state"] not in APPLICABILITY_STATES:
            raise RecordError(f"applicability.{name}.state is not supported")
        require_text(capability["reason"], f"applicability.{name}.reason")
        refs = require_list(
            capability["evidence_refs"], f"applicability.{name}.evidence_refs"
        )
        if capability["state"] in {"required", "optional"} and not refs:
            raise RecordError(
                f"applicability.{name} requires repository or user evidence"
            )


def validate_scope(scope_value: Any) -> None:
    scope = require_object(scope_value, "scope")
    require_keys(
        scope,
        {
            "direct",
            "enabling",
            "follow_up",
            "prohibited",
            "change_envelope",
            "expansion",
        },
        "scope",
    )
    for key in (
        "direct",
        "enabling",
        "follow_up",
        "prohibited",
        "change_envelope",
    ):
        require_list(scope[key], f"scope.{key}")
    for index, enabling_value in enumerate(scope["enabling"]):
        enabling = require_object(enabling_value, f"scope.enabling[{index}]")
        require_keys(
            enabling,
            {"change", "inseparability_evidence"},
            f"scope.enabling[{index}]",
        )
        require_text(
            enabling["inseparability_evidence"],
            f"scope.enabling[{index}].inseparability_evidence",
        )
    expansion = require_object(scope["expansion"], "scope.expansion")
    require_keys(expansion, {"triggered", "reasons", "approval_state"}, "scope.expansion")
    require_list(expansion["reasons"], "scope.expansion.reasons")
    if expansion["triggered"] and expansion["approval_state"] != "revised_approved":
        raise RecordError(
            "material scope expansion blocks implementation until revised approval"
        )


def validate_impact_inventory(
    value: Any,
    *,
    evidence_status: str,
    valid_verification_refs: set[str],
) -> None:
    """Keep pattern-wide work tied to every discovered surface and final proof."""

    inventory = require_object(value, "impact_inventory")
    require_keys(
        inventory,
        {"pattern_wide", "discovery_evidence_refs", "discovered_surface_ids", "surfaces"},
        "impact_inventory",
    )
    if not isinstance(inventory["pattern_wide"], bool):
        raise RecordError("impact_inventory.pattern_wide must be boolean")
    discovery_refs = require_list(
        inventory["discovery_evidence_refs"], "impact_inventory.discovery_evidence_refs"
    )
    if any(not isinstance(ref, str) or not ref.strip() for ref in discovery_refs):
        raise RecordError("impact_inventory discovery evidence must be non-empty text")
    discovered = require_list(
        inventory["discovered_surface_ids"], "impact_inventory.discovered_surface_ids"
    )
    if len(discovered) != len(set(discovered)) or any(
        not isinstance(item, str) or not item.strip() for item in discovered
    ):
        raise RecordError("impact_inventory discovered surface IDs must be unique text")
    surfaces = require_list(inventory["surfaces"], "impact_inventory.surfaces")
    if inventory["pattern_wide"] and (not discovery_refs or not discovered):
        raise RecordError("pattern-wide work requires discovery evidence and surfaces")
    if not inventory["pattern_wide"] and (discovered or surfaces):
        raise RecordError("impact_inventory surfaces require pattern_wide=true")
    included = 0
    surface_ids: list[str] = []
    for index, item in enumerate(surfaces):
        surface = require_object(item, f"impact_inventory.surfaces[{index}]")
        require_keys(
            surface,
            {"id", "kind", "decision", "reason", "shared_point", "verification_refs"},
            f"impact_inventory.surfaces[{index}]",
        )
        surface_id = require_text(surface["id"], f"impact_inventory.surfaces[{index}].id")
        surface_ids.append(surface_id)
        require_text(surface["kind"], f"impact_inventory.surfaces[{index}].kind")
        require_text(surface["reason"], f"impact_inventory.surfaces[{index}].reason")
        if surface["decision"] not in {"included", "excluded"}:
            raise RecordError(f"surface {surface_id} has unsupported decision")
        if not isinstance(surface["shared_point"], str):
            raise RecordError(f"surface {surface_id} shared_point must be text")
        refs = require_list(
            surface["verification_refs"],
            f"impact_inventory.surfaces[{index}].verification_refs",
        )
        if any(not isinstance(ref, str) or not ref.strip() for ref in refs):
            raise RecordError(f"surface {surface_id} verification refs must be text")
        if surface["decision"] == "included":
            included += 1
            if evidence_status == "final" and not refs:
                raise RecordError(f"included surface {surface_id} lacks final verification")
            if not set(refs).issubset(valid_verification_refs):
                raise RecordError(f"surface {surface_id} references unknown verification")
    if set(surface_ids) != set(discovered) or len(surface_ids) != len(discovered):
        raise RecordError("impact_inventory omits or duplicates a discovered surface")
    if inventory["pattern_wide"] and not included:
        raise RecordError("pattern-wide work has no included surface")


def validate_diagnostics(
    value: Any, *, included_surface_ids: set[str] | None = None,
) -> None:
    """Reject invented root-cause certainty and unsafely specified trace records."""

    incidents = require_list(value, "diagnostics")
    seen: set[str] = set()
    for index, item in enumerate(incidents):
        incident = require_object(item, f"diagnostics[{index}]")
        require_keys(
            incident,
            {
                "id", "symptom", "target_environment", "running_revision",
                "trace_state", "operation", "missing_trace_reason", "correlation_id",
                "first_evidence_ref", "root_cause_state", "root_cause_evidence_refs",
                "reproduction_ref", "resolution_state", "remedy_verification_ref",
                "trace_policy",
            },
            f"diagnostics[{index}]",
        )
        incident_id = require_text(incident["id"], f"diagnostics[{index}].id")
        if incident_id in seen:
            raise RecordError("diagnostic IDs must be unique")
        seen.add(incident_id)
        if "affected_surface_ids" in incident:
            affected = require_list(
                incident["affected_surface_ids"],
                f"diagnostics[{index}].affected_surface_ids",
            )
            if not affected or any(not isinstance(item, str) or not item.strip() for item in affected):
                raise RecordError("affected_surface_ids must contain non-empty text IDs")
            if len(affected) != len(set(affected)):
                raise RecordError("affected_surface_ids must contain unique IDs")
            if included_surface_ids is None:
                raise RecordError("cause-family coverage requires an impact inventory")
            if not set(affected).issubset(included_surface_ids):
                raise RecordError("diagnosed affected surface is omitted or excluded from inventory")
        require_text(incident["symptom"], f"diagnostics[{index}].symptom")
        require_text(
            incident["target_environment"], f"diagnostics[{index}].target_environment"
        )
        require_text(incident["running_revision"], f"diagnostics[{index}].running_revision")
        if incident["trace_state"] == "available":
            for field in ("operation", "correlation_id", "first_evidence_ref"):
                require_text(incident[field], f"diagnostics[{index}].{field}")
        elif incident["trace_state"] == "missing":
            require_text(
                incident["missing_trace_reason"],
                f"diagnostics[{index}].missing_trace_reason",
            )
            if incident["root_cause_state"] == "proven":
                raise RecordError("missing trace cannot prove the exact root cause")
        else:
            raise RecordError(f"diagnostic {incident_id} has unsupported trace state")
        if incident["root_cause_state"] not in {"proven", "unproven"}:
            raise RecordError(f"diagnostic {incident_id} has unsupported root-cause state")
        refs = require_list(
            incident["root_cause_evidence_refs"],
            f"diagnostics[{index}].root_cause_evidence_refs",
        )
        if any(not isinstance(ref, str) or not ref.strip() for ref in refs):
            raise RecordError(f"diagnostic {incident_id} evidence refs must be text")
        if incident["root_cause_state"] == "proven":
            if not refs:
                raise RecordError(f"diagnostic {incident_id} lacks root-cause evidence")
            require_text(
                incident["reproduction_ref"], f"diagnostics[{index}].reproduction_ref"
            )
        if incident["resolution_state"] not in {"open", "mitigated", "fixed", "blocked"}:
            raise RecordError(f"diagnostic {incident_id} has unsupported resolution state")
        if incident["resolution_state"] == "fixed" and incident["root_cause_state"] != "proven":
            raise RecordError(f"diagnostic {incident_id} cannot be fixed with unproven cause")
        if incident["resolution_state"] in {"mitigated", "fixed"}:
            require_text(
                incident["remedy_verification_ref"],
                f"diagnostics[{index}].remedy_verification_ref",
            )
        policy = require_object(incident["trace_policy"], f"diagnostics[{index}].trace_policy")
        require_keys(
            policy,
            {"redaction", "retention_seconds", "access", "collection_basis"},
            "trace_policy",
        )
        for field in ("redaction", "access", "collection_basis"):
            require_text(policy[field], f"diagnostics[{index}].trace_policy.{field}")
        retention = policy["retention_seconds"]
        if isinstance(retention, bool) or not isinstance(retention, int) or retention <= 0:
            raise RecordError("trace_policy.retention_seconds must be a positive limit")


def validate_release_readback(value: Any) -> None:
    """Prevent an unverified deployment or stale process from being called available."""

    readback = require_object(value, "release_readback")
    require_keys(
        readback,
        {
            "state", "target_surface", "intended_revision", "active_revision",
            "expected_mode", "active_mode", "target_url", "observed_at",
            "live_evidence_ref", "health", "user_flow", "public_reachable",
            "process_handle", "handle_state", "merged_revision", "artifact_digest",
            "deployment_id", "configuration_identity",
        },
        "release_readback",
    )
    if readback["state"] not in {
        "not_requested", "pr_open", "merged", "deployed_unverified", "available", "blocked"
    }:
        raise RecordError("release_readback.state is unsupported")
    if readback["state"] != "available":
        return
    for field in (
        "target_surface", "intended_revision", "active_revision", "target_url",
        "observed_at", "live_evidence_ref",
    ):
        require_text(readback[field], f"release_readback.{field}")
    if readback["active_revision"] != readback["intended_revision"]:
        raise RecordError("available runtime revision differs from intended revision")
    if readback["merged_revision"] and readback["intended_revision"] != readback["merged_revision"]:
        raise RecordError("available runtime is not bound to the merged revision")
    target = urlparse(readback["target_url"])
    if target.scheme not in {"http", "https"} or not target.netloc:
        raise RecordError("available runtime target_url must be an absolute HTTP URL")
    try:
        observed = datetime.fromisoformat(readback["observed_at"].replace("Z", "+00:00"))
    except ValueError as error:
        raise RecordError("release_readback.observed_at must be an ISO timestamp") from error
    if observed.tzinfo is None:
        raise RecordError("release_readback.observed_at needs a timezone")
    if readback["expected_mode"] and readback["active_mode"] != readback["expected_mode"]:
        raise RecordError("available runtime uses the wrong start mode")
    if readback["health"] != "passed" or readback["user_flow"] != "passed":
        raise RecordError("available runtime requires live health and user-flow proof")
    if readback["target_surface"] == "public" and readback["public_reachable"] is not True:
        raise RecordError("public availability requires public reachability proof")
    if readback["process_handle"] and readback["handle_state"] != "live":
        raise RecordError("available runtime process handle is not live")


def validate_ui_conventions(value: Any, *, repository: str, require_final: bool = False) -> None:
    """Review scoped decisions; never infer a preference from another repository."""
    record = require_object(value, "ui_conventions")
    if record.get("repository") != repository:
        raise RecordError("UI convention repository mismatch")
    surfaces = require_list(record.get("changed_surfaces"), "ui_conventions.changed_surfaces")
    seen = set()
    for raw in require_list(record.get("rules"), "ui_conventions.rules"):
        rule = require_object(raw, "UI convention")
        rule_id = require_text(rule.get("id"), "UI convention.id")
        if rule_id in seen:
            raise RecordError("duplicate UI convention")
        seen.add(rule_id)
        for key in ("source_ref", "surface"):
            require_text(rule.get(key), f"UI convention.{key}")
        state = require_choice(rule.get("state"), {"current", "superseded", "screen_local"}, "UI convention.state")
        if state == "superseded":
            require_text(rule.get("superseded_by"), "UI convention.superseded_by")
        if not isinstance(rule.get("applicable"), bool):
            raise RecordError("UI convention needs explicit applicability")
        if state == "superseded" and rule["applicable"]:
            raise RecordError("superseded UI convention cannot apply")
        if state == "screen_local" and rule["applicable"] and rule["surface"] not in surfaces:
            raise RecordError("screen-local UI convention cannot apply to another surface")
        review = require_choice(rule.get("review"), {"pending", "passed", "failed", "exception", "not_applicable"}, "UI convention.review")
        if review == "exception":
            require_text(rule.get("exception_reason"), "UI convention.exception_reason")
        if rule["applicable"] and review in {"passed", "exception"}:
            require_text(rule.get("evidence_ref"), "UI convention.evidence_ref")
        if require_final and rule["applicable"] and review not in {"passed", "exception"}:
            raise RecordError("applicable UI convention has not passed delivery review")


def validate_merge_readiness(value: Any, *, source_revision: str) -> None:
    """Reject an activation-ready claim based solely on local fixture readiness."""
    record = require_object(value, "merge_readiness")
    state = require_choice(record.get("state"), {"planned", "blocked", "ready", "merged"}, "merge_readiness.state")
    trigger = require_choice(record.get("trigger"), {"unknown", "deploys", "does_not_deploy"}, "merge_readiness.trigger")
    prerequisites = require_list(record.get("prerequisites"), "merge_readiness.prerequisites")
    if state not in {"ready", "merged"}:
        return
    if trigger == "unknown":
        raise RecordError("unknown deployment trigger blocks merge readiness")
    require_text(record.get("trigger_evidence_ref"), "merge_readiness.trigger_evidence_ref")
    if record.get("revision") != source_revision:
        raise RecordError("merge readiness has stale candidate")
    if trigger == "does_not_deploy":
        if prerequisites:
            raise RecordError("non-deploying merge must not require target prerequisites")
        return
    for key in ("environment", "configuration_ref", "observed_at", "authority_ref", "inventory_ref"):
        require_text(record.get(key), f"merge_readiness.{key}")
    mode = require_choice(record.get("activation"), {"active", "safely_inactive"}, "merge_readiness.activation")
    if mode == "safely_inactive":
        for key in ("inactivity_evidence_ref", "compatibility_evidence_ref", "activation_followup"):
            require_text(record.get(key), f"merge_readiness.{key}")
    seen = set()
    for raw in prerequisites:
        check = require_object(raw, "merge prerequisite")
        check_id = require_text(check.get("id"), "merge prerequisite.id")
        if check_id in seen:
            raise RecordError("duplicate merge prerequisite")
        seen.add(check_id)
        status = require_choice(check.get("state"), {"ready", "blocked", "unknown", "deferred"}, "merge prerequisite.state")
        if status != "ready" and not (mode == "safely_inactive" and status == "deferred"):
            raise RecordError("unverified target prerequisite blocks merge")
        for key in ("revision", "environment", "configuration_ref"):
            if check.get(key) != record[key]:
                raise RecordError("merge prerequisite has stale candidate, target or configuration")
        for key in ("evidence_ref", "observed_at"):
            require_text(check.get(key), f"merge prerequisite.{key}")
        if check.get("evidence_surface") != "target":
            raise RecordError("local fixtures cannot prove target prerequisites")


def validate_release_invariants(
    value: Any, *, release_readback: Any = None, require_final: bool = False
) -> None:
    """Keep durable state and background jobs separate from HTTP readiness."""

    record = require_object(value, "release_invariants")
    require_keys(record, {"applicability", "reason", "baseline_ref", "rollback_ref", "checks"},
                 "release_invariants")
    applicability = require_choice(
        record["applicability"], {"required", "not_applicable"},
        "release_invariants.applicability",
    )
    require_text(record["reason"], "release_invariants.reason")
    checks = require_list(record["checks"], "release_invariants.checks")
    if applicability == "not_applicable":
        if checks:
            raise RecordError("not-applicable release invariants cannot contain checks")
        return
    require_text(record["baseline_ref"], "release_invariants.baseline_ref")
    require_text(record["rollback_ref"], "release_invariants.rollback_ref")
    if not checks:
        raise RecordError("stateful release needs critical invariant checks")
    if not any(isinstance(check, dict) and check.get("critical") is True for check in checks):
        raise RecordError("stateful release needs at least one critical invariant")
    seen: set[str] = set()
    for index, raw in enumerate(checks):
        check = require_object(raw, f"release_invariants.checks[{index}]")
        require_keys(check, {
            "id", "kind", "claim", "critical", "safe_probe", "state", "revision",
            "environment", "observed_at", "evidence_ref", "authority_ref",
            "live_effect", "configured_state", "runtime_state", "store_state",
            "read_surface_state", "read_surface_freshness", "failure_action",
        }, "release invariant")
        check_id = require_text(check["id"], "release invariant.id")
        if check_id in seen:
            raise RecordError(f"duplicate release invariant: {check_id}")
        seen.add(check_id)
        require_choice(check["kind"], {
            "durable_record", "worker", "queue", "external_flow"
        }, f"release invariant {check_id}.kind")
        require_text(check["claim"], f"release invariant {check_id}.claim")
        if not isinstance(check["critical"], bool) or not isinstance(check["safe_probe"], bool):
            raise RecordError(f"release invariant {check_id} needs boolean risk fields")
        require_choice(check["state"], {
            "planned", "passed", "failed", "blocked", "not_applicable"
        }, f"release invariant {check_id}.state")
        require_choice(check["live_effect"], {
            "synthetic", "observed", "not_exercised"
        }, f"release invariant {check_id}.live_effect")
        if check["state"] == "not_applicable":
            require_text(check["failure_action"], f"release invariant {check_id}.exclusion_reason")
        if check["state"] in {"passed", "failed"}:
            for field in ("revision", "environment", "observed_at", "evidence_ref"):
                require_text(check[field], f"release invariant {check_id}.{field}")
        if check["state"] == "passed":
            if not check["safe_probe"] and not check["authority_ref"]:
                raise RecordError(f"release invariant {check_id} lacks live probe authority")
            if check["kind"] == "worker":
                if check["configured_state"] != "enabled":
                    raise RecordError(f"release invariant {check_id} has no enabled worker baseline")
                if check["runtime_state"] != "running":
                    raise RecordError(f"release invariant {check_id} has a stopped worker")
            if check["kind"] == "durable_record":
                if check["store_state"] != "present":
                    raise RecordError(f"release invariant {check_id} has a missing durable record")
                if check["read_surface_state"] != "present":
                    raise RecordError(f"release invariant {check_id} has a missing visible record")
                if check["read_surface_freshness"] != "current":
                    raise RecordError(f"release invariant {check_id} has a stale visible record")
            if check["kind"] in {"queue", "external_flow"} and check["live_effect"] == "not_exercised":
                raise RecordError(f"release invariant {check_id} has no end-to-end outcome proof")
            if release_readback and check["revision"] != release_readback.get("active_revision"):
                raise RecordError(f"release invariant {check_id} has a stale revision")
        if check["state"] in {"failed", "blocked"}:
            require_text(check["failure_action"], f"release invariant {check_id}.failure_action")
        if require_final and check["critical"] and check["state"] != "passed":
            raise RecordError(f"critical release invariant {check_id} is not proven")
    if release_readback and release_readback.get("state") == "available":
        if any(check["critical"] and check["state"] != "passed" for check in checks):
            raise RecordError("available release has an unverified critical invariant")


def validate_interaction_decisions(value: Any) -> None:
    """Track stable choices and just-in-time actions without repeating questions."""

    record = require_object(value, "interaction_decisions")
    questions = require_list(record.get("questions"), "interaction_decisions.questions")
    independent_work = require_list(
        record.get("independent_work", []), "interaction_decisions.independent_work"
    )
    for index, work in enumerate(independent_work):
        require_text(work, f"interaction_decisions.independent_work[{index}]")
    ids: set[str] = set()
    for index, raw in enumerate(questions):
        item = require_object(raw, f"interaction_decisions.questions[{index}]")
        require_keys(item, {
            "id", "kind", "question", "dependencies", "state", "answer_ref",
            "confirmed_value", "authority_ref", "ask_count", "reask_reason",
        }, "interaction decision")
        item_id = require_text(item["id"], "interaction decision.id")
        if item_id in ids:
            raise RecordError(f"duplicate interaction decision: {item_id}")
        ids.add(item_id)
        require_choice(item["kind"], {
            "stable_choice", "just_in_time_consent", "private_entry"
        }, f"interaction decision {item_id}.kind")
        require_text(item["question"], f"interaction decision {item_id}.question")
        require_choice(item["state"], {
            "pending", "answered", "approved", "blocked"
        }, f"interaction decision {item_id}.state")
        if isinstance(item["ask_count"], bool) or not isinstance(item["ask_count"], int):
            raise RecordError(f"interaction decision {item_id}.ask_count must be an integer")
        if item["ask_count"] < 0 or item["ask_count"] > 1 and not item["reask_reason"]:
            raise RecordError(f"interaction decision {item_id} repeats without material change")
        if item["state"] in {"answered", "approved"}:
            require_text(item["answer_ref"], f"interaction decision {item_id}.answer_ref")
        if item["kind"] == "stable_choice" and item["state"] == "answered":
            require_text(item["confirmed_value"], f"interaction decision {item_id}.confirmed_value")
        if item["kind"] == "just_in_time_consent" and item["state"] == "approved":
            require_text(item["authority_ref"], f"interaction decision {item_id}.authority_ref")
        if item["kind"] == "private_entry" and item["confirmed_value"]:
            raise RecordError(f"interaction decision {item_id} cannot store a private value")
    for item in questions:
        for dependency in require_list(item["dependencies"], "interaction decision.dependencies"):
            if dependency not in ids or dependency == item["id"]:
                raise RecordError(f"interaction decision {item['id']} has invalid dependency")
    graph = {item["id"]: item["dependencies"] for item in questions}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(item_id: str) -> None:
        if item_id in visiting:
            raise RecordError(f"interaction decision {item_id} has cyclic dependencies")
        if item_id in visited:
            return
        visiting.add(item_id)
        for dependency in graph[item_id]:
            visit(dependency)
        visiting.remove(item_id)
        visited.add(item_id)

    for item_id in graph:
        visit(item_id)


def interaction_plan(value: Any) -> dict[str, Any]:
    """Bundle ready stable questions and identify one dependent action."""

    validate_interaction_decisions(value)
    questions = value["questions"]
    answered = {item["id"] for item in questions if item["state"] in {"answered", "approved"}}
    ready = [item for item in questions if item["state"] == "pending"
             and item["ask_count"] == 0 and set(item["dependencies"]).issubset(answered)]
    stable = [item["id"] for item in ready if item["kind"] == "stable_choice"]
    if stable:
        return {"action": "ask_grouped", "question_ids": stable}
    if ready:
        return {"action": "ask_just_in_time", "question_ids": [ready[0]["id"]]}
    blocked = [item["id"] for item in questions if item["state"] == "blocked"]
    if blocked:
        return {"action": "blocked", "question_ids": blocked}
    if value.get("independent_work"):
        return {"action": "continue_independent_work",
                "question_ids": [], "work_refs": value["independent_work"]}
    waiting = [item["id"] for item in questions if item["state"] == "pending"]
    return {"action": "wait_for_input" if waiting else "complete",
            "question_ids": waiting}


def validate_pr_handoff(value: Any, *, task_status: str, require_final: bool) -> None:
    """A changed worktree needs a verified PR before successful handoff."""

    handoff = require_object(value, "pr_handoff")
    reject_secrets(handoff, "pr_handoff")
    completion_required = require_final or task_status == "completed"
    require_keys(handoff, {
        "worktree_changed", "changed_paths", "explicit_local_only", "override_ref", "state", "branch",
        "base_branch", "head_revision", "pr_url", "pr_head_revision", "pr_base_branch",
        "pr_state", "review_state", "checks_state", "readback_ref", "blocker",
        "existing_pr_url", "preserved_work_ref",
    }, "pr_handoff")
    if not isinstance(handoff["worktree_changed"], bool):
        raise RecordError("pr_handoff.worktree_changed must be boolean")
    if not isinstance(handoff["explicit_local_only"], bool):
        raise RecordError("pr_handoff.explicit_local_only must be boolean")
    changed_paths = require_list(handoff["changed_paths"], "pr_handoff.changed_paths")
    for index, path in enumerate(changed_paths):
        require_text(path, f"pr_handoff.changed_paths[{index}]")
    if bool(changed_paths) != handoff["worktree_changed"]:
        raise RecordError("pr_handoff.changed_paths must match tracked worktree changes")
    require_choice(handoff["state"], {
        "pending", "ready", "blocked", "not_applicable"
    }, "pr_handoff.state")
    if not handoff["worktree_changed"]:
        if handoff["state"] != "not_applicable":
            raise RecordError("unchanged worktree must not claim a PR handoff")
        return
    if handoff["explicit_local_only"]:
        require_text(handoff["override_ref"], "pr_handoff.override_ref")
        if handoff["state"] == "not_applicable":
            return
    if handoff["state"] == "ready":
        for field in ("branch", "base_branch", "head_revision", "pr_url", "pr_head_revision",
                      "pr_base_branch", "readback_ref"):
            require_text(handoff[field], f"pr_handoff.{field}")
        if not re.fullmatch(r"[0-9a-f]{40}", handoff["head_revision"]):
            raise RecordError("pr_handoff.head_revision must be a full Git revision")
        if handoff["head_revision"] != handoff["pr_head_revision"]:
            raise RecordError("PR head does not match worktree candidate")
        if handoff["existing_pr_url"] and handoff["existing_pr_url"] != handoff["pr_url"]:
            raise RecordError("matching existing PR must be updated, not duplicated")
        if handoff["base_branch"] != handoff["pr_base_branch"]:
            raise RecordError("PR base does not match planned base branch")
        tracking_url(handoff["pr_url"], "pull", issue_url=handoff["pr_url"])
        require_choice(handoff["pr_state"], {"open", "draft", "merged"}, "pr_handoff.pr_state")
        require_choice(handoff["review_state"], {
            "pending", "approved", "changes_requested", "not_required"
        }, "pr_handoff.review_state")
        require_choice(handoff["checks_state"], {
            "passed", "pending", "failed", "unavailable"
        }, "pr_handoff.checks_state")
        if handoff["checks_state"] == "failed" and completion_required and task_status != "blocked":
            raise RecordError("completed task has failing PR checks")
        if (handoff["review_state"] == "changes_requested"
                and completion_required and task_status != "blocked"):
            raise RecordError("completed task has unresolved PR review changes")
        if (handoff["review_state"] == "pending"
                and completion_required and task_status != "blocked"):
            raise RecordError("required independent review is incomplete")
    elif handoff["state"] == "blocked":
        require_text(handoff["blocker"], "pr_handoff.blocker")
        require_text(handoff["preserved_work_ref"], "pr_handoff.preserved_work_ref")
        if task_status != "blocked":
            raise RecordError("blocked PR handoff requires blocked task status")
    elif completion_required:
        raise RecordError("changed worktree lacks a reviewable PR handoff")


def tracking_url(value: Any, kind: str, *, issue_url: str) -> str:
    """Require a concrete issue/PR in the same repository as the primary issue."""

    url = require_text(value, f"delivery_tracking.{kind}_url")
    parsed = urlparse(url)
    primary = urlparse(issue_url)
    match = re.fullmatch(r"/([^/]+)/([^/]+)/(issues|pull)/([1-9][0-9]*)", parsed.path)
    if (
        parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
        or parsed.query or parsed.fragment or not match or match[3] != kind
        or parsed.netloc.casefold() != primary.netloc.casefold()
        or parsed.path.rsplit("/", 2)[0].casefold()
        != primary.path.rsplit("/", 2)[0].casefold()
    ):
        raise RecordError(f"delivery_tracking URL must identify a same-repository {kind} item")
    return url.casefold()


def validate_delivery_tracking(
    value: Any, *, issue_url: str, task_status: str, require_final: bool,
    pr_handoff: Any = None,
) -> None:
    """Validate many-to-many tracking; every delivered issue and PR needs a link."""

    tracking = require_object(value, "delivery_tracking")
    require_keys(tracking, {"issues", "pull_requests", "links"}, "delivery_tracking")
    issues: set[str] = set()
    prs: dict[str, dict[str, Any]] = {}
    for item_value in require_list(tracking["issues"], "delivery_tracking.issues"):
        item = require_object(item_value, "delivery_tracking.issue")
        require_keys(item, {"url", "readback_ref"}, "delivery_tracking.issue")
        url = tracking_url(item["url"], "issues", issue_url=issue_url)
        require_text(item["readback_ref"], "delivery_tracking.issue.readback_ref")
        if url in issues:
            raise RecordError("duplicate delivery_tracking issue")
        issues.add(url)
    if not issues or tracking_url(issue_url, "issues", issue_url=issue_url) not in issues:
        raise RecordError("delivery_tracking requires the primary tracking issue")
    for item_value in require_list(tracking["pull_requests"], "delivery_tracking.pull_requests"):
        item = require_object(item_value, "delivery_tracking.pull_request")
        require_keys(item, {"url", "head_revision", "base_branch", "state", "readback_ref"},
                     "delivery_tracking.pull_request")
        url = tracking_url(item["url"], "pull", issue_url=issue_url)
        if url in prs:
            raise RecordError("duplicate delivery_tracking PR")
        revision = require_text(item["head_revision"], "delivery_tracking.PR.head_revision")
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise RecordError("delivery_tracking PR head must be a full Git revision")
        require_text(item["base_branch"], "delivery_tracking.PR.base_branch")
        require_text(item["readback_ref"], "delivery_tracking.PR.readback_ref")
        require_choice(item["state"], {"open", "draft", "merged"}, "delivery_tracking.PR.state")
        prs[url] = item
    links: set[tuple[str, str]] = set()
    for link_value in require_list(tracking["links"], "delivery_tracking.links"):
        link = require_object(link_value, "delivery_tracking.link")
        require_keys(link, {"issue_url", "pr_url", "readback_ref"}, "delivery_tracking.link")
        issue = tracking_url(link["issue_url"], "issues", issue_url=issue_url)
        pr = tracking_url(link["pr_url"], "pull", issue_url=issue_url)
        require_text(link["readback_ref"], "delivery_tracking.link.readback_ref")
        if issue not in issues or pr not in prs:
            raise RecordError("delivery_tracking link references an unlisted issue or PR")
        if (issue, pr) in links:
            raise RecordError("duplicate delivery_tracking link")
        links.add((issue, pr))
    if {pr for _, pr in links} != set(prs):
        raise RecordError("every delivery_tracking PR must link a tracking issue")
    paired_gate = require_final or task_status == "completed" or (
        pr_handoff is not None and pr_handoff.get("state") == "ready"
    )
    pr_not_applicable = (
        pr_handoff is not None and pr_handoff.get("state") == "not_applicable"
        and (pr_handoff.get("explicit_local_only") or not pr_handoff.get("worktree_changed"))
    )
    if paired_gate and task_status != "blocked" and not pr_not_applicable:
        if not prs:
            raise RecordError("delivery requires at least one tracking issue and one PR")
        if {issue for issue, _ in links} != issues:
            raise RecordError("every delivered tracking issue must link at least one PR")
    if pr_handoff is not None and pr_handoff.get("state") == "ready":
        url = tracking_url(pr_handoff["pr_url"], "pull", issue_url=issue_url)
        if url not in prs:
            raise RecordError("PR handoff is missing from delivery_tracking")
        pr = prs[url]
        if (pr["head_revision"] != pr_handoff["pr_head_revision"]
                or pr["base_branch"] != pr_handoff["pr_base_branch"]
                or pr["state"] != pr_handoff["pr_state"]):
            raise RecordError("delivery_tracking PR identity differs from PR handoff")


def decomposition_plan(value: Any) -> dict[str, Any]:
    """Group coupled outcomes into the smallest independently testable children."""

    request = require_object(value, "decomposition request")
    require_keys(request, {"outcomes", "one_pr_requested"}, "decomposition request")
    if not isinstance(request["one_pr_requested"], bool):
        raise RecordError("decomposition request.one_pr_requested must be boolean")
    outcomes = require_list(request["outcomes"], "decomposition request.outcomes")
    if not outcomes:
        raise RecordError("decomposition request needs an outcome")
    by_id: dict[str, dict[str, Any]] = {}
    groups: dict[str, list[dict[str, Any]]] = {}
    for index, raw in enumerate(outcomes):
        item = require_object(raw, f"decomposition request.outcomes[{index}]")
        require_keys(item, {"id", "deliverable", "cohesion_group", "dependencies",
                            "test_refs"}, "decomposition outcome")
        item_id = require_text(item["id"], "decomposition outcome.id")
        if item_id in by_id:
            raise RecordError(f"duplicate decomposition outcome: {item_id}")
        by_id[item_id] = item
        group = require_text(item["cohesion_group"], f"outcome {item_id}.cohesion_group")
        require_text(item["deliverable"], f"outcome {item_id}.deliverable")
        if not require_list(item["test_refs"], f"outcome {item_id}.test_refs"):
            raise RecordError(f"outcome {item_id} lacks mapped tests")
        require_list(item["dependencies"], f"outcome {item_id}.dependencies")
        groups.setdefault(group, []).append(item)
    for item in outcomes:
        for dependency in item["dependencies"]:
            if dependency not in by_id or dependency == item["id"]:
                raise RecordError(f"outcome {item['id']} has invalid dependency")
    if request["one_pr_requested"] or len(groups) == 1:
        return {"mode": "single", "reason": "explicit_one_pr" if request[
            "one_pr_requested"] else "one_coupled_group", "children": []}
    children = []
    for group_id, members in groups.items():
        own_ids = {item["id"] for item in members}
        children.append({
            "id": group_id,
            "deliverables": [item["deliverable"] for item in members],
            "outcome_ids": [item["id"] for item in members],
            "test_refs": sorted({test for item in members for test in item["test_refs"]}),
            "dependencies": sorted({by_id[dependency]["cohesion_group"]
                                    for item in members for dependency in item["dependencies"]
                                    if dependency not in own_ids}),
        })
    graph = {child["id"]: child["dependencies"] for child in children}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(group_id: str) -> None:
        if group_id in visiting:
            raise RecordError(f"decomposition group {group_id} has cyclic dependencies")
        if group_id in visited:
            return
        visiting.add(group_id)
        for dependency in graph[group_id]:
            visit(dependency)
        visiting.remove(group_id)
        visited.add(group_id)

    for group_id in graph:
        visit(group_id)
    return {"mode": "parent", "reason": "independently_testable_groups",
            "children": children}


def validate_decomposition(value: Any) -> None:
    """Separate branch merge authority from current-candidate readiness."""

    plan = require_object(value, "decomposition")
    require_keys(plan, {
        "mode", "decision_ref", "parent_issue", "parent_branch", "default_branch",
        "default_revision_at_branch", "parent_base_revision", "branch_creation_ref",
        "children", "combined_tests_state", "combined_evidence_ref", "main_merge_state",
        "main_approval_ref", "approved_head_revision", "parent_head_revision",
        "approved_pr_url", "parent_pr_url", "parent_pr_base", "parent_pr_head_revision",
        "parent_pr_child_issues", "parent_pr_readback_ref", "main_auto_merge_state",
    }, "decomposition")
    require_choice(plan["mode"], {"single", "parent"}, "decomposition.mode")
    require_text(plan["decision_ref"], "decomposition.decision_ref")
    children = require_list(plan["children"], "decomposition.children")
    if plan["mode"] == "single":
        if children:
            raise RecordError("single issue must not contain child deliveries")
        return
    for field in ("parent_issue", "parent_branch", "default_branch"):
        require_text(plan[field], f"decomposition.{field}")
    if plan["parent_branch"] == plan["default_branch"]:
        raise RecordError("parent issue branch must differ from default branch")
    for field in ("default_revision_at_branch", "parent_base_revision"):
        revision = require_text(plan[field], f"decomposition.{field}")
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise RecordError(f"decomposition.{field} must be a full Git revision")
    if plan["default_revision_at_branch"] != plan["parent_base_revision"]:
        raise RecordError("parent issue branch did not start at the verified default revision")
    require_text(plan["branch_creation_ref"], "decomposition.branch_creation_ref")
    if not children:
        raise RecordError("parent issue needs testable child deliveries")
    seen: set[str] = set()
    for index, raw in enumerate(children):
        child = require_object(raw, f"decomposition.children[{index}]")
        require_keys(child, {
            "issue", "branch", "deliverable", "dependencies", "test_refs", "pr_url", "pr_base",
            "head_revision", "base_revision", "checks_revision", "review_revision",
            "verification_revision", "base_at_merge_revision", "verification_state",
            "checks_state", "review_state", "state", "merge_evidence_ref",
            "issue_state", "issue_readback_ref",
        }, "child delivery")
        child_issue = require_text(child["issue"], "child delivery.issue")
        if child_issue in seen:
            raise RecordError(f"duplicate child issue: {child_issue}")
        seen.add(child_issue)
        for field in ("branch", "deliverable"):
            require_text(child[field], f"child {child_issue}.{field}")
        require_list(child["dependencies"], f"child {child_issue}.dependencies")
        if not require_list(child["test_refs"], f"child {child_issue}.test_refs"):
            raise RecordError(f"child {child_issue} lacks mapped tests")
        require_choice(child["state"], {"planned", "pr_open", "merged", "blocked"},
                       f"child {child_issue}.state")
        if child["state"] in {"pr_open", "merged"}:
            require_text(child["pr_url"], f"child {child_issue}.pr_url")
            if child["pr_base"] != plan["parent_branch"]:
                raise RecordError(f"child {child_issue} PR targets the wrong branch")
        if child["state"] == "merged":
            if (child["checks_state"] != "passed" or child["review_state"] != "passed"
                    or child["verification_state"] != "passed"):
                raise RecordError(f"child {child_issue} merged without required gates")
            for field in ("head_revision", "base_revision", "checks_revision",
                          "review_revision", "verification_revision", "base_at_merge_revision"):
                revision = require_text(child[field], f"child {child_issue}.{field}")
                if not re.fullmatch(r"[0-9a-f]{40}", revision):
                    raise RecordError(f"child {child_issue}.{field} must be a full Git revision")
            if any(child[field] != child["head_revision"] for field in (
                "checks_revision", "review_revision", "verification_revision"
            )) or child["base_revision"] != child["base_at_merge_revision"]:
                raise RecordError(f"child {child_issue} has stale head or parent-base evidence")
            require_text(child["merge_evidence_ref"], f"child {child_issue}.merge_evidence_ref")
            if child["issue_state"] != "closed":
                raise RecordError(f"child {child_issue} merge lacks closed issue readback")
            require_text(child["issue_readback_ref"], f"child {child_issue}.issue_readback_ref")
    graph = {child["issue"]: child["dependencies"] for child in children}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(issue: str) -> None:
        if issue in visiting:
            raise RecordError(f"child {issue} has cyclic dependencies")
        if issue in visited:
            return
        visiting.add(issue)
        for dependency in graph[issue]:
            if dependency not in graph or dependency == issue:
                raise RecordError(f"child {issue} has invalid dependency")
            visit(dependency)
        visiting.remove(issue)
        visited.add(issue)

    for issue in graph:
        visit(issue)
    for child in children:
        if child["state"] == "merged" and any(
            next(item for item in children if item["issue"] == dependency)["state"] != "merged"
            for dependency in child["dependencies"]
        ):
            raise RecordError(f"child {child['issue']} merged before its dependencies")
    require_choice(plan["combined_tests_state"], {"pending", "passed", "failed"},
                   "decomposition.combined_tests_state")
    require_choice(plan["main_merge_state"], {
        "not_requested", "approval_pending", "approved", "merged"
    }, "decomposition.main_merge_state")
    require_choice(plan["main_auto_merge_state"], {"disabled", "enabled"},
                   "decomposition.main_auto_merge_state")
    if plan["main_merge_state"] != "not_requested":
        require_text(plan["parent_pr_url"], "decomposition.parent_pr_url")
        require_text(plan["parent_pr_readback_ref"], "decomposition.parent_pr_readback_ref")
        if urlparse(plan["parent_pr_url"]).path.count("/pull/") != 1:
            raise RecordError("decomposition.parent_pr_url must identify a pull request")
        linked_issues = require_list(plan["parent_pr_child_issues"],
                                     "decomposition.parent_pr_child_issues")
        if set(linked_issues) != {child["issue"] for child in children}:
            raise RecordError("parent PR does not link every child issue")
        if plan["parent_pr_base"] != plan["default_branch"]:
            raise RecordError("parent PR targets the wrong default branch")
        if plan["parent_pr_head_revision"] != plan["parent_head_revision"]:
            raise RecordError("parent PR head does not match the parent candidate")
    if plan["main_auto_merge_state"] == "enabled" and plan["main_merge_state"] != "approved":
        raise RecordError("parent auto-merge requires current explicit approval")
    if plan["main_merge_state"] in {"approved", "merged"}:
        require_text(plan["main_approval_ref"], "decomposition.main_approval_ref")
        for field in ("approved_head_revision", "parent_head_revision"):
            revision = require_text(plan[field], f"decomposition.{field}")
            if not re.fullmatch(r"[0-9a-f]{40}", revision):
                raise RecordError(f"decomposition.{field} must be a full Git revision")
        if plan["approved_pr_url"] != plan["parent_pr_url"]:
            raise RecordError("main merge approval is for a different parent PR")
        # Retained version-1 records bind the branch through their approved PR.
        # The historical approval head remains provenance, not a freshness gate.
        approved_branch = plan.get("approved_branch", plan["parent_branch"])
        if approved_branch != plan["parent_branch"]:
            raise RecordError("main merge approval is for a different parent branch")
        approval_scope = plan.get("main_approval_scope", "branch")
        require_choice(approval_scope, {"branch", "commit"}, "decomposition.main_approval_scope")
        if (approval_scope == "commit"
                and plan["approved_head_revision"] != plan["parent_head_revision"]):
            raise RecordError("main merge approval is stale for parent candidate")
    # Approval starts full verification; it does not claim that verification passed.
    if plan["main_merge_state"] == "merged" or plan["main_auto_merge_state"] == "enabled":
        if any(child["state"] != "merged" for child in children):
            raise RecordError("parent main merge with unfinished children")
        if plan["combined_tests_state"] != "passed":
            raise RecordError("parent main merge without combined tests")
        if plan.get("combined_tests_revision") != plan["parent_head_revision"]:
            raise RecordError("parent main merge has stale or missing combined test revision")
        require_text(plan["combined_evidence_ref"], "decomposition.combined_evidence_ref")


def validate_resources(
    resources_value: Any,
    reclamation_approvals: dict[str, dict[str, Any]],
    *,
    task_status: str,
) -> None:
    for index, resource_value in enumerate(require_list(resources_value, "resources")):
        resource = require_object(resource_value, f"resources[{index}]")
        require_keys(
            resource,
            {
                "id",
                "kind",
                "ownership",
                "capacity",
                "cleanup",
                "recovery",
            },
            f"resources[{index}]",
        )
        if resource["ownership"] not in RESOURCE_OWNERSHIP:
            raise RecordError(f"resources[{index}].ownership is not supported")
        if resource["capacity"] not in {
            "sufficient",
            "insufficient",
            "unknown",
            "not_applicable",
        }:
            raise RecordError(f"resources[{index}].capacity is not supported")
        if (
            resource["capacity"] in {"insufficient", "unknown"}
            and task_status not in {"planned", "blocked"}
        ):
            raise RecordError(
                f"resources[{index}] capacity blocks expensive work"
            )
        require_text(resource["recovery"], f"resources[{index}].recovery")
        cleanup = require_object(resource["cleanup"], f"resources[{index}].cleanup")
        require_keys(cleanup, {"allowed", "exact_target", "approval_ref"}, f"resources[{index}].cleanup")
        if cleanup["allowed"] and not cleanup["exact_target"]:
            raise RecordError(f"resources[{index}] cleanup requires an exact target")
        if resource["ownership"] != "task" and cleanup["allowed"]:
            approval_ref = cleanup["approval_ref"]
            if approval_ref not in reclamation_approvals:
                raise RecordError(
                    f"resources[{index}] shared cleanup requires explicit approval"
                )
        if "coordination" in cleanup:
            path = f"resources[{index}].cleanup.coordination"
            if not isinstance(cleanup["allowed"], bool):
                raise RecordError(f"{path} cleanup.allowed must be a boolean")
            coordination = require_object(cleanup["coordination"], path)
            require_keys(coordination, {"target", "state", "observed_at", "evidence_ref",
                                        "active_consumers", "interruption_approval_ref"}, path)
            require_text(coordination["target"], f"{path}.target")
            if coordination["target"] != cleanup["exact_target"]:
                raise RecordError(f"{path} coordination target differs from cleanup target")
            state = require_choice(coordination["state"],
                                   {"clear", "blocked", "unknown", "interruption_approved"}, path)
            require_text(coordination["evidence_ref"], f"{path}.evidence_ref")
            observed_at = require_text(coordination["observed_at"], f"{path}.observed_at")
            try:
                observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
            except ValueError as error:
                raise RecordError(f"{path}.observed_at must be an ISO timestamp") from error
            if observed.tzinfo is None:
                raise RecordError(f"{path}.observed_at needs a timezone")
            consumers = [require_text(item, f"{path}.active_consumers") for item in
                         require_list(coordination["active_consumers"], f"{path}.active_consumers")]
            if len(consumers) != len(set(consumers)):
                raise RecordError(f"{path} has duplicate active consumers")
            if state == "clear" and consumers:
                raise RecordError(f"{path} clear coordination has active consumers")
            if cleanup["allowed"] and state in {"blocked", "unknown"}:
                raise RecordError(f"{path} coordination blocks cleanup")
            if state != "interruption_approved" and coordination["interruption_approval_ref"] is not None:
                raise RecordError(f"{path} interruption approval only applies to approved interruption")
            if state == "interruption_approved":
                approval_ref = coordination["interruption_approval_ref"]
                approval = reclamation_approvals.get(approval_ref) if isinstance(approval_ref, str) else None
                approved_consumers = approval.get("active_consumers") if approval else None
                if (not consumers or not approval
                        or approval.get("cleanup_target") != cleanup["exact_target"]
                        or not isinstance(approved_consumers, list)
                        or any(not isinstance(item, str) for item in approved_consumers)
                        or len(approved_consumers) != len(consumers)
                        or set(approved_consumers) != set(consumers)):
                    raise RecordError(f"{path} interruption approval must bind target and active consumers")
                require_text(approval.get("source_ref"), f"{path} interruption approval.source_ref")


def validate_steps(validation_value: Any) -> dict[str, dict[str, Any]]:
    validation = require_object(validation_value, "validation")
    require_keys(validation, {"source_revision", "steps"}, "validation")
    require_text(validation["source_revision"], "validation.source_revision")
    steps: dict[str, dict[str, Any]] = {}
    ordered_steps = require_list(validation["steps"], "validation.steps")
    previous_cost = -1
    for index, step_value in enumerate(ordered_steps):
        step = require_object(step_value, f"validation.steps[{index}]")
        require_keys(
            step,
            {
                "id",
                "command_or_boundary",
                "evidence_ref",
                "prerequisites",
                "cost",
                "completion_required",
                "state",
                "skip_reason",
            },
            f"validation.steps[{index}]",
        )
        step_id = require_text(step["id"], f"validation.steps[{index}].id")
        if step_id in steps:
            raise RecordError(f"duplicate validation step id: {step_id}")
        if step["state"] not in STEP_STATES:
            raise RecordError(f"validation step {step_id} has unsupported state")
        if step["cost"] not in COST_ORDER:
            raise RecordError(f"validation step {step_id} has unsupported cost")
        if COST_ORDER[step["cost"]] < previous_cost:
            raise RecordError("validation ladder is not ordered cheap-first")
        previous_cost = COST_ORDER[step["cost"]]
        if step["state"] == "skipped" and not step["skip_reason"]:
            raise RecordError(f"validation step {step_id} requires a skip reason")
        steps[step_id] = step
    for step_id, step in steps.items():
        prerequisites = require_list(
            step["prerequisites"], f"validation step {step_id}.prerequisites"
        )
        for prerequisite in prerequisites:
            if prerequisite not in steps:
                raise RecordError(
                    f"validation step {step_id} has unknown prerequisite {prerequisite}"
                )
            if (
                steps[prerequisite]["state"] in {"failed", "blocked"}
                and step["state"] in {"running", "passed"}
            ):
                raise RecordError(
                    f"validation step {step_id} ran after failed prerequisite {prerequisite}"
                )
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise RecordError("validation prerequisites contain a cycle")
        if step_id in visited:
            return
        visiting.add(step_id)
        for prerequisite in steps[step_id]["prerequisites"]:
            visit(prerequisite)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in steps:
        visit(step_id)
    return steps


def validate_failures(failures_value: Any, steps: dict[str, dict[str, Any]]) -> None:
    for index, failure_value in enumerate(require_list(failures_value, "failures")):
        failure = require_object(failure_value, f"failures[{index}]")
        require_keys(
            failure,
            {
                "id",
                "step_ref",
                "first_evidence",
                "reproduction",
                "classification",
                "classification_evidence",
                "remedy",
                "rerun_steps",
                "accepted",
            },
            f"failures[{index}]",
        )
        if failure["step_ref"] not in steps:
            raise RecordError(f"failures[{index}] references an unknown step")
        if failure["classification"] not in FAILURE_CLASSES:
            raise RecordError(f"failures[{index}] has unsupported classification")
        require_text(failure["first_evidence"], f"failures[{index}].first_evidence")
        require_text(failure["reproduction"], f"failures[{index}].reproduction")
        if (
            steps[failure["step_ref"]]["completion_required"]
            and failure["classification"] == "unknown"
            and not failure["accepted"]
        ):
            raise RecordError("unknown required failure blocks the review gate")


def validate_sandboxes(sandboxes_value: Any) -> None:
    sandboxes = require_list(sandboxes_value, "sandboxes")
    for index, sandbox_value in enumerate(sandboxes):
        sandbox = require_object(sandbox_value, f"sandboxes[{index}]")
        require_keys(
            sandbox,
            {
                "id",
                "suite",
                "mutable_resources",
                "readiness",
                "cleanup_targets",
                "safe_sharing_evidence",
            },
            f"sandboxes[{index}]",
        )
    for left_index, left_value in enumerate(sandboxes):
        left = require_object(left_value, f"sandboxes[{left_index}]")
        left_resources = set(require_list(left["mutable_resources"], "mutable_resources"))
        for right_value in sandboxes[left_index + 1 :]:
            right = require_object(right_value, "sandbox")
            overlap = left_resources & set(
                require_list(right["mutable_resources"], "mutable_resources")
            )
            if overlap and not (
                left["safe_sharing_evidence"] and right["safe_sharing_evidence"]
            ):
                raise RecordError(
                    "validation sandboxes share mutable state without safety evidence"
                )


def validate_artifacts(artifacts_value: Any, source_revision: str) -> set[str]:
    artifact_ids: set[str] = set()
    for index, artifact_value in enumerate(require_list(artifacts_value, "artifacts")):
        artifact = require_object(artifact_value, f"artifacts[{index}]")
        require_keys(
            artifact,
            {
                "id",
                "digest",
                "source_revision",
                "build_inputs_digest",
                "command_ref",
                "platform",
                "immutable",
                "verified",
            },
            f"artifacts[{index}]",
        )
        artifact_id = require_text(artifact["id"], f"artifacts[{index}].id")
        if artifact_id in artifact_ids:
            raise RecordError(f"duplicate artifact id: {artifact_id}")
        artifact_ids.add(artifact_id)
        if not artifact["immutable"]:
            raise RecordError(f"artifact {artifact_id} is mutable and cannot be reused")
        if not artifact["verified"]:
            raise RecordError(f"artifact {artifact_id} output is not verified")
        if artifact["source_revision"] != source_revision:
            raise RecordError(f"artifact {artifact_id} has stale source identity")
        for key in ("digest", "build_inputs_digest"):
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(artifact[key])):
                raise RecordError(f"artifact {artifact_id} requires immutable {key}")
    return artifact_ids


def validate_operations(operations_value: Any, source_revision: str) -> None:
    mutation_keys: set[str] = set()
    for index, operation_value in enumerate(require_list(operations_value, "operations")):
        operation = require_object(operation_value, f"operations[{index}]")
        require_keys(
            operation,
            {
                "id",
                "purpose",
                "command_or_tool",
                "evidence_ref",
                "working_directory",
                "source_revision",
                "inputs_digest",
                "expected_outputs",
                "ownership",
                "budgets",
                "liveness",
                "cancellation",
                "resumability",
                "state",
                "checkpoint",
                "mutating",
                "mutation_key",
                "retry_count",
                "max_retries",
                "retry_reason",
            },
            f"operations[{index}]",
        )
        operation_id = require_text(operation["id"], f"operations[{index}].id")
        for key in (
            "purpose",
            "command_or_tool",
            "evidence_ref",
            "working_directory",
            "liveness",
            "cancellation",
            "resumability",
        ):
            require_text(operation[key], f"operation {operation_id}.{key}")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(operation["inputs_digest"])):
            raise RecordError(f"operation {operation_id} inputs_digest is not immutable")
        require_list(operation["expected_outputs"], f"operation {operation_id}.expected_outputs")
        if operation["state"] not in OPERATION_STATES:
            raise RecordError(f"operation {operation_id} has unsupported state")
        if operation["source_revision"] != source_revision:
            raise RecordError(f"operation {operation_id} checkpoint is stale")
        budgets = require_object(operation["budgets"], f"operation {operation_id}.budgets")
        require_keys(budgets, {"soft_seconds", "hard_seconds"}, f"operation {operation_id}.budgets")
        if budgets["soft_seconds"] <= 0 or budgets["hard_seconds"] < budgets["soft_seconds"]:
            raise RecordError(f"operation {operation_id} has invalid time budgets")
        if operation["retry_count"] > operation["max_retries"]:
            raise RecordError(f"operation {operation_id} exceeded its retry budget")
        if operation["retry_count"] > 0:
            require_text(
                operation["retry_reason"],
                f"operation {operation_id}.retry_reason",
            )
        if operation["state"] != "planned" and not operation["checkpoint"]:
            raise RecordError(f"operation {operation_id} requires a durable checkpoint")
        if operation["mutating"]:
            mutation_key = require_text(
                operation["mutation_key"], f"operation {operation_id}.mutation_key"
            )
            if mutation_key in mutation_keys and operation["state"] in {
                "running",
                "completed_unverified",
                "verified",
            }:
                raise RecordError("duplicate mutating operation identity")
            mutation_keys.add(mutation_key)


def validate_verification(
    verification_value: Any,
    *,
    artifact_ids: set[str],
    fallback_approval_ids: set[str],
    require_final: bool = False,
) -> set[str]:
    verification = require_object(verification_value, "verification")
    require_keys(verification, {"claims"}, "verification")
    satisfied_claims: set[str] = set()
    for index, claim_value in enumerate(require_list(verification["claims"], "verification.claims")):
        claim = require_object(claim_value, f"verification.claims[{index}]")
        require_keys(
            claim,
            {
                "id",
                "claim",
                "primary_channel",
                "availability",
                "selected_channel",
                "decision",
                "equivalence_justification",
                "approval_owner",
                "approval_ref",
                "satisfied",
                "artifact_refs",
            },
            f"verification.claims[{index}]",
        )
        claim_id = require_text(claim["id"], f"verification.claims[{index}].id")
        if "outcome_check" in claim:
            outcome = require_object(claim["outcome_check"], f"claim {claim_id}.outcome_check")
            require_keys(outcome, {
                "input_ref", "expected_result", "observed_result", "evidence_ref",
                "evidence_kind", "state", "limitation",
            }, f"claim {claim_id}.outcome_check")
            for field in ("input_ref", "expected_result"):
                require_text(outcome[field], f"claim {claim_id}.outcome_check.{field}")
            for field in ("observed_result", "evidence_ref", "limitation"):
                if not isinstance(outcome[field], str):
                    raise RecordError(f"outcome_check.{field} must be text")
            for field in ("state", "evidence_kind"):
                require_text(outcome[field], f"outcome_check.{field}")
            if outcome["state"] not in {"passed", "failed", "unavailable"}:
                raise RecordError("outcome_check.state is unsupported")
            if outcome["evidence_kind"] not in {"actual", "controlled"}:
                raise RecordError("outcome_check.evidence_kind is unsupported")
            if not isinstance(claim["satisfied"], bool):
                raise RecordError("outcome claim satisfied must be boolean")
            completion_required = outcome.get("completion_required", True)
            if not isinstance(completion_required, bool):
                raise RecordError("outcome_check.completion_required must be boolean")
            if not completion_required:
                require_text(outcome["limitation"], f"claim {claim_id}.outcome_check.limitation")
            if claim["satisfied"] and (
                outcome["state"] != "passed" or outcome["evidence_kind"] != "actual"
            ):
                raise RecordError(f"claim {claim_id} lacks a passed actual outcome")
            if outcome["state"] != "unavailable":
                for field in ("observed_result", "evidence_ref"):
                    require_text(outcome[field], f"claim {claim_id}.outcome_check.{field}")
            if outcome["state"] in {"failed", "unavailable"}:
                require_text(outcome["limitation"], f"claim {claim_id}.outcome_check.limitation")
            if require_final and completion_required and not claim["satisfied"]:
                raise RecordError(f"final actual outcome {claim_id} remains unsatisfied")
        if claim["decision"] not in CHANNEL_DECISIONS:
            raise RecordError(f"verification claim {claim_id} has unsupported decision")
        if (
            claim["decision"] == "primary"
            and claim["selected_channel"] != claim["primary_channel"]
        ):
            raise RecordError(
                f"verification claim {claim_id} primary decision selects a different channel"
            )
        if claim["decision"] == "equivalent":
            require_text(
                claim["equivalence_justification"],
                f"verification claim {claim_id}.equivalence_justification",
            )
            require_text(
                claim["approval_owner"],
                f"verification claim {claim_id}.approval_owner",
            )
            if claim["approval_ref"] not in fallback_approval_ids:
                raise RecordError(
                    f"verification claim {claim_id} lacks approved fallback authority"
                )
        if claim["decision"] in {"partial", "diagnostic"} and claim["satisfied"]:
            raise RecordError(
                f"verification claim {claim_id} cannot be satisfied by a weaker channel"
            )
        if (
            claim["availability"] == "unavailable"
            and claim["decision"] == "primary"
            and claim["satisfied"]
        ):
            raise RecordError(
                f"verification claim {claim_id} uses an unavailable primary channel"
            )
        if claim["satisfied"]:
            satisfied_claims.add(claim_id)
        if not set(require_list(claim["artifact_refs"], "artifact_refs")).issubset(
            artifact_ids
        ):
            raise RecordError(
                f"verification claim {claim_id} references an unknown artifact"
            )
    return satisfied_claims


def validate_evidence(
    evidence_value: Any,
    *,
    source_revision: str,
    steps: dict[str, dict[str, Any]],
    artifact_ids: set[str],
    satisfied_claims: set[str],
    require_final: bool,
) -> None:
    evidence = require_object(evidence_value, "evidence")
    require_keys(
        evidence,
        {
            "status",
            "source_revision",
            "tracked_source_clean",
            "artifact_refs",
            "validation_refs",
            "claim_refs",
            "files",
            "limitations",
            "finalized_at",
        },
        "evidence",
    )
    if evidence["status"] not in {"rehearsal", "final"}:
        raise RecordError("evidence.status must be rehearsal or final")
    if require_final and evidence["status"] != "final":
        raise RecordError("rehearsal evidence cannot satisfy the review gate")
    if evidence["status"] != "final":
        return
    if evidence["source_revision"] != source_revision:
        raise RecordError("final evidence has stale source identity")
    if not evidence["tracked_source_clean"]:
        raise RecordError("final evidence requires clean tracked source")
    for step_ref in require_list(evidence["validation_refs"], "evidence.validation_refs"):
        if step_ref not in steps or steps[step_ref]["state"] != "passed":
            raise RecordError(f"final evidence references incomplete validation: {step_ref}")
    required_steps = {
        step_id
        for step_id, step in steps.items()
        if step["completion_required"] and step["state"] != "skipped"
    }
    if not required_steps.issubset(set(evidence["validation_refs"])):
        raise RecordError("final evidence omits a completion-required validation step")
    if not set(evidence["artifact_refs"]).issubset(artifact_ids):
        raise RecordError("final evidence references an unknown artifact")
    if not set(evidence["claim_refs"]).issubset(satisfied_claims):
        raise RecordError("final evidence references an unsatisfied verification claim")
    for index, file_value in enumerate(require_list(evidence["files"], "evidence.files")):
        file_record = require_object(file_value, f"evidence.files[{index}]")
        require_keys(
            file_record,
            {"path", "digest", "channel", "capture_context"},
            f"evidence.files[{index}]",
        )
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(file_record["digest"])):
            raise RecordError(f"evidence.files[{index}].digest is not immutable")
    require_text(evidence["finalized_at"], "evidence.finalized_at")


def validate_verification_costs(value: Any) -> dict[str, dict[str, Any]]:
    costs: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(require_list(value, "capabilities.verification_costs")):
        item = require_object(raw, f"capabilities.verification_costs[{index}]")
        require_keys(item, {
            "id", "command", "claim_refs", "required_gate", "setup_seconds",
            "median_seconds", "p95_seconds", "mutable_resources", "reuse_policy",
            "measured_at", "evidence_ref",
        }, "verification cost")
        check_id = require_text(item["id"], "verification cost.id")
        if check_id in costs:
            raise RecordError(f"duplicate verification cost: {check_id}")
        require_text(item["command"], f"verification cost {check_id}.command")
        require_text(item["measured_at"], f"verification cost {check_id}.measured_at")
        require_text(item["evidence_ref"], f"verification cost {check_id}.evidence_ref")
        require_list(item["claim_refs"], f"verification cost {check_id}.claim_refs")
        require_list(item["mutable_resources"], f"verification cost {check_id}.mutable_resources")
        if not isinstance(item["required_gate"], bool):
            raise RecordError(f"verification cost {check_id}.required_gate must be boolean")
        require_choice(item["reuse_policy"], {"immutable", "candidate", "never"}, f"verification cost {check_id}.reuse_policy")
        for field in ("setup_seconds", "median_seconds", "p95_seconds"):
            number = item[field]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or number < 0:
                raise RecordError(f"verification cost {check_id}.{field} must be non-negative")
        if item["p95_seconds"] < item["median_seconds"]:
            raise RecordError(f"verification cost {check_id} has p95 below median")
        costs[check_id] = item
    return costs


def profile_check(value: Any) -> dict[str, Any]:
    """Build one measured cost entry from timestamped setup/run samples."""

    payload = require_object(value, "verification profile input")
    reject_secrets(payload)
    require_keys(payload, {
        "id", "command", "claim_refs", "required_gate", "mutable_resources",
        "reuse_policy", "evidence_ref", "samples",
    }, "verification profile input")
    samples = require_list(payload["samples"], "verification profile input.samples")
    if not samples:
        raise RecordError("verification profile requires measured samples")
    setup: list[float] = []
    duration: list[float] = []
    measured_at = ""
    for index, raw in enumerate(samples):
        sample = require_object(raw, f"verification profile input.samples[{index}]")
        require_keys(sample, {"setup_seconds", "run_seconds", "measured_at"}, "verification sample")
        for field in ("setup_seconds", "run_seconds"):
            number = sample[field]
            if isinstance(number, bool) or not isinstance(number, (int, float)) or number < 0:
                raise RecordError(f"verification sample {index}.{field} must be non-negative")
        setup.append(sample["setup_seconds"])
        duration.append(sample["run_seconds"])
        measured_at = max(measured_at, require_text(sample["measured_at"], f"verification sample {index}.measured_at"))
    ordered = sorted(duration)
    cost = {key: payload[key] for key in (
        "id", "command", "claim_refs", "required_gate", "mutable_resources",
        "reuse_policy", "evidence_ref",
    )}
    cost.update({
        "setup_seconds": statistics.median(setup),
        "median_seconds": statistics.median(duration),
        "p95_seconds": ordered[math.ceil(0.95 * len(ordered)) - 1],
        "measured_at": measured_at,
    })
    validate_verification_costs([cost])
    return cost


def validate_verification_runs(
    value: Any, *, source_revision: str, costs: dict[str, dict[str, Any]] | None = None,
) -> None:
    runs: dict[str, dict[str, Any]] = {}
    executed: dict[tuple[str, str, str, str, str, str], str] = {}
    groups: dict[str, list[dict[str, Any]]] = {}
    for index, raw in enumerate(require_list(value, "verification_runs")):
        run = require_object(raw, f"verification_runs[{index}]")
        require_keys(run, {
            "id", "check_id", "environment", "platform", "source_revision", "input_digest",
            "artifact_digest", "started_at", "duration_seconds", "result", "phase",
            "execution", "reused_from", "claim_refs", "isolation_refs",
            "overlap_group", "capacity_evidence_ref", "invalidation_reason",
        }, "verification run")
        run_id = require_text(run["id"], "verification run.id")
        if run_id in runs:
            raise RecordError(f"duplicate verification run id: {run_id}")
        check_id = require_text(run["check_id"], f"verification run {run_id}.check_id")
        if costs is not None and check_id not in costs:
            raise RecordError(f"verification run {run_id} has no measured cost inventory entry")
        for field in ("environment", "platform", "source_revision", "started_at"):
            require_text(run[field], f"verification run {run_id}.{field}")
        if run["source_revision"] != source_revision and not run["invalidation_reason"]:
            raise RecordError(f"verification run {run_id} has stale source revision without invalidation")
        if not DIGEST_PATTERN.fullmatch(str(run["input_digest"])):
            raise RecordError(f"verification run {run_id} has invalid input digest")
        if run["artifact_digest"] and not DIGEST_PATTERN.fullmatch(str(run["artifact_digest"])):
            raise RecordError(f"verification run {run_id} has invalid artifact digest")
        require_choice(run["result"], {"passed", "failed", "blocked"}, f"verification run {run_id}.result")
        require_choice(run["phase"], {"iteration", "final"}, f"verification run {run_id}.phase")
        require_choice(run["execution"], {"executed", "reused"}, f"verification run {run_id}.execution")
        duration = run["duration_seconds"]
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration < 0:
            raise RecordError(f"verification run {run_id} has invalid duration")
        require_list(run["claim_refs"], f"verification run {run_id}.claim_refs")
        isolation = require_list(run["isolation_refs"], f"verification run {run_id}.isolation_refs")
        group = run["overlap_group"]
        if group:
            require_text(group, f"verification run {run_id}.overlap_group")
            require_text(run["capacity_evidence_ref"], f"verification run {run_id}.capacity_evidence_ref")
            if not isolation:
                raise RecordError(f"concurrent verification run {run_id} lacks isolated resources")
            for other in groups.get(group, []):
                if set(isolation) & set(other["isolation_refs"]):
                    raise RecordError(f"concurrent verification runs share mutable state: {run_id}")
            groups.setdefault(group, []).append(run)
        identity = (check_id, run["environment"], run["platform"], run["source_revision"], run["input_digest"], run["phase"])
        if run["execution"] == "reused":
            origin = runs.get(run["reused_from"])
            if origin is None or origin["result"] != "passed" or origin["execution"] != "executed":
                raise RecordError(f"verification run {run_id} lacks a prior passed execution")
            origin_identity = (origin["check_id"], origin["environment"], origin["platform"], origin["source_revision"], origin["input_digest"], origin["phase"])
            if identity != origin_identity or run["result"] != "passed":
                raise RecordError(f"verification run {run_id} cannot reuse mismatched evidence")
            if costs is not None and costs[check_id]["reuse_policy"] == "never":
                raise RecordError(f"verification run {run_id} cannot reuse this check")
        elif run["result"] == "passed":
            if identity in executed and not run["invalidation_reason"]:
                raise RecordError(f"verification run {run_id} repeats an unchanged passed check")
            executed[identity] = run_id
        runs[run_id] = run


def verification_plan(
    costs: list[dict[str, Any]], runs: list[dict[str, Any]], *,
    source_revision: str, environment: str, platform: str, input_digests: dict[str, str],
) -> list[dict[str, Any]]:
    """Select reusable final checks by exact identity; never reuse an unmeasured shortcut."""

    inventory = validate_verification_costs(costs)
    plan = []
    for check_id, cost in inventory.items():
        digest = input_digests.get(check_id)
        if not digest or not DIGEST_PATTERN.fullmatch(digest):
            plan.append({"check_id": check_id, "action": "run", "reason": "missing current input digest"})
            continue
        previous = next((run for run in reversed(runs) if
            run.get("check_id") == check_id and run.get("environment") == environment
            and run.get("platform") == platform
            and run.get("source_revision") == source_revision
            and run.get("input_digest") == digest and run.get("phase") == "final"), None)
        origin = previous
        if previous and previous.get("execution") == "reused":
            origin = next((run for run in runs if run.get("id") == previous.get("reused_from")), None)
        if (previous and previous.get("result") == "passed" and origin
                and origin.get("result") == "passed" and origin.get("execution") == "executed"
                and (cost["reuse_policy"] != "immutable" or origin.get("artifact_digest"))
                and cost["reuse_policy"] != "never"):
            plan.append({"check_id": check_id, "action": "reuse", "run_id": origin["id"],
                         "estimated_seconds_saved": cost["setup_seconds"] + cost["median_seconds"]})
        else:
            plan.append({"check_id": check_id, "action": "run", "reason": "no valid final evidence"})
    return plan


def next_external_step(value: Any) -> dict[str, Any] | None:
    """Return the first actionable or blocked provider step after verified dependencies."""

    external = require_object(value, "external_work")
    steps = require_list(external.get("provider_steps"), "external_work.provider_steps")
    states = {step["id"]: step["state"] for step in steps}
    for step in steps:
        if step["state"] == "flow_verified":
            continue
        if all(states.get(dep) == "flow_verified" for dep in step["dependencies"]):
            return step
    return None


def source_recovery_plan(value: Any, *, target: str, source_identity: str) -> dict[str, Any]:
    """Choose only an authorized route to the same authoritative source."""

    external = require_object(value, "external_work")
    routes = [route for route in require_list(external.get("source_routes"), "external_work.source_routes")
              if route["target"] == target and route["source_identity"] == source_identity
              and route["authorization_ref"]]
    verified = next((route for route in routes if route["state"] == "verified"), None)
    if verified:
        return {"action": "use_verified", "route_id": verified["id"], "channel": verified["channel"]}
    available = next((route for route in routes if route["state"] == "available"), None)
    if available:
        return {"action": "check_authorized_route", "route_id": available["id"], "channel": available["channel"]}
    return {"action": "blocked", "reason": "no verified or available authorized route to the same source"}


def validate_external_work(value: Any, *, require_final: bool) -> None:
    external = require_object(value, "external_work")
    require_keys(external, {"source_routes", "provider_steps", "artifact_checks"}, "external_work")
    route_ids: set[str] = set()
    for index, raw in enumerate(require_list(external["source_routes"], "external_work.source_routes")):
        route = require_object(raw, f"external_work.source_routes[{index}]")
        require_keys(route, {"id", "target", "source_identity", "channel", "authorization_ref", "state", "failure_class", "checked_at", "evidence_ref"}, "source route")
        route_id = require_text(route["id"], "source route.id")
        if route_id in route_ids:
            raise RecordError(f"duplicate source route: {route_id}")
        route_ids.add(route_id)
        for field in ("target", "source_identity", "channel", "authorization_ref", "checked_at"):
            require_text(route[field], f"source route {route_id}.{field}")
        require_choice(route["state"], {"available", "failed", "verified"}, f"source route {route_id}.state")
        if route["state"] == "failed":
            require_choice(route["failure_class"], SOURCE_FAILURES, f"source route {route_id}.failure_class")
        if route["state"] in {"failed", "verified"}:
            require_text(route["evidence_ref"], f"source route {route_id}.evidence_ref")
    steps: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(require_list(external["provider_steps"], "external_work.provider_steps")):
        step = require_object(raw, f"external_work.provider_steps[{index}]")
        require_keys(step, {"id", "target", "environment", "action", "dependencies", "state", "required", "observations", "evidence_ref", "checked_at", "blocker"}, "provider step")
        step_id = require_text(step["id"], "provider step.id")
        if step_id in steps:
            raise RecordError(f"duplicate provider step: {step_id}")
        for field in ("target", "environment", "action"):
            require_text(step[field], f"provider step {step_id}.{field}")
        require_choice(step["state"], EXTERNAL_STATES, f"provider step {step_id}.state")
        if not isinstance(step["required"], bool):
            raise RecordError(f"provider step {step_id}.required must be boolean")
        observations = require_list(step["observations"], f"provider step {step_id}.observations")
        stages = {"observed": 0, "saved": 1, "read_back": 2, "flow_verified": 3}
        prior_rank = -1
        for observation_index, raw_observation in enumerate(observations):
            observation = require_object(raw_observation, f"provider step {step_id}.observations[{observation_index}]")
            require_keys(observation, {"stage", "checked_at", "evidence_ref"}, "provider observation")
            stage = require_choice(observation["stage"], set(stages), f"provider step {step_id}.observation.stage")
            if stages[stage] < prior_rank:
                raise RecordError(f"provider step {step_id} has out-of-order observations")
            prior_rank = stages[stage]
            require_text(observation["checked_at"], f"provider step {step_id}.observation.checked_at")
            require_text(observation["evidence_ref"], f"provider step {step_id}.observation.evidence_ref")
        if step["state"] == "pending" and observations:
            raise RecordError(f"pending provider step {step_id} has completed observations")
        if step["state"] in {"observed", "saved", "read_back", "flow_verified"}:
            require_text(step["evidence_ref"], f"provider step {step_id}.evidence_ref")
            require_text(step["checked_at"], f"provider step {step_id}.checked_at")
            if not observations or observations[-1]["stage"] != step["state"]:
                raise RecordError(f"provider step {step_id} disagrees with observation history")
            if (step["evidence_ref"] != observations[-1]["evidence_ref"]
                    or step["checked_at"] != observations[-1]["checked_at"]):
                raise RecordError(f"provider step {step_id} has stale current evidence")
        if step["state"] == "flow_verified" and not any(
            observation["stage"] == "read_back" for observation in observations
        ):
            raise RecordError(f"provider step {step_id} lacks live readback before flow verification")
        if step["state"] == "blocked":
            require_text(step["blocker"], f"provider step {step_id}.blocker")
        if require_final and step["required"] and step["state"] != "flow_verified":
            raise RecordError(f"required provider step {step_id} lacks flow verification")
        steps[step_id] = step
    for step_id, step in steps.items():
        for dependency in require_list(step["dependencies"], f"provider step {step_id}.dependencies"):
            if dependency not in steps or dependency == step_id:
                raise RecordError(f"provider step {step_id} has invalid dependency")
            if step["state"] == "flow_verified" and steps[dependency]["state"] != "flow_verified":
                raise RecordError(f"provider step {step_id} has unverified dependency")
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(step_id: str) -> None:
        if step_id in visiting:
            raise RecordError("provider steps contain a dependency cycle")
        if step_id in visited:
            return
        visiting.add(step_id)
        for dependency in steps[step_id]["dependencies"]:
            visit(dependency)
        visiting.remove(step_id)
        visited.add(step_id)

    for step_id in steps:
        visit(step_id)
    check_ids: set[str] = set()
    for index, raw in enumerate(require_list(external["artifact_checks"], "external_work.artifact_checks")):
        check = require_object(raw, f"external_work.artifact_checks[{index}]")
        require_keys(check, {"id", "source_ref", "artifact_ref", "source_units", "verified_units", "state", "required", "evidence_ref"}, "artifact check")
        check_id = require_text(check["id"], "artifact check.id")
        if check_id in check_ids:
            raise RecordError(f"duplicate artifact check: {check_id}")
        check_ids.add(check_id)
        require_text(check["source_ref"], f"artifact check {check_id}.source_ref")
        require_text(check["artifact_ref"], f"artifact check {check_id}.artifact_ref")
        source_units = require_list(check["source_units"], f"artifact check {check_id}.source_units")
        verified_units = require_list(check["verified_units"], f"artifact check {check_id}.verified_units")
        for unit in source_units + verified_units:
            require_text(unit, f"artifact check {check_id}.unit")
        if len(source_units) != len(set(source_units)) or len(verified_units) != len(set(verified_units)):
            raise RecordError(f"artifact check {check_id} has duplicate source units")
        require_choice(check["state"], {"pending", "verified"}, f"artifact check {check_id}.state")
        if not isinstance(check["required"], bool):
            raise RecordError(f"artifact check {check_id}.required must be boolean")
        if check["state"] == "verified":
            require_text(check["evidence_ref"], f"artifact check {check_id}.evidence_ref")
            if not source_units or set(source_units) != set(verified_units):
                raise RecordError(f"artifact check {check_id} does not cover every source unit")
        if require_final and check["required"] and check["state"] != "verified":
            raise RecordError(f"required artifact check {check_id} is unverified")


def validate_record(
    payload: dict[str, Any],
    *,
    profile: dict[str, Any] | None = None,
    source_root: Path | None = None,
    require_final: bool = False,
) -> None:
    """Validate one workflow record and its cross-section invariants."""

    reject_secrets(payload)
    require_keys(
        payload,
        {
            "schema_version",
            "record_kind",
            "record_id",
            "repository",
            "provenance",
            "applicability",
            "status",
        },
        "$",
    )
    if payload["schema_version"] != SCHEMA_VERSION:
        raise RecordError(
            f"schema_version must be {SCHEMA_VERSION}; migrate incompatible records explicitly"
        )
    if payload["record_kind"] not in RECORD_KINDS:
        raise RecordError("record_kind is not supported")
    require_text(payload["record_id"], "record_id")
    repository = require_object(payload["repository"], "repository")
    require_keys(
        repository,
        {"identity", "default_branch", "revision"},
        "repository",
    )
    require_text(repository["identity"], "repository.identity")
    source_revision = require_text(repository["revision"], "repository.revision")
    provenance = require_object(payload["provenance"], "provenance")
    require_keys(provenance, {"created_at", "sources"}, "provenance")
    validate_evidence_sources(provenance["sources"], source_root=source_root)
    validate_applicability(payload["applicability"])
    blocked_capabilities = [
        name
        for name, capability in payload["applicability"].items()
        if capability["state"] == "blocked"
    ]
    if blocked_capabilities and payload["status"] not in {"planned", "blocked"}:
        raise RecordError(
            "blocking capabilities prevent execution: "
            + ", ".join(sorted(blocked_capabilities))
        )
    if payload["record_kind"] == "repository_profile":
        require_keys(payload, {"capabilities", "environment_keys"}, "$")
        capabilities = require_object(payload["capabilities"], "capabilities")
        if "verification_costs" in capabilities:
            validate_verification_costs(capabilities["verification_costs"])
        for index, key in enumerate(
            require_list(payload["environment_keys"], "environment_keys")
        ):
            if not isinstance(key, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
                raise RecordError(f"environment_keys[{index}] is not a key name")
        return

    require_keys(
        payload,
        {
            "profile_ref",
            "task",
            "scope",
            "approvals",
            "resources",
            "validation",
            "failures",
            "sandboxes",
            "artifacts",
            "operations",
            "verification",
            "evidence",
        },
        "$",
    )
    profile_ref = require_object(payload["profile_ref"], "profile_ref")
    require_keys(profile_ref, {"record_id", "digest"}, "profile_ref")
    if profile is not None:
        validate_record(profile, source_root=source_root)
        if profile["record_kind"] != "repository_profile":
            raise RecordError("profile_ref target is not a repository profile")
        if profile_ref["record_id"] != profile["record_id"]:
            raise RecordError("task consumed a different capability profile")
        if profile_ref["digest"] != content_digest(profile):
            raise RecordError("task capability profile is stale")
        if profile["repository"]["identity"] != repository["identity"]:
            raise RecordError("task and capability profile repositories differ")
    task = require_object(payload["task"], "task")
    require_keys(task, {"issue", "objective", "worktree", "base_revision"}, "task")
    issue_url = require_text(task["issue"], "task.issue")
    tracking_url(issue_url, "issues", issue_url=issue_url)
    require_text(task["objective"], "task.objective")
    require_text(task["worktree"], "task.worktree")
    plan_digest = task.get("plan_digest")
    may_wait_for_approval = payload["status"] in {"planned", "blocked"}
    if "plan_digest" in task and (
        not (plan_digest is None and may_wait_for_approval)
        and (not isinstance(plan_digest, str) or not DIGEST_PATTERN.fullmatch(plan_digest))
    ):
        raise RecordError("task.plan_digest must be a canonical SHA-256 digest")
    planning_mode = task.get("planning_mode", "legacy")
    if planning_mode not in {"legacy", "github_issue"}:
        raise RecordError("task.planning_mode is unsupported")
    if planning_mode == "github_issue":
        if "plan" not in task:
            raise RecordError("GitHub issue planning requires task.plan")
        validate_plan_comment(
            task["plan"],
            issue_url=issue_url,
            source_revision=source_revision,
            task_status=payload["status"],
        )
    if task["base_revision"] != source_revision and payload["status"] == "planned":
        raise RecordError("planned task base revision differs from repository revision")
    if "delivery_contract" in payload:
        validate_delivery_contract(payload["delivery_contract"], require_final=require_final)
    validate_scope(payload["scope"])
    approved_plan = False
    reclamation_approvals: dict[str, dict[str, Any]] = {}
    fallback_approval_ids: set[str] = set()
    for index, approval_value in enumerate(require_list(payload["approvals"], "approvals")):
        approval = require_object(approval_value, f"approvals[{index}]")
        require_keys(approval, {"id", "kind", "state", "scope"}, f"approvals[{index}]")
        approval_id = require_text(approval["id"], f"approvals[{index}].id")
        if approval["kind"] == "implementation_plan" and "plan_digest" in approval:
            if plan_digest is None:
                raise RecordError("versioned plan approval requires the current task.plan_digest")
        if approval["state"] == "approved":
            if approval["kind"] == "implementation_plan":
                if plan_digest is None:
                    approved_plan = True
                elif approval.get("plan_digest") == plan_digest:
                    require_text(approval.get("source_ref"), f"approvals[{index}].source_ref")
                    approved_plan = True
            elif approval["kind"] == "shared_resource_reclamation":
                reclamation_approvals[approval_id] = approval
            elif approval["kind"] == "verification_fallback":
                fallback_approval_ids.add(approval_id)
    if not may_wait_for_approval and not approved_plan:
        if plan_digest is not None:
            raise RecordError("execution requires approval of the current plan digest")
        raise RecordError("execution requires an approved implementation plan")
    validate_resources(
        payload["resources"],
        reclamation_approvals,
        task_status=payload["status"],
    )
    steps = validate_steps(payload["validation"])
    if payload["validation"]["source_revision"] != source_revision:
        raise RecordError("validation results have stale source identity")
    if "verification_runs" in payload:
        costs = None
        if profile is not None:
            costs = validate_verification_costs(profile["capabilities"].get("verification_costs", []))
        validate_verification_runs(payload["verification_runs"], source_revision=source_revision, costs=costs)
    if "external_work" in payload:
        validate_external_work(payload["external_work"], require_final=require_final)
    if "interaction_decisions" in payload:
        validate_interaction_decisions(payload["interaction_decisions"])
    if "pr_handoff" in payload:
        validate_pr_handoff(
            payload["pr_handoff"], task_status=payload["status"],
            require_final=require_final,
        )
    if "decomposition" in payload:
        validate_decomposition(payload["decomposition"])
    tracking_required = (
        require_final or payload["status"] not in {"planned", "blocked"}
        or payload.get("pr_handoff", {}).get("state") == "ready"
    )
    if "delivery_tracking" not in payload and tracking_required:
        raise RecordError("delivery_tracking is required for execution and final delivery")
    if "delivery_tracking" in payload:
        validate_delivery_tracking(
            payload["delivery_tracking"], issue_url=issue_url, task_status=payload["status"],
            require_final=require_final, pr_handoff=payload.get("pr_handoff"),
        )
    if payload["status"] == "completed" and "pr_handoff" not in payload:
        raise RecordError("completed task requires pr_handoff completion evidence")
    validate_failures(payload["failures"], steps)
    validate_sandboxes(payload["sandboxes"])
    artifact_ids = validate_artifacts(payload["artifacts"], source_revision)
    validate_operations(payload["operations"], source_revision)
    satisfied_claims = validate_verification(
        payload["verification"],
        artifact_ids=artifact_ids,
        fallback_approval_ids=fallback_approval_ids,
        require_final=require_final,
    )
    validate_evidence(
        payload["evidence"],
        source_revision=source_revision,
        steps=steps,
        artifact_ids=artifact_ids,
        satisfied_claims=satisfied_claims,
        require_final=require_final,
    )
    if "impact_inventory" in payload:
        if payload["evidence"]["status"] == "final":
            eligible_steps = set(payload["evidence"]["validation_refs"])
            eligible_claims = set(payload["evidence"]["claim_refs"])
        else:
            eligible_steps = set(steps)
            eligible_claims = satisfied_claims
        validate_impact_inventory(
            payload["impact_inventory"],
            evidence_status=payload["evidence"]["status"],
            valid_verification_refs=eligible_steps | eligible_claims,
        )
    if "diagnostics" in payload:
        included_surface_ids = None
        if "impact_inventory" in payload:
            included_surface_ids = {
                surface["id"] for surface in payload["impact_inventory"]["surfaces"]
                if surface["decision"] == "included"
            }
        validate_diagnostics(payload["diagnostics"], included_surface_ids=included_surface_ids)
    if "ui_conventions" in payload:
        validate_ui_conventions(payload["ui_conventions"], repository=repository["identity"],
                                require_final=require_final)
    if "merge_readiness" in payload:
        validate_merge_readiness(payload["merge_readiness"], source_revision=source_revision)
    if "release_readback" in payload:
        validate_release_readback(payload["release_readback"])
        if (payload["release_readback"]["state"] == "available"
                and "release_invariants" not in payload):
            raise RecordError("available release must declare critical invariant applicability")
    if "release_invariants" in payload:
        validate_release_invariants(
            payload["release_invariants"],
            release_readback=payload.get("release_readback"),
            require_final=require_final and payload.get("release_readback", {}).get("state")
            == "available",
        )


def state_directory(
    *,
    platform_name: str | None = None,
    environment: Any = None,
    home: Path | None = None,
) -> Path:
    """Resolve a scoped, cross-platform per-user workflow state directory."""

    selected_platform = platform_name or os.name
    selected_environment = environment if environment is not None else os.environ
    selected_home = home if home is not None else Path.home()
    def absolute_path(value: str, label: str) -> Path:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise RecordError(f"{label} must be an absolute path")
        return path

    explicit = selected_environment.get("AGENTIC_WORKFLOWS_WORKFLOW_STATE_DIR")
    if explicit:
        return absolute_path(explicit, "AGENTIC_WORKFLOWS_WORKFLOW_STATE_DIR")
    if selected_platform == "nt":
        base = selected_environment.get("LOCALAPPDATA")
        if base:
            return (
                absolute_path(base, "LOCALAPPDATA")
                / "Agentic Workflows"
                / "standard-development-workflow"
            )
    state_home = selected_environment.get("XDG_STATE_HOME")
    if state_home:
        return (
            absolute_path(state_home, "XDG_STATE_HOME")
            / "agentic-workflows"
            / "standard-development-workflow"
        )
    return (
        selected_home
        / ".local"
        / "state"
        / "agentic-workflows"
        / "standard-development-workflow"
    )


def summarize(payload: dict[str, Any]) -> str:
    """Return a concise human-readable record readback."""

    lines = [
        f"# {payload['record_kind'].replace('_', ' ').title()}",
        "",
        f"- Record: `{payload['record_id']}`",
        f"- Repository: `{payload['repository']['identity']}`",
        f"- Revision: `{payload['repository']['revision']}`",
        f"- Status: `{payload['status']}`",
    ]
    applicability = payload["applicability"]
    required = sorted(
        name for name, item in applicability.items() if item["state"] == "required"
    )
    blocked = sorted(
        name for name, item in applicability.items() if item["state"] == "blocked"
    )
    lines.append(f"- Required capabilities: {', '.join(required) if required else 'none'}")
    lines.append(f"- Blockers: {', '.join(blocked) if blocked else 'none'}")
    if payload["record_kind"] == "task_run":
        lines.extend(
            [
                f"- Issue: {payload['task']['issue']}",
                *(
                    [
                        f"- Plan: {payload['task']['plan']['comment_url']}",
                        f"- Plan state: `{payload['task']['plan']['state']}`",
                    ]
                    if payload["task"].get("planning_mode") == "github_issue"
                    else []
                ),
                f"- Objective: {payload['task']['objective']}",
                f"- Validation steps: {len(payload['validation']['steps'])}",
                f"- Open failures: {sum(not item['accepted'] for item in payload['failures'])}",
                f"- Evidence: `{payload['evidence']['status']}`",
            ]
        )
        if "delivery_contract" in payload:
            requirements = payload["delivery_contract"]["requirements"]
            outstanding = [item["id"] for item in requirements if item["state"] == "required" and item["status"] != "complete"]
            lines.append(f"- Outstanding deliverables: {', '.join(outstanding) if outstanding else 'none'}")
        if "verification_runs" in payload:
            runs = payload["verification_runs"]
            lines.append(f"- Verification runs: {len(runs)} ({sum(item['execution'] == 'reused' for item in runs)} reused)")
        if "external_work" in payload:
            next_step = next_external_step(payload["external_work"])
            lines.append(f"- Next external step: {next_step['id'] if next_step else 'none'}")
        if "interaction_decisions" in payload:
            plan = interaction_plan(payload["interaction_decisions"])
            lines.append(f"- User interaction: `{plan['action']}` ({', '.join(plan['question_ids']) or 'none'})")
        if "pr_handoff" in payload:
            lines.append(f"- PR handoff: `{payload['pr_handoff']['state']}`")
        if "decomposition" in payload:
            lines.append(f"- Delivery topology: `{payload['decomposition']['mode']}`")
        if payload.get("impact_inventory", {}).get("pattern_wide"):
            lines.append(
                f"- Impact surfaces: {len(payload['impact_inventory']['surfaces'])} inventoried"
            )
        if payload.get("diagnostics"):
            unproven = sum(
                item["root_cause_state"] == "unproven" for item in payload["diagnostics"]
            )
            missing = sum(item["trace_state"] == "missing" for item in payload["diagnostics"])
            lines.append(
                f"- Diagnostics: {len(payload['diagnostics'])} recorded, "
                f"{unproven} unproven, {missing} missing trace"
            )
        if "release_readback" in payload:
            release = payload["release_readback"]
            lines.append(f"- Release state: `{release['state']}`")
            if release["state"] != "not_requested":
                lines.append(f"- Target surface: `{release['target_surface'] or 'unknown'}`")
                lines.append(f"- Active revision: `{release['active_revision'] or 'unverified'}`")
                if release["deployment_id"]:
                    lines.append(f"- Deployment: `{release['deployment_id']}`")
                if release["target_url"]:
                    lines.append(f"- Target URL: {release['target_url']}")
        if "release_invariants" in payload:
            checks = payload["release_invariants"]["checks"]
            lines.append(f"- Critical release checks: {sum(c['critical'] for c in checks)} planned, "
                         f"{sum(c['critical'] and c['state'] == 'passed' for c in checks)} passed")
    return "\n".join(lines) + "\n"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("record", type=Path)
    validate_parser.add_argument("--profile", type=Path)
    validate_parser.add_argument("--source-root", type=Path)
    validate_parser.add_argument("--require-final", action="store_true")
    handoff_parser = subparsers.add_parser(
        "handoff-check", help="check the existing pr_handoff object without a full task record",
    )
    handoff_parser.add_argument("record", type=Path)
    handoff_parser.add_argument("--task-status", choices=("completed", "blocked"), default="completed")
    canonicalize_parser = subparsers.add_parser("canonicalize")
    canonicalize_parser.add_argument("record", type=Path)
    digest_parser = subparsers.add_parser("digest")
    digest_parser.add_argument("record", type=Path)
    summary_parser = subparsers.add_parser("summary")
    summary_parser.add_argument("record", type=Path)
    contract_parser = subparsers.add_parser("contract-update")
    contract_parser.add_argument("record", type=Path)
    contract_parser.add_argument("update", type=Path)
    plan_parser = subparsers.add_parser("verification-plan")
    plan_parser.add_argument("record", type=Path)
    plan_parser.add_argument("--profile", required=True, type=Path)
    plan_parser.add_argument("--environment", required=True)
    plan_parser.add_argument("--platform", required=True)
    plan_parser.add_argument("--input-digests", required=True, type=Path)
    external_parser = subparsers.add_parser("next-external")
    external_parser.add_argument("record", type=Path)
    interaction_parser = subparsers.add_parser("interaction-plan")
    interaction_parser.add_argument("record", type=Path)
    decomposition_parser = subparsers.add_parser("decomposition-plan")
    decomposition_parser.add_argument("request", type=Path)
    recovery_parser = subparsers.add_parser("source-recovery")
    recovery_parser.add_argument("record", type=Path)
    recovery_parser.add_argument("--target", required=True)
    recovery_parser.add_argument("--source-identity", required=True)
    profile_parser = subparsers.add_parser("profile-check")
    profile_parser.add_argument("samples", type=Path)
    subparsers.add_parser("state-dir")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "state-dir":
            print(state_directory())
            return 0
        if args.command == "profile-check":
            print(json.dumps(profile_check(load_record(args.samples)), indent=2))
            return 0
        if args.command == "decomposition-plan":
            print(json.dumps(decomposition_plan(load_record(args.request)), indent=2))
            return 0
        record = load_record(args.record)
        if args.command == "handoff-check":
            validate_pr_handoff(record, task_status=args.task_status, require_final=True)
            if args.task_status == "blocked":
                if record["state"] != "blocked":
                    raise RecordError("blocked handoff must record the concrete blocker")
                print(f"PR delivery incomplete: {record['blocker']}", file=sys.stderr)
                return 2
            print("PR handoff ready" if record["state"] == "ready" else "PR handoff not applicable")
            return 0
        if args.command == "contract-update":
            if record["record_kind"] != "task_run":
                raise RecordError("contract updates require a task-run record")
            record["delivery_contract"] = reconcile_delivery_contract(
                record.get("delivery_contract", {"requirements": [], "changes": []}),
                load_record(args.update),
            )
            validate_record(record)
            sys.stdout.buffer.write(canonical_bytes(record))
            return 0
        if args.command == "verification-plan":
            profile = load_record(args.profile)
            validate_record(record, profile=profile)
            input_digests = load_record(args.input_digests)
            print(json.dumps(verification_plan(
                profile["capabilities"].get("verification_costs", []),
                record.get("verification_runs", []),
                source_revision=record["repository"]["revision"],
                environment=args.environment,
                platform=args.platform,
                input_digests=input_digests,
            ), indent=2))
            return 0
        if args.command == "next-external":
            validate_record(record)
            print(json.dumps(next_external_step(record.get("external_work", {
                "provider_steps": [],
            })), indent=2))
            return 0
        if args.command == "interaction-plan":
            validate_record(record)
            print(json.dumps(interaction_plan(record.get("interaction_decisions", {
                "questions": [],
            })), indent=2))
            return 0
        if args.command == "source-recovery":
            validate_record(record)
            print(json.dumps(source_recovery_plan(record.get("external_work", {
                "source_routes": [],
            }), target=args.target, source_identity=args.source_identity), indent=2))
            return 0
        if args.command == "canonicalize":
            sys.stdout.buffer.write(canonical_bytes(record))
            return 0
        if args.command == "digest":
            print(content_digest(record))
            return 0
        if args.command == "summary":
            validate_record(record)
            print(summarize(record), end="")
            return 0
        profile = load_record(args.profile) if args.profile else None
        validate_record(
            record,
            profile=profile,
            source_root=args.source_root,
            require_final=args.require_final,
        )
        print(f"Valid {record['record_kind']} record: {record['record_id']}")
        return 0
    except RecordError as error:
        print(f"Workflow record validation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
