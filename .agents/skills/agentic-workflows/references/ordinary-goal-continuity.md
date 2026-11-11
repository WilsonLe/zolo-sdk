# Ordinary Goal-mode continuations

Apply this contract when the host already has an explicitly requested goal. A normal request
to implement work does not create a goal, activate `$sdlc-loop`, delegate work, or authorize
merge/deployment. Read the current host goal and latest user instructions before continuing.

Carry named required outcomes and exclusions forward. A newer explicit correction replaces only
the affected scope. For example, removing Safari from a Chrome/Safari task leaves Chrome required;
do not keep asking about Safari or reinstate it on the next automatic turn. Reconcile the host
objective using supported controls. If the host cannot edit an existing objective, retain the
effective scope in the task contract, disclose the stale host objective, and continue authorized
work under the corrected scope. Do not create a replacement goal merely to rewrite its objective.

Count blocked turns only when the same concrete condition prevents all meaningful progress.
Continue independent authorized work first. Actual progress, a changed blocker, or changed scope
resets the unchanged-blocker audit; repeated green PR checks and identical approval requests are
not progress. Use the current host's documented threshold. On the current Codex host, after three
consecutive goal turns at an impasse, call `update_goal(status="blocked")`, read back the returned
status, and stop goal work. A later explicit resume starts a fresh audit, including after a
previous blocked state. Do not remain active indefinitely while repeating the same blocker.


Pause only at the user's explicit request. Mark complete only when every remaining required
outcome has been achieved with appropriate evidence. A PR open, checks green, or budget nearly
exhausted does not complete a goal that still requires approved merge, deployment, or runtime
verification. If controls are unavailable, report that limitation without claiming a transition.
Never claim paused, blocked, or complete from narrative alone; use the actual host readback.

## Optional read-only replay

Run `python3 <skill-root>/scripts/check_goal_continuity.py trace.json` against secret-free recorded
turns. It recommends decisions and checks terminal claims; it never calls host APIs, grants
authority, or proves that the supplied observations are true. Exit codes: `0` consistent,
`3` unsupported terminal claim, `2` malformed input. Keep the live readback as separate evidence.

Minimal replay input (item identifiers stand for concrete required outcomes):

```json
{
  "goal_id": "actual-existing-goal-id",
  "initial_scope": ["chrome", "safari"],
  "blocked_after": 3,
  "host_contract": "current host update_goal contract",
  "turns": [{
    "observed_goal_id": "actual-existing-goal-id",
    "explicit_scope": ["chrome"],
    "host_scope": ["chrome", "safari"],
    "remaining": [],
    "progress": true,
    "independent_work": false,
    "blocker": null,
    "controls_available": true,
    "scope_update_supported": false,
    "observed_status": "complete",
    "claims_terminal": true
  }]
}
```

Append one entry per actual goal turn, not per tool poll. `explicit_scope` is the full effective
scope after applying a direct user correction. `remaining` contains only unfulfilled required
items. `progress` means new evidence or completed authorized work; `independent_work` means useful
authorized work can still proceed. `blocker` is a stable, nonsecret condition identifier, not a
changing timestamp or log. Optional `explicit_pause` and `explicit_resume` record direct requests;
retain pause/resume events in the replay. `observed_status` is the current host status or
`unavailable`. Bind every available readback's `observed_goal_id` to the existing `goal_id`,
so another goal's terminal state cannot satisfy this task. Set `claims_terminal` only when the
agent reports an actual terminal transition.
Scope reconciliation output explains whether a supported edit or disclosure of stale host scope
is needed; it does not mutate the goal. Preserve the original host contract as evidence when
supplying `blocked_after`; do not increase it to prolong an unchanged loop.
