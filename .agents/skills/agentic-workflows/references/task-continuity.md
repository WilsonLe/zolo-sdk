# Task continuity for every workflow

Use a short working contract for the user's actual outcome. Retain named artifacts, explicit
exclusions, issue/PR/review/deployment expectations, source of truth, and the evidence that would
prove completion. Carry the contract across turns and task resumption. A newer explicit correction
updates only the affected item; do not ask again for a decision or authorization already supplied
for the same scope. Check current external state before acting or reporting because saved notes
and previous observations can drift.
For repository changes under SDLC, apply the
[plan approval gate](../../standard-development-workflow/references/stage-contracts.md#stage-4a-plan-approval).
Reuse approval of the current plan and honor any issue-first, plan-only, prototype-first,
or stop-before-coding boundary. Continue independent authorized work while a decision is pending.
For an already active ordinary host goal, apply [ordinary Goal-mode continuity](ordinary-goal-continuity.md)
to reconcile corrections, count unchanged blockers, and verify actual terminal status.

When a requested source is authenticated, inspect the named channel early. If one route fails,
classify the failure and check an already-authorized equivalent route to the same source before
declaring the artifact impossible. Do not bypass access controls or treat an error/redirect page as
the source. Keep a secret-free progress list for multi-provider tasks: target, action, observed
state, saved setting, live readback, end-to-end flow result, and next unverified step. A saved
setting alone does not prove the requested flow.
Before asking about provider setup, group independent nonsecret choices into one concise
question. Reuse an answer or exact approval already supplied for the same operation;
ask separately only when dependent consent or private entry cannot be completed with existing authority and a concealed tool path, or the scope materially changes.
For provider clicks and credential transfer, apply [task authority and concealed secrets](task-authority-and-secrets.md).
Continue independent authorized work while waiting and resume at the first unverified step.

Before finishing, inspect the actual requested artifact or target environment. For a source copy,
compare the local result with the source's required pages or sections. For hosted work, distinguish
local, Preview, staging, and production evidence. If a required item remains unverified, report
that precise state and continue independent authorized work.

For repository delivery, use the Standard Development Workflow's
[record and planning guide](../../standard-development-workflow/references/efficient-delivery-and-external-work.md)
for a structured contract, measured verification, and resumable external ledger. Its helper is
optional for lighter non-code tasks.
Every SDLC request requires at least one live tracking issue before implementation and
at least one linked PR before completed delivery. Read back all issue–PR pairs in both
directions; one issue can span several PRs and one PR can deliver several issues.
For tracked implementation changes in a Git worktree, finish with a live PR whose head matches
the reviewed candidate. Read back its base, state, checks, and review status before the final
response, then link it. Reuse a matching existing PR. An unchanged or read-only checkout does
not need an empty PR; an unavailable remote or missing permission is an incomplete blocker.
Before that handoff, reassess whether the implemented behavior makes user docs or agent
instructions stale. Update warranted guidance and maintained mirrors in the candidate; report
the surfaces and checks, or briefly explain why no update was warranted. Known stale required
guidance is an unresolved delivery item.

For later UI tasks, reuse scoped approved [project UI conventions](../../standard-development-workflow/references/project-ui-conventions.md), not inferred global preferences. On every changed screen, check that visible text has a user purpose and deliver operation status through Sonner/toasts or dialogs instead of persistent main-screen prose. For changed async flows, check immediate visible feedback and honest data readiness; for incremental loading, check bounded demand-led fetching and preserved viewport or focus. Before an auto-deploying merge, apply [target prerequisite readiness](../../standard-development-workflow/references/merge-deployment-readiness.md); do not defer known activation dependencies to a post-merge caveat.
