---
name: engineering-diagnosis
description: Use whenever fixing a software bug, repeated error, or performance regression; discover the full supported cause family and verify the user's actual outcome without waiting for a request for branch and leaf symptoms.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- No additional setup beyond installing this plugin.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# Engineering diagnosis

Read the intended environment and running revision. Follow repository delivery and
evidence rules and the Standard Development Workflow when available. Protect
secrets and personal data in observations.

## Establish a useful signal

1. Capture the exact symptom and first failure safely. Separate observation from
   suspected cause; inspect accessible logs and state before asking the user.
2. Run the smallest repeatable check through the failing path. Derive expected
   results independently of the implementation: known inputs, values, ordering,
   durable effects, or a trusted baseline. Confirm a relevant wrong result fails
   the check; successful execution alone does not prove correct behavior.
3. Control unstable inputs and minimize setup and steps, rerunning after each change.
   For intermittent failures, improve reproduction rate. If the real path is
   unavailable, name the missing evidence before claiming a root cause.

## Locate and fix

Rank a few falsifiable explanations and their distinguishing probes. Test the
cheapest boundary first, changing one variable at a time. Measure a performance
baseline before altering code. Keep temporary instrumentation removable.

Apply [existing abstractions first](../engineering-exploration/SKILL.md#existing-abstractions-first):
repair the responsible owner instead of duplicating its rule in a workaround.
Apply [Ponytail](../ponytail/SKILL.md) when selecting the smallest complete remedy;
preserve validation, supported callers and the outcome checks below.
Where a useful seam exists, retain the minimized case as a failing regression,
make the justified fix, and rerun that same test through the original interface.
If no suitable seam exists, report the limitation rather than add an irrelevant test.

Repeat the original user-facing flow on the intended running revision. Remove
probes and report the initial signal, cause confidence, changed behavior, and
unverified environment or provider boundaries.
Use [cause-family coverage](#cover-the-cause-family) before the first patch and
[actual outcome checks](#verify-actual-outcomes) before declaring the remedy verified.

## Cover the cause family

Every bug-fix request includes investigation of the supported cause family, even
when the user reports one symptom and does not ask for branch and leaf coverage.
Before the first patch, trace the responsible owner, callers, consumers, and relevant
input, retry, cancellation, persistence, reload, and display states. Follow states
reachable through that mechanism; a single-consumer bug may have one leaf.

Use the same issue or existing task record to map cause → branches (consumers or
failure paths) → leaf symptoms. For each candidate, retain evidence, inclusion or
exclusion reason, and an independently expected result/check. Label unobserved
hypotheses rather than claim they are confirmed defects. Exclude unrelated defects;
material architecture or authority expansion retains the delivery workflow's gates.
Fix the responsible owner and preserve necessary consumer differences. Check each
included supported leaf at its consumer boundary, keeping a failing regression where
practical. Reconcile the same inventory when a new consumer appears and before
handoff; report unavailable coverage instead of claiming the entire family fixed.

For task-role contamination, inspect goal, to-do and review consumers: answers
replacing internal notes, lost completed/blocked tasks, execution markup, and stale
scope belong only where the shared inputs make those failures reachable. A fix to
the to-do display alone cannot establish coverage of all three agents.

## Verify actual outcomes

Before editing, define independently expected user-observable results and relevant
failure states: representative input, target/candidate revision, actual consumer,
timing or durable effect, and a check that detects a plausible wrong result. Preflight
the needed channel early; use the original failing case or a negative control where
practical. A helper or fixture computing its own expected value can hide the defect.

Run the relevant flow after the fix and inspect the actual result at that boundary.
Include rendering, interaction, timing, reload/persistence, or provider receipt when
the claim depends on them. Reuse equivalent checks where they prove the same invariant;
check materially different consumers separately. Local evidence proves local behavior,
not production availability. Record expected and observed results and their evidence.

- Stored mouse coordinates do not prove replay rendering. Use known samples and inspect
  cursor visibility before/after the first sample, movement, pause/rewind and relevant
  viewport positioning. If a recording's first sample occurs at 38 seconds, the cursor
  should remain hidden before then; absence during that interval is not itself a defect.
- Controlled model text proves framing, transport, display and persistence for those
  responses. It cannot prove live model task roles, current scope or completed/blocked
  tasks. Use an authorized live-model path for that claim; classify harness/provider
  failures separately from model behavior.
- A CLI exit code alone does not prove correct output or durable effects. Read back
  output/state against known inputs and the requested result.

Use existing access and cost authority. A missing permission, credential or required
device leaves the dependent outcome incomplete; continue independent authorized work
and report the exact limitation. Do not silently substitute mocks, add a paid request,
or mutate customer data to pass a check. A reviewable development handoff can retain
pending live evidence; it cannot claim that unverified outcome fixed. Records and
synthetic fixtures alone do not prove that an agent follows these instructions.
