#!/usr/bin/env python3
"""Maintain a minimal, secret-safe Agent Orchestration coordination register."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import ntpath
import os
import re
import stat
import subprocess
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows uses msvcrt below.
    fcntl = None

try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX uses fcntl above.
    msvcrt = None

SCHEMA_VERSION = 7
GOAL_ONLY_SCHEMA_VERSION = 7
AUTOPILOT_SCHEMA_VERSION = 5
LAUNCH_SCHEMA_VERSION = 4
SAME_WORKTREE_SCHEMA_VERSION = 4
REVIEW_SCHEMA_VERSION = 3
WORKTREE_SCHEMA_VERSION = 2
LEGACY_SCHEMA_VERSION = 1
MAX_REVIEW_PASSES = 2
LUNA_MODEL = "gpt-5.6-luna"
MAX_REASONING_EFFORT = "max"
TASK_SETTING_STATES = {
    "not_applicable",
    "requested",
    "verified",
    "blocked",
    "legacy_unverified",
}
TASK_SETTING_BLOCKERS = {
    None,
    "host_capability",
    "model_mismatch",
    "reasoning_mismatch",
    "readback_unavailable",
}
LEGACY_MIGRATION_STATES = {None, "v4_detached_review", "v4_unverified_settings"}
CLAIM_STATES = {"claimed", "released"}
CLAIM_SCHEMA_VERSION = 1
CLAIM_KEYS = {
    "schema_version",
    "worktree_identity",
    "state",
    "controller_id",
    "task_id",
    "revision",
    "updated_at",
}
TASK_STATUSES = {
    "active",
    "waiting",
    "needs_attention",
    "blocked",
    "completed",
    "archived_known",
    "excluded",
}
GOAL_STATES = {"clarifying", "active", "completed", "blocked"}
ARCHIVE_STATES = {"unarchived", "archive_intent", "archived"}
RUN_MODES = {
    "observed_peer",
    "issue_session",
    "review_session",
    "verification_session",
}
PERMISSION_PROFILES = {"full_access"}
EXECUTION_MODES = {"goal"}
LAUNCH_VERIFICATION_STATES = {
    "requested",
    "preflight_verified",
    "created",
    "verified",
    "blocked",
}
LAUNCH_BLOCKER_CATEGORIES = {
    None,
    "host_capability",
    "permission_mismatch",
    "mode_mismatch",
    "readback_unavailable",
    "goal_scope",
}
SDLC_SCOPE_KINDS = {"all_open", "issues", "pr"}
SDLC_ROLES = {
    "control_plane",
    "inventory",
    "planner",
    "implementation",
    "review",
    "remediation",
    "verification",
    "ci_reconciliation",
    "delivery",
}
SDLC_RISK_LEVELS = {"low", "standard", "exceptional", "critical"}
SDLC_MODELS = {"gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"}
SDLC_REASONING_EFFORTS = {"medium", "high", "xhigh", "max"}
SDLC_SESSION_POLICIES = {
    "reuse_control_plane",
    "new_bounded",
    "new_issue_owner",
    "new_independent",
    "reuse_issue_owner",
    "new_delivery",
}
SDLC_WORKTREE_POLICIES = {
    "none",
    "fresh_issue",
    "detached_exact_head",
    "reuse_issue",
    "merged_revision",
}
SDLC_ROUTE_STATES = {"requested", "verified", "blocked"}
SDLC_ROUTE_BLOCKERS = {
    None,
    "readback_unavailable",
    "model_mismatch",
    "reasoning_mismatch",
    "worktree_mismatch",
}
SDLC_ISSUE_BOUND_ROLES = {"planner", "implementation", "remediation"}
SDLC_CANDIDATE_BOUND_ROLES = {"review", "verification", "delivery"}
REVIEW_OUTCOMES = {
    None,
    "pending",
    "clear",
    "findings",
    "passed",
    "failed",
    "blocked",
    "stale",
}
CLEANUP_STATES = {
    "not_applicable",
    "active",
    "cleanup_intent",
    "cleaned",
    "preserved",
}
CLOSEOUT_RESULTS = {
    None,
    "pending",
    "reconciled",
    "ineligible",
    "archived",
    "recovered",
}
BLOCKER_CATEGORIES = {
    None,
    "user_input",
    "dependency",
    "tooling",
    "unknown",
}
DECISION_POLICY = "autopilot"
GATE_DECISIONS = {"proceed", "revise", "retry", "skip", "stop", "blocked"}
GATE_TYPES = {
    "goal_scope",
    "plan",
    "replan",
    "implementation",
    "draft_pr",
    "pr_readiness",
    "review_remediation",
    "final_review",
    "merge",
    "synchronization",
    "staging",
    "production",
    "provider_mutation",
    "financial_activity",
    "destructive_recovery",
    "archive",
    "cleanup",
    "spawned_request",
}
DECISION_RESULT_STATES = {
    "active",
    "waiting",
    "blocked",
    "completed",
    "skipped",
    "stopped",
}
EVIDENCE_STATES = {"passed", "failed", "unavailable", "not_applicable"}
BASE_REGISTER_KEYS = {
    "schema_version",
    "project_id",
    "orchestrator_id",
    "decision_policy",
    "gate_decisions",
    "goal",
    "inventory",
    "launches",
    "tasks",
    "state_revision",
    "updated_at",
}
REGISTER_KEYS = BASE_REGISTER_KEYS | {
    "sdlc_scope",
    "routing_decisions",
}
V5_REGISTER_KEYS = BASE_REGISTER_KEYS
ORIGIN_V6_REGISTER_KEYS = REGISTER_KEYS - {"state_revision"}
ORIGIN_V5_REGISTER_KEYS = V5_REGISTER_KEYS - {"state_revision"}
V4_REGISTER_KEYS = V5_REGISTER_KEYS - {
    "decision_policy",
    "gate_decisions",
    "state_revision",
}
V4_AUTOPILOT_KEYS = V5_REGISTER_KEYS - {"state_revision"}
REGISTER_V3_KEYS = V4_REGISTER_KEYS - {"launches"}
REGISTER_V3_AUTOPILOT_KEYS = V4_AUTOPILOT_KEYS - {"launches"}
TASK_CORE_KEYS = {
    "thread_id",
    "host_id",
    "project_id",
    "title",
    "status",
    "issue_number",
    "pr_number",
    "cursor",
    "archive_state",
    "last_observed_at",
    "last_action_at",
    "terminal_verified",
    "final_read",
    "reconciled",
    "needed_for_dependency",
    "closeout_result",
    "blocker_category",
    "run_mode",
    "worktree_path",
    "branch_name",
    "base_revision",
    "subject_thread_id",
    "target_revision",
    "review_outcome",
    "cleanup_state",
}
TASK_EXTENSION_KEYS = {
    "requested_model",
    "effective_model",
    "requested_reasoning_effort",
    "effective_reasoning_effort",
    "settings_verification_state",
    "settings_blocker_category",
    "remediation_turn",
    "legacy_migration_state",
}
TASK_KEYS = TASK_CORE_KEYS | TASK_EXTENSION_KEYS
REVIEW_ATTEMPT_KEYS = {"review_order", "review_refresh"}
V4_TASK_KEYS = set(TASK_CORE_KEYS)
ORIGIN_V6_TASK_KEYS = set(TASK_CORE_KEYS)
ORIGIN_V5_TASK_KEYS = set(TASK_CORE_KEYS)
PREVIOUS_TASK_KEYS = TASK_CORE_KEYS - {
    "subject_thread_id",
    "target_revision",
    "review_outcome",
}
LEGACY_TASK_KEYS = PREVIOUS_TASK_KEYS - {
    "run_mode",
    "worktree_path",
    "branch_name",
    "base_revision",
    "cleanup_state",
}
REMEDIATION_TURN_KEYS = {
    "turn_id",
    "requested_model",
    "effective_model",
    "requested_reasoning_effort",
    "effective_reasoning_effort",
    "verification_state",
    "blocker_category",
}
LAUNCH_KEYS = {
    "issue_number",
    "requested_permission_profile",
    "effective_permission_profile",
    "requested_execution_mode",
    "effective_execution_mode",
    "goal_contract",
    "verification_state",
    "blocker_category",
    "thread_id",
    "host_id",
    "last_checked_at",
}
DELEGATED_GOAL_KEYS = {
    "objective",
    "project_boundary",
    "completion_conditions",
    "constraints",
}
SDLC_SCOPE_KEYS = {
    "kind",
    "issue_numbers",
    "pr_number",
    "normalized_selector",
    "last_checked_at",
}
SDLC_ROUTE_KEYS = {
    "route_id",
    "role",
    "issue_number",
    "pr_number",
    "risk",
    "requested_model",
    "effective_model",
    "requested_reasoning_effort",
    "effective_reasoning_effort",
    "session_policy",
    "worktree_policy",
    "effective_worktree_policy",
    "fallback_from_model",
    "verification_state",
    "blocker_category",
    "thread_id",
    "host_id",
    "last_checked_at",
}
GATE_DECISION_KEYS = {
    "decision_id",
    "gate_type",
    "decision",
    "task_id",
    "issue_number",
    "pr_number",
    "candidate_revision",
    "deployment_identity",
    "evidence_digests",
    "authority_envelope_digest",
    "reason_category",
    "decided_at",
    "resulting_state",
    "validity_digest",
    "request_digest",
    "invalidated_at",
}
TRIAGE_KEYS = {
    "issue_number",
    "priority",
    "blocked",
    "minor_dependency",
    "valuable",
    "overlap_keys",
}
FORBIDDEN_FIELD = re.compile(
    r"(?:^|_)(?:prompt|message|body|output|source_code|secret|token|password|"
    r"authorization|cookie|credential|environment_value)(?:_|$)",
    re.IGNORECASE,
)
SECRET_VALUE = re.compile(
    r"(?:gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|"
    r"password\s*[:=]|authorization\s*[:=]|api[_-]?key\s*[:=])",
    re.IGNORECASE,
)
FULL_GIT_OBJECT_ID = re.compile(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})")
GATE_IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9._:-]{0,199}")


class OrchestrationStateError(RuntimeError):
    """Raised when coordination state is unsafe or invalid."""


def now_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def parse_time(value: Any, label: str, *, nullable: bool = False) -> datetime | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value:
        raise OrchestrationStateError(f"{label} must be an RFC 3339 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise OrchestrationStateError(
            f"{label} must be an RFC 3339 timestamp"
        ) from error
    if parsed.tzinfo is None:
        raise OrchestrationStateError(f"{label} must include a timezone")
    return parsed


def require_text(
    value: Any,
    label: str,
    *,
    nullable: bool = False,
    maximum: int | None = None,
) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value:
        raise OrchestrationStateError(f"{label} must be non-empty text")
    if any(ord(character) < 32 for character in value):
        raise OrchestrationStateError(f"{label} contains control characters")
    if maximum is not None and len(value) > maximum:
        raise OrchestrationStateError(f"{label} exceeds {maximum} characters")
    if SECRET_VALUE.search(value):
        raise OrchestrationStateError(f"{label} contains secret-shaped text")
    return value


def validate_no_forbidden_fields(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise OrchestrationStateError(f"{path} contains a non-text field")
            if FORBIDDEN_FIELD.search(key):
                raise OrchestrationStateError(
                    f"{path}.{key} is a prohibited coordination-state field"
                )
            validate_no_forbidden_fields(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            validate_no_forbidden_fields(nested, f"{path}[{index}]")
    elif isinstance(value, str) and SECRET_VALUE.search(value):
        raise OrchestrationStateError(f"{path} contains secret-shaped text")


def positive_number(value: Any, label: str, *, nullable: bool = True) -> int | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise OrchestrationStateError(f"{label} must be a positive integer")
    return value


def absolute_path_text(value: Any, label: str, *, nullable: bool = True) -> str | None:
    text = require_text(value, label, nullable=nullable, maximum=1000)
    if text is None:
        return None
    windows_absolute = bool(re.match(r"^[A-Za-z]:[\\\\/]", text))
    if not Path(text).is_absolute() and not windows_absolute:
        raise OrchestrationStateError(f"{label} must be an absolute path")
    return text


def setting_token(value: Any, label: str, *, nullable: bool = False) -> str | None:
    text = require_text(value, label, nullable=nullable, maximum=40)
    if text is not None and not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", text):
        raise OrchestrationStateError(f"{label} must be a normalized setting token")
    return text


def identifier_token(
    value: Any,
    label: str,
    *,
    nullable: bool = False,
    maximum: int = 64,
) -> str | None:
    text = require_text(value, label, nullable=nullable, maximum=maximum)
    if text is not None and not re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", text):
        raise OrchestrationStateError(f"{label} must be a normalized identifier")
    return text


def gate_decision_id(value: Any, label: str) -> str | None:
    text = require_text(value, label, maximum=200)
    if text is not None and not GATE_IDENTIFIER.fullmatch(text):
        raise OrchestrationStateError(f"{label} must be a valid gate identifier")
    return text


def validate_remediation_turn(
    value: Any,
    label: str = "remediation_turn",
) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != REMEDIATION_TURN_KEYS:
        raise OrchestrationStateError(f"{label} fields differ")
    require_text(value["turn_id"], f"{label}.turn_id", maximum=200)
    requested_model = identifier_token(
        value["requested_model"], f"{label}.requested_model", nullable=True
    )
    effective_model = identifier_token(
        value["effective_model"], f"{label}.effective_model", nullable=True
    )
    requested_reasoning = identifier_token(
        value["requested_reasoning_effort"],
        f"{label}.requested_reasoning_effort",
        nullable=True,
    )
    effective_reasoning = identifier_token(
        value["effective_reasoning_effort"],
        f"{label}.effective_reasoning_effort",
        nullable=True,
    )
    state = value["verification_state"]
    if state not in {"requested", "verified", "blocked"}:
        raise OrchestrationStateError(f"{label}.verification_state is unsupported")
    blocker = value["blocker_category"]
    if blocker not in TASK_SETTING_BLOCKERS:
        raise OrchestrationStateError(f"{label}.blocker_category is unsupported")
    if state == "requested":
        if any(
            item is not None
            for item in (
                effective_model,
                effective_reasoning,
                blocker,
            )
        ):
            raise OrchestrationStateError(
                f"{label} requested state contains effective readback"
            )
    elif state == "verified":
        if (
            requested_model != LUNA_MODEL
            or effective_model != LUNA_MODEL
            or requested_reasoning != MAX_REASONING_EFFORT
            or effective_reasoning != MAX_REASONING_EFFORT
            or blocker is not None
        ):
            raise OrchestrationStateError(
                f"{label} verified state requires an exact Luna/max readback"
            )
    elif blocker is None:
        raise OrchestrationStateError(f"{label} blocked state requires a blocker")
    return value


def validate_task_settings(
    task: dict[str, Any],
    index: int,
    *,
    allow_unverified: bool = False,
) -> None:
    label = f"tasks[{index}]"
    requested_model = identifier_token(
        task["requested_model"], f"{label}.requested_model", nullable=True
    )
    effective_model = identifier_token(
        task["effective_model"], f"{label}.effective_model", nullable=True
    )
    requested_reasoning = identifier_token(
        task["requested_reasoning_effort"],
        f"{label}.requested_reasoning_effort",
        nullable=True,
    )
    effective_reasoning = identifier_token(
        task["effective_reasoning_effort"],
        f"{label}.effective_reasoning_effort",
        nullable=True,
    )
    state = task["settings_verification_state"]
    if state not in TASK_SETTING_STATES:
        raise OrchestrationStateError(
            f"{label}.settings_verification_state is unsupported"
        )
    blocker = task["settings_blocker_category"]
    if blocker not in TASK_SETTING_BLOCKERS:
        raise OrchestrationStateError(
            f"{label}.settings_blocker_category is unsupported"
        )
    validate_remediation_turn(task["remediation_turn"], f"{label}.remediation_turn")
    legacy_state = task["legacy_migration_state"]
    if legacy_state not in LEGACY_MIGRATION_STATES:
        raise OrchestrationStateError(
            f"{label}.legacy_migration_state is unsupported"
        )

    child_session = task["run_mode"] in {"review_session", "verification_session"}
    if not child_session:
        if any(
            item is not None
            for item in (
                requested_model,
                effective_model,
                requested_reasoning,
                effective_reasoning,
                blocker,
                legacy_state,
            )
        ) or state != "not_applicable":
            raise OrchestrationStateError(
                f"{label} non-review task must not contain review setting state"
            )
        if task["run_mode"] != "issue_session" and task["remediation_turn"] is not None:
            raise OrchestrationStateError(
                f"{label} observed peer must not contain a remediation turn"
            )
        if (
            task["run_mode"] == "issue_session"
            and task["remediation_turn"] is not None
            and task["remediation_turn"]["verification_state"] == "blocked"
        ):
            if task["status"] != "blocked" or task["blocker_category"] is None:
                raise OrchestrationStateError(
                    f"{label} failed remediation readback requires a blocked "
                    "no-source-work state"
                )
        return

    if task["remediation_turn"] is not None:
        raise OrchestrationStateError(
            f"{label} review or verification task must not contain a remediation turn"
        )
    if legacy_state is not None:
        if (
            requested_model is not None
            or effective_model is not None
            or requested_reasoning is not None
            or effective_reasoning is not None
            or state != "legacy_unverified"
            or blocker != "readback_unavailable"
        ):
            raise OrchestrationStateError(
                f"{label} legacy task must preserve missing Luna/max readback"
            )
        return

    if requested_model != LUNA_MODEL:
        raise OrchestrationStateError(
            f"{label} requested_model must be {LUNA_MODEL}"
        )
    if requested_reasoning != MAX_REASONING_EFFORT:
        raise OrchestrationStateError(
            f"{label} requested_reasoning_effort must be {MAX_REASONING_EFFORT}"
        )
    if state == "requested":
        if any(
            item is not None
            for item in (
                effective_model,
                effective_reasoning,
                blocker,
            )
        ):
            raise OrchestrationStateError(
                f"{label} requested setting state contains premature readback"
            )
        if not allow_unverified:
            raise OrchestrationStateError(
                f"{label} session requires verified Luna/max readback"
            )
    elif state == "verified":
        if (
            effective_model != LUNA_MODEL
            or effective_reasoning != MAX_REASONING_EFFORT
            or blocker is not None
        ):
            raise OrchestrationStateError(
                f"{label} verified setting state requires an exact Luna/max readback"
            )
    elif state == "blocked":
        if blocker is None:
            raise OrchestrationStateError(
                f"{label} blocked setting state requires a blocker"
            )
        if not allow_unverified and task["status"] != "blocked":
            raise OrchestrationStateError(
                f"{label} blocked setting state requires blocked task status"
            )
    else:
        raise OrchestrationStateError(
            f"{label} setting state is not a terminal or requested state"
        )
def validate_delegated_goal(
    goal_value: Any,
    *,
    index: int = 0,
    nullable: bool = False,
) -> dict[str, str] | None:
    if goal_value is None and nullable:
        return None
    if not isinstance(goal_value, dict):
        raise OrchestrationStateError(
            f"launches[{index}].goal_contract must be an object"
        )
    if set(goal_value) != DELEGATED_GOAL_KEYS:
        missing = sorted(DELEGATED_GOAL_KEYS - set(goal_value))
        unexpected = sorted(set(goal_value) - DELEGATED_GOAL_KEYS)
        raise OrchestrationStateError(
            f"launches[{index}].goal_contract fields differ: "
            f"missing={missing}, unexpected={unexpected}"
        )
    return {
        "objective": str(
            require_text(
                goal_value["objective"],
                f"launches[{index}].goal_contract.objective",
                maximum=240,
            )
        ),
        "project_boundary": str(
            require_text(
                goal_value["project_boundary"],
                f"launches[{index}].goal_contract.project_boundary",
                maximum=240,
            )
        ),
        "completion_conditions": str(
            require_text(
                goal_value["completion_conditions"],
                f"launches[{index}].goal_contract.completion_conditions",
                maximum=500,
            )
        ),
        "constraints": str(
            require_text(
                goal_value["constraints"],
                f"launches[{index}].goal_contract.constraints",
                maximum=500,
            )
        ),
}


def validate_launch(launch_value: Any, index: int = 0) -> dict[str, Any]:
    if not isinstance(launch_value, dict):
        raise OrchestrationStateError(f"launches[{index}] must be an object")
    if set(launch_value) != LAUNCH_KEYS:
        missing = sorted(LAUNCH_KEYS - set(launch_value))
        unexpected = sorted(set(launch_value) - LAUNCH_KEYS)
        raise OrchestrationStateError(
            f"launches[{index}] fields differ: missing={missing}, "
            f"unexpected={unexpected}"
        )
    launch = launch_value
    positive_number(launch["issue_number"], f"launches[{index}].issue_number")
    if launch["requested_permission_profile"] not in PERMISSION_PROFILES:
        raise OrchestrationStateError(
            f"launches[{index}].requested_permission_profile must be full_access"
        )
    setting_token(
        launch["effective_permission_profile"],
        f"launches[{index}].effective_permission_profile",
        nullable=True,
    )
    if launch["requested_execution_mode"] != "goal":
        raise OrchestrationStateError(
            f"launches[{index}].requested_execution_mode must be goal"
        )
    setting_token(
        launch["effective_execution_mode"],
        f"launches[{index}].effective_execution_mode",
        nullable=True,
    )
    state = launch["verification_state"]
    if state not in LAUNCH_VERIFICATION_STATES:
        raise OrchestrationStateError(
            f"launches[{index}].verification_state is unsupported"
        )
    blocker = launch["blocker_category"]
    if blocker not in LAUNCH_BLOCKER_CATEGORIES:
        raise OrchestrationStateError(
            f"launches[{index}].blocker_category is unsupported"
        )
    thread_id = require_text(
        launch["thread_id"],
        f"launches[{index}].thread_id",
        nullable=True,
        maximum=200,
    )
    host_id = require_text(
        launch["host_id"],
        f"launches[{index}].host_id",
        nullable=True,
        maximum=200,
    )
    parse_time(launch["last_checked_at"], f"launches[{index}].last_checked_at")
    validate_delegated_goal(
        launch["goal_contract"],
        index=index,
        nullable=state == "blocked",
    )

    effective_permission = launch["effective_permission_profile"]
    effective_mode = launch["effective_execution_mode"]
    if (thread_id is None) != (host_id is None):
        raise OrchestrationStateError(
            f"launches[{index}] thread_id and host_id must be recorded together"
        )
    if state in {"requested", "preflight_verified"}:
        if any(
            value is not None
            for value in (thread_id, host_id, effective_permission, effective_mode, blocker)
        ):
            raise OrchestrationStateError(
                f"launches[{index}] {state} state contains premature launch data"
            )
    elif state == "created":
        if thread_id is None or any(
            value is not None for value in (effective_permission, effective_mode, blocker)
        ):
            raise OrchestrationStateError(
                f"launches[{index}] created state requires only child task identity"
            )
    elif state == "verified":
        if (
            thread_id is None
            or blocker is not None
            or effective_permission != launch["requested_permission_profile"]
            or effective_mode != launch["requested_execution_mode"]
        ):
            raise OrchestrationStateError(
                f"launches[{index}] verified state requires exact effective settings"
            )
    elif blocker is None:
        raise OrchestrationStateError(
            f"launches[{index}] blocked state requires a blocker category"
        )
    return launch


def parse_sdlc_selector(
    selector: str | None,
    *,
    observed_at: str | None = None,
) -> dict[str, Any]:
    """Normalize only the selector supplied to an explicit SDLC-loop invocation."""
    raw = "" if selector is None else selector.strip()
    checked_at = observed_at or now_utc()
    parse_time(checked_at, "selector observed_at")
    if not raw:
        scope = {
            "kind": "all_open",
            "issue_numbers": [],
            "pr_number": None,
            "normalized_selector": "all open issues and PRs",
            "last_checked_at": checked_at,
        }
        return validate_sdlc_scope(scope)
    if re.search(r"(?:https?://|github\.com|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#)", raw):
        raise OrchestrationStateError("cross-repository selectors are unsupported")
    issue_match = re.fullmatch(r"(?i)issues?\s+(.+)", raw)
    pr_match = re.fullmatch(r"(?i)pr\s+(#?[1-9][0-9]*)", raw)
    if issue_match is not None:
        tokens = issue_match.group(1).split()
        if not tokens or any(not re.fullmatch(r"#[1-9][0-9]*", token) for token in tokens):
            raise OrchestrationStateError(
                "issue selectors must contain only space-separated #numbers"
            )
        numbers = sorted({int(token[1:]) for token in tokens})
        scope = {
            "kind": "issues",
            "issue_numbers": numbers,
            "pr_number": None,
            "normalized_selector": "issues " + " ".join(f"#{value}" for value in numbers),
            "last_checked_at": checked_at,
        }
        return validate_sdlc_scope(scope)
    if pr_match is not None:
        number = int(pr_match.group(1).lstrip("#"))
        scope = {
            "kind": "pr",
            "issue_numbers": [],
            "pr_number": number,
            "normalized_selector": f"PR #{number}",
            "last_checked_at": checked_at,
        }
        return validate_sdlc_scope(scope)
    raise OrchestrationStateError(
        "selector must be empty, issue #N, issues #N #M, or PR #N"
    )


def validate_sdlc_scope(scope_value: Any) -> dict[str, Any]:
    if not isinstance(scope_value, dict) or set(scope_value) != SDLC_SCOPE_KEYS:
        raise OrchestrationStateError("sdlc_scope fields differ")
    scope = scope_value
    if scope["kind"] not in SDLC_SCOPE_KINDS:
        raise OrchestrationStateError("sdlc_scope.kind is unsupported")
    numbers = scope["issue_numbers"]
    if not isinstance(numbers, list):
        raise OrchestrationStateError("sdlc_scope.issue_numbers must be a list")
    for index, number in enumerate(numbers):
        positive_number(number, f"sdlc_scope.issue_numbers[{index}]", nullable=False)
    if numbers != sorted(set(numbers)):
        raise OrchestrationStateError("sdlc_scope.issue_numbers must be sorted and unique")
    pr_number = positive_number(scope["pr_number"], "sdlc_scope.pr_number")
    normalized = require_text(
        scope["normalized_selector"], "sdlc_scope.normalized_selector", maximum=240
    )
    parse_time(scope["last_checked_at"], "sdlc_scope.last_checked_at")
    if scope["kind"] == "all_open" and (numbers or pr_number is not None):
        raise OrchestrationStateError("all-open scope cannot contain explicit numbers")
    if scope["kind"] == "issues" and (not numbers or pr_number is not None):
        raise OrchestrationStateError("issue scope requires issues only")
    if scope["kind"] == "pr" and (numbers or pr_number is None):
        raise OrchestrationStateError("PR scope requires exactly one PR")
    expected_normalized = {
        "all_open": "all open issues and PRs",
        "issues": "issues " + " ".join(f"#{value}" for value in numbers),
        "pr": f"PR #{pr_number}" if pr_number is not None else "",
    }[scope["kind"]]
    if normalized != expected_normalized:
        raise OrchestrationStateError("sdlc_scope normalized selector is inconsistent")
    return scope


def choose_sdlc_route(
    *,
    role: str,
    risk: str = "standard",
    luna_supported: bool = True,
    small_single_issue: bool = False,
) -> dict[str, Any]:
    if role not in SDLC_ROLES:
        raise OrchestrationStateError("SDLC role is unsupported")
    if risk not in SDLC_RISK_LEVELS:
        raise OrchestrationStateError("SDLC risk level is unsupported")
    if not isinstance(luna_supported, bool) or not isinstance(small_single_issue, bool):
        raise OrchestrationStateError("SDLC routing flags must be boolean")
    profiles = {
        "control_plane": ("gpt-5.6-terra", "high", "reuse_control_plane", "none"),
        "inventory": ("gpt-5.6-luna", "medium", "new_bounded", "none"),
        "planner": ("gpt-5.6-sol", "xhigh", "new_bounded", "none"),
        "implementation": ("gpt-5.6-terra", "high", "new_issue_owner", "fresh_issue"),
        "review": ("gpt-5.6-terra", "high", "new_independent", "detached_exact_head"),
        "remediation": ("gpt-5.6-terra", "high", "reuse_issue_owner", "reuse_issue"),
        "verification": ("gpt-5.6-luna", "high", "new_independent", "detached_exact_head"),
        "ci_reconciliation": ("gpt-5.6-terra", "high", "reuse_control_plane", "none"),
        "delivery": ("gpt-5.6-terra", "high", "new_delivery", "merged_revision"),
    }
    model, effort, session_policy, worktree_policy = profiles[role]
    fallback_from_model = None
    if role == "planner":
        if risk in {"exceptional", "critical"}:
            effort = "max"
        elif small_single_issue and risk == "low":
            effort = "high"
    elif role == "review":
        if risk == "low":
            model = "gpt-5.6-luna"
        elif risk == "exceptional":
            model, effort = "gpt-5.6-sol", "xhigh"
        elif risk == "critical":
            model, effort = "gpt-5.6-sol", "max"
    if role in {"inventory", "verification"} and not luna_supported:
        fallback_from_model = model
        model = "gpt-5.6-terra"
    return {
        "model": model,
        "reasoning_effort": effort,
        "session_policy": session_policy,
        "worktree_policy": worktree_policy,
        "fallback_from_model": fallback_from_model,
    }


def default_sdlc_route(
    *,
    route_id: str,
    role: str,
    risk: str,
    luna_supported: bool,
    small_single_issue: bool,
    observed_at: str,
    issue_number: int | None = None,
    pr_number: int | None = None,
) -> dict[str, Any]:
    profile = choose_sdlc_route(
        role=role,
        risk=risk,
        luna_supported=luna_supported,
        small_single_issue=small_single_issue,
    )
    route = {
        "route_id": route_id,
        "role": role,
        "issue_number": issue_number,
        "pr_number": pr_number,
        "risk": risk,
        "requested_model": profile["model"],
        "effective_model": None,
        "requested_reasoning_effort": profile["reasoning_effort"],
        "effective_reasoning_effort": None,
        "session_policy": profile["session_policy"],
        "worktree_policy": profile["worktree_policy"],
        "effective_worktree_policy": None,
        "fallback_from_model": profile["fallback_from_model"],
        "verification_state": "requested",
        "blocker_category": None,
        "thread_id": None,
        "host_id": None,
        "last_checked_at": observed_at,
    }
    return validate_sdlc_route(route)


def validate_sdlc_route(route_value: Any, index: int = 0) -> dict[str, Any]:
    label = f"routing_decisions[{index}]"
    if not isinstance(route_value, dict) or set(route_value) != SDLC_ROUTE_KEYS:
        raise OrchestrationStateError(f"{label} fields differ")
    route = route_value
    route_id = require_text(route["route_id"], f"{label}.route_id", maximum=200)
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:-]{0,199}", route_id):
        raise OrchestrationStateError(f"{label}.route_id is not normalized")
    if route["role"] not in SDLC_ROLES or route["risk"] not in SDLC_RISK_LEVELS:
        raise OrchestrationStateError(f"{label} role or risk is unsupported")
    positive_number(route["issue_number"], f"{label}.issue_number")
    positive_number(route["pr_number"], f"{label}.pr_number")
    if route["role"] in SDLC_ISSUE_BOUND_ROLES and route["issue_number"] is None:
        raise OrchestrationStateError(f"{label} {route['role']} role requires issue_number")
    if (
        route["role"] in SDLC_CANDIDATE_BOUND_ROLES
        and route["issue_number"] is None
        and route["pr_number"] is None
    ):
        raise OrchestrationStateError(
            f"{label} {route['role']} role requires issue_number or pr_number"
        )
    for field in ("requested_model", "effective_model", "fallback_from_model"):
        value = route[field]
        if value is not None and value not in SDLC_MODELS:
            raise OrchestrationStateError(f"{label}.{field} is unsupported")
    for field in ("requested_reasoning_effort", "effective_reasoning_effort"):
        value = route[field]
        if value is not None and value not in SDLC_REASONING_EFFORTS:
            raise OrchestrationStateError(f"{label}.{field} is unsupported")
    if route["session_policy"] not in SDLC_SESSION_POLICIES:
        raise OrchestrationStateError(f"{label}.session_policy is unsupported")
    for field in ("worktree_policy", "effective_worktree_policy"):
        value = route[field]
        if value is not None and value not in SDLC_WORKTREE_POLICIES:
            raise OrchestrationStateError(f"{label}.{field} is unsupported")
    if route["verification_state"] not in SDLC_ROUTE_STATES:
        raise OrchestrationStateError(f"{label}.verification_state is unsupported")
    if route["blocker_category"] not in SDLC_ROUTE_BLOCKERS:
        raise OrchestrationStateError(f"{label}.blocker_category is unsupported")
    thread_id = require_text(route["thread_id"], f"{label}.thread_id", nullable=True, maximum=200)
    host_id = require_text(route["host_id"], f"{label}.host_id", nullable=True, maximum=200)
    parse_time(route["last_checked_at"], f"{label}.last_checked_at")
    if (thread_id is None) != (host_id is None):
        raise OrchestrationStateError(f"{label} thread_id and host_id must be paired")
    effective = (
        route["effective_model"],
        route["effective_reasoning_effort"],
        route["effective_worktree_policy"],
    )
    if route["verification_state"] == "requested":
        if thread_id is not None or any(value is not None for value in effective) or route["blocker_category"] is not None:
            raise OrchestrationStateError(f"{label} requested state contains readback data")
    elif route["verification_state"] == "verified":
        requested = (
            route["requested_model"],
            route["requested_reasoning_effort"],
            route["worktree_policy"],
        )
        if thread_id is None or effective != requested or route["blocker_category"] is not None:
            raise OrchestrationStateError(f"{label} verified state requires exact readback")
    elif route["blocker_category"] is None:
        raise OrchestrationStateError(f"{label} blocked state requires a category")
    return route


def verify_sdlc_route(
    route: dict[str, Any],
    *,
    thread_id: str,
    host_id: str,
    effective_model: str | None,
    effective_reasoning_effort: str | None,
    effective_worktree_policy: str | None,
    observed_at: str | None = None,
) -> dict[str, Any]:
    validate_sdlc_route(route)
    if route["verification_state"] != "requested":
        raise OrchestrationStateError("SDLC route readback requires requested state")
    route["thread_id"] = require_text(thread_id, "route thread_id", maximum=200)
    route["host_id"] = require_text(host_id, "route host_id", maximum=200)
    route["effective_model"] = effective_model
    route["effective_reasoning_effort"] = effective_reasoning_effort
    route["effective_worktree_policy"] = effective_worktree_policy
    route["last_checked_at"] = observed_at or now_utc()
    if None in (effective_model, effective_reasoning_effort, effective_worktree_policy):
        route["blocker_category"] = "readback_unavailable"
    elif effective_model != route["requested_model"]:
        route["blocker_category"] = "model_mismatch"
    elif effective_reasoning_effort != route["requested_reasoning_effort"]:
        route["blocker_category"] = "reasoning_mismatch"
    elif effective_worktree_policy != route["worktree_policy"]:
        route["blocker_category"] = "worktree_mismatch"
    else:
        route["verification_state"] = "verified"
        return validate_sdlc_route(route)
    route["verification_state"] = "blocked"
    return validate_sdlc_route(route)


def set_sdlc_scope(register: dict[str, Any], scope: dict[str, Any]) -> None:
    validate_register(register)
    register["sdlc_scope"] = validate_sdlc_scope(copy.deepcopy(scope))
    register["updated_at"] = now_utc()
    validate_register(register)


def upsert_sdlc_route(register: dict[str, Any], route: dict[str, Any]) -> None:
    validate_register(register)
    validated = validate_sdlc_route(copy.deepcopy(route))
    current = next(
        (
            item
            for item in register["routing_decisions"]
            if item["route_id"] == validated["route_id"]
        ),
        None,
    )
    if current is not None:
        old_time = parse_time(current["last_checked_at"], "existing route check")
        new_time = parse_time(validated["last_checked_at"], "new route check")
        assert old_time is not None and new_time is not None
        if new_time < old_time:
            raise OrchestrationStateError("stale route observation cannot replace newer state")
        register["routing_decisions"].remove(current)
    register["routing_decisions"].append(validated)
    register["routing_decisions"].sort(key=lambda item: item["route_id"])
    register["updated_at"] = now_utc()
    validate_register(register)


def resolve_sdlc_route(register: dict[str, Any], route_id: str) -> dict[str, Any]:
    validate_register(register)
    selected_id = require_text(route_id, "route_id", maximum=200)
    matches = [
        route for route in register["routing_decisions"] if route["route_id"] == selected_id
    ]
    if not matches:
        raise OrchestrationStateError("SDLC route request is unknown")
    return matches[0]


def require_digest(value: Any, label: str, *, nullable: bool = False) -> str | None:
    text = require_text(value, label, nullable=nullable, maximum=64)
    if text is not None and not re.fullmatch(r"[0-9a-f]{64}", text):
        raise OrchestrationStateError(f"{label} must be a lowercase SHA-256 digest")
    return text


def validate_gate_decision(
    decision_value: Any,
    index: int = 0,
) -> dict[str, Any]:
    label = f"gate_decisions[{index}]"
    if not isinstance(decision_value, dict) or set(decision_value) != GATE_DECISION_KEYS:
        raise OrchestrationStateError(f"{label} fields differ")
    decision = decision_value
    gate_decision_id(decision["decision_id"], f"{label}.decision_id")
    if decision["gate_type"] not in GATE_TYPES:
        raise OrchestrationStateError(f"{label}.gate_type is unsupported")
    if decision["decision"] not in GATE_DECISIONS:
        raise OrchestrationStateError(f"{label}.decision is unsupported")
    require_text(decision["task_id"], f"{label}.task_id", nullable=True, maximum=200)
    positive_number(decision["issue_number"], f"{label}.issue_number")
    positive_number(decision["pr_number"], f"{label}.pr_number")
    candidate = require_text(
        decision["candidate_revision"],
        f"{label}.candidate_revision",
        nullable=True,
        maximum=64,
    )
    if candidate is not None and not FULL_GIT_OBJECT_ID.fullmatch(candidate):
        raise OrchestrationStateError(f"{label}.candidate_revision must be a full Git object ID")
    require_text(
        decision["deployment_identity"],
        f"{label}.deployment_identity",
        nullable=True,
        maximum=200,
    )
    evidence = decision["evidence_digests"]
    if not isinstance(evidence, list) or not evidence:
        raise OrchestrationStateError(f"{label}.evidence_digests must be non-empty")
    for item in evidence:
        require_digest(item, f"{label}.evidence_digests")
    if len(evidence) != len(set(evidence)):
        raise OrchestrationStateError(f"{label}.evidence_digests contains duplicates")
    require_digest(decision["authority_envelope_digest"], f"{label}.authority_envelope_digest")
    setting_token(decision["reason_category"], f"{label}.reason_category")
    parse_time(decision["decided_at"], f"{label}.decided_at")
    if decision["resulting_state"] not in DECISION_RESULT_STATES:
        raise OrchestrationStateError(f"{label}.resulting_state is unsupported")
    require_digest(decision["validity_digest"], f"{label}.validity_digest")
    require_digest(decision["request_digest"], f"{label}.request_digest", nullable=True)
    parse_time(decision["invalidated_at"], f"{label}.invalidated_at", nullable=True)
    if decision["gate_type"] == "spawned_request":
        if decision["task_id"] is None or decision["request_digest"] is None:
            raise OrchestrationStateError(f"{label} spawned request requires task and digest")
    elif decision["request_digest"] is not None:
        raise OrchestrationStateError(f"{label}.request_digest is only valid for spawned requests")
    return decision


def canonical_managed_path(value: str, label: str) -> str:
    windows_absolute = bool(re.match(r"^[A-Za-z]:[\\/]", value))
    if windows_absolute:
        normalized = ntpath.normpath(value)
        if normalized != value.replace("/", "\\"):
            raise OrchestrationStateError(f"{label} must be canonical")
        if os.name == "nt":
            path = Path(value)
            if path.is_symlink():
                raise OrchestrationStateError(f"{label} must not be a symlink")
            try:
                resolved = path.resolve(strict=False)
            except (OSError, RuntimeError) as error:
                raise OrchestrationStateError(
                    f"{label} cannot be resolved safely"
                ) from error
            return "windows:" + ntpath.normcase(str(resolved))
        return "windows:" + ntpath.normcase(normalized)
    normalized = os.path.normpath(value)
    if normalized != value:
        raise OrchestrationStateError(f"{label} must be canonical")
    path = Path(value)
    if path.is_symlink():
        raise OrchestrationStateError(f"{label} must not be a symlink")
    try:
        resolved = path.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise OrchestrationStateError(
            f"{label} cannot be resolved safely"
        ) from error
    # Use one realpath-normalized path identity for both absent and existent
    # worktrees. Switching from a path key to an inode key at creation time
    # would strand an existing claim; resolving parent symlinks keeps aliases
    # convergent without making identity depend on filesystem existence.
    return "path:" + os.path.normcase(str(resolved))


def canonicalize_legacy_worktree_path(value: str) -> str:
    if re.match(r"^[A-Za-z]:[\\/]", value):
        normalized = ntpath.normpath(value)
        if os.name == "nt":
            return str(Path(normalized).resolve(strict=False))
        return normalized
    return str(Path(value).resolve(strict=False))


def resolve_legacy_git_object_id(worktree_path: str, revision: str) -> str:
    path = Path(worktree_path)
    if not path.is_dir():
        raise OrchestrationStateError(
            "schema v2 abbreviated revision requires its original worktree "
            f"for explicit Git re-resolution: {worktree_path}"
        )
    try:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(path),
                "rev-parse",
                "--verify",
                f"{revision}^{{commit}}",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise OrchestrationStateError(
            "cannot re-resolve schema v2 abbreviated revision"
        ) from error
    resolved = result.stdout.strip()
    if result.returncode != 0 or not FULL_GIT_OBJECT_ID.fullmatch(resolved):
        raise OrchestrationStateError(
            "schema v2 abbreviated revision is missing or ambiguous; restore "
            "the recorded worktree and resolve it to a full Git object ID"
        )
    if not resolved.casefold().startswith(revision.casefold()):
        raise OrchestrationStateError(
            "schema v2 revision re-resolution returned a different object"
        )
    return resolved


def validate_task(
    task_value: Any,
    project_id: str,
    index: int = 0,
    *,
    allow_unverified_settings: bool = False,
) -> dict[str, Any]:
    if not isinstance(task_value, dict):
        raise OrchestrationStateError(f"tasks[{index}] must be an object")
    if set(task_value) - REVIEW_ATTEMPT_KEYS != TASK_KEYS:
        missing = sorted(TASK_KEYS - set(task_value))
        unexpected = sorted(set(task_value) - TASK_KEYS - REVIEW_ATTEMPT_KEYS)
        raise OrchestrationStateError(
            f"tasks[{index}] fields differ: missing={missing}, unexpected={unexpected}"
        )
    task = task_value
    require_text(task["thread_id"], f"tasks[{index}].thread_id")
    require_text(
        task["host_id"],
        f"tasks[{index}].host_id",
        nullable=True,
        maximum=200,
    )
    if task["project_id"] != project_id:
        raise OrchestrationStateError(
            f"tasks[{index}].project_id differs from the register"
        )
    require_text(task["title"], f"tasks[{index}].title", maximum=160)
    if task["status"] not in TASK_STATUSES:
        raise OrchestrationStateError(f"tasks[{index}].status is unsupported")
    positive_number(task["issue_number"], f"tasks[{index}].issue_number")
    positive_number(task["pr_number"], f"tasks[{index}].pr_number")
    require_text(
        task["cursor"],
        f"tasks[{index}].cursor",
        nullable=True,
        maximum=1000,
    )
    if task["archive_state"] not in ARCHIVE_STATES:
        raise OrchestrationStateError(
            f"tasks[{index}].archive_state is unsupported"
        )
    parse_time(task["last_observed_at"], f"tasks[{index}].last_observed_at")
    parse_time(
        task["last_action_at"],
        f"tasks[{index}].last_action_at",
        nullable=True,
    )
    for field in (
        "terminal_verified",
        "final_read",
        "reconciled",
        "needed_for_dependency",
    ):
        if not isinstance(task[field], bool):
            raise OrchestrationStateError(
                f"tasks[{index}].{field} must be boolean"
            )
    if task["closeout_result"] not in CLOSEOUT_RESULTS:
        raise OrchestrationStateError(
            f"tasks[{index}].closeout_result is unsupported"
        )
    if task["blocker_category"] not in BLOCKER_CATEGORIES:
        raise OrchestrationStateError(
            f"tasks[{index}].blocker_category is unsupported"
        )
    if task["run_mode"] not in RUN_MODES:
        raise OrchestrationStateError(f"tasks[{index}].run_mode is unsupported")
    if REVIEW_ATTEMPT_KEYS.intersection(task) and task["run_mode"] != "review_session":
        raise OrchestrationStateError("review attempt metadata requires a review session")
    if "review_order" in task:
        order = task["review_order"]
        if isinstance(order, bool) or not isinstance(order, int) or order < 1:
            raise OrchestrationStateError("review order must be a positive integer")
    if "review_refresh" in task:
        refresh = task["review_refresh"]
        if (
            not isinstance(refresh, dict)
            or set(refresh) != {"prior_thread_id", "evidence_ref"}
        ):
            raise OrchestrationStateError("review refresh requires a review and provenance")
        require_text(refresh["prior_thread_id"], "review refresh prior thread ID")
        require_text(refresh["evidence_ref"], "review refresh evidence reference", maximum=1000)
    absolute_path_text(
        task["worktree_path"],
        f"tasks[{index}].worktree_path",
        nullable=True,
    )
    branch_name = require_text(
        task["branch_name"],
        f"tasks[{index}].branch_name",
        nullable=True,
        maximum=240,
    )
    if branch_name is not None and (
        branch_name.startswith(("-", "."))
        or ".." in branch_name
        or branch_name.endswith((".", "/"))
    ):
        raise OrchestrationStateError(
            f"tasks[{index}].branch_name is unsafe"
        )
    base_revision = require_text(
        task["base_revision"],
        f"tasks[{index}].base_revision",
        nullable=True,
        maximum=64,
    )
    if base_revision is not None and not FULL_GIT_OBJECT_ID.fullmatch(
        base_revision
    ):
        raise OrchestrationStateError(
            f"tasks[{index}].base_revision must be a Git object ID"
        )
    require_text(
        task["subject_thread_id"],
        f"tasks[{index}].subject_thread_id",
        nullable=True,
        maximum=200,
    )
    target_revision = require_text(
        task["target_revision"],
        f"tasks[{index}].target_revision",
        nullable=True,
        maximum=64,
    )
    if target_revision is not None and not FULL_GIT_OBJECT_ID.fullmatch(
        target_revision
    ):
        raise OrchestrationStateError(
            f"tasks[{index}].target_revision must be a Git object ID"
        )
    if task["review_outcome"] not in REVIEW_OUTCOMES:
        raise OrchestrationStateError(
            f"tasks[{index}].review_outcome is unsupported"
        )
    if task["cleanup_state"] not in CLEANUP_STATES:
        raise OrchestrationStateError(
            f"tasks[{index}].cleanup_state is unsupported"
        )
    validate_task_settings(
        task,
        index,
        allow_unverified=allow_unverified_settings,
    )
    if task["run_mode"] == "issue_session":
        for field in (
            "issue_number",
            "host_id",
            "worktree_path",
            "branch_name",
            "base_revision",
        ):
            if task[field] is None:
                raise OrchestrationStateError(
                    f"tasks[{index}] issue session requires {field}"
                )
        if task["cleanup_state"] == "not_applicable":
            raise OrchestrationStateError(
                f"tasks[{index}] issue session requires cleanup tracking"
            )
        if any(
            task[field] is not None
            for field in (
                "subject_thread_id",
                "target_revision",
                "review_outcome",
            )
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] issue session must not contain review metadata"
            )
    elif task["run_mode"] in {"review_session", "verification_session"}:
        lane = "review" if task["run_mode"] == "review_session" else "verification"
        for field in (
            "host_id",
            "worktree_path",
            "base_revision",
            "subject_thread_id",
            "target_revision",
            "review_outcome",
        ):
            if task[field] is None:
                raise OrchestrationStateError(
                    f"tasks[{index}] {lane} session requires {field}"
                )
        if task["issue_number"] is None and task["pr_number"] is None:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} session requires an issue or PR reference"
            )
        if task["branch_name"] is not None:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} session must not claim branch ownership"
            )
        if task["subject_thread_id"] == task["thread_id"]:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} session must be independent"
            )
        if task["cleanup_state"] != "not_applicable":
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} session must not clean the shared worktree"
            )
        allowed_terminal = (
            {"clear", "findings"}
            if task["run_mode"] == "review_session"
            else {"passed", "failed"}
        )
        allowed_outcomes = {"pending", "blocked", "stale", *allowed_terminal}
        if task["review_outcome"] not in allowed_outcomes:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} outcome is unsupported"
            )
        active_review = task["archive_state"] != "archived"
        if (
            active_review
            and task["status"] == "blocked"
            and task["review_outcome"] != "blocked"
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] blocked review requires blocked outcome"
            )
        if (
            active_review
            and task["review_outcome"] == "blocked"
            and task["status"] != "blocked"
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] blocked outcome requires blocked status"
            )
        if (
            active_review
            and task["review_outcome"] in allowed_terminal
            and task["status"] != "completed"
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] terminal {lane} outcome requires completed status"
            )
        if (
            active_review
            and task["status"] == "completed"
            and task["review_outcome"] == "pending"
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] completed {lane} requires a terminal outcome"
            )
    elif any(
        task[field] is not None
        for field in (
            "worktree_path",
            "branch_name",
            "base_revision",
            "subject_thread_id",
            "target_revision",
            "review_outcome",
        )
    ) or task["cleanup_state"] != "not_applicable":
        raise OrchestrationStateError(
            f"tasks[{index}] observed peer must not own session resources"
        )
    if task["archive_state"] == "archived" and task["closeout_result"] != "archived":
        raise OrchestrationStateError(
            f"tasks[{index}] archived state requires archived closeout result"
        )
    if task["archive_state"] == "archived" and task["status"] != "archived_known":
        raise OrchestrationStateError(
            f"tasks[{index}] archived state requires archived-known status"
        )
    if task["status"] == "archived_known" and task["archive_state"] != "archived":
        raise OrchestrationStateError(
            f"tasks[{index}] archived-known status requires archived state"
        )
    return task


def _legacy_task_is_detached(
    task: dict[str, Any],
    tasks: list[dict[str, Any]],
) -> bool:
    if task["run_mode"] not in {"review_session", "verification_session"}:
        return False
    subject_id = task.get("subject_thread_id")
    if not isinstance(subject_id, str):
        raise OrchestrationStateError(
            "schema v4 review migration has no authoritative implementation "
            "subject; preserve the v4 register"
        )
    subject = next(
        (candidate for candidate in tasks if candidate.get("thread_id") == subject_id),
        None,
    )
    if not isinstance(subject, dict):
        raise OrchestrationStateError(
            "schema v4 review migration has no authoritative implementation "
            "subject; preserve the v4 register"
        )
    review_path = task.get("worktree_path")
    subject_path = subject.get("worktree_path")
    if not isinstance(review_path, str) or not isinstance(subject_path, str):
        raise OrchestrationStateError(
            "schema v4 review migration has ambiguous worktree ownership; "
            "preserve the v4 register"
        )
    try:
        return canonical_managed_path(review_path, "legacy review worktree") != (
            canonical_managed_path(subject_path, "legacy subject worktree")
        )
    except OrchestrationStateError as error:
        # A symlink, loop, permission failure, or other non-canonical path does
        # not prove that the legacy reviewer was detached. Raising here leaves
        # the v4 record and its ownership conflict untouched for recovery.
        raise OrchestrationStateError(
            "schema v4 review migration cannot prove detached worktree "
            "ownership; preserve the v4 register"
        ) from error


def _add_legacy_task_fields(
    task: dict[str, Any],
    *,
    detached: bool,
) -> None:
    child_session = task["run_mode"] in {"review_session", "verification_session"}
    if child_session:
        task.update(
            {
                "requested_model": None,
                "effective_model": None,
                "requested_reasoning_effort": None,
                "effective_reasoning_effort": None,
                "settings_verification_state": "legacy_unverified",
                "settings_blocker_category": "readback_unavailable",
                "remediation_turn": None,
                "legacy_migration_state": (
                    "v4_detached_review" if detached else "v4_unverified_settings"
                ),
            }
        )
    else:
        task.update(
            {
                "requested_model": None,
                "effective_model": None,
                "requested_reasoning_effort": None,
                "effective_reasoning_effort": None,
                "settings_verification_state": "not_applicable",
                "settings_blocker_category": None,
                "remediation_turn": None,
                "legacy_migration_state": None,
            }
        )


def migrate_register(
    payload: Any,
    *,
    legacy_revision_resolver: Callable[[str, str], str] | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise OrchestrationStateError("register must contain an object")
    version = payload.get("schema_version")
    register_keys = set(payload)
    if version == SCHEMA_VERSION and register_keys == REGISTER_KEYS:
        return validate_register(payload)

    accepted_register_keys: tuple[set[str], ...]
    if version == 6:
        accepted_register_keys = (REGISTER_KEYS, ORIGIN_V6_REGISTER_KEYS)
    elif version == AUTOPILOT_SCHEMA_VERSION:
        accepted_register_keys = (V5_REGISTER_KEYS, ORIGIN_V5_REGISTER_KEYS)
    elif version == SAME_WORKTREE_SCHEMA_VERSION:
        accepted_register_keys = (V4_REGISTER_KEYS, V4_AUTOPILOT_KEYS)
    elif version in {
        LEGACY_SCHEMA_VERSION,
        WORKTREE_SCHEMA_VERSION,
        REVIEW_SCHEMA_VERSION,
    }:
        accepted_register_keys = (REGISTER_V3_KEYS, REGISTER_V3_AUTOPILOT_KEYS)
    else:
        raise OrchestrationStateError(
            "unsupported schema version; migrate incompatible records explicitly"
        )
    migrated = copy.deepcopy(payload)
    if version in {
        LEGACY_SCHEMA_VERSION,
        WORKTREE_SCHEMA_VERSION,
        REVIEW_SCHEMA_VERSION,
        SAME_WORKTREE_SCHEMA_VERSION,
    } and {"sdlc_scope", "routing_decisions"} <= register_keys:
        migrated.pop("sdlc_scope")
        migrated.pop("routing_decisions")
        register_keys = set(migrated)

    matched_keys = next(
        (keys for keys in accepted_register_keys if register_keys == keys),
        None,
    )
    if matched_keys is None or not isinstance(migrated.get("tasks"), list):
        raise OrchestrationStateError("legacy register fields differ")

    if version in {
        LEGACY_SCHEMA_VERSION,
        WORKTREE_SCHEMA_VERSION,
        REVIEW_SCHEMA_VERSION,
        SAME_WORKTREE_SCHEMA_VERSION,
    }:
        expected_task_keys = {
            LEGACY_SCHEMA_VERSION: LEGACY_TASK_KEYS,
            WORKTREE_SCHEMA_VERSION: PREVIOUS_TASK_KEYS,
            REVIEW_SCHEMA_VERSION: V4_TASK_KEYS,
            SAME_WORKTREE_SCHEMA_VERSION: V4_TASK_KEYS,
        }[version]
    elif version == AUTOPILOT_SCHEMA_VERSION:
        expected_task_keys = (
            TASK_KEYS if matched_keys == V5_REGISTER_KEYS else ORIGIN_V5_TASK_KEYS
        )
    elif version == 6:
        expected_task_keys = (
            TASK_KEYS if matched_keys == REGISTER_KEYS else ORIGIN_V6_TASK_KEYS
        )
    else:
        expected_task_keys = ORIGIN_V6_TASK_KEYS

    for index, task in enumerate(migrated["tasks"]):
        if not isinstance(task, dict) or set(task) != expected_task_keys:
            raise OrchestrationStateError(
                f"schema v{version} tasks[{index}] fields differ"
            )
        if version == LEGACY_SCHEMA_VERSION:
            task.update(
                {
                    "run_mode": "observed_peer",
                    "worktree_path": None,
                    "branch_name": None,
                    "base_revision": None,
                    "cleanup_state": "not_applicable",
                }
            )
        if version in {LEGACY_SCHEMA_VERSION, WORKTREE_SCHEMA_VERSION}:
            task.update(
                {
                    "subject_thread_id": None,
                    "target_revision": None,
                    "review_outcome": None,
                }
            )
        if (
            version == WORKTREE_SCHEMA_VERSION
            and isinstance(task.get("worktree_path"), str)
        ):
            task["worktree_path"] = canonicalize_legacy_worktree_path(
                task["worktree_path"]
            )
        base_revision = task.get("base_revision")
        if (
            version == WORKTREE_SCHEMA_VERSION
            and isinstance(base_revision, str)
            and not FULL_GIT_OBJECT_ID.fullmatch(base_revision)
        ):
            worktree_path = task.get("worktree_path")
            if not isinstance(worktree_path, str):
                raise OrchestrationStateError(
                    "schema v2 abbreviated revision lacks a worktree for "
                    "explicit Git re-resolution"
                )
            resolver = legacy_revision_resolver or resolve_legacy_git_object_id
            resolved_revision = resolver(worktree_path, base_revision)
            if (
                not FULL_GIT_OBJECT_ID.fullmatch(resolved_revision)
                or not resolved_revision.casefold().startswith(
                    base_revision.casefold()
                )
            ):
                raise OrchestrationStateError(
                    "schema v2 revision re-resolution did not return the "
                    "matching full Git object ID"
                )
            task["base_revision"] = resolved_revision
        if set(task) == ORIGIN_V6_TASK_KEYS:
            if task["run_mode"] in {"review_session", "verification_session"}:
                task["cleanup_state"] = "not_applicable"
            _add_legacy_task_fields(
                task,
                detached=_legacy_task_is_detached(task, migrated["tasks"]),
            )

    if version in {
        LEGACY_SCHEMA_VERSION,
        WORKTREE_SCHEMA_VERSION,
        REVIEW_SCHEMA_VERSION,
        SAME_WORKTREE_SCHEMA_VERSION,
    }:
        if version != SAME_WORKTREE_SCHEMA_VERSION:
            migrated["launches"] = []
        migrated["state_revision"] = 0

    if version < GOAL_ONLY_SCHEMA_VERSION:
        # Earlier launch records could request Plan mode and did not retain the
        # explicit delegated goal required by v7. Do not manufacture either fact.
        migrated["launches"] = []
    if version < AUTOPILOT_SCHEMA_VERSION:
        migrated["decision_policy"] = DECISION_POLICY
        migrated["gate_decisions"] = []
        migrated["sdlc_scope"] = None
        migrated["routing_decisions"] = []
    elif version == AUTOPILOT_SCHEMA_VERSION:
        migrated.setdefault("state_revision", 0)
        migrated["sdlc_scope"] = None
        migrated["routing_decisions"] = []
    else:
        migrated.setdefault("state_revision", 0)

    migrated["schema_version"] = SCHEMA_VERSION
    return validate_register(migrated)


def validate_register(payload: Any) -> dict[str, Any]:
    validate_no_forbidden_fields(payload)
    if not isinstance(payload, dict):
        raise OrchestrationStateError("register must contain an object")
    if set(payload) != REGISTER_KEYS:
        missing = sorted(REGISTER_KEYS - set(payload))
        unexpected = sorted(set(payload) - REGISTER_KEYS)
        raise OrchestrationStateError(
            f"register fields differ: missing={missing}, unexpected={unexpected}"
        )
    if payload["schema_version"] != SCHEMA_VERSION:
        raise OrchestrationStateError(
            "unsupported schema version; migrate incompatible records explicitly"
        )
    revision = payload["state_revision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise OrchestrationStateError(
            "state_revision must be a non-negative integer"
        )
    project_id = require_text(payload["project_id"], "project_id")
    require_text(payload["orchestrator_id"], "orchestrator_id")
    if payload["decision_policy"] != DECISION_POLICY:
        raise OrchestrationStateError(
            "control-plane decision policy must always be autopilot"
        )
    if payload["sdlc_scope"] is not None:
        validate_sdlc_scope(payload["sdlc_scope"])
    if not isinstance(payload["routing_decisions"], list):
        raise OrchestrationStateError("routing_decisions must be a list")
    seen_route_ids: set[str] = set()
    seen_route_threads: set[str] = set()
    for index, route in enumerate(payload["routing_decisions"]):
        validated_route = validate_sdlc_route(route, index)
        route_id = str(validated_route["route_id"])
        if route_id in seen_route_ids:
            raise OrchestrationStateError(f"duplicate SDLC route ID: {route_id}")
        seen_route_ids.add(route_id)
        if validated_route["thread_id"] is not None:
            thread_id = str(validated_route["thread_id"])
            if thread_id in seen_route_threads:
                raise OrchestrationStateError(
                    f"duplicate SDLC route task ID: {thread_id}"
                )
            seen_route_threads.add(thread_id)
    if not isinstance(payload["gate_decisions"], list):
        raise OrchestrationStateError("gate_decisions must be a list")
    seen_decision_ids: set[str] = set()
    seen_request_digests: set[str] = set()
    for index, decision in enumerate(payload["gate_decisions"]):
        validated_decision = validate_gate_decision(decision, index)
        decision_id = str(validated_decision["decision_id"])
        if decision_id in seen_decision_ids:
            raise OrchestrationStateError(f"duplicate gate decision ID: {decision_id}")
        seen_decision_ids.add(decision_id)
        request_digest = validated_decision["request_digest"]
        if request_digest is not None:
            if request_digest in seen_request_digests:
                raise OrchestrationStateError(
                    f"duplicate spawned-request digest: {request_digest}"
                )
            seen_request_digests.add(str(request_digest))
    goal = payload["goal"]
    if not isinstance(goal, dict) or set(goal) != {"state", "last_checked_at"}:
        raise OrchestrationStateError("goal fields differ")
    if goal["state"] not in GOAL_STATES:
        raise OrchestrationStateError("goal.state is unsupported")
    parse_time(goal["last_checked_at"], "goal.last_checked_at", nullable=True)
    inventory = payload["inventory"]
    inventory_keys = {"complete", "limitation", "rotation_offset"}
    if not isinstance(inventory, dict) or set(inventory) != inventory_keys:
        raise OrchestrationStateError("inventory fields differ")
    if not isinstance(inventory["complete"], bool):
        raise OrchestrationStateError("inventory.complete must be boolean")
    if not isinstance(inventory["limitation"], str):
        raise OrchestrationStateError("inventory.limitation must be text")
    if len(inventory["limitation"]) > 240:
        raise OrchestrationStateError("inventory.limitation exceeds 240 characters")
    if SECRET_VALUE.search(inventory["limitation"]):
        raise OrchestrationStateError(
            "inventory.limitation contains secret-shaped text"
        )
    offset = inventory["rotation_offset"]
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise OrchestrationStateError(
            "inventory.rotation_offset must be a non-negative integer"
        )
    if not isinstance(payload["launches"], list):
        raise OrchestrationStateError("launches must be a list")
    seen_launch_issues: set[int] = set()
    seen_launch_threads: set[str] = set()
    for index, launch in enumerate(payload["launches"]):
        validated_launch = validate_launch(launch, index)
        issue_number = int(validated_launch["issue_number"])
        if issue_number in seen_launch_issues:
            raise OrchestrationStateError(
                f"duplicate launch issue number: {issue_number}"
            )
        seen_launch_issues.add(issue_number)
        if validated_launch["thread_id"] is not None:
            thread_id = str(validated_launch["thread_id"])
            if thread_id in seen_launch_threads:
                raise OrchestrationStateError(
                    f"duplicate launch task ID: {thread_id}"
                )
            seen_launch_threads.add(thread_id)
    if not isinstance(payload["tasks"], list):
        raise OrchestrationStateError("tasks must be a list")
    seen: set[str] = set()
    subject_sessions: list[tuple[int, dict[str, Any]]] = []
    managed_worktrees: dict[str, list[int]] = {}
    for index, task in enumerate(payload["tasks"]):
        validated = validate_task(task, str(project_id), index)
        thread_id = str(validated["thread_id"])
        if thread_id in seen:
            raise OrchestrationStateError(f"duplicate task ID: {thread_id}")
        seen.add(thread_id)
        worktree_path = validated["worktree_path"]
        if (
            worktree_path is not None
            and validated["legacy_migration_state"] != "v4_detached_review"
        ):
            worktree_key = canonical_managed_path(
                str(worktree_path),
                f"tasks[{index}].worktree_path",
            )
            managed_worktrees.setdefault(worktree_key, []).append(index)
        if validated["run_mode"] in {"review_session", "verification_session"}:
            subject_sessions.append((index, validated))
    tasks_by_id = {task["thread_id"]: task for task in payload["tasks"]}
    validate_review_refreshes(tasks_by_id)
    for index, session in subject_sessions:
        lane = "review" if session["run_mode"] == "review_session" else "verification"
        subject_thread_id = str(session["subject_thread_id"])
        if session["thread_id"] == payload["orchestrator_id"]:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} task must differ from the orchestrator"
            )
        if subject_thread_id not in tasks_by_id:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} subject is not in this project register"
            )
        subject = tasks_by_id[subject_thread_id]
        if subject["run_mode"] != "issue_session":
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} subject must be an issue session"
            )
        if (
            session["archive_state"] != "archived"
            and session["status"] in {"active", "waiting", "needs_attention"}
            and subject["archive_state"] != "unarchived"
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} subject must remain unarchived"
            )
        if session["issue_number"] != subject["issue_number"]:
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} issue differs from its subject"
            )
        if (
            session["pr_number"] is not None
            and session["pr_number"] != subject["pr_number"]
        ):
            raise OrchestrationStateError(
                f"tasks[{index}] {lane} PR differs from its subject"
            )
        if session["legacy_migration_state"] != "v4_detached_review":
            session_key = canonical_managed_path(
                str(session["worktree_path"]), f"tasks[{index}].worktree_path"
            )
            subject_index = payload["tasks"].index(subject)
            subject_key = canonical_managed_path(
                str(subject["worktree_path"]), f"tasks[{subject_index}].worktree_path"
            )
            if session_key != subject_key:
                raise OrchestrationStateError(
                    f"tasks[{index}] {lane} session must reuse its subject implementation worktree"
                )
            if session["status"] in {"active", "waiting", "needs_attention"} and subject[
                "status"
            ] != "waiting":
                raise OrchestrationStateError(
                    f"tasks[{index}] active {lane} session requires a quiescent waiting subject"
                )
    for worktree_key, indices in managed_worktrees.items():
        owners = [payload["tasks"][index] for index in indices]
        issue_owners = [task for task in owners if task["run_mode"] == "issue_session"]
        if len(issue_owners) != 1:
            raise OrchestrationStateError(
                "managed worktree reuse requires exactly one issue-session owner"
            )
        active_children = [
            task
            for task in owners
            if task["run_mode"] in {"review_session", "verification_session"}
            and task["archive_state"] != "archived"
            and task["status"] != "excluded"
        ]
        if len(active_children) > 1:
            raise OrchestrationStateError(
                "shared implementation worktree has concurrent review or verification owners"
            )
    parse_time(payload["updated_at"], "updated_at")
    return payload


def validate_review_refreshes(tasks_by_id: dict[str, dict[str, Any]]) -> None:
    orders: set[tuple[str, int]] = set()
    replaced: set[str] = set()
    for task in tasks_by_id.values():
        if "review_order" in task:
            order_key = (task["subject_thread_id"], task["review_order"])
            if order_key in orders:
                raise OrchestrationStateError("review order must be unique for its subject")
            orders.add(order_key)
        refresh = task.get("review_refresh")
        if refresh is None:
            continue
        prior_id = refresh["prior_thread_id"]
        prior = tasks_by_id.get(prior_id)
        if (
            prior is None
            or prior["run_mode"] != "review_session"
            or prior["subject_thread_id"] != task["subject_thread_id"]
            or (prior["pr_number"] is not None and prior["pr_number"] != task["pr_number"])
            or prior.get("review_order", 0) >= task.get("review_order", 0)
            or prior["review_outcome"] not in {"clear", "findings", "stale"}
            or not (prior["terminal_verified"] and prior["final_read"] and prior["reconciled"])
        ):
            raise OrchestrationStateError(
                "review refresh requires a prior reconciled attempt on the same subject"
            )
        if prior_id in replaced:
            raise OrchestrationStateError("a review attempt can have only one refresh successor")
        replaced.add(prior_id)
        if all(
            prior[field].casefold() == task[field].casefold()
            for field in ("base_revision", "target_revision")
        ):
            raise OrchestrationStateError("review refresh requires a fresh revision pair")


def latest_review(reviews: list[dict[str, Any]]) -> dict[str, Any] | None:
    ordered = [review for review in reviews if "review_order" in review]
    if ordered:
        return max(ordered, key=lambda review: review["review_order"])
    return reviews[0] if len(reviews) == 1 else None


def state_directory(
    *,
    platform_name: str | None = None,
    environment: Any = None,
    home: Path | None = None,
) -> Path:
    selected_platform = platform_name or os.name
    selected_environment = environment if environment is not None else os.environ
    selected_home = home if home is not None else Path.home()

    def absolute(value: str, label: str) -> Path:
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise OrchestrationStateError(f"{label} must be an absolute path")
        return path

    explicit = selected_environment.get("AGENTIC_WORKFLOWS_ORCHESTRATION_STATE_DIR")
    if explicit:
        return absolute(explicit, "AGENTIC_WORKFLOWS_ORCHESTRATION_STATE_DIR")
    if selected_platform == "nt" and selected_environment.get("LOCALAPPDATA"):
        return (
            absolute(selected_environment["LOCALAPPDATA"], "LOCALAPPDATA")
            / "Agentic Workflows"
            / "agent-orchestration"
        )
    if selected_environment.get("XDG_STATE_HOME"):
        return (
            absolute(selected_environment["XDG_STATE_HOME"], "XDG_STATE_HOME")
            / "agentic-workflows"
            / "agent-orchestration"
        )
    return selected_home / ".local" / "state" / "agentic-workflows" / "agent-orchestration"


def identity_digest(value: str) -> str:
    require_text(value, "identity")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def register_path(
    project_id: str,
    orchestrator_id: str,
    *,
    root: Path | None = None,
) -> Path:
    selected_root = (root or state_directory()).expanduser()
    if not selected_root.is_absolute():
        raise OrchestrationStateError("state root must be an absolute path")
    if selected_root.exists() and selected_root.is_symlink():
        raise OrchestrationStateError("state root must not be a symlink")
    path = (
        selected_root
        / identity_digest(project_id)
        / identity_digest(orchestrator_id)
        / "register.json"
    )
    try:
        path.relative_to(selected_root)
    except ValueError as error:
        raise OrchestrationStateError("register path escapes the state root") from error
    for candidate in (path.parent.parent, path.parent):
        if candidate.exists() and candidate.is_symlink():
            raise OrchestrationStateError("register path contains a symlink")
    return path


def new_register(
    project_id: str,
    orchestrator_id: str,
    *,
    timestamp: str | None = None,
) -> dict[str, Any]:
    current = timestamp or now_utc()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "project_id": project_id,
        "orchestrator_id": orchestrator_id,
        "decision_policy": DECISION_POLICY,
        "gate_decisions": [],
        "goal": {"state": "clarifying", "last_checked_at": None},
        "inventory": {
            "complete": False,
            "limitation": "Live project inventory has not been recorded.",
            "rotation_offset": 0,
        },
        "sdlc_scope": None,
        "routing_decisions": [],
        "launches": [],
        "tasks": [],
        "state_revision": 0,
        "updated_at": current,
    }
    return validate_register(payload)


def default_gate_decision(
    *,
    decision_id: str,
    gate_type: str,
    decision: str,
    evidence_digests: list[str],
    authority_envelope_digest: str,
    reason_category: str,
    resulting_state: str,
    validity_digest: str,
    decided_at: str,
    task_id: str | None = None,
    issue_number: int | None = None,
    pr_number: int | None = None,
    candidate_revision: str | None = None,
    deployment_identity: str | None = None,
    request_digest: str | None = None,
) -> dict[str, Any]:
    return validate_gate_decision(
        {
            "decision_id": decision_id,
            "gate_type": gate_type,
            "decision": decision,
            "task_id": task_id,
            "issue_number": issue_number,
            "pr_number": pr_number,
            "candidate_revision": candidate_revision,
            "deployment_identity": deployment_identity,
            "evidence_digests": evidence_digests,
            "authority_envelope_digest": authority_envelope_digest,
            "reason_category": reason_category,
            "decided_at": decided_at,
            "resulting_state": resulting_state,
            "validity_digest": validity_digest,
            "request_digest": request_digest,
            "invalidated_at": None,
        }
    )


def choose_autopilot_decision(
    *,
    gate_type: str,
    in_goal: bool,
    authority_available: bool,
    credentials_available: bool,
    required_evidence: str,
    safe_path_available: bool,
    remediation_available: bool = False,
    review_passes: int = 0,
    review_outcome: str | None = None,
    unrelated_review_drift: bool = False,
) -> str:
    if gate_type not in GATE_TYPES:
        raise OrchestrationStateError("autopilot gate type is unsupported")
    for label, value in (
        ("in_goal", in_goal),
        ("authority_available", authority_available),
        ("credentials_available", credentials_available),
        ("safe_path_available", safe_path_available),
        ("remediation_available", remediation_available),
        ("unrelated_review_drift", unrelated_review_drift),
    ):
        if not isinstance(value, bool):
            raise OrchestrationStateError(f"{label} must be boolean")
    if required_evidence not in EVIDENCE_STATES:
        raise OrchestrationStateError("required evidence state is unsupported")
    if isinstance(review_passes, bool) or not isinstance(review_passes, int) or review_passes < 0:
        raise OrchestrationStateError("review_passes must be a non-negative integer")
    if not in_goal:
        return "skip"
    if not authority_available or not credentials_available or not safe_path_available:
        return "blocked"
    if gate_type == "final_review" and review_outcome == "stale" and unrelated_review_drift:
        return "retry"
    if required_evidence in {"failed", "unavailable"}:
        return "retry" if remediation_available else "blocked"
    if gate_type == "final_review" and review_outcome != "clear":
        if review_passes >= MAX_REVIEW_PASSES:
            return "stop"
        return "revise" if review_outcome == "findings" else "retry"
    return "proceed"


def record_gate_decision(
    register: dict[str, Any],
    decision: dict[str, Any],
) -> dict[str, Any]:
    validate_register(register)
    validated = validate_gate_decision(copy.deepcopy(decision))
    candidate = copy.deepcopy(register)
    existing = next(
        (item for item in candidate["gate_decisions"] if item["decision_id"] == validated["decision_id"]),
        None,
    )
    if existing is not None:
        if existing == validated:
            return existing
        raise OrchestrationStateError("gate decision ID already identifies another record")
    if validated["request_digest"] is not None:
        duplicate = next(
            (item for item in candidate["gate_decisions"] if item["request_digest"] == validated["request_digest"]),
            None,
        )
        if duplicate is not None:
            if all(
                duplicate[field] == validated[field]
                for field in GATE_DECISION_KEYS - {"decision_id", "decided_at"}
            ):
                return duplicate
            raise OrchestrationStateError("spawned request already has a different bounded decision")
    binding = ("gate_type", "task_id", "issue_number", "pr_number")
    for current in candidate["gate_decisions"]:
        if current["invalidated_at"] is None and all(current[field] == validated[field] for field in binding):
            if current["validity_digest"] == validated["validity_digest"]:
                raise OrchestrationStateError("current gate evidence already has a different decision")
            current["invalidated_at"] = validated["decided_at"]
    candidate["gate_decisions"].append(validated)
    candidate["gate_decisions"].sort(key=lambda item: (item["decided_at"], item["decision_id"]))
    candidate["updated_at"] = now_utc()
    validate_register(candidate)
    register.clear()
    register.update(candidate)
    return validated


def choose_execution_mode(
    *,
    goal_contract: dict[str, str] | None = None,
) -> tuple[str, str]:
    validate_delegated_goal(goal_contract)
    return "goal", "explicit_goal"


def default_launch(
    *,
    issue_number: int,
    goal_contract: dict[str, str],
    observed_at: str,
) -> dict[str, Any]:
    launch = {
        "issue_number": issue_number,
        "requested_permission_profile": "full_access",
        "effective_permission_profile": None,
        "requested_execution_mode": "goal",
        "effective_execution_mode": None,
        "goal_contract": goal_contract,
        "verification_state": "requested",
        "blocker_category": None,
        "thread_id": None,
        "host_id": None,
        "last_checked_at": observed_at,
    }
    return validate_launch(launch)


def preflight_launch(
    launch: dict[str, Any],
    *,
    config_inheritance_supported: bool = False,
    permission_selection_supported: bool = False,
    permission_readback_supported: bool,
    mode_selection_supported: bool,
    mode_readback_supported: bool,
    observed_at: str | None = None,
) -> dict[str, Any]:
    validate_launch(launch)
    if launch["verification_state"] != "requested":
        raise OrchestrationStateError("launch preflight requires requested state")
    support = {
        "config inheritance": config_inheritance_supported,
        "permission readback": permission_readback_supported,
        "mode selection": mode_selection_supported,
        "mode readback": mode_readback_supported,
    }
    # Retain the old caller flag, but selecting permissions is not inheritance evidence.
    if not isinstance(permission_selection_supported, bool) or any(
        not isinstance(value, bool) for value in support.values()
    ):
        raise OrchestrationStateError("launch capability support flags must be boolean")
    launch["last_checked_at"] = observed_at or now_utc()
    if not all(support.values()):
        launch["verification_state"] = "blocked"
        launch["blocker_category"] = "host_capability"
    else:
        launch["verification_state"] = "preflight_verified"
    return validate_launch(launch)


def bind_launch_task(
    launch: dict[str, Any],
    *,
    thread_id: str,
    host_id: str,
    observed_at: str | None = None,
) -> dict[str, Any]:
    validate_launch(launch)
    if launch["verification_state"] != "preflight_verified":
        raise OrchestrationStateError(
            "child task creation requires verified launch preflight"
        )
    launch["thread_id"] = require_text(thread_id, "launch thread_id", maximum=200)
    launch["host_id"] = require_text(host_id, "launch host_id", maximum=200)
    launch["last_checked_at"] = observed_at or now_utc()
    launch["verification_state"] = "created"
    return validate_launch(launch)


def verify_launch_readback(
    launch: dict[str, Any],
    *,
    effective_permission_profile: str | None,
    effective_execution_mode: str | None,
    observed_at: str | None = None,
) -> dict[str, Any]:
    validate_launch(launch)
    if launch["verification_state"] != "created":
        raise OrchestrationStateError("launch readback requires created state")
    launch["last_checked_at"] = observed_at or now_utc()
    launch["effective_permission_profile"] = setting_token(
        effective_permission_profile,
        "effective permission profile",
        nullable=True,
    )
    launch["effective_execution_mode"] = setting_token(
        effective_execution_mode,
        "effective execution mode",
        nullable=True,
    )
    if effective_permission_profile is None or effective_execution_mode is None:
        launch["verification_state"] = "blocked"
        launch["blocker_category"] = "readback_unavailable"
    elif effective_permission_profile != launch["requested_permission_profile"]:
        launch["verification_state"] = "blocked"
        launch["blocker_category"] = "permission_mismatch"
    elif effective_execution_mode != launch["requested_execution_mode"]:
        launch["verification_state"] = "blocked"
        launch["blocker_category"] = "mode_mismatch"
    else:
        launch["verification_state"] = "verified"
        launch["blocker_category"] = None
    return validate_launch(launch)


def launch_allows_activation(launch: dict[str, Any]) -> bool:
    validate_launch(launch)
    return launch["verification_state"] == "verified"


def upsert_launch(register: dict[str, Any], launch: dict[str, Any]) -> None:
    validate_register(register)
    validated = validate_launch(launch)
    current = next(
        (
            item
            for item in register["launches"]
            if item["issue_number"] == validated["issue_number"]
        ),
        None,
    )
    if current is not None:
        old_time = parse_time(current["last_checked_at"], "existing launch check")
        new_time = parse_time(validated["last_checked_at"], "new launch check")
        assert old_time is not None and new_time is not None
        if new_time < old_time:
            raise OrchestrationStateError(
                "stale launch observation cannot replace newer state"
            )
        register["launches"].remove(current)
    register["launches"].append(validated)
    register["launches"].sort(key=lambda item: item["issue_number"])
    register["updated_at"] = now_utc()
    validate_register(register)


def resolve_launch(register: dict[str, Any], issue_number: int) -> dict[str, Any]:
    validate_register(register)
    selected_issue = positive_number(issue_number, "issue_number", nullable=False)
    matches = [
        launch
        for launch in register["launches"]
        if launch["issue_number"] == selected_issue
    ]
    if not matches:
        raise OrchestrationStateError("launch request is unknown")
    return matches[0]


def _ensure_owner_only_directory(path: Path, label: str) -> None:
    if path.exists() and path.is_symlink():
        raise OrchestrationStateError(f"{label} must not be a symlink")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise OrchestrationStateError(f"cannot create {label}: {error}") from error
    if os.name != "nt":
        try:
            details = path.stat()
        except OSError as error:
            raise OrchestrationStateError(f"cannot inspect {label}: {error}") from error
        if not stat.S_ISDIR(details.st_mode):
            raise OrchestrationStateError(f"{label} must be a directory")
        if details.st_uid != os.getuid():
            raise OrchestrationStateError(f"{label} must be owned by the current user")
        path.chmod(0o700)


def _ensure_owner_only_regular(path: Path, label: str) -> os.stat_result:
    if path.is_symlink():
        raise OrchestrationStateError(f"{label} must not be a symlink")
    try:
        details = path.stat()
    except OSError as error:
        raise OrchestrationStateError(f"cannot inspect {label}: {error}") from error
    if not stat.S_ISREG(details.st_mode):
        raise OrchestrationStateError(f"{label} must be a regular file")
    if os.name != "nt":
        if details.st_uid != os.getuid():
            raise OrchestrationStateError(f"{label} must be owned by the current user")
        if stat.S_IMODE(details.st_mode) & 0o077:
            raise OrchestrationStateError(f"{label} permissions must be owner-only")
    return details


@contextmanager
def _exclusive_file_lock(path: Path, label: str) -> Iterable[None]:
    _ensure_owner_only_directory(path.parent, f"{label} directory")
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise OrchestrationStateError(f"cannot open {label} lock: {error}") from error
    locked = False
    try:
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode):
                raise OrchestrationStateError(f"{label} lock must be a regular file")
            if os.name != "nt":
                if details.st_uid != os.getuid():
                    raise OrchestrationStateError(
                        f"{label} lock must be owned by the current user"
                    )
                if stat.S_IMODE(details.st_mode) & 0o077:
                    raise OrchestrationStateError(
                        f"{label} lock permissions must be owner-only"
                    )
                os.fchmod(descriptor, 0o600)
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                locked = True
            elif msvcrt is not None:  # pragma: no cover - Windows-only fallback.
                os.lseek(descriptor, 0, os.SEEK_SET)
                os.write(descriptor, b"\0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
                locked = True
            else:  # pragma: no cover - every supported platform has one backend.
                raise OrchestrationStateError(
                    "no supported file-lock backend is available"
                )
        except OSError as error:
            raise OrchestrationStateError(
                f"cannot acquire {label} lock: {error}"
            ) from error
        yield
    finally:
        if locked:
            try:
                if fcntl is not None:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
                elif msvcrt is not None:  # pragma: no cover - Windows-only fallback.
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            finally:
                os.close(descriptor)
        else:
            os.close(descriptor)


def _state_root_for_register(path: Path, state_root: Path | None) -> Path:
    selected = (state_root or path.parent.parent.parent).expanduser()
    if not selected.is_absolute():
        raise OrchestrationStateError("state root must be an absolute path")
    _ensure_owner_only_directory(selected, "state root")
    return selected


def _atomic_json_write(path: Path, payload: dict[str, Any], label: str) -> None:
    if path.exists():
        _ensure_owner_only_regular(path, label)
    _ensure_owner_only_directory(path.parent, f"{label} directory")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        if os.name != "nt":
            path.chmod(0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _restore_file_snapshot(
    path: Path,
    snapshot: bytes | None,
    label: str,
) -> None:
    """Restore one locked sidecar file without following a changed symlink."""
    if snapshot is None:
        if path.exists() or path.is_symlink():
            _ensure_owner_only_regular(path, label)
            path.unlink()
        return
    if path.exists():
        _ensure_owner_only_regular(path, label)
    _ensure_owner_only_directory(path.parent, f"{label} directory")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".rollback.tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        if os.name != "nt":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(snapshot)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        if os.name != "nt":
            path.chmod(0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _validate_claim(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != CLAIM_KEYS:
        raise OrchestrationStateError("worktree claim fields differ")
    if value["schema_version"] != CLAIM_SCHEMA_VERSION:
        raise OrchestrationStateError("unsupported worktree claim schema version")
    require_text(value["worktree_identity"], "worktree claim identity", maximum=2000)
    if value["state"] not in CLAIM_STATES:
        raise OrchestrationStateError("worktree claim state is unsupported")
    require_text(value["controller_id"], "worktree claim controller", maximum=200)
    require_text(
        value["task_id"],
        "worktree claim task",
        nullable=True,
        maximum=200,
    )
    revision = value["revision"]
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise OrchestrationStateError("worktree claim revision must be positive")
    parse_time(value["updated_at"], "worktree claim updated_at")
    if value["state"] == "claimed" and value["task_id"] is None:
        raise OrchestrationStateError("claimed worktree state requires a task")
    if value["state"] == "released" and value["task_id"] is not None:
        raise OrchestrationStateError("released worktree state must not retain a task")
    return value


def _claim_paths(worktree_path: str, state_root: Path) -> tuple[str, Path, Path]:
    identity = canonical_managed_path(worktree_path, "worktree path")
    claims = state_root / "worktree-claims"
    _ensure_owner_only_directory(claims, "worktree claim directory")
    digest = identity_digest(identity)
    return identity, claims / f"{digest}.json", claims / f".{digest}.lock"


def _read_claim_locked(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    _ensure_owner_only_regular(path, "worktree claim")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise OrchestrationStateError(
            f"cannot read worktree claim safely: {error}"
        ) from error
    return _validate_claim(payload)


def _claim_payload(
    *,
    identity: str,
    state: str,
    controller_id: str,
    task_id: str | None,
    revision: int,
) -> dict[str, Any]:
    payload = {
        "schema_version": CLAIM_SCHEMA_VERSION,
        "worktree_identity": identity,
        "state": state,
        "controller_id": controller_id,
        "task_id": task_id,
        "revision": revision,
        "updated_at": now_utc(),
    }
    return _validate_claim(payload)


def _claim_matches(
    claim: dict[str, Any] | None,
    controller_id: str,
    task_id: str,
) -> bool:
    return bool(
        claim
        and claim["state"] == "claimed"
        and claim["controller_id"] == controller_id
        and claim["task_id"] == task_id
    )


def claim_worktree_ownership(
    worktree_path: str,
    *,
    state_root: Path | None = None,
    controller_id: str,
    task_id: str,
    expected_revision: int | None = None,
) -> dict[str, Any]:
    root = state_root or state_directory()
    root = _state_root_for_register(Path("/unused/register.json"), root)
    controller = require_text(controller_id, "controller_id", maximum=200)
    task = require_text(task_id, "task_id", maximum=200)
    assert controller is not None and task is not None
    identity, claim_path, lock_path = _claim_paths(worktree_path, root)
    with _exclusive_file_lock(lock_path, "worktree claim"):
        current = _read_claim_locked(claim_path)
        if current is None:
            if expected_revision not in {None, 0}:
                raise OrchestrationStateError("stale worktree claim revision")
            candidate = _claim_payload(
                identity=identity,
                state="claimed",
                controller_id=controller,
                task_id=task,
                revision=1,
            )
        else:
            if current["worktree_identity"] != identity:
                raise OrchestrationStateError("worktree claim identity mismatch")
            if expected_revision is not None and current["revision"] != expected_revision:
                raise OrchestrationStateError("stale worktree claim revision")
            if _claim_matches(current, controller, task):
                return current
            if current["state"] == "claimed":
                raise OrchestrationStateError(
                    "worktree is owned by another controller or task"
                )
            if expected_revision is None:
                raise OrchestrationStateError(
                    "released worktree claim requires an expected revision"
                )
            candidate = _claim_payload(
                identity=identity,
                state="claimed",
                controller_id=controller,
                task_id=task,
                revision=current["revision"] + 1,
            )
        _atomic_json_write(claim_path, candidate, "worktree claim")
        return candidate


def release_worktree_ownership(
    worktree_path: str,
    *,
    state_root: Path | None = None,
    controller_id: str,
    task_id: str,
    expected_revision: int,
) -> dict[str, Any]:
    root = state_root or state_directory()
    root = _state_root_for_register(Path("/unused/register.json"), root)
    controller = require_text(controller_id, "controller_id", maximum=200)
    task = require_text(task_id, "task_id", maximum=200)
    assert controller is not None and task is not None
    if isinstance(expected_revision, bool) or expected_revision < 1:
        raise OrchestrationStateError("expected worktree claim revision must be positive")
    identity, claim_path, lock_path = _claim_paths(worktree_path, root)
    with _exclusive_file_lock(lock_path, "worktree claim"):
        current = _read_claim_locked(claim_path)
        if current is None or current["revision"] != expected_revision:
            raise OrchestrationStateError("stale worktree claim revision")
        if not _claim_matches(current, controller, task):
            raise OrchestrationStateError(
                "worktree claim release is restricted to its current owner"
            )
        candidate = _claim_payload(
            identity=identity,
            state="released",
            controller_id=controller,
            task_id=None,
            revision=current["revision"] + 1,
        )
        _atomic_json_write(claim_path, candidate, "worktree claim")
        return candidate


def _worktree_entries(register: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    entries: dict[str, list[dict[str, Any]]] = {}
    for task in register["tasks"]:
        if (
            task["worktree_path"] is None
            or task["legacy_migration_state"] == "v4_detached_review"
        ):
            continue
        key = canonical_managed_path(task["worktree_path"], "task worktree path")
        entries.setdefault(key, []).append(task)
    return entries


def _desired_worktree_claims(
    register: dict[str, Any],
) -> dict[str, tuple[str, str]]:
    desired: dict[str, tuple[str, str]] = {}
    for key, tasks in _worktree_entries(register).items():
        active_children = [
            task
            for task in tasks
            if task["run_mode"] in {"review_session", "verification_session"}
            and task["archive_state"] != "archived"
            and task["status"] != "excluded"
        ]
        active_issues = [
            task
            for task in tasks
            if task["run_mode"] == "issue_session"
            and task["archive_state"] != "archived"
            and task["status"] != "excluded"
        ]
        owner = (active_children or active_issues)
        if owner:
            desired[key] = (register["orchestrator_id"], owner[0]["thread_id"])
    return desired


@contextmanager
def _synchronise_worktree_claims(
    current: dict[str, Any] | None,
    candidate: dict[str, Any],
    state_root: Path,
) -> Iterable[None]:
    current_entries = _worktree_entries(current) if current is not None else {}
    candidate_entries = _worktree_entries(candidate)
    current_desired = _desired_worktree_claims(current) if current is not None else {}
    candidate_desired = _desired_worktree_claims(candidate)
    identities = sorted(set(current_entries) | set(candidate_entries))
    claim_paths = {
        identity: _claim_paths(
            current_entries.get(identity, candidate_entries.get(identity))[0][
                "worktree_path"
            ],
            state_root,
        )
        for identity in identities
    }
    snapshots: dict[Path, bytes | None] = {}
    changed: list[Path] = []
    with ExitStack() as locks:
        for identity in identities:
            locks.enter_context(
                _exclusive_file_lock(claim_paths[identity][2], "worktree claim")
            )
        try:
            for identity in identities:
                _, claim_path, _ = claim_paths[identity]
                if claim_path.is_symlink():
                    raise OrchestrationStateError(
                        "worktree claim must not be a symlink"
                    )
                if claim_path.exists():
                    _ensure_owner_only_regular(claim_path, "worktree claim")
                    snapshots[claim_path] = claim_path.read_bytes()
                else:
                    snapshots[claim_path] = None
                current_claim = _read_claim_locked(claim_path)
                desired = candidate_desired.get(identity)
                current_owner = current_desired.get(identity)
                known_current = {
                    (current["orchestrator_id"], task["thread_id"])
                    for task in current_entries.get(identity, [])
                } if current is not None else set()
                known_candidate = {
                    (candidate["orchestrator_id"], task["thread_id"])
                    for task in candidate_entries.get(identity, [])
                }
                if desired is not None:
                    desired_controller, desired_task = desired
                    if current_claim is not None and current_claim["worktree_identity"] != identity:
                        raise OrchestrationStateError("worktree claim identity mismatch")
                    if current_claim is not None and current_claim["state"] == "claimed":
                        if _claim_matches(current_claim, desired_controller, desired_task):
                            continue
                        if current_claim["controller_id"] != desired_controller:
                            raise OrchestrationStateError(
                                "worktree is owned by another controller"
                            )
                        if current_owner != (
                            current_claim["controller_id"],
                            current_claim["task_id"],
                        ) and (
                            current_claim["controller_id"],
                            current_claim["task_id"],
                        ) not in known_current:
                            raise OrchestrationStateError(
                                "stale worktree claim cannot be replaced"
                            )
                        next_revision = current_claim["revision"] + 1
                    elif current_claim is not None:
                        next_revision = current_claim["revision"] + 1
                    else:
                        next_revision = 1
                    changed.append(claim_path)
                    _atomic_json_write(
                        claim_path,
                        _claim_payload(
                            identity=identity,
                            state="claimed",
                            controller_id=desired_controller,
                            task_id=desired_task,
                            revision=next_revision,
                        ),
                        "worktree claim",
                    )
                    continue
                if current_claim is None or current_claim["state"] == "released":
                    continue
                claim_owner = (current_claim["controller_id"], current_claim["task_id"])
                if claim_owner not in known_current and claim_owner not in known_candidate:
                    raise OrchestrationStateError(
                        "worktree claim release is restricted to its recorded owner"
                    )
                released = _claim_payload(
                    identity=identity,
                    state="released",
                    controller_id=current_claim["controller_id"],
                    task_id=None,
                    revision=current_claim["revision"] + 1,
                )
                changed.append(claim_path)
                _atomic_json_write(claim_path, released, "worktree claim")
            # Keep every claim lock held while the caller persists the register.
            # If that later write fails, the exception exits this context and
            # restores only the sidecars changed by this candidate.
            yield
        except Exception:
            try:
                for claim_path in reversed(changed):
                    _restore_file_snapshot(
                        claim_path,
                        snapshots[claim_path],
                        "worktree claim",
                    )
            except Exception as rollback_error:
                raise OrchestrationStateError(
                    "worktree claim rollback failed; register write is not committed"
                ) from rollback_error
            raise


def load_register(path: Path) -> dict[str, Any]:
    _ensure_owner_only_regular(path, "register")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise OrchestrationStateError(f"cannot read register safely: {error}") from error
    return migrate_register(payload)


def write_register(
    path: Path,
    payload: dict[str, Any],
    *,
    expected_revision: int | None = None,
    owner_id: str | None = None,
    state_root: Path | None = None,
) -> None:
    validate_register(payload)
    controller = owner_id or payload["orchestrator_id"]
    if controller != payload["orchestrator_id"]:
        raise OrchestrationStateError(
            "register write owner must match orchestrator_id"
        )
    root = _state_root_for_register(path, state_root)
    _ensure_owner_only_directory(path.parent.parent, "register project directory")
    _ensure_owner_only_directory(path.parent, "register directory")
    lock_path = path.parent / f".{path.name}.lock"
    with _exclusive_file_lock(lock_path, "register"):
        current = load_register(path) if path.exists() else None
        candidate = copy.deepcopy(payload)
        expected = (
            expected_revision
            if expected_revision is not None
            else candidate["state_revision"]
        )
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            raise OrchestrationStateError("expected register revision must be non-negative")
        if current is None:
            if expected != 0 or candidate["state_revision"] != 0:
                raise OrchestrationStateError("stale register write")
            candidate["state_revision"] = 1
        else:
            if current["state_revision"] != expected:
                raise OrchestrationStateError("stale register write")
            if candidate["state_revision"] != expected:
                raise OrchestrationStateError(
                    "register payload revision does not match expected revision"
                )
            candidate["state_revision"] = current["state_revision"] + 1
        validate_register(candidate)
        with _synchronise_worktree_claims(current, candidate, root):
            _atomic_json_write(path, candidate, "register")
        payload.clear()
        payload.update(candidate)


def default_task(
    *,
    thread_id: str,
    project_id: str,
    status: str,
    observed_at: str,
    host_id: str | None = None,
    title: str = "",
    issue_number: int | None = None,
    pr_number: int | None = None,
    run_mode: str = "observed_peer",
    worktree_path: str | None = None,
    branch_name: str | None = None,
    base_revision: str | None = None,
    subject_thread_id: str | None = None,
    target_revision: str | None = None,
    review_outcome: str | None = None,
    requested_model: str | None = None,
    effective_model: str | None = None,
    requested_reasoning_effort: str | None = None,
    effective_reasoning_effort: str | None = None,
    settings_verification_state: str | None = None,
    settings_blocker_category: str | None = None,
    remediation_turn: dict[str, Any] | None = None,
    legacy_migration_state: str | None = None,
) -> dict[str, Any]:
    child_session = run_mode in {"review_session", "verification_session"}
    if child_session:
        selected_requested_model = requested_model or LUNA_MODEL
        selected_requested_reasoning = (
            requested_reasoning_effort or MAX_REASONING_EFFORT
        )
        selected_state = settings_verification_state or (
            "verified"
            if effective_model == LUNA_MODEL
            and effective_reasoning_effort == MAX_REASONING_EFFORT
            else "requested"
        )
    else:
        selected_requested_model = None
        selected_requested_reasoning = None
        selected_state = "not_applicable"
    task = {
        "thread_id": thread_id,
        "host_id": host_id,
        "project_id": project_id,
        "title": title,
        "status": status,
        "issue_number": issue_number,
        "pr_number": pr_number,
        "cursor": None,
        "archive_state": "unarchived",
        "last_observed_at": observed_at,
        "last_action_at": None,
        "terminal_verified": False,
        "final_read": False,
        "reconciled": False,
        "needed_for_dependency": False,
        "closeout_result": "pending",
        "blocker_category": None,
        "run_mode": run_mode,
        "worktree_path": worktree_path,
        "branch_name": branch_name,
        "base_revision": base_revision,
        "subject_thread_id": subject_thread_id,
        "target_revision": target_revision,
        "review_outcome": review_outcome,
        "cleanup_state": (
            "active" if run_mode == "issue_session" else "not_applicable"
        ),
        "requested_model": selected_requested_model,
        "effective_model": effective_model if child_session else None,
        "requested_reasoning_effort": selected_requested_reasoning,
        "effective_reasoning_effort": (
            effective_reasoning_effort if child_session else None
        ),
        "settings_verification_state": selected_state,
        "settings_blocker_category": (
            settings_blocker_category if child_session else None
        ),
        "remediation_turn": remediation_turn if run_mode == "issue_session" else None,
        "legacy_migration_state": legacy_migration_state if child_session else None,
    }
    return validate_task(
        task,
        project_id,
        allow_unverified_settings=True,
    )


def verify_task_settings_readback(
    task: dict[str, Any],
    *,
    effective_model: str | None,
    effective_reasoning_effort: str | None,
    observed_at: str | None = None,
) -> dict[str, Any]:
    validate_task(
        task,
        task["project_id"],
        allow_unverified_settings=True,
    )
    if task["run_mode"] not in {"review_session", "verification_session"}:
        raise OrchestrationStateError(
            "Luna/max task settings apply only to review or verification sessions"
        )
    if task["legacy_migration_state"] is not None:
        raise OrchestrationStateError(
            "legacy task settings require explicit replacement, not inferred readback"
        )
    if task["settings_verification_state"] != "requested":
        raise OrchestrationStateError(
            "task settings readback requires requested state"
        )
    task["effective_model"] = identifier_token(
        effective_model,
        "effective model",
        nullable=True,
    )
    task["effective_reasoning_effort"] = identifier_token(
        effective_reasoning_effort,
        "effective reasoning effort",
        nullable=True,
    )
    task["last_observed_at"] = observed_at or now_utc()
    if effective_model is None or effective_reasoning_effort is None:
        task["settings_verification_state"] = "blocked"
        task["settings_blocker_category"] = "readback_unavailable"
    elif effective_model != LUNA_MODEL:
        task["settings_verification_state"] = "blocked"
        task["settings_blocker_category"] = "model_mismatch"
    elif effective_reasoning_effort != MAX_REASONING_EFFORT:
        task["settings_verification_state"] = "blocked"
        task["settings_blocker_category"] = "reasoning_mismatch"
    else:
        task["settings_verification_state"] = "verified"
        task["settings_blocker_category"] = None
    if task["settings_verification_state"] == "blocked":
        task["status"] = "blocked"
        task["review_outcome"] = "blocked"
    return validate_task(task, task["project_id"])


def task_settings_allow_activation(task: dict[str, Any]) -> bool:
    validate_task(task, task["project_id"])
    return bool(
        task["run_mode"] in {"review_session", "verification_session"}
        and task["settings_verification_state"] == "verified"
        and task["effective_model"] == LUNA_MODEL
        and task["effective_reasoning_effort"] == MAX_REASONING_EFFORT
    )


def record_remediation_turn(
    task: dict[str, Any],
    *,
    turn_id: str,
    effective_model: str | None,
    effective_reasoning_effort: str | None,
) -> dict[str, Any]:
    validate_task(
        task,
        task["project_id"],
        allow_unverified_settings=True,
    )
    if task["run_mode"] != "issue_session":
        raise OrchestrationStateError(
            "remediation turns apply only to issue sessions"
        )
    effective_model = identifier_token(
        effective_model,
        "remediation effective model",
        nullable=True,
    )
    effective_reasoning_effort = identifier_token(
        effective_reasoning_effort,
        "remediation effective reasoning effort",
        nullable=True,
    )
    turn = {
        "turn_id": require_text(turn_id, "remediation turn ID", maximum=200),
        "requested_model": LUNA_MODEL,
        "effective_model": effective_model,
        "requested_reasoning_effort": MAX_REASONING_EFFORT,
        "effective_reasoning_effort": effective_reasoning_effort,
        "verification_state": "verified",
        "blocker_category": None,
    }
    if effective_model is None or effective_reasoning_effort is None:
        turn["verification_state"] = "blocked"
        turn["blocker_category"] = "readback_unavailable"
    elif effective_model != LUNA_MODEL:
        turn["verification_state"] = "blocked"
        turn["blocker_category"] = "model_mismatch"
    elif effective_reasoning_effort != MAX_REASONING_EFFORT:
        turn["verification_state"] = "blocked"
        turn["blocker_category"] = "reasoning_mismatch"
    if task["remediation_turn"] is not None:
        if task["remediation_turn"] != turn:
            raise OrchestrationStateError(
                "remediation turn identity and readback are immutable"
            )
        return validate_task(task, task["project_id"], allow_unverified_settings=True)
    task["remediation_turn"] = turn
    if turn["verification_state"] == "blocked":
        # A failed host-authoritative Luna/max readback is a hard source-work
        # gate. Persist the implementation as blocked before the caller can
        # write the register; prompt text or a false active state must not
        # authorize remediation edits.
        task["status"] = "blocked"
        task["blocker_category"] = "tooling"
    return validate_task(task, task["project_id"])


def remediation_turn_allows_work(task: dict[str, Any]) -> bool:
    validate_task(
        task,
        task["project_id"],
        allow_unverified_settings=True,
    )
    turn = task["remediation_turn"]
    return bool(
        task["run_mode"] == "issue_session"
        and task["status"] in {"active", "waiting"}
        and isinstance(turn, dict)
        and turn["verification_state"] == "verified"
        and turn["effective_model"] == LUNA_MODEL
        and turn["effective_reasoning_effort"] == MAX_REASONING_EFFORT
    )


def upsert_task(
    register: dict[str, Any],
    task: dict[str, Any],
    *,
    legacy_review_order: tuple[str, ...] = (),
) -> None:
    validate_register(register)
    validated = validate_task(task, register["project_id"]).copy()
    candidate = copy.deepcopy(register)
    current = next(
        (
            item
            for item in candidate["tasks"]
            if item["thread_id"] == validated["thread_id"]
        ),
        None,
    )
    if legacy_review_order and (current is not None or "review_refresh" not in validated):
        raise OrchestrationStateError("legacy review order can only accompany a new refresh")
    if current is None and validated["run_mode"] == "review_session":
        reviews = [
            item
            for item in candidate["tasks"]
            if item["run_mode"] == "review_session"
            and item["subject_thread_id"] == validated["subject_thread_id"]
        ]
        refresh = validated.get("review_refresh")
        if refresh is not None:
            if legacy_review_order:
                by_id = {review["thread_id"]: review for review in reviews}
                if (
                    len(reviews) < 2
                    or len(legacy_review_order) != len(reviews)
                    or set(legacy_review_order) != set(by_id)
                    or any("review_order" in review for review in reviews)
                ):
                    raise OrchestrationStateError(
                        "legacy review order must list every unordered attempt for this subject once"
                    )
                for order, thread_id in enumerate(legacy_review_order, start=1):
                    by_id[thread_id]["review_order"] = order
            prior = latest_review(reviews)
            if prior is None and reviews:
                raise OrchestrationStateError(
                    "review refresh requires verified launch order for multiple legacy attempts"
                )
            if (
                prior is None
                or prior["thread_id"] != refresh["prior_thread_id"]
                or prior["archive_state"] != "archived"
            ):
                raise OrchestrationStateError(
                    "review refresh requires the latest archived attempt for this subject"
                )
        elif sum("review_refresh" not in item for item in reviews) >= MAX_REVIEW_PASSES:
            raise OrchestrationStateError(
                "two-pass review cap reached for this implementation session; "
                "stop for an explicit next-step decision instead of creating pass 3"
            )
        validated["review_order"] = max(
            (item.get("review_order", 0) for item in reviews), default=0
        ) + 1
    if current is not None:
        old_time = parse_time(current["last_observed_at"], "existing observation")
        new_time = parse_time(validated["last_observed_at"], "new observation")
        assert old_time is not None and new_time is not None
        if new_time < old_time:
            raise OrchestrationStateError("stale live observation cannot replace newer state")
        if current["run_mode"] in {"review_session", "verification_session"}:
            immutable_fields = (
                "host_id",
                "project_id",
                "issue_number",
                "pr_number",
                "run_mode",
                "worktree_path",
                "branch_name",
                "base_revision",
                "subject_thread_id",
                "target_revision",
            )
            immutable_fields += (
                "requested_model",
                "effective_model",
                "requested_reasoning_effort",
                "effective_reasoning_effort",
                "settings_verification_state",
                "settings_blocker_category",
                "legacy_migration_state",
            )
            changed = [
                field
                for field in immutable_fields
                if current[field] != validated[field]
            ]
            if current.get("review_refresh") != validated.get("review_refresh"):
                changed.append("review_refresh")
            if "review_order" in validated and validated["review_order"] != current.get("review_order"):
                changed.append("review_order")
            if changed:
                raise OrchestrationStateError(
                    "review session identity and revision range are immutable: "
                    + ", ".join(changed)
                )
            if "review_order" in current:
                validated["review_order"] = current["review_order"]
            terminal_outcomes = (
                {"clear", "findings", "blocked", "stale"}
                if current["run_mode"] == "review_session"
                else {"passed", "failed", "blocked", "stale"}
            )
            if (
                current["review_outcome"] in terminal_outcomes
                and validated["review_outcome"] != current["review_outcome"]
            ):
                lane = (
                    "review"
                    if current["run_mode"] == "review_session"
                    else "verification"
                )
                raise OrchestrationStateError(
                    f"terminal {lane} outcome is immutable; use explicit stale "
                    "invalidation before a fresh terminal session"
                )
        elif (
            current["remediation_turn"] is not None
            and validated["remediation_turn"] != current["remediation_turn"]
        ):
            raise OrchestrationStateError(
                "remediation turn identity and readback are immutable"
            )
        candidate["tasks"].remove(current)
    candidate["tasks"].append(validated)
    candidate["tasks"].sort(key=lambda item: item["thread_id"])
    candidate["updated_at"] = now_utc()
    validate_register(candidate)
    register.clear()
    register.update(candidate)


def activate_issue_session(
    register: dict[str, Any], task: dict[str, Any]
) -> None:
    validate_register(register)
    validated_task = validate_task(task, register["project_id"])
    if validated_task["run_mode"] != "issue_session":
        raise OrchestrationStateError("launch activation requires an issue session")
    launch = resolve_launch(register, validated_task["issue_number"])
    if not launch_allows_activation(launch):
        raise OrchestrationStateError(
            "issue session cannot activate before launch settings are verified"
        )
    if (
        launch["thread_id"] != validated_task["thread_id"]
        or launch["host_id"] != validated_task["host_id"]
    ):
        raise OrchestrationStateError(
            "issue session identity differs from verified launch readback"
        )
    upsert_task(register, validated_task)


def format_title(
    *,
    status: str,
    issue_number: int | None = None,
    pr_number: int | None = None,
    fallback_kind: str | None = None,
    fallback_text: str | None = None,
) -> str:
    normalized_status = " ".join(status.split())
    if "|" in normalized_status or len(normalized_status.split()) > 3:
        raise OrchestrationStateError("status must be a short operational phrase")
    require_text(normalized_status, "status", maximum=24)
    references: list[str] = []
    if issue_number is not None:
        references.append(f"Issue #{positive_number(issue_number, 'issue_number')}")
    if pr_number is not None:
        references.append(f"PR #{positive_number(pr_number, 'pr_number')}")
    if not references:
        if fallback_kind not in {"Project", "Task"}:
            raise OrchestrationStateError(
                "fallback_kind must be Project or Task without an issue or PR"
            )
        normalized_fallback = " ".join((fallback_text or "").split())
        require_text(normalized_fallback, "fallback_text", maximum=36)
        if "|" in normalized_fallback:
            raise OrchestrationStateError("fallback_text must not contain a separator")
        references.append(f"{fallback_kind} {normalized_fallback}")
    return " | ".join([*references, normalized_status])


def archive_eligible(
    task: dict[str, Any],
    *,
    implementation_review_clear: bool = False,
    implementation_verification_passed: bool = False,
) -> bool:
    try:
        validate_task(task, task["project_id"])
    except (KeyError, OrchestrationStateError):
        return False
    terminal = task["status"] == "completed" or (
        task["run_mode"] in {
            "issue_session",
            "review_session",
            "verification_session",
        }
        and task["status"] == "blocked"
    )
    if task["run_mode"] == "observed_peer":
        blocker_safe = task["blocker_category"] is None
        dependency_safe = not task["needed_for_dependency"]
    elif task["status"] == "blocked":
        blocker_safe = task["blocker_category"] in {
            "user_input",
            "dependency",
            "tooling",
        }
        dependency_safe = True
    else:
        blocker_safe = task["blocker_category"] is None
        dependency_safe = True
    review_complete = bool(
        task["run_mode"] not in {"review_session", "verification_session"}
        or (
            task["status"] == "blocked"
            and task["review_outcome"] == "blocked"
        )
        or (
            task["status"] in {"completed", "archived_known"}
            and task["review_outcome"]
            in {"clear", "findings", "passed", "failed", "stale"}
        )
    )
    implementation_complete = bool(
        task["run_mode"] != "issue_session"
        or task["status"] == "blocked"
        or (implementation_review_clear and implementation_verification_passed)
    )
    return bool(
        terminal
        and task["archive_state"] == "unarchived"
        and task["terminal_verified"]
        and task["final_read"]
        and task["reconciled"]
        and dependency_safe
        and blocker_safe
        and review_complete
        and implementation_complete
    )


def cleanup_eligible(
    task: dict[str, Any],
    *,
    worktree_clean: bool,
    branch_evidence_preserved: bool,
    task_owned: bool,
) -> bool:
    return bool(
        task["run_mode"] == "issue_session"
        and task["archive_state"] == "archived"
        and task["cleanup_state"] == "active"
        and task["worktree_path"]
        and task["base_revision"]
        and (
            bool(task["branch_name"])
            if task["run_mode"] == "issue_session"
            else bool(task["target_revision"])
        )
        and worktree_clean
        and branch_evidence_preserved
        and task_owned
    )


def set_cleanup_state(
    register: dict[str, Any],
    *,
    thread_id: str,
    cleanup_state: str,
    worktree_clean: bool = False,
    branch_evidence_preserved: bool = False,
    task_owned: bool = False,
    state_root: Path | None = None,
) -> dict[str, Any]:
    validate_register(register)
    task = resolve_task(register, thread_id)
    if task["run_mode"] != "issue_session":
        raise OrchestrationStateError(
            "cleanup state applies only to managed sessions"
        )
    if cleanup_state == "cleanup_intent":
        if (
            task["status"] == "archived_known"
            and task["blocker_category"] is None
            and not _has_archived_terminal_verifier(
                register,
                task,
                state_root=state_root,
            )
        ):
            raise OrchestrationStateError(
                "completed implementation cleanup requires the terminal "
                "verifier to be authoritatively archived and released first"
            )
        if not cleanup_eligible(
            task,
            worktree_clean=worktree_clean,
            branch_evidence_preserved=branch_evidence_preserved,
            task_owned=task_owned,
        ):
            raise OrchestrationStateError(
                "managed session is not eligible for cleanup intent"
            )
        task["cleanup_state"] = "cleanup_intent"
    elif cleanup_state == "cleaned":
        if task["cleanup_state"] != "cleanup_intent":
            raise OrchestrationStateError(
                "cleanup result requires a recorded cleanup intent"
            )
        task["cleanup_state"] = "cleaned"
    elif cleanup_state == "preserved":
        if task["archive_state"] != "archived" or task["cleanup_state"] not in {
            "active",
            "cleanup_intent",
        }:
            raise OrchestrationStateError(
                "preserved cleanup result requires an archived managed session"
            )
        task["cleanup_state"] = "preserved"
    else:
        raise OrchestrationStateError("cleanup state is unsupported")
    task["last_action_at"] = now_utc()
    register["updated_at"] = now_utc()
    validate_register(register)
    return task


def set_review_outcome(
    register: dict[str, Any],
    *,
    thread_id: str,
    review_outcome: str,
) -> dict[str, Any]:
    validate_register(register)
    task = resolve_task(register, thread_id)
    if task["run_mode"] != "review_session":
        raise OrchestrationStateError(
            "review outcome applies only to review sessions"
        )
    if review_outcome != "stale":
        raise OrchestrationStateError(
            "only stale invalidation can be recorded independently; terminal "
            "review outcomes require a live task upsert"
        )
    if task["archive_state"] != "unarchived":
        raise OrchestrationStateError(
            "review outcome cannot change after archive intent"
        )
    current_outcome = task["review_outcome"]
    if current_outcome == "blocked":
        raise OrchestrationStateError(
            "blocked review outcome cannot be replaced"
        )
    task["review_outcome"] = review_outcome
    task["last_action_at"] = now_utc()
    register["updated_at"] = now_utc()
    validate_register(register)
    return task


def set_verification_outcome(
    register: dict[str, Any],
    *,
    thread_id: str,
    verification_outcome: str,
) -> dict[str, Any]:
    validate_register(register)
    task = resolve_task(register, thread_id)
    if task["run_mode"] != "verification_session":
        raise OrchestrationStateError(
            "verification outcome applies only to verification sessions"
        )
    if verification_outcome != "stale":
        raise OrchestrationStateError(
            "only stale invalidation can be recorded independently; terminal "
            "verification outcomes require a live task upsert"
        )
    if task["archive_state"] != "unarchived":
        raise OrchestrationStateError(
            "verification outcome cannot change after archive intent"
        )
    if task["review_outcome"] in {"passed", "failed", "blocked", "stale"}:
        raise OrchestrationStateError(
            "terminal verification outcome is immutable; create a fresh "
            "verification session for a new outcome"
        )
    task["review_outcome"] = verification_outcome
    task["last_action_at"] = now_utc()
    register["updated_at"] = now_utc()
    validate_register(register)
    return task


def _full_revision(value: Any, label: str) -> str:
    revision = require_text(value, label, maximum=64)
    assert revision is not None
    if not FULL_GIT_OBJECT_ID.fullmatch(revision):
        raise OrchestrationStateError(f"{label} must be a full Git object ID")
    return revision


def review_clears_revision(
    task: dict[str, Any],
    base_revision: str,
    target_revision: str,
) -> bool:
    base = _full_revision(base_revision, "base_revision")
    target = _full_revision(target_revision, "target_revision")
    return bool(
        task["run_mode"] == "review_session"
        and task["status"] in {"completed", "archived_known"}
        and task["terminal_verified"]
        and task["final_read"]
        and task["reconciled"]
        and task["review_outcome"] == "clear"
        and task_settings_allow_activation(task)
        and str(task["base_revision"]).casefold() == base.casefold()
        and str(task["target_revision"]).casefold() == target.casefold()
    )


def verification_passes_revision(
    task: dict[str, Any],
    base_revision: str,
    target_revision: str,
) -> bool:
    base = _full_revision(base_revision, "base_revision")
    target = _full_revision(target_revision, "target_revision")
    return bool(
        task["run_mode"] == "verification_session"
        and task["status"] in {"completed", "archived_known"}
        and task["terminal_verified"]
        and task["final_read"]
        and task["reconciled"]
        and task["review_outcome"] == "passed"
        and task_settings_allow_activation(task)
        and str(task["base_revision"]).casefold() == base.casefold()
        and str(task["target_revision"]).casefold() == target.casefold()
    )


def triage_issue_candidates(
    issues: Iterable[dict[str, Any]],
    *,
    capacity: int,
    active_overlap_keys: Iterable[str] = (),
) -> list[dict[str, Any]]:
    if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 0:
        raise OrchestrationStateError("triage capacity must be a non-negative integer")
    occupied: set[str] = set()
    for index, key in enumerate(active_overlap_keys):
        occupied.add(str(require_text(key, f"active_overlap_keys[{index}]", maximum=120)))

    normalized: list[dict[str, Any]] = []
    seen: set[int] = set()
    for index, issue in enumerate(issues):
        if not isinstance(issue, dict) or set(issue) != TRIAGE_KEYS:
            raise OrchestrationStateError(f"issues[{index}] fields differ")
        number = positive_number(issue["issue_number"], f"issues[{index}].issue_number")
        assert number is not None
        if number in seen:
            raise OrchestrationStateError(f"duplicate issue number: {number}")
        seen.add(number)
        priority = issue["priority"]
        if isinstance(priority, bool) or not isinstance(priority, int) or priority < 0:
            raise OrchestrationStateError(
                f"issues[{index}].priority must be a non-negative integer"
            )
        for field in ("blocked", "minor_dependency", "valuable"):
            if not isinstance(issue[field], bool):
                raise OrchestrationStateError(f"issues[{index}].{field} must be boolean")
        keys = issue["overlap_keys"]
        if not isinstance(keys, list):
            raise OrchestrationStateError(
                f"issues[{index}].overlap_keys must be a list"
            )
        normalized_keys = [
            str(require_text(key, f"issues[{index}].overlap_keys", maximum=120))
            for key in keys
        ]
        if len(normalized_keys) != len(set(normalized_keys)):
            raise OrchestrationStateError(
                f"issues[{index}].overlap_keys contains duplicates"
            )
        normalized.append({**issue, "issue_number": number, "overlap_keys": normalized_keys})

    # One foreground issue owns the implementation lane; spare capacity is
    # reserved for its review, remediation, verification, and diagnostics.
    remaining = min(capacity, 1)
    foreground_issue: int | None = None
    decisions: list[dict[str, Any]] = []
    for issue in sorted(normalized, key=lambda item: (-item["priority"], item["issue_number"])):
        overlap = occupied.intersection(issue["overlap_keys"])
        if issue["blocked"]:
            decision = "blocked"
            reason = "A genuine dependency or required channel blocks meaningful progress."
        elif not issue["valuable"]:
            decision = "defer"
            reason = "No independently valuable ready lane is currently identified."
        elif overlap:
            decision = "defer"
            reason = "The ready lane conflicts with active overlap ownership."
        elif foreground_issue is not None:
            decision = "defer"
            reason = (
                f"Foreground issue #{foreground_issue} owns the single implementation "
                "lane until its delivery checkpoint."
            )
        elif remaining == 0:
            decision = "defer"
            reason = "Available issue-session capacity is exhausted."
        else:
            decision = "start"
            reason = (
                "Start the independently valuable lane while its minor dependency remains in flight."
                if issue["minor_dependency"]
                else "Start the ready independently valuable lane."
            )
            remaining -= 1
            foreground_issue = issue["issue_number"]
            occupied.update(issue["overlap_keys"])
        decisions.append(
            {
                "issue_number": issue["issue_number"],
                "decision": decision,
                "reason": reason,
            }
        )
    return decisions


def set_inventory(
    register: dict[str, Any],
    *,
    complete: bool,
    limitation: str,
    rotation_offset: int,
) -> None:
    validate_register(register)
    if not isinstance(complete, bool):
        raise OrchestrationStateError("inventory.complete must be boolean")
    if not isinstance(limitation, str) or len(limitation) > 240:
        raise OrchestrationStateError(
            "inventory.limitation must be text of at most 240 characters"
        )
    if SECRET_VALUE.search(limitation):
        raise OrchestrationStateError(
            "inventory.limitation contains secret-shaped text"
        )
    if isinstance(rotation_offset, bool) or rotation_offset < 0:
        raise OrchestrationStateError(
            "inventory.rotation_offset must be a non-negative integer"
        )
    register["inventory"] = {
        "complete": complete,
        "limitation": limitation,
        "rotation_offset": rotation_offset,
    }
    register["updated_at"] = now_utc()
    validate_register(register)


def _has_archived_terminal_verifier(
    register: dict[str, Any],
    subject: dict[str, Any],
    *,
    base_revision: str | None = None,
    target_revision: str | None = None,
    state_root: Path | None = None,
) -> bool:
    if state_root is None:
        return False
    for verifier in register["tasks"]:
        if (
            verifier["run_mode"] != "verification_session"
            or verifier["subject_thread_id"] != subject["thread_id"]
            or verifier["archive_state"] != "archived"
            or verifier["status"] != "archived_known"
            or verifier["closeout_result"] != "archived"
        ):
            continue
        verifier_base = (
            base_revision if base_revision is not None else verifier["base_revision"]
        )
        verifier_target = (
            target_revision
            if target_revision is not None
            else verifier["target_revision"]
        )
        if verification_passes_revision(
            verifier,
            verifier_base,
            verifier_target,
        ) and verifier["worktree_path"]:
            identity, claim_path, lock_path = _claim_paths(
                verifier["worktree_path"], state_root
            )
            with _exclusive_file_lock(lock_path, "verifier claim readback"):
                claim = _read_claim_locked(claim_path)
            if (
                claim is not None
                and claim["worktree_identity"] == identity
                and claim["controller_id"] == register["orchestrator_id"]
                and (
                    (
                        claim["state"] == "released"
                        and claim["task_id"] is None
                    )
                    or (
                        claim["state"] == "claimed"
                        and claim["task_id"] == subject["thread_id"]
                    )
                )
            ):
                return True
    return False


def set_archive_state(
    register: dict[str, Any],
    *,
    thread_id: str,
    archive_state: str,
    review_base_revision: str | None = None,
    review_target_revision: str | None = None,
    verification_base_revision: str | None = None,
    verification_target_revision: str | None = None,
    state_root: Path | None = None,
) -> dict[str, Any]:
    validate_register(register)
    candidate = copy.deepcopy(register)
    task = resolve_task(candidate, thread_id)

    def implementation_closeout_evidence() -> tuple[bool, bool, bool]:
        if task["run_mode"] != "issue_session" or task["status"] != "completed":
            return False, False, False
        if review_base_revision is None or review_target_revision is None:
            raise OrchestrationStateError(
                "completed issue session archive requires the full live "
                "review and verification base and target revisions"
            )
        if (verification_base_revision is None) != (
            verification_target_revision is None
        ):
            raise OrchestrationStateError(
                "completed issue session archive requires the full live "
                "verification base and target revisions"
            )
        review_base = _full_revision(review_base_revision, "review base revision")
        review_target = _full_revision(
            review_target_revision,
            "review target revision",
        )
        if verification_base_revision is not None and (
            _full_revision(
                verification_base_revision,
                "verification base revision",
            ).casefold()
            != review_base.casefold()
            or _full_revision(
                verification_target_revision,
                "verification target revision",
            ).casefold()
            != review_target.casefold()
        ):
            raise OrchestrationStateError(
                "review and verification must certify the same full base/head pair"
            )
        reviews = [
            review
            for review in candidate["tasks"]
            if review["run_mode"] == "review_session"
            and review["subject_thread_id"] == task["thread_id"]
        ]
        if any("review_order" in review for review in reviews):
            current_review = latest_review(reviews)
            reviews = [current_review] if current_review is not None else []
        review_clear = any(
            review_clears_revision(review, review_base, review_target)
            for review in reviews
        )
        verification_passed = any(
            verifier["run_mode"] == "verification_session"
            and verifier["subject_thread_id"] == task["thread_id"]
            and verification_passes_revision(
                verifier,
                review_base,
                review_target,
            )
            for verifier in candidate["tasks"]
        )
        verifier_archived = _has_archived_terminal_verifier(
            candidate,
            task,
            base_revision=review_base,
            target_revision=review_target,
            state_root=state_root,
        )
        return review_clear, verification_passed, verifier_archived

    if archive_state == "archive_intent":
        implementation_review_clear = False
        implementation_verification_passed = False
        if task["run_mode"] == "issue_session" and task["status"] == "completed":
            (
                implementation_review_clear,
                implementation_verification_passed,
                verifier_archived,
            ) = implementation_closeout_evidence()
            if not verifier_archived:
                raise OrchestrationStateError(
                    "completed implementation archive requires the terminal "
                    "verifier to be authoritatively archived and released first"
                )
        if not archive_eligible(
            task,
            implementation_review_clear=implementation_review_clear,
            implementation_verification_passed=implementation_verification_passed,
        ):
            raise OrchestrationStateError(
                "task is not eligible for archive intent"
            )
        task["archive_state"] = "archive_intent"
        task["closeout_result"] = "reconciled"
    elif archive_state == "archived":
        if task["archive_state"] != "archive_intent":
            raise OrchestrationStateError(
                "archive result requires a recorded archive intent"
            )
        if task["run_mode"] == "issue_session" and task["status"] == "completed":
            review_clear, verification_passed, verifier_archived = (
                implementation_closeout_evidence()
            )
            if not review_clear:
                raise OrchestrationStateError(
                    "implementation review clearance is stale at archive result"
                )
            if not verification_passed:
                raise OrchestrationStateError(
                    "implementation verification pass is stale at archive result"
                )
            if not verifier_archived:
                raise OrchestrationStateError(
                    "completed implementation archive requires the terminal "
                    "verifier to be authoritatively archived and released first"
                )
        task["archive_state"] = "archived"
        task["closeout_result"] = "archived"
        task["status"] = "archived_known"
    elif archive_state == "unarchived":
        if task["archive_state"] != "archived":
            raise OrchestrationStateError(
                "unarchive result requires a recorded archived state"
            )
        task["archive_state"] = "unarchived"
        task["closeout_result"] = "recovered"
        task["status"] = (
            "blocked"
            if (
                task["run_mode"] == "review_session"
                and task["review_outcome"] == "blocked"
            )
            or (
                task["run_mode"] == "issue_session"
                and task["blocker_category"] is not None
            )
            else "completed"
        )
    else:
        raise OrchestrationStateError("archive state is unsupported")
    task["last_action_at"] = now_utc()
    candidate["updated_at"] = now_utc()
    validate_register(candidate)
    register.clear()
    register.update(candidate)
    return resolve_task(register, thread_id)


def wait_batches(
    tasks: Iterable[dict[str, Any]],
    *,
    rotation_offset: int = 0,
    batch_size: int = 8,
) -> list[list[dict[str, str]]]:
    if batch_size < 1 or batch_size > 8:
        raise OrchestrationStateError("wait batch size must be between 1 and 8")
    candidates = sorted(
        (
            task
            for task in tasks
            if task["status"] in {"active", "waiting", "needs_attention"}
            and task["archive_state"] == "unarchived"
        ),
        key=lambda item: item["thread_id"],
    )
    if candidates:
        offset = rotation_offset % len(candidates)
        candidates = candidates[offset:] + candidates[:offset]
    targets = [
        {
            **{"threadId": task["thread_id"]},
            **({"hostId": task["host_id"]} if task["host_id"] else {}),
            **({"afterCursor": task["cursor"]} if task["cursor"] else {}),
        }
        for task in candidates
    ]
    return [
        targets[index : index + batch_size]
        for index in range(0, len(targets), batch_size)
    ]


def resolve_task(register: dict[str, Any], query: str) -> dict[str, Any]:
    require_text(query, "query")
    exact_id = [task for task in register["tasks"] if task["thread_id"] == query]
    if exact_id:
        return exact_id[0]
    matches = [
        task
        for task in register["tasks"]
        if task["title"].casefold() == query.casefold()
    ]
    if len(matches) != 1:
        raise OrchestrationStateError(
            "task recovery query is missing or ambiguous; use an exact task ID"
        )
    return matches[0]


def summarize(register: dict[str, Any]) -> str:
    validate_register(register)
    counts = {
        status: sum(task["status"] == status for task in register["tasks"])
        for status in sorted(TASK_STATUSES)
    }
    lines = [
        "# Agent Orchestration Register",
        "",
        f"- Project: `{register['project_id']}`",
        f"- Orchestrator: `{register['orchestrator_id']}`",
        f"- Decision policy: `{register['decision_policy']}`",
        f"- Goal: `{register['goal']['state']}`",
        f"- Inventory complete: `{str(register['inventory']['complete']).lower()}`",
        f"- Launch requests: {len(register['launches'])}",
        "- Launch verified: "
        + str(
            sum(
                launch["verification_state"] == "verified"
                for launch in register["launches"]
            )
        ),
        "- Launch blocked: "
        + str(
            sum(
                launch["verification_state"] == "blocked"
                for launch in register["launches"]
            )
        ),
        f"- Managed tasks: {len(register['tasks'])}",
        f"- Gate decisions: {len(register['gate_decisions'])}",
        "- Issue sessions: "
        + str(sum(task["run_mode"] == "issue_session" for task in register["tasks"])),
        "- Review sessions: "
        + str(sum(task["run_mode"] == "review_session" for task in register["tasks"])),
        "- Statuses: "
        + ", ".join(f"{name}={count}" for name, count in counts.items() if count),
        f"- Archive eligible: {sum(archive_eligible(task) for task in register['tasks'])}",
    ]
    if register["inventory"]["limitation"]:
        lines.append(f"- Limitation: {register['inventory']['limitation']}")
    return "\n".join(lines) + "\n"


def parse_root(value: str | None) -> Path | None:
    return Path(value).expanduser() if value else None


def selected_path(args: argparse.Namespace) -> Path:
    return register_path(
        args.project_id,
        args.orchestrator_id,
        root=parse_root(args.state_root),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("state-dir")

    selector_parser = subparsers.add_parser("parse-selector")
    selector_parser.add_argument("--selector", default="")
    selector_parser.add_argument("--observed-at")

    route_profile_parser = subparsers.add_parser("route-profile")
    route_profile_parser.add_argument("--role", choices=sorted(SDLC_ROLES), required=True)
    route_profile_parser.add_argument("--risk", choices=sorted(SDLC_RISK_LEVELS), default="standard")
    route_profile_parser.add_argument(
        "--luna-supported", action=argparse.BooleanOptionalAction, default=True
    )
    route_profile_parser.add_argument("--small-single-issue", action="store_true")

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("path", type=Path)

    for command in (
        "init",
        "goal",
        "inventory",
        "scope",
        "route-request",
        "route-verify",
        "decision",
        "launch-request",
        "launch-preflight",
        "launch-bind",
        "launch-verify",
        "launches",
        "routes",
        "upsert",
        "archive",
        "cleanup",
        "review",
        "verification",
        "remediation",
        "list",
        "resolve",
        "summary",
    ):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("--project-id", required=True)
        command_parser.add_argument("--orchestrator-id", required=True)
        command_parser.add_argument("--state-root")
        if command == "goal":
            command_parser.add_argument("--state", choices=sorted(GOAL_STATES), required=True)
            command_parser.add_argument("--checked-at")
        elif command == "inventory":
            command_parser.add_argument(
                "--complete",
                action=argparse.BooleanOptionalAction,
                required=True,
            )
            command_parser.add_argument("--limitation", default="")
            command_parser.add_argument("--rotation-offset", type=int, default=0)
        elif command == "scope":
            command_parser.add_argument("--selector", default="")
            command_parser.add_argument("--observed-at")
        elif command == "route-request":
            command_parser.add_argument("--route-id", required=True)
            command_parser.add_argument("--role", choices=sorted(SDLC_ROLES), required=True)
            command_parser.add_argument("--risk", choices=sorted(SDLC_RISK_LEVELS), default="standard")
            command_parser.add_argument("--issue-number", type=int)
            command_parser.add_argument("--pr-number", type=int)
            command_parser.add_argument(
                "--luna-supported", action=argparse.BooleanOptionalAction, default=True
            )
            command_parser.add_argument("--small-single-issue", action="store_true")
            command_parser.add_argument("--observed-at")
        elif command == "route-verify":
            command_parser.add_argument("--route-id", required=True)
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument("--host-id", required=True)
            command_parser.add_argument("--effective-model")
            command_parser.add_argument("--effective-reasoning-effort")
            command_parser.add_argument("--effective-worktree-policy")
            command_parser.add_argument("--observed-at")
        elif command == "decision":
            command_parser.add_argument("--decision-id", required=True)
            command_parser.add_argument("--gate-type", choices=sorted(GATE_TYPES), required=True)
            command_parser.add_argument("--decision", choices=sorted(GATE_DECISIONS), required=True)
            command_parser.add_argument("--task-id")
            command_parser.add_argument("--issue-number", type=int)
            command_parser.add_argument("--pr-number", type=int)
            command_parser.add_argument("--candidate-revision")
            command_parser.add_argument("--deployment-identity")
            command_parser.add_argument("--evidence-digest", action="append", required=True)
            command_parser.add_argument("--authority-envelope-digest", required=True)
            command_parser.add_argument("--reason-category", required=True)
            command_parser.add_argument("--resulting-state", choices=sorted(DECISION_RESULT_STATES), required=True)
            command_parser.add_argument("--validity-digest", required=True)
            command_parser.add_argument("--request-digest")
            command_parser.add_argument("--decided-at")
        elif command == "launch-request":
            command_parser.add_argument("--issue-number", type=int, required=True)
            command_parser.add_argument("--goal-objective", required=True)
            command_parser.add_argument("--project-boundary", required=True)
            command_parser.add_argument("--completion-conditions", required=True)
            command_parser.add_argument("--constraints", required=True)
            command_parser.add_argument("--observed-at")
        elif command == "launch-preflight":
            command_parser.add_argument("--issue-number", type=int, required=True)
            command_parser.add_argument(
                "--config-inheritance-supported",
                action=argparse.BooleanOptionalAction,
                default=False,
                help="host can inherit saved TOML without permission overrides",
            )
            command_parser.add_argument(
                "--permission-selection-supported",
                action=argparse.BooleanOptionalAction,
                default=False,
                help="deprecated; permission selection does not establish config inheritance",
            )
            for flag in (
                "permission-readback-supported",
                "mode-selection-supported",
                "mode-readback-supported",
            ):
                command_parser.add_argument(
                    f"--{flag}",
                    action=argparse.BooleanOptionalAction,
                    required=True,
                )
            command_parser.add_argument("--observed-at")
        elif command == "launch-bind":
            command_parser.add_argument("--issue-number", type=int, required=True)
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument("--host-id", required=True)
            command_parser.add_argument("--observed-at")
        elif command == "launch-verify":
            command_parser.add_argument("--issue-number", type=int, required=True)
            command_parser.add_argument("--effective-permission-profile")
            command_parser.add_argument("--effective-execution-mode")
            command_parser.add_argument("--observed-at")
        elif command == "upsert":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument("--host-id")
            command_parser.add_argument("--title", required=True)
            command_parser.add_argument("--status", choices=sorted(TASK_STATUSES), required=True)
            command_parser.add_argument("--issue-number", type=int)
            command_parser.add_argument("--pr-number", type=int)
            command_parser.add_argument(
                "--run-mode",
                choices=sorted(RUN_MODES),
                default="observed_peer",
            )
            command_parser.add_argument("--worktree-path")
            command_parser.add_argument("--branch-name")
            command_parser.add_argument("--base-revision")
            command_parser.add_argument("--subject-thread-id")
            command_parser.add_argument("--target-revision")
            command_parser.add_argument("--refreshes-review-thread-id")
            command_parser.add_argument("--review-refresh-evidence-ref")
            command_parser.add_argument("--legacy-review-order", action="append", default=[])
            command_parser.add_argument(
                "--review-outcome",
                choices=sorted(value for value in REVIEW_OUTCOMES if value),
            )
            command_parser.add_argument("--effective-model")
            command_parser.add_argument("--effective-reasoning-effort")
            command_parser.add_argument("--cursor")
            command_parser.add_argument("--observed-at")
            command_parser.add_argument("--terminal-verified", action="store_true")
            command_parser.add_argument("--final-read", action="store_true")
            command_parser.add_argument("--reconciled", action="store_true")
            command_parser.add_argument("--needed-for-dependency", action="store_true")
            command_parser.add_argument("--blocker-category", choices=sorted(
                value for value in BLOCKER_CATEGORIES if value is not None
            ))
        elif command == "archive":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument(
                "--state",
                choices=("archive_intent", "archived", "unarchived"),
                required=True,
            )
            command_parser.add_argument("--review-base-revision")
            command_parser.add_argument("--review-target-revision")
            command_parser.add_argument("--verification-base-revision")
            command_parser.add_argument("--verification-target-revision")
        elif command == "cleanup":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument(
                "--state",
                choices=("cleanup_intent", "cleaned", "preserved"),
                required=True,
            )
            command_parser.add_argument("--worktree-clean", action="store_true")
            command_parser.add_argument(
                "--branch-evidence-preserved", action="store_true"
            )
            command_parser.add_argument("--task-owned", action="store_true")
        elif command == "review":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument(
                "--outcome",
                choices=("stale",),
                required=True,
            )
        elif command == "verification":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument(
                "--outcome",
                choices=("stale",),
                required=True,
            )
        elif command == "remediation":
            command_parser.add_argument("--thread-id", required=True)
            command_parser.add_argument("--turn-id", required=True)
            command_parser.add_argument("--effective-model")
            command_parser.add_argument("--effective-reasoning-effort")
        elif command == "resolve":
            command_parser.add_argument("--query", required=True)

    title_parser = subparsers.add_parser("format-title")
    title_parser.add_argument("--status", required=True)
    title_parser.add_argument("--issue-number", type=int)
    title_parser.add_argument("--pr-number", type=int)
    title_parser.add_argument("--fallback-kind", choices=("Project", "Task"))
    title_parser.add_argument("--fallback-text")

    triage_parser = subparsers.add_parser("triage")
    triage_parser.add_argument("--input", type=Path, required=True)
    triage_parser.add_argument("--capacity", type=int, required=True)
    triage_parser.add_argument("--active-overlap-key", action="append", default=[])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "state-dir":
            print(state_directory())
            return 0
        if args.command == "parse-selector":
            print(
                json.dumps(
                    parse_sdlc_selector(args.selector, observed_at=args.observed_at),
                    sort_keys=True,
                )
            )
            return 0
        if args.command == "route-profile":
            print(
                json.dumps(
                    choose_sdlc_route(
                        role=args.role,
                        risk=args.risk,
                        luna_supported=args.luna_supported,
                        small_single_issue=args.small_single_issue,
                    ),
                    sort_keys=True,
                )
            )
            return 0
        if args.command == "validate":
            load_register(args.path)
            print(json.dumps({"status": "valid", "path": str(args.path)}))
            return 0
        if args.command == "format-title":
            print(
                format_title(
                    status=args.status,
                    issue_number=args.issue_number,
                    pr_number=args.pr_number,
                    fallback_kind=args.fallback_kind,
                    fallback_text=args.fallback_text,
                )
            )
            return 0
        if args.command == "triage":
            try:
                issues = json.loads(args.input.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise OrchestrationStateError(
                    f"cannot read triage input safely: {error}"
                ) from error
            if not isinstance(issues, list):
                raise OrchestrationStateError("triage input must contain a list")
            print(
                json.dumps(
                    triage_issue_candidates(
                        issues,
                        capacity=args.capacity,
                        active_overlap_keys=args.active_overlap_key,
                    ),
                    indent=2,
                    sort_keys=True,
                )
            )
            return 0

        path = selected_path(args)
        if args.command == "init":
            register = new_register(args.project_id, args.orchestrator_id)
            write_register(path, register)
            print(json.dumps({"status": "initialized", "path": str(path)}))
            return 0

        register = load_register(path)
        authoritative_state_root = _state_root_for_register(
            path, parse_root(args.state_root)
        )
        if args.command == "goal":
            checked_at = args.checked_at or now_utc()
            parse_time(checked_at, "checked_at")
            register["goal"] = {"state": args.state, "last_checked_at": checked_at}
            register["updated_at"] = now_utc()
            write_register(path, register)
            print(json.dumps(register["goal"], sort_keys=True))
        elif args.command == "inventory":
            set_inventory(
                register,
                complete=args.complete,
                limitation=args.limitation,
                rotation_offset=args.rotation_offset,
            )
            write_register(path, register)
            print(json.dumps(register["inventory"], sort_keys=True))
        elif args.command == "scope":
            scope = parse_sdlc_selector(args.selector, observed_at=args.observed_at)
            set_sdlc_scope(register, scope)
            write_register(path, register)
            print(json.dumps(scope, sort_keys=True))
        elif args.command == "route-request":
            route = default_sdlc_route(
                route_id=args.route_id,
                role=args.role,
                risk=args.risk,
                luna_supported=args.luna_supported,
                small_single_issue=args.small_single_issue,
                observed_at=args.observed_at or now_utc(),
                issue_number=args.issue_number,
                pr_number=args.pr_number,
            )
            upsert_sdlc_route(register, route)
            write_register(path, register)
            print(json.dumps(route, sort_keys=True))
        elif args.command == "route-verify":
            route = resolve_sdlc_route(register, args.route_id)
            verify_sdlc_route(
                route,
                thread_id=args.thread_id,
                host_id=args.host_id,
                effective_model=args.effective_model,
                effective_reasoning_effort=args.effective_reasoning_effort,
                effective_worktree_policy=args.effective_worktree_policy,
                observed_at=args.observed_at,
            )
            upsert_sdlc_route(register, route)
            write_register(path, register)
            print(json.dumps(route, sort_keys=True))
        elif args.command == "decision":
            decision = default_gate_decision(
                decision_id=args.decision_id,
                gate_type=args.gate_type,
                decision=args.decision,
                task_id=args.task_id,
                issue_number=args.issue_number,
                pr_number=args.pr_number,
                candidate_revision=args.candidate_revision,
                deployment_identity=args.deployment_identity,
                evidence_digests=args.evidence_digest,
                authority_envelope_digest=args.authority_envelope_digest,
                reason_category=args.reason_category,
                resulting_state=args.resulting_state,
                validity_digest=args.validity_digest,
                request_digest=args.request_digest,
                decided_at=args.decided_at or now_utc(),
            )
            recorded = record_gate_decision(register, decision)
            write_register(path, register)
            print(json.dumps(recorded, sort_keys=True))
        elif args.command == "launch-request":
            launch = default_launch(
                issue_number=args.issue_number,
                goal_contract={
                    "objective": args.goal_objective,
                    "project_boundary": args.project_boundary,
                    "completion_conditions": args.completion_conditions,
                    "constraints": args.constraints,
                },
                observed_at=args.observed_at or now_utc(),
            )
            upsert_launch(register, launch)
            write_register(path, register)
            print(json.dumps(launch, sort_keys=True))
        elif args.command == "launch-preflight":
            launch = resolve_launch(register, args.issue_number)
            preflight_launch(
                launch,
                config_inheritance_supported=args.config_inheritance_supported,
                permission_selection_supported=args.permission_selection_supported,
                permission_readback_supported=args.permission_readback_supported,
                mode_selection_supported=args.mode_selection_supported,
                mode_readback_supported=args.mode_readback_supported,
                observed_at=args.observed_at,
            )
            upsert_launch(register, launch)
            write_register(path, register)
            print(json.dumps(launch, sort_keys=True))
        elif args.command == "launch-bind":
            launch = resolve_launch(register, args.issue_number)
            bind_launch_task(
                launch,
                thread_id=args.thread_id,
                host_id=args.host_id,
                observed_at=args.observed_at,
            )
            upsert_launch(register, launch)
            write_register(path, register)
            print(json.dumps(launch, sort_keys=True))
        elif args.command == "launch-verify":
            launch = resolve_launch(register, args.issue_number)
            verify_launch_readback(
                launch,
                effective_permission_profile=args.effective_permission_profile,
                effective_execution_mode=args.effective_execution_mode,
                observed_at=args.observed_at,
            )
            upsert_launch(register, launch)
            write_register(path, register)
            print(json.dumps(launch, sort_keys=True))
        elif args.command == "upsert":
            task = default_task(
                thread_id=args.thread_id,
                project_id=args.project_id,
                status=args.status,
                observed_at=args.observed_at or now_utc(),
                host_id=args.host_id,
                title=args.title,
                issue_number=args.issue_number,
                pr_number=args.pr_number,
                run_mode=args.run_mode,
                worktree_path=args.worktree_path,
                branch_name=args.branch_name,
                base_revision=args.base_revision,
                subject_thread_id=args.subject_thread_id,
                target_revision=args.target_revision,
                review_outcome=args.review_outcome,
            )
            prior_id = args.refreshes_review_thread_id
            evidence_ref = args.review_refresh_evidence_ref
            if prior_id is not None or evidence_ref is not None:
                task["review_refresh"] = {"prior_thread_id": prior_id, "evidence_ref": evidence_ref}
            else:
                current = next(
                    (item for item in register["tasks"] if item["thread_id"] == task["thread_id"]),
                    None,
                )
                if current is not None and "review_refresh" in current:
                    task["review_refresh"] = current["review_refresh"]
            if task["run_mode"] in {"review_session", "verification_session"}:
                task = verify_task_settings_readback(
                    task,
                    effective_model=args.effective_model,
                    effective_reasoning_effort=args.effective_reasoning_effort,
                    observed_at=args.observed_at or now_utc(),
                )
            task["cursor"] = args.cursor
            task["terminal_verified"] = args.terminal_verified
            task["final_read"] = args.final_read
            task["reconciled"] = args.reconciled
            task["needed_for_dependency"] = args.needed_for_dependency
            task["blocker_category"] = args.blocker_category
            if archive_eligible(task):
                task["closeout_result"] = "reconciled"
            if task["run_mode"] == "issue_session":
                if args.legacy_review_order:
                    raise OrchestrationStateError("legacy review order can only accompany a new refresh")
                activate_issue_session(register, task)
            else:
                upsert_task(register, task, legacy_review_order=tuple(args.legacy_review_order))
            write_register(path, register)
            print(json.dumps(resolve_task(register, task["thread_id"]), sort_keys=True))
        elif args.command == "archive":
            task = set_archive_state(
                register,
                thread_id=args.thread_id,
                archive_state=args.state,
                review_base_revision=args.review_base_revision,
                review_target_revision=args.review_target_revision,
                verification_base_revision=args.verification_base_revision,
                verification_target_revision=args.verification_target_revision,
                state_root=authoritative_state_root,
            )
            write_register(path, register)
            print(json.dumps(task, sort_keys=True))
        elif args.command == "cleanup":
            task = set_cleanup_state(
                register,
                thread_id=args.thread_id,
                cleanup_state=args.state,
                worktree_clean=args.worktree_clean,
                branch_evidence_preserved=args.branch_evidence_preserved,
                task_owned=args.task_owned,
                state_root=authoritative_state_root,
            )
            write_register(path, register)
            print(json.dumps(task, sort_keys=True))
        elif args.command == "review":
            task = set_review_outcome(
                register,
                thread_id=args.thread_id,
                review_outcome=args.outcome,
            )
            write_register(path, register)
            print(json.dumps(task, sort_keys=True))
        elif args.command == "verification":
            task = set_verification_outcome(
                register,
                thread_id=args.thread_id,
                verification_outcome=args.outcome,
            )
            write_register(path, register)
            print(json.dumps(task, sort_keys=True))
        elif args.command == "remediation":
            task = resolve_task(register, args.thread_id)
            task = record_remediation_turn(
                task,
                turn_id=args.turn_id,
                effective_model=args.effective_model,
                effective_reasoning_effort=args.effective_reasoning_effort,
            )
            upsert_task(register, task)
            write_register(path, register)
            print(json.dumps(task, sort_keys=True))
        elif args.command == "list":
            print(json.dumps(register["tasks"], indent=2, sort_keys=True))
        elif args.command == "launches":
            print(json.dumps(register["launches"], indent=2, sort_keys=True))
        elif args.command == "routes":
            print(json.dumps(register["routing_decisions"], indent=2, sort_keys=True))
        elif args.command == "resolve":
            print(json.dumps(resolve_task(register, args.query), indent=2, sort_keys=True))
        elif args.command == "summary":
            print(summarize(register), end="")
        return 0
    except OrchestrationStateError as error:
        print(f"orchestration state error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
