# Verification channels, frozen evidence, and release

## Verification-channel contract

For browser verification, follow [browser selection](../../agentic-workflows/references/browser-selection.md).
Preflight the selected host channel for the required claims. Retain explicit
browser and engine requirements and repository test suites. Record any fallback's
reason and actual channel.

In structured claims, `decision: primary` requires `selected_channel` to match
`primary_channel`. Record a different channel under the existing equivalent,
partial, or diagnostic decision, with its required justification and authority.

For every explicitly requested or risk-critical claim, record:

- the observable claim;
- primary tool, environment, account, device, or control channel;
- early availability preflight;
- pre-approved equivalent fallbacks;
- weaker partial or diagnostic substitutes;
- approval owner and blocking behavior;
- the exact channel that produced each artifact.

An **equivalent fallback** proves the same claim through an independently justified boundary. A
**partial substitute** proves only a subset. **Diagnostic evidence** helps investigation but cannot
satisfy acceptance. If a required channel becomes unavailable and no equivalent was approved,
stop the completion claim and request direction.

Never relabel Playwright as Chrome CDP, API output as browser proof, a screenshot as interaction
proof, local evidence as deployed-environment proof, or one account/provider/device as another.
Fallback availability never broadens credential, authorization, privacy, security, or
data-integrity boundaries.

Examples:

- Browser automation through another engine is equivalent only for claims independent of the
  requested engine or control channel; otherwise it is partial.
- A simulator cannot silently replace a required real-device hardware or operating-system claim.
- An unauthenticated mock cannot satisfy an authenticated provider/account flow.
- Local health, API, or browser output cannot satisfy a staging identity or deployed-integration
  claim.

## Actual outcome check

Use Engineering Diagnosis's [actual outcome method](../../engineering-diagnosis/SKILL.md#verify-actual-outcomes)
to define independent expected results before implementation and inspect actual
consumer results afterward. This applies to requested behavior as well as bug fixes.
Keep this reference's channel, candidate identity and final-evidence contracts.

In new structured bug-fix claims, add `verification.claims[].outcome_check`:
`input_ref`, `expected_result`, `observed_result`, `evidence_ref`, `evidence_kind`
(`actual` or `controlled`), `state` (`passed`, `failed`, `unavailable`), and `limitation`.
Keep references and concise redacted observations, not sensitive source payloads.
An unavailable path may leave observation/evidence empty but must name its limitation.
Failed checks retain their observation/evidence and limitation. Controlled or failed
checks cannot satisfy an actual outcome claim. Final record validation rejects any
declared outcome required for the current milestone still unsatisfied, even if
omitted from the final evidence list. `completion_required` defaults to `true`.
Use `false` only for an explicitly deferred future milestone, naming that milestone
and the reason in `limitation`; its unsatisfied claim cannot enter satisfied/final
evidence. Make it required and refresh candidate/target evidence when that milestone
is reached. Deferral does not weaken the actual/controlled, state, or observation
checks for any claim reported satisfied.
Legacy claims without this field remain readable; the helper cannot prove semantic
truth, discover missing acceptance claims, or detect falsely labeled real evidence.

## Rehearsal and final evidence

Capture rehearsal evidence during iteration when helpful, but label it clearly and never use it to
satisfy review or deployment. Finalize evidence only after:

- the candidate is committed and tracked source is clean;
- implementation and complete planned local checks are stable;
- applicable immutable artifact identities are known;
- required channel claims are satisfied;
- retained artifacts are complete, visually inspectable when required, and secret-safe.

The final manifest binds repository and commit identity, build/package/container/deployment
artifact identities, validation results, evidence file digests, capture context, exact channels,
timestamps, skipped or inapplicable checks, limitations, and environment classification without
credentials.

Relevant source, test, workflow, generated-file, artifact, deployment, or evidence drift removes
final status and requires revalidation or recapture. Recheck the manifest at draft-PR handoff,
merge readiness, and staging. Identity and hashes do not replace visual inspection of requested
visual evidence. Cleanup cannot remove required evidence before durable handoff.

For “available now?” questions, follow [release-readback.md](release-readback.md). Read the
requested target's active revision, start mode, URL, health, and relevant user flow. Do not infer
availability from a PR, merge, completed deployment job, saved tab, or earlier readback.

## Plugin release readback

For an authored plugin, use its repository's release and rollback runbooks.
For this suite, follow [host installation and updates](../../agentic-workflows/references/onboarding.md#update-an-existing-installation).
Use Codex's source marketplace or the verified Codex distribution. If the target is another plugin, discover its actual distribution
channel and required release evidence.

Verify the installed source and candidate parity, installed or enabled state
where exposed, and a fresh-session load from the expected path. Record the
release revision and any package version or cache identity the host exposes.
When the task requires a rendered plugin entry, inspect it through the available
host UI. Roll back through the project's documented process and recheck the
active package and workflow.
