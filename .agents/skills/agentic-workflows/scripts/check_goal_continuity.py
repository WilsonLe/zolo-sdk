#!/usr/bin/env python3
"""Read-only replay of ordinary Goal-mode continuation decisions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def scope(value: object) -> set[str]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise ValueError(
            "scope and remaining must be arrays of nonempty item identifiers"
        )
    if len(value) != len(set(value)):
        raise ValueError("scope items must be unique")
    return set(value)


def check_trace(trace: dict) -> dict:
    goal_id = trace.get("goal_id")
    if not isinstance(goal_id, str) or not goal_id:
        raise ValueError("goal_id must identify the already existing host goal")
    threshold = trace.get("blocked_after")
    if (
        (not isinstance(threshold, int) or isinstance(threshold, bool))
        or threshold < 1
        or not trace.get("host_contract")
    ):
        raise ValueError(
            "blocked_after requires the current host contract and positive integer"
        )
    turns = trace.get("turns")
    if not isinstance(turns, list) or not turns:
        raise ValueError("turns must be a nonempty array")
    effective = scope(trace.get("initial_scope"))
    repeated = 0
    previous_blocker = None
    paused = False
    results = []
    errors = []
    for index, turn in enumerate(turns):
        if not isinstance(turn, dict):
            raise ValueError("turn must be an object")
        for flag in ("explicit_pause", "explicit_resume", "claims_terminal"):
            if flag in turn and not isinstance(turn[flag], bool):
                raise ValueError(f"{flag} must be a boolean")
        if turn.get("explicit_pause") and turn.get("explicit_resume"):
            raise ValueError("a turn cannot both pause and resume the goal")
        if "explicit_scope" in turn:
            updated = scope(turn["explicit_scope"])
            if updated != effective:
                repeated = 0
                previous_blocker = None
            effective = updated
        if turn.get("explicit_resume") is True:
            repeated = 0
            previous_blocker = None
            paused = False
        host_scope = scope(turn.get("host_scope"))
        remaining = scope(turn.get("remaining"))
        if not remaining.issubset(effective):
            raise ValueError("remaining work must belong to the latest explicit scope")
        blocker = turn.get("blocker")
        if blocker is not None and (not isinstance(blocker, str) or not blocker):
            raise ValueError(
                "blocker must be a nonempty stable condition identifier or null"
            )
        for field in (
            "progress",
            "independent_work",
            "controls_available",
            "scope_update_supported",
        ):
            if not isinstance(turn.get(field), bool):
                raise ValueError(f"{field} must be a boolean")
        if turn.get("explicit_pause") is True:
            paused = True
        if paused:
            decision = "paused"
            repeated = 0
        elif not remaining:
            decision = "complete"
            repeated = 0
        elif turn["progress"] or turn["independent_work"] or blocker is None:
            decision = "continue"
            repeated = 0
        else:
            repeated = repeated + 1 if blocker == previous_blocker else 1
            decision = "blocked" if repeated >= threshold else "continue"
        previous_blocker = blocker if repeated else None
        reconciliation = (
            "current"
            if host_scope == effective
            else (
                "update-supported-scope"
                if turn["scope_update_supported"]
                else "report-stale-host-scope"
            )
        )
        action = (
            decision if turn["controls_available"] else "report-unavailable-controls"
        )
        observed = turn.get("observed_status")
        if observed not in {"active", "blocked", "complete", "paused", "unavailable"}:
            raise ValueError(
                "observed_status requires a current host readback or unavailable"
            )
        if observed != "unavailable" and turn.get("observed_goal_id") != goal_id:
            errors.append(
                f"turn {index}: readback belongs to a different or unidentified goal"
            )
        if repeated > threshold and observed == "active" and turn["controls_available"]:
            errors.append(
                f"turn {index}: unchanged active continuation after blocking threshold"
            )
        if turn.get("claims_terminal") is True:
            if (
                decision == "continue"
                or observed != decision
                or not turn["controls_available"]
            ):
                errors.append(
                    f"turn {index}: terminal claim lacks matching host readback"
                )
        results.append(
            {
                "decision": decision,
                "action": action,
                "blocked_turns": repeated,
                "scope_reconciliation": reconciliation,
                "effective_scope": sorted(effective),
            }
        )
    return {"passed": not errors, "read_only": True, "turns": results, "errors": errors}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    try:
        report = check_trace(json.loads(args.trace.read_text()))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        return 2
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
