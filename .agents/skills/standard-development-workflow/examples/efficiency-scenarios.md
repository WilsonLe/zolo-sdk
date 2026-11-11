# Efficiency scenarios

## Issue first, then implementation

The user asks for an issue, plan, implementation, and one PR. Record `issue_first` and
`pull_request` as explicit required items. Inspect GitHub for a matching issue; create or reuse it
before writing the detailed plan or changing code. On resumption, inspect its current state and
the PR state, then continue from the first unfulfilled deliverable. A prior approval remains valid
for its exact scope; do not ask for it again simply because a new turn started.

## Later correction to explanation only

The user changes a proposed onboarding-document task to “walk me through the code; no issue or
PR.” Update only the issue and PR items to explicit `excluded`; keep the requested explanation.
The old issue/PR plan does not justify creating either artifact.

## Small library

Profile static and unit commands from actual logs. A passing final unit run for the same source,
input digest, and environment may be reused if the repository's gate permits. An iteration run
does not become final evidence. Compare check coverage before dropping repetitive setup.

## Compose application

Record build, integration, and browser costs separately. Reuse an immutable image only when
source, lockfile, build inputs, architecture, and digest match. A live local server or unit test
cannot replace a required production-built Compose test. Give each concurrent suite its own
database and port block, or run serially. Run the mandatory full gate once on the frozen candidate.

## Concurrent worktrees

Two worktrees may share read-only package caches after identity checks. They must not share mutable
fixtures, test databases, queues, or output directories. Record distinct isolation references and
capacity evidence before overlapping integration and browser checks. A duplicate passed check with
the same revision, input digest, environment, and phase requires an invalidation reason.

## Signed-in source after a connector error

A document API returns an authentication redirect. Record that route as failed, inspect the user's
already-authorized signed-in browser, and verify it reaches the same document. Copy the requested
content locally and compare every required page/section against the browser source. The redirect
page itself is not the source and a partial transcription is not a verified artifact.

## Multi-provider migration paused mid-setup

The database project and Preview variables have saved/readback evidence; the OAuth provider is
still pending. Resume by refreshing those live states, then work on the OAuth step. Do not repeat
project creation or claim the migration works end to end until the authenticated flow passes on
the requested target environment. Store no credential values in the provider ledger.
