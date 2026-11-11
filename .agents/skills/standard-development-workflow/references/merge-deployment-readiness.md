# Merge readiness when a merge deploys

Before an authorized merge, inspect authoritative branch/provider configuration for deployment
triggers. Classify the merge as `deploys`, `does_not_deploy`, or `unknown`; provider branding and
an old report are insufficient. Resolve unknown behavior before calling the merge safe to activate.

When the merge activates a release, confirm that existing authority covers the triggered target
before merging. Apply the [deployment authority boundaries](../SKILL.md#approval-and-evidence-boundaries)
and prepare the [post-merge checks](verification-deployment-cleanup.md#post-merge-deployment-verification).

For a deployment-triggering merge, enumerate prerequisites introduced or changed by this
candidate: migrations and compatibility ordering, required configuration presence (never values),
services/jobs, and feature activation. Bind evidence to the exact candidate, target environment,
deployment configuration, and observation time. Local fixtures and successful builds do not prove
target readiness. Recheck transient prerequisite state immediately before merge.

Each prerequisite must be verified ready, or the feature must be proven safely inactive with a
compatible staged rollout. If readiness is unknown or blocked, stop the dependent merge. Prepare
the concrete remediation and resolve it within existing authority; request only genuinely missing
authority. Never invent approval to provision secrets, migrate production, or disable deployment.
An existing merge approval does not make a missing dependency ready. A non-deploying merge does
not acquire unrelated production requirements or a redundant deployment approval.

A staged rollout needs evidence that all affected entry points are inaccessible/inactive, that
old and new schema/readers remain compatible, and a linked activation follow-up with acceptance
checks. Track unfinished activation separately while retaining the implementation issue closure
rule. Do not leave it only in a terminal caveat. Preserve post-deployment invariant and authenticated
read/write checks, using synthetic data only with the required authority.

Optional `merge_readiness` records include trigger evidence, candidate, environment, configuration
identity, prerequisites, and staged activation evidence. A declared `ready` or `merged` record is
rejected for unknown triggers, stale identities, missing prerequisites, or unverified staging.
`planned` and `blocked` records can retain unresolved checks. This is a record consistency check,
not a mechanical interception of Git merges or proof of provider state. Guidance applies even
when no structured record is used. Revisions, environment, configuration or prerequisite drift
invalidate affected evidence; timestamps never prove that unchanged state is still current.

Evaluate a fresh task with passing local tests and a missing hosted migration/key: an auto-deploy
merge must stop or prove safe inactivity; an ordinary non-deploying merge may proceed. Repeat with
unknown triggers, stale candidate evidence, and an explicitly approved compatible staged rollout.
