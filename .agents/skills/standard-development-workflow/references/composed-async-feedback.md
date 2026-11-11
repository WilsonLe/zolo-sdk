# Composed async feedback acceptance

For a changed async flow, inventory the initiating control, shared control wrapper, router,
global progress consumer, and data region that can render feedback. Observe them together with
a delayed operation. Disabled styling alone is insufficient. Verify recognizable immediate
feedback and accessible busy state, honest content readiness, and the same operation's lifetime.
Keep cached-ready content visible during warm revalidation while showing pending feedback.

Use this project's approved indicator count and ownership convention. A project may choose one
shared indicator or several independent region indicators; no universal single-spinner rule
applies. An indicator may own several overlapping operations. Completing/cancelling one operation
or mounting another consumer must not clear another operation's feedback. Check both pending
overlap and terminal cleanup; inject failure and retry with distinct attempt identifiers.
Observe ready, empty, failure, cancellation, warm cache, and retry where the flow supports them.
Retain required accessible announcements and focus behavior under the project's toast/dialog rule.

Measure the initiating action and first recognizable feedback, then sample during the delay and
after settlement. State the reviewed observation budget and its source; do not invent a universal
millisecond threshold. A unit test of a button prop or pending boolean does not prove composed
rendered behavior. Browser evidence must identify the changed surface and runtime revision;
synthetic traces establish checker behavior only.

## Optional observation replay

Run `python3 <skill-root>/scripts/check_async_feedback.py trace.json`. The helper checks a supplied
trace without launching a browser. Exit codes: `0` consistent, `3` acceptance failure,
`2` malformed input. `runtime_verified` is always false: inspect the referenced browser artifact
and match the requested environment before reporting runtime acceptance.

```json
{
  "evidence_kind": "fixture",
  "feedback_deadline_ms": 100,
  "timing_source": "synthetic evaluation budget",
  "max_indicators": 1,
  "policy_source": "Project A approved convention",
  "frames": [
    {"at_ms": 0, "action_at_ms": 0, "event": "start", "operation": "navigation-a",
     "feedback": ["navigation-a"], "pending": ["navigation-a"],
     "indicators": [["navigation-a"]], "busy": ["navigation-a"], "ready": []},
    {"at_ms": 1500, "event": "sample", "pending": ["navigation-a"],
     "indicators": [["navigation-a"]], "busy": ["navigation-a"], "ready": []},
    {"at_ms": 2000, "event": "finish", "operation": "navigation-a", "outcome": "ready",
     "terminal_observed": true, "pending": [], "indicators": [], "busy": [],
     "ready": ["navigation-a"]}
  ]
}
```

Each `indicators` entry is one visible marker's operation-owner array, so `[["a", "b"]]`
represents one shared marker covering two pending operations; `[["a"], ["a"]]` represents two
markers. `busy` identifies operations covered by observed accessible busy state. `feedback`
identifies recognizable initiating feedback, excluding disabled-only styling. Start frames
record `action_at_ms`; timestamps are monotonic observations. Add `cached_ready: true` to a warm
start and retain that operation in every pending frame's `ready` list. `retry_of` identifies a
completed attempt; use a new operation ID. Finish outcomes are `ready`, `empty`, `failed`, or
`cancelled`; `terminal_observed` records actual content or recovery/status feedback. End only
after all required operations settle. Unobserved transitions remain an evidence limitation.

For captured browser observations set `evidence_kind` to `browser-observation` and add a nonsecret
`artifact` reference containing runtime identity, surface, timings, and rendered/accessibility
observations. Also supply `expected_runtime` and `observed_runtime` objects, each with nonempty
`revision`, `environment`, and `surface` strings. All three must match; old-build or wrong-target
observations fail even when their feedback states look correct. These objects may also accompany
fixtures to test stale evidence. Omit `max_indicators` when no approved count exists. Use negative replays for
disabled-only feedback, stacked markers, premature clearing by a different consumer, stale
markers, late feedback, partial-ready content, and missing terminal feedback, then verify each
corrected transition in the running product. Fixtures cannot substitute for those observations.
