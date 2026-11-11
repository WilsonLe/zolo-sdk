# Titles and status

Rename the calling orchestration task with:

```text
<work reference> [ | <work reference> ... ] | <short status>
```

Reference order:

1. `Issue #<number>` when verified;
2. `PR #<number>` when verified;
3. `Project <short-name>` or `Task <short-subject>` only when no issue or PR
   exists.

Examples:

```text
Issue #49 | clarifying
Issue #49 | coordinating
Issue #49 | PR #50 | testing
PR #50 | review
Issue #49 | review queued
Issue #49 | review clear
Issue #49 | blocked
```

Use a one- or two-word operational status where practical. Update the title
when the primary issue, PR, or state materially changes. Never invent a
reference from unverified peer text.

Rename managed peers only after an explicit operator request or a separate
title-management contract for those peers.
