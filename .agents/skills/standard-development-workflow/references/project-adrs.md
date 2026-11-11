# Project architecture decision records

Each project owns its durable architectural decisions in version control. The
Standard Development Workflow owns this maintenance loop; intake, exploration and
review consume it. Issues/plans own task execution, and ADRs own the lasting
reason for a material choice. Do not duplicate task logs or global memory here.
“Self-maintaining” means agents reconcile records during authorized development;
it does not promise a background service or a periodic scan of unrelated projects.

## Discover and adopt once

At discovery, read project instructions and locate the existing ADR/decision index,
format, IDs, approval policy and checks. Reuse those conventions, even if the path
is not `docs/adr/`; link them from the existing project instruction entry point so
future tasks can find them. Do not create a second store or migrate existing records
merely to use this helper. Multiple competing stores require resolving ownership
before ADR writes. Reuse relevant records instead of bulk backfilling assumed history.

When no convention exists and the first material decision needs a record, initialize
`docs/adr/` using the fallback below, add a short pointer in the project's existing
`AGENTS.md`, and include those files in
the same issue/PR. Each repository has its own sequence; worktrees are branches of
that project's history. A monorepo follows its established project boundaries;
independent applications may use distinct directories selected with `--directory`.
Never infer cross-project write authority from installation of this workflow.

## Maintenance loop

1. **Discovery and planning:** read the index and relevant accepted ADRs before
   choosing architecture. Search superseded records when their rationale matters.
   In the existing issue/plan, link affected ADR IDs, or record “ADR impact: none”
   with a reason. An absent store alone does not require creating one.
2. **Design:** create a proposed ADR for a material, durable tradeoff that is costly
   to reverse: boundaries, persisted/public contracts, data ownership, security/trust,
   infrastructure or a reusable project policy. Small implementation choices stay
   in the issue. Record actual alternatives, constraints, rationale, consequences,
   decision owner/authority evidence and a concrete revisit trigger. Link the issue
   and later the PR without copying sensitive content. A proposal is not approval.
3. **Implementation:** compare discoveries and actual behavior with affected ADRs.
   Correct factual/supporting links in place, preserving dated rationale. A changed
   accepted decision uses a new ADR and explicit supersession, not a rewritten past.
   Revisit triggers are prompts to investigate; they do not automatically expire or
   reverse an accepted decision. If authority or a material choice is unresolved,
   keep the proposal and block only dependent work; continue independent work.
4. **Before PR handoff:** reconcile impacted ADRs against the final diff, fill new
   records, update lifecycle links, regenerate the index, and run project ADR checks
   with focused checks. Record affected IDs and results (or justified no impact) in
   the PR. Reviewers check both architectural drift and missing decisions. A passing
   structural check cannot establish factual accuracy, decision authority or actual
   agent compliance.
5. **Resume and merge:** reuse the same records and recheck them after base/head
   changes. Resolve numeric-ID collisions across branches by renumbering only the
   unmerged new proposal and updating every reference, then refresh/check. Never
   renumber published history. Reconcile accepted status with the project's actual
   decision authority before handoff; merge approval can supply that authority if
   the project says so. This loop grants no merge or deployment permission.

Use the project's existing validation hook when one exists. For a new fallback
store, put the helper's `check` command (with the installed helper path resolved)
in the normal project checks or instruction entry point. Do not hardcode a user's
plugin-cache path in a committed CI command. Maintenance is complete when the same
candidate contains the required ADR changes and a current index, or a recorded
no-impact reason; unsupported existing validators remain an explicit evidence gap.

## Lifecycle and history

| Status | Meaning and permitted next step |
| --- | --- |
| proposed | Undecided; keep or move to accepted/rejected with actual authority evidence. |
| accepted | Chosen by the project's authorized decision process; implementation/deployment evidence remains separate. |
| rejected | Proposal declined; retain its rationale and evidence. A materially different proposal gets a new ID. |
| deprecated | Chosen decision retired without a replacement; retain why/when and evidence. |
| superseded | Chosen decision replaced by another chosen ADR; both records link reciprocally. |

Authority can be an explicit user decision or an existing project policy that
covers routine implementation decisions; do not require a new approval when the
current request already covers the choice. Cite that source in Evidence. Record
status changes with dated reasons and evidence in Decision or Consequences; keep
the original Date as the proposal date. Rejected/deprecated records remain in the
index. If a project later re-adopts an old approach, record a new decision rather
than erasing the intervening history.

## Fallback Markdown contract and helper

The dependency-free [project ADR helper](../scripts/project_adrs.py) owns only the
fallback file format and derived index. The existing task-run validator continues
to own task records; neither consumes the other's persisted state. No dependency
installation, global registry, scheduler, automatic migration or semantic approval
is needed. On existing formats, follow their own tooling instead.

Resolve `<skill-root>` to this installed Standard Development Workflow directory;
run from the target project, supplying its explicit root. For example:

```sh
python3 <skill-root>/scripts/project_adrs.py init --project-root .
python3 <skill-root>/scripts/project_adrs.py new --project-root . --title 'Choose project storage ownership' --date 2026-10-18
# Fill the returned Markdown file, including Owner, Evidence and each section.
python3 <skill-root>/scripts/project_adrs.py refresh --project-root .
python3 <skill-root>/scripts/project_adrs.py check --project-root .
```

Use the actual project-local date, not the example date. For a separate project
boundary or a previously chosen fallback location, pass the same relative
`--directory path/to/adr` on every command.

Files are `0001-lowercase-slug.md`, monotonically allocated from existing IDs, with
canonical IDs padded to at least four digits and a `# ADR-0001: Title` heading.
Each has exactly one metadata line before its sections:

```markdown
- Status: proposed
- Date: 2026-10-18
- Owner: Project maintainer
- Evidence: User request and tracking issue/PR links; decision authority source
- Supersedes: none
- Superseded by: none
```

Required level-two sections are Context, Decision, Alternatives, Consequences and
Revisit. Complete each with meaningful content. The helper rejects empty fields,
empty sections and TODO/TBD placeholders even in proposals; `new` intentionally
creates a draft needing completion before refresh/check or another allocation.
Titles are single-line and omit table pipes. References use numeric IDs separated
by comma-space, or `none`. A superseded record has exactly one `Superseded by` ID;
a chosen replacement lists all records it `Supersedes`. Proposed replacements
link the old ADR in their prose and leave metadata `none` until actually chosen.
On acceptance, update both records in the same candidate. Chains are allowed;
self references, missing targets, cycles and nonreciprocal edges fail validation.

`init` is idempotent and refuses an occupied unmarked store; it does not repair a
stale index. `new` never overwrites records or chooses a status beyond proposed.
`refresh` validates all records before atomically replacing the helper-owned
README index; `check` is read-only and also fails on stale indexes. Errors exit
nonzero without changing decision content. A failed new/edit may leave an incomplete
proposal: finish or deliberately remove that uncommitted proposal before resuming.
An interrupted index write may leave `.project-adrs-index.tmp`; inspect and remove
only that task-owned artifact before retrying. No command deletes ADR history.

Writes use a per-store lock and reject symlinked paths. An interrupted writer may
leave `.project-adrs-lock`: verify no writer is running, inspect changes, then
remove that empty lock before resuming. Do not run check concurrently with an
editor or writer; its snapshot assumes a stable candidate. Separate worktrees
still require the merge-time ID reconciliation above. The helper checks present
structure, not historical status transitions, substantive rationale or whether a
stored URL/authority claim is true; agents and review verify those boundaries.
