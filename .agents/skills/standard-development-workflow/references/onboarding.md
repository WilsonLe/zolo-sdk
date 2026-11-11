# Standard Development Workflow onboarding

Use this guide when the user asks to set up, onboard, or get started with the workflow.

## Prerequisites

- A Git repository with a resolvable canonical checkout and base branch.
- Git worktree support.
- Native independent review or an available independent review tool for draft PR handoff.
- Live GitHub CLI authentication with access to read the repository, create issues and branches,
  push changes, open pull requests, and merge when repository policy permits.
- The repository's documented language runtimes, package managers, test tools, and local stack.
- For containerized applications, Docker and Docker Compose plus an available isolated port block.
- For staging, an existing authorized deployment mechanism and non-production credentials supplied
  outside chat.

Never ask the user to paste secrets. Verify whether required variables or credentials exist without
printing their values.

## First-run readiness check

1. Locate the repository and read its local instructions.
2. Confirm Git and GitHub CLI availability and verify the live GitHub identity. The presence of
   `gh` alone is not proof of authentication.
3. Inspect configured worktrees, canonical checkout status, default branch, remotes, and repository
   protections without changing them.
4. Identify documented install, test, local-stack, and deployment commands.
   Profile existing CI/log timings and repeated setup before proposing test shortcuts; record
   check coverage, mandatory gates, setup cost, median/p95 duration, and mutable resources.
5. Look for a retained repository capability profile in the scoped workflow state directory. Reuse
   it only after verifying repository identity and the relevant evidence digests; otherwise create
   or selectively refresh it from repository evidence.
6. For Docker Compose, inspect the canonical checkout's project name, published ports, networks,
   volumes, and active containers. Identify a consecutive, non-overlapping port block for the next
   worktree without starting it.
7. Preflight explicitly required browser, device, provider, staging, or control channels before
   promising them in the task contract. For authenticated sources, also record an already
   authorized equivalent route and the artifact or flow that must be verified.
8. Report `Ready`, `Needs input`, `Needs configuration`, or `Blocked`, with the next safe action.
9. Do not create a worktree or GitHub issue merely to prove installation unless the user has also
   asked to begin a real change.

The capability profile stores commands, versions, services, key names, and constraints—not
credential values. Keep it outside the project repository by default as defined in
[workflow-record-model.md](workflow-record-model.md).

## Invoke the workflow

Use the installed Standard Development Workflow skill in Codex. Use chat to
approve a specific plan version when native interactive approval is unavailable.

## Suggested first prompt

> Use Standard Development Workflow for this change. Create and onboard an isolated worktree,
> research and create a spec-ready GitHub issue, write the exhaustive implementation and test plan,
> then stop for my approval before coding.
