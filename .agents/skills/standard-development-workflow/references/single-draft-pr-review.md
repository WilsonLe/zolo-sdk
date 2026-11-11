# Single bounded automatic draft-PR review cycle

For an ordinary implementation task, run one bounded adversarial review-and-address
cycle after opening its draft PR and before final handoff. Use the bundled
[Engineering Review](../../engineering-review/SKILL.md) skill; no additional plugin
installation is required. Explicit user limits take precedence. A verified control
plane retains its own review and independence policy; this default does not activate autopilot.

1. Read back the live PR URL, base SHA, and committed head SHA after focused development
   checks and cheap prerequisites pass. Check supported runners and required static
   audits before starting expensive work. Full-suite checks remain deferred until
   merging is requested. Review
   the complete exact base-to-head diff and affected contracts against the originating
   request, all tracking issues, repository instructions, and relevant tests. Include
   existing PR comments, reviews, and unresolved threads in the feedback snapshot;
   a bot's pending review is not a completed review.
2. Retain a cycle note in the task evidence and PR comment: PR URL, each started pass,
   reviewed base/head, reviewer identity, status (`started`, `reviewed`, `addressed`,
   or `blocked`), coverage/limits, findings and disposition, resulting head, and
   validation evidence. On resume or PR update, read the existing note and continue
   the first incomplete step. Number passes separately from review attempts. A fix
   commit or resumed chat retains the cycle. Apply the two-pass decision below.
3. Use the host's supported independent review channel. Delegate a read-only
   adversarial review to a separate reviewer sub-agent when supported. Supply
   pinned revisions, request/issue links, repository instructions, and the
   Engineering Review skill. The reviewer must not edit files, launch another
   reviewer, or schedule a pass. An available independent review tool may serve the
   same role if it binds findings to the exact candidate. Never substitute the
   implementer's self-review for an independent review. If neither channel is
   available, keep the draft PR, record the blocker, and report the automatic cycle incomplete.
4. Read the complete review result and feedback snapshot. Evaluate every finding
   against the candidate and supported contracts. Fix supported in-scope issues;
   record evidence-backed reasons for rejected findings and the impact, owner, and
   required decision for deferred/out-of-scope work. Do not silently dismiss required
   findings. No findings is a valid outcome only when the reviewer actually completed
   the relevant coverage; passing tests do not substitute for review.
   Retain the Engineering Review coverage map and material candidate decisions in
   this same report/note. Keep source-grounded needs-validation leads with exact
   blockers and next checks, and material rejected claims with counterevidence.
   Evidence state and fixed/deferred disposition are separate. Carry gaps and
   stable root-cause identities into the next pass; recheck changed source and
   conditions instead of inheriting old coverage or verdicts. This does not add
   per-finding verifiers or extend the two-pass budget.
5. After fixes, run affected focused verification and relevant static/generated checks.
   Do not run the full suite unless merging is already requested. Commit and push only
   after applicable checks pass, update PR evidence and the cycle note, and read back
   the resulting base/head and checks. Material fixes change behavior, acceptance,
   interfaces, state/failure contracts, or the evidence supporting clearance. Review
   the final changed state again after such fixes: use pass 2 with an independent
   reviewer, the full updated diff and contracts, prior findings/dispositions, and
   verification results. Refresh the base and finish all known fixes and focused
   checks first. When merge is already authorized, finish required full validation
   before the final pass where practical. Prioritize fixes and their interactions
   while covering the full change. Re-read the live base and head before handoff.
6. Proceed only with current independent clearance on the live pair and all required
   findings resolved. Keep a draft while required review remains incomplete.
   Clearance permits only the next authorized step. Leave GitHub approvals to reviewers.

## Two-pass decision

Allow at most two automatic review-and-address passes. The first reviews the
candidate. The second reviews the state produced by material remediation.
Failed or blocked reviewer attempts follow the existing bounded recovery budget.

When a different work item changes the base or head, compare the live revision
pairs, commit history, and diff. Confirm the change comes from that work and
contains no edits addressing findings from the pass being refreshed. Record the
prior attempt, both revision pairs, and evidence for the attribution in the cycle
note. Preserve prior findings and their dispositions. Coalesce known upstream
changes before launching a fresh independent review of the current pair. This
refreshes the same pass, including after pass 2, and needs no new permission.
An unchanged pair cannot use this exception. Keep stale results as history.

Classify mixed changes that address review findings as remediation. If the cause
is unclear, resolve it before using the refresh exception. After material fixes
prompted by pass 2, further review needs an explicit decision in ordinary mode.
In autopilot, record `stop` or `blocked` for unresolved remediation at the cap.
Preserve candidate identity, verification, findings, and remaining risk in the
handoff. Never start pass 3 automatically.

The cycle note is provenance, not a new workflow-record schema or review approval.
When structured task records are used, reference it from existing verification/handoff
fields. Report each reviewed SHA separately from the final PR head, and distinguish
verified fixes from independently reviewed fixes. Finish with the
[self-contained chat summary](decomposition-and-pr-handoff.md#self-contained-chat-summary),
applying its pre-send check to the actual final reply after the review result is known.
