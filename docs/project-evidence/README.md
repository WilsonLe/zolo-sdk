# Preserved project evidence

These selected records were copied on 12 November 2026 to remove dependence on the original chat and visualization folder. [manifest.json](manifest.json) pins all retained files. They contain synthetic validation/source evidence, not account stores or keys. Absolute paths in historical records identify original execution locations and are not portable commands.

- Root 0.46: `zalo-sdk-0.46-main-integration.json`, `zalo-sdk-0.46-review-pass2.md`, product candidate/owned manifest and final PR handoff. The PR gate was unavailable because no Git repository/remote existed.
- Candidate 0.47: plan, source identity, source reports, archive/payload records, documentation reconciliation and independent consumer-author originals under `sdk047-consumer-author/`.
- `zalo-sdk-0.47-inherited-focused319.*`: 319 inherited checks, exit 0.
- `zalo-sdk-0.47-source-new22.*`: 22 new source-blind public groups, exit 0.
- `zalo-sdk-0.47-installed-public95.*`: 95 installed-package checks, exit 0.
- `zalo-sdk-0.47-installed-strict41.*`: 41 strict fixtures without skipLibCheck, exit 0.
- `zalo-sdk-0.47-installed-imports.*`: root 303/e2ee 99, CJS and private-export checks, exit 0.
- `zalo-sdk-0.47-baseline046-positive-controls.*`: five old-package positive controls, exit 0. `baseline046-missing-operation.*`: one expected failure because 0.46 has no new function; this is not a final-candidate failure.
- `first-build.*` and `final-pack.*`: successful candidate build/package commands. An earlier packaging-directory preparation failure is described in the reconciliation record; these final logs do not imply a first-attempt success.

Each `.process.json` pairs a command, working directory, time bound, observed terminal state and exit code with its `.log`. Counts are separate scopes, not additive claims of unique coverage or full CI. They were inspected during wrap-up but not rerun as SDK tests. Final candidate review, source-absent relocation and integration remain unfinished. Current wrap-up verification is recorded separately in [../project-wrapup-validation.json](../project-wrapup-validation.json).

The full source candidate and exact archive are under ../../work-in-progress/. Native bundles and private sessions are not included. Source hashes/anchors allow a future developer to match an independently acquired artifact; missing original bundles are an explicit prerequisite for retracing, not evidence of parity.
