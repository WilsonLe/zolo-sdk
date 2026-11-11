# Worktree bootstrap and runtime isolation

Create the worktree before researching the issue or writing the implementation plan. Minimal
read-only discovery is allowed first because the exact repository, base, and safe target path must
be resolved before mutation.

## Create safely

1. Read repository and parent-directory instructions.
2. Identify the canonical checkout, remote, default/base branch, current branch, dirty state, and
   all existing worktrees. Preserve every unrelated modification.
3. Fetch the required remote state when network access is authorized. Create a clearly named
   feature branch from the intended current base revision, not from an arbitrary dirty checkout.
4. For each new worktree, use a sibling directory formed by appending `.worktrees` to the canonical
   repository directory name, then add a clearly named feature leaf:
   `<parent>/<repository>.worktrees/<feature-name>`. For example, a canonical checkout at
   `/workspace/example` uses `/workspace/example.worktrees/fix-login`. Confirm the path does not
   overlap an existing worktree. Record repository, base revision, branch, and path in progress
   updates.
5. Apply this convention prospectively. Never relocate, reset, clean, rename, or reuse an existing
   or unrelated worktree merely to make it conform or to make room.

## Carry over local configuration without leaking it

1. Resolve the source checkout in the same repository: use the canonical checkout
   by default or the originating worktree when branching from its local setup.
   Do not merge state from unrelated checkouts.
2. Exclude agent authentication stores before inventory or copy. Remote provider
   authentication belongs to [Codex connected apps](../../agentic-workflows/references/service-browser-operations.md),
   not the checkout. Leave legacy credentials untouched. Inventory only required
   application env/config files from repository docs, manifests, and ignore rules.
   Include nested app env files; tracked examples already arrive through Git.
3. Before copying a required runtime file, verify source and destination are inside
   their resolved roots, untracked, ignored, owner-controlled, and free of symlinks
   in every path component. Ignore rules do not untrack files. Resolve unsafe paths
   before writing, without exposing contents.
4. Make independent owner-only copies at matching relative paths. Never overwrite
   an existing destination: reuse only after a concealed comparison proves it
   identical; otherwise preserve it and resolve the conflict. Do not copy global
   credential stores, connector authentication, broad home-directory state,
   shared hardlinks, or symlinks.
5. Verify runtime-file presence, permissions, ignore/untracked status, and required
   application readiness without printing values. Missing required runtime files
   block dependent work; do not treat a partial copy as ready. Optional hosted
   media runtimes use their explicitly configured process input, not a checkout
   credential file or worktree key-copy command.
6. Put distinct nonsecret ports, hostnames, Compose project/database names, or other
   overrides in the documented local override file. Do not modify shared secret
   source files.
7. Verify the intended remote account/project/environment through connected-app
   tools before dependent remote work. A Git worktree does not create a separate
   remote target, provide permissions, or isolate provider data.

## Install and onboard

1. Re-read worktree-local instructions and lockfiles.
2. Verify exact runtime and package-manager versions from repository configuration.
3. Use the lockfile-preserving deterministic install command documented by the repository.
4. Run prerequisite generation, submodule, database, or asset steps only when repository evidence
   requires them.
5. Record commands and outcomes without recording credentials.

## Docker Compose isolation

1. Inspect all ports published by the canonical stack and other feature stacks, including inactive
   repository configurations and active host listeners.
2. Allocate one consecutive digit block large enough for every published worktree service. Keep the
   same last-digit service mapping when practical. Example: if the main stack uses `30289` through
   `30292`, choose a different free consecutive block rather than reusing any of those ports.
3. Assign a unique Compose project name derived from the repository and feature branch so
   containers, networks, and named volumes do not collide.
4. Keep container ports unchanged unless the application requires otherwise; isolate published host
   ports and worktree-facing URLs.
5. Isolate mutable databases, caches, uploads, queues, and volumes. Never point a feature stack at
   the canonical development database unless the repository explicitly defines that as safe.
6. Render and validate the effective Compose configuration before startup.
7. Start the full documented stack, wait for health, inspect logs, and verify the real local URL.
8. Record the port map and Compose project name in the implementation plan and draft PR evidence,
   excluding secrets.

## Capacity and suite isolation

Before startup or another expensive operation, apply the resource budget in
[discovery-contract-and-scope.md](discovery-contract-and-scope.md). Resolve task-owned,
repository-shared, host-shared, and external resources before any cleanup decision.

Worktree isolation does not automatically isolate validation suites. When integration, browser, or
other suites can mutate data observed by each other, give them separate databases, queues, object
stores, caches, filesystem roots, users, fixtures, or namespaces unless repository evidence proves
sharing safe. Record readiness and exact cleanup ownership before starting a suite.
