# Disclosure and role patterns

Treat density as a consequence of the task. A sparse start is useful when the user needs orientation or one next action. A dense table is useful when they need comparison, scanning, or repeated operations. Reduce irrelevant information before reducing useful information.

## Choose a disclosure mechanism

| Need | Useful mechanism | Keep visible |
| --- | --- | --- |
| Compare candidates | Compact list or grid, then detail view | Decision-relevant differences |
| Understand optional supporting material | Labeled expansion or resource drawer | Enough context to know the detail exists |
| Configure an infrequent option | Secondary settings section | Current setting if it changes the outcome |
| Act on selected records | Contextual bulk toolbar | Selection count and a way to clear selection |
| Complete dependent choices | Steps with back/edit and progress | Earlier choices needed for the current decision |
| Audit one record | Row action opening history | Current status and recognizable action label |
| Perform repeated expert work | Direct controls, shortcuts, persistent filters | Frequent actions and working context |

Use a tooltip only for short supplementary clarification. Use a popover, drawer, or page for interactive content. A modal suits a bounded decision; it becomes cumbersome for long editing or frequent cross-record comparison. Do not split a short independent form into steps just to create a sense of minimalism.

## Role-specific starting points

These are hypotheses to adapt to the actual brief, not requirements inferred from role names.

| Role | Typical immediate purpose | Initial view | Reveal later |
| --- | --- | --- | --- |
| Student | Continue or choose learning | Current activity, useful next step, meaningful progress | Lesson resources, detailed progress, rewards, role details |
| Instructor | Prepare, teach, or review | Relevant teaching workspace, active work, items needing review | Quest details, authoring options, objectives, version history, bulk actions |
| Manager | Operate the workspace | Actionable counts/status, clear routes to people and work | Member history, workspace configuration, selected-record actions |

Share components and terminology across roles while selecting content and navigation by purpose. Avoid showing every role's metrics and tools to everyone. An instructor may also manage a workspace: support an explicit context switch or a clear combined workflow when the brief calls for it. UI visibility is not an authorization boundary.

## Example journeys

**Student:** arrival → Continue lesson → current instructions → optional resources. If there is no lesson, explain how to join or choose one. Do not fill the page with zero-value progress widgets.

**Instructor:** quests list → open or create a quest → edit relevant content → review → publish. Distinguish draft/saved/published states; show prerequisites and consequences before publishing. Expose version history on request. Row selection can reveal bulk actions, but frequent filtering stays accessible.

**Manager:** workspace overview → members → search or select a member → details/history or an authorized action. Keep operational counts linked to the records they summarize. Add charts only when a trend answers a real management question.

## Guardrails against excessive hiding

- Keep prices, prerequisites, destructive consequences, validation errors, and required legal/contextual information available before commitment when applicable.
- Keep data needed for side-by-side comparison together. A drawer per row may conceal the comparison the user came to make.
- Keep a discoverable entry to deferred content; avoid mystery icons and controls that appear only on hover.
- Preserve working state through back, dismissal, and context changes. Explain any deliberate loss before it happens.
- Offer efficient access for frequent users when a guided first-use path would otherwise slow them down.
- A blank page still needs orientation and a next step. Show only useful status, but do not imply success when data is loading, unavailable, or absent.
