#!/usr/bin/env python3
"""Replay secret-free async observations; never drive or certify an application."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def names(value: object) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise ValueError("operation identifiers must be nonempty strings in an array")
    return value


def check_trace(trace: dict) -> dict:
    kind = trace.get("evidence_kind")
    if kind not in {"fixture", "browser-observation"}:
        raise ValueError("evidence_kind must identify fixture or browser-observation")
    if kind == "browser-observation" and (
        not isinstance(trace.get("artifact"), str) or not trace["artifact"]
    ):
        raise ValueError(
            "browser observations require a secret-free artifact reference"
        )
    runtime_errors = []
    if (
        kind == "browser-observation"
        or "expected_runtime" in trace
        or "observed_runtime" in trace
    ):
        for field in ("expected_runtime", "observed_runtime"):
            identity = trace.get(field)
            if not isinstance(identity, dict) or any(
                not isinstance(identity.get(key), str) or not identity[key]
                for key in ("revision", "environment", "surface")
            ):
                raise ValueError(f"{field} requires revision, environment, and surface")
        if any(
            trace["expected_runtime"][key] != trace["observed_runtime"][key]
            for key in ("revision", "environment", "surface")
        ):
            runtime_errors.append(
                "runtime observation identity differs from the requested candidate"
            )
    deadline = trace.get("feedback_deadline_ms")
    if (
        (not isinstance(deadline, int) or isinstance(deadline, bool))
        or deadline < 0
        or not trace.get("timing_source")
    ):
        raise ValueError(
            "feedback_deadline_ms requires an explicit observation budget and timing_source"
        )
    limit = trace.get("max_indicators")
    if limit is not None and (
        (not isinstance(limit, int) or isinstance(limit, bool))
        or limit < 1
        or not trace.get("policy_source")
    ):
        raise ValueError(
            "max_indicators requires a positive integer and approved policy_source"
        )
    frames = trace.get("frames")
    if not isinstance(frames, list) or not frames:
        raise ValueError("frames must be a nonempty array")
    active: set[str] = set()
    completed: set[str] = set()
    cached: set[str] = set()
    errors: list[str] = runtime_errors
    previous_time = -1
    starts = 0
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise ValueError("frame must be an object")
        timestamp = frame.get("at_ms")
        if (
            (not isinstance(timestamp, int) or isinstance(timestamp, bool))
            or timestamp < 0
            or timestamp < previous_time
        ):
            raise ValueError("at_ms must be nonnegative and monotonic")
        previous_time = timestamp
        event = frame.get("event")
        operation = frame.get("operation")
        if event in {"start", "finish"}:
            if not isinstance(operation, str) or not operation:
                raise ValueError("start/finish requires an operation identifier")
        if event == "start":
            action_time = frame.get("action_at_ms")
            if (
                not isinstance(action_time, int) or isinstance(action_time, bool)
            ) or not 0 <= action_time <= timestamp:
                raise ValueError(
                    "start requires measured action_at_ms no later than observation"
                )
            if timestamp - action_time > deadline:
                errors.append(
                    f"frame {index}: initiating feedback exceeded observation budget"
                )
            if operation in active or operation in completed:
                raise ValueError("each attempt needs a unique operation identifier")
            retry = frame.get("retry_of")
            if retry is not None and retry not in completed:
                raise ValueError("retry_of must identify a completed attempt")
            active.add(operation)
            starts += 1
            if frame.get("cached_ready") is True:
                cached.add(operation)
            if operation not in names(frame.get("feedback", [])):
                errors.append(
                    f"frame {index}: initiating feedback missing for {operation}"
                )
        elif event == "finish":
            if operation not in active:
                raise ValueError("finish must identify an active operation")
            if frame.get("outcome") not in {"ready", "empty", "failed", "cancelled"}:
                raise ValueError(
                    "finish requires ready, empty, failed, or cancelled outcome"
                )
            active.remove(operation)
            completed.add(operation)
            cached.discard(operation)
            if frame.get("terminal_observed") is not True:
                errors.append(f"frame {index}: terminal outcome feedback not observed")
        elif event != "sample":
            raise ValueError("event must be start, sample, or finish")
        pending = names(frame.get("pending"))
        indicators = frame.get("indicators")
        if not isinstance(indicators, list):
            raise ValueError("indicators must be an array of operation-owner arrays")
        owners: set[str] = set()
        for indicator in indicators:
            owned = names(indicator)
            if not owned:
                raise ValueError(
                    "visible indicators require at least one operation owner"
                )
            owners.update(owned)
        busy = names(frame.get("busy"))
        ready = names(frame.get("ready", []))
        if len(pending) != len(set(pending)) or set(pending) != active:
            errors.append(
                f"frame {index}: pending lifetime differs from active operations"
            )
        if not active.issubset(owners):
            errors.append(f"frame {index}: visible pending feedback missing")
        if owners - active:
            errors.append(f"frame {index}: stale or unowned indicator")
        if not active.issubset(set(busy)) or set(busy) - active:
            errors.append(
                f"frame {index}: accessible busy lifetime differs from pending work"
            )
        if limit is not None and len(indicators) > limit:
            errors.append(f"frame {index}: approved indicator limit exceeded")
        if set(ready) & (active - cached):
            errors.append(f"frame {index}: partial result presented as ready")
        if not cached.issubset(set(ready)):
            errors.append(
                f"frame {index}: cached-ready content hidden during revalidation"
            )
        if event == "finish" and frame["outcome"] == "ready" and operation not in ready:
            errors.append(f"frame {index}: completed ready content not observed")
    if active or not starts:
        errors.append(
            "trace has no completed operation or leaves required work pending"
        )
    return {
        "passed": not errors,
        "evidence_kind": kind,
        "errors": errors,
        "runtime_verified": False,
    }


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
