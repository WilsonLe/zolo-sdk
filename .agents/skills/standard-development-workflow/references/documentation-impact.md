# Documentation and instruction impact before delivery

At planning, identify who will use the changed behavior and where they currently learn it.
Include relevant README pages, setup and operator guides, API/configuration examples,
troubleshooting and deployment runbooks, `AGENTS.md`, skills, and maintained generated or
bundled copies. Recheck this inventory after implementation and review findings; a planned
"no update" decision may become false when the behavior changes.

Before freezing the candidate or reporting it ready, compare each affected instruction with
the implemented behavior. Update guidance when a command, configuration, interface, user
behavior, architecture, safety boundary, or operator/agent step is now inaccurate or missing.
Keep warranted updates with the implementation whenever possible. Regenerate maintained
copies using the repository's source-of-truth process; do not edit a generated mirror alone.
Run applicable link, example, generation, lint, or package checks and inspect the result.
Describe local, PR, merged, and deployed behavior at its verified status.

Record one brief result in the PR or delivery summary:

- **Updated:** name the changed documentation/instruction surfaces and their checks.
- **No update warranted:** say why existing guidance still describes the behavior accurately.
- **Unresolved:** name the stale required guidance and its owner or linked follow-up. Do not
  claim the candidate is ready while guidance needed to use or operate it remains stale.
  A separately owned release or system may require its own update; report that boundary and
  current limitation explicitly.

For durable architectural choices, apply [project ADR maintenance](project-adrs.md)
and include affected IDs and validation, or a justified no-impact reason. ADRs
capture lasting rationale while this impact check covers instructions and usage.

Do not edit documents merely because source files changed. For example, a private refactor
that preserves the documented API, commands, configuration, and operator steps can use
"no update warranted." A changed setup command or configuration key requires the setup guide
and any governing agent instruction to be corrected and checked before delivery.

When UI work establishes reusable project decisions, use [project UI conventions](project-ui-conventions.md); keep isolated corrections scoped and never update global memory automatically.
