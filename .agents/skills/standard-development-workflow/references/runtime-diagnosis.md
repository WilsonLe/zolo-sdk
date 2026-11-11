# Runtime diagnosis and privacy-safe traces

Start with the user's exact symptom and intended environment. Read the current
runtime revision, timestamp, request or correlation ID, and first failure from
the applicable logs. Reproduce the smallest safe path before changing code.
For a hard bug, first make a repeatable check that can detect the user's exact symptom
on that path; run it and tighten its signal before advancing a cause theory. A passing
command with no assertion about the symptom does not establish a reproduction. Minimize
the failing input or sequence, then use probes that distinguish falsifiable causes. If
the target path cannot be reached, retain the missing evidence as a limitation.
Use the existing failure taxonomy to separate product, harness, state,
environment, provider/rate-limit, and expected behavior. A suspected cause is
`unproven` until the operation and reproduction support it.

## Cause-family coverage

Apply Engineering Diagnosis's [cause-family method](../../engineering-diagnosis/SKILL.md#cover-the-cause-family)
for every bug fix before the first patch, without requiring “all/every” wording.
Reuse [impact inventory](impact-inventory.md) for its discovery, inclusion/exclusion
decisions, branch/leaf expectations and verification; retain one owner for that state.

For new structured bug-fix records, set `diagnostics[].affected_surface_ids` to
the non-empty, unique IDs of affected leaves in `impact_inventory`. These IDs must
be included, and existing final-inventory validation requires verification for
each included leaf. Discovered unaffected candidates may be excluded with reasons.
Legacy records without this additive link remain readable. The validator catches
record omissions, not undiscovered consumers or the truth of a causal theory;
review the discovery evidence and report unavailable coverage explicitly.

## Trace and remedy evidence

For agent and tool-driven applications, use a correlation ID across the user
action, HTTP request, model step, tool invocation, parameterized query or
provider call, retry, and response. Retain operation name, sanitized argument
shape, query template or digest, error class/status, latency, attempt count,
and result category. Log neither secret values nor raw prompts, personal
records, token-bearing URLs, unredacted SQL parameters, or unrestricted response
bodies. Decide access control, bounded retention, and user consent or notice
under the application's own policy before adding telemetry.

If a trace is absent, state precisely which operation cannot be reconstructed.
Do not fill the gap with a guessed root cause. Add focused instrumentation only
within an authorized code change, then replay with synthetic or redacted data.
After a fix, repeat the original path on the intended running revision and
verify the user-facing result, including an understandable error state when the
external service still fails.
Use an [actual outcome check](verification-evidence-and-release.md#actual-outcome-check)
for the original symptom and each materially distinct included branch; define its
expected result before implementation and inspect the observed result afterward.
When a correct test seam exists, preserve the minimized failure as a regression test
and observe it fail before the fix and pass afterward. A shallow test of a helper does
not replace a test of a defect that occurred across callers or services.

The optional `diagnostics` task-run section records symptom, target, running
revision, trace state, operation, correlation ID, evidence references,
reproduction, root-cause confidence, and the redaction/retention/access policy.
It stores references and classifications, never trace payloads. The validator
will not accept `proven` for a missing trace or without root-cause evidence and
a reproduction reference. A `fixed` outcome also needs a same-path remedy
verification reference. A `mitigated` symptom may keep its cause `unproven`, but
still needs a verified user-facing result. Set a positive `retention_seconds` limit and state the
collection basis. This guard cannot prove that an application actually
emits safe logs; inspect its logging implementation and access path.

## Synthetic evaluation cases

| Symptom | First evidence to seek | Distinguishing result |
| --- | --- | --- |
| Generated SQL fails | Correlated tool operation, query template/digest, database error | Report exact failing step or missing trace; do not invent the SQL |
| 429 response | Provider status, retry-after, attempt count | Distinguish quota/rate limit from a product parse error; show a useful wait/retry state |
| Repeated pagination | Request IDs and cursor/trigger sequence | Confirm whether the client, intersection observer, or server creates the loop |
| Production-only symbol mismatch | Active revision, input contract metadata, selected symbol, order response | Confirm the production path before a trading hotfix |
| Environment-only failure | Runtime configuration identity, service availability, same-code baseline | Correct or report the environment boundary without patching product logic |
