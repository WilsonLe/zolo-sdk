# Mandatory issue and PR tracking

Every repository-change SDLC request must have at least one live tracking issue before implementation
and at least one linked PR before completed delivery. This includes code, documentation,
configuration, and artifacts, regardless of size or repository issue conventions.
Reuse relevant existing issues and PRs; do not manufacture duplicates.

The relationship is many-to-many. One issue may require multiple PRs; one PR may
address multiple issues. Every delivery PR links at least one implementation tracking
issue, and every delivered tracking issue links at least one PR. Dependencies, examples,
and follow-ups do not count toward these minimums unless they actually track the request.

Before editing, read back the issue URL, live state, scope, and acceptance criteria.
Before PR handoff, list every tracking issue in the PR body, update each issue body or
canonical comment with its associated PR URLs, and read back every pair in both directions.
Use `Refs` for partial delivery. Use closing keywords only for an issue fully completed
by that PR; close a shared issue only after all PRs needed for its acceptance criteria
have merged and the combined outcome passes. Preserve unfinished work on the open issue.

Record the complete graph in `delivery_tracking`, including live issue/PR and link
readback references. Validate after linkage readback with `--require-final`. Missing
issues, orphan PRs, unpaired delivered issues, or missing readbacks block delivery.
A primary issue URL or PR URL alone does not satisfy this contract.

Planning-only, issue-first, read-only, no-diff, and explicitly local-only boundaries
still limit authorized actions. Create tracking for an authorized SDLC change, but do
not create empty PRs or implement merely to satisfy a count. Such a request remains
planning/local work, not completed SDLC delivery, until its authorized implementation
has the required pair. In Plan mode, defer external writes as well as implementation.
If GitHub issues are disabled, permissions are missing, or a required issue/PR cannot
be created or read back, preserve the work and report the exact incomplete blocker.
Never silently waive tracking or expand authority to enable repository features.
