# Project UI conventions across tasks

For UI work, inspect the project's existing instructions, design-system guidance, shared
components, and explicit approved decisions before choosing copy or controls. Reuse only
conventions applicable to this repository and changed surface. A prior task's isolated screen
correction is not automatically a project-wide rule; another project's style is never authority.

Use a short section in existing project guidance when authorized work establishes a reusable
rule. No mandatory new file, history ingestion, or global memory write is needed. Record:

| Convention | Project and surface scope | Approved source | Exceptions or superseding source |
| --- | --- | --- | --- |
| Concise functional copy | This project's application screens | Explicit user decision or project guide | Keep useful errors, accessible labels, and decision-support text |
| Shared controls and theme | Named component consumers | Current design-system guide | Document a semantic or accessibility exception |

At intake, choose current applicable rules using their sources, not frequency of old complaints.
An explicit newer decision supersedes the affected older rule. If generalizing an ambiguous
choice would materially change scope, ask one grouped question; otherwise keep it screen-local.
Do not request confirmation again for a clear existing project convention.

Before delivery, inspect every changed rendered screen and make an on-screen text pass. For each
visible heading, description, helper, placeholder, empty state, and feedback message, identify
the user action, decision, required input, or recovery step it supports. Remove copy that has no
such purpose, repeats nearby UI, describes the implementation, or adds excessive metatext. This
purpose check applies even when the project has no recorded concise-copy convention.

Deliver operation progress, success, failure, and other status text through the project's
Sonner/toast component or a dialog when the user must respond. Do not leave status paragraphs,
banners, or similar prose on the main screen. Keep the feedback accessible, including announcement
and focus behavior, and retain essential labels, field-specific validation, and decision-support
content. Compare changed components and typography/theme tokens against applicable project rules,
then inspect representative rendered states. Fix conflicts or record a justified exception
supported by the current request. Avoid brittle exact-word tests or screenshots of unchanged
screens. Update warranted guidance in the same PR; do not redesign unrelated pages.

For each changed asynchronous interaction, trace the initiating action through immediate feedback,
pending or streaming work, ready content, empty results, failure, retry, and cancellation where
applicable. Show immediate visual feedback at the action or affected region. Render cached-ready
data without an artificial wait; use a skeleton for an imminent layout, a determinate progress
bar only with real progress, and streaming output when the transport supports it. Do not present
partial data as a final result or invent a percentage. Observe time to first visible feedback in
a running app, not only request completion. Route status words through the toast or dialog rule
above; a non-text spinner or progress bar can remain at the action or content region.
For shared controls, routing, or overlapping work, apply
[composed async feedback acceptance](composed-async-feedback.md): observe all consumers together,
bind feedback to operation lifetime, and retain delayed, warm-cache, failure/retry, and cleanup
evidence. Use the optional trace checker for consistency, alongside actual rendered observations.

For changed infinite scroll, pagination, charts, or other incremental loading, identify the user
demand trigger, page bound, duplicate-request guard, and completion condition. Preserve relevant
scroll or pan anchor, zoom, focus, selection, and active gesture as data is appended or refreshed.
Verify both a user-triggered append and a no-demand interval in the rendered interaction. Check
that requests do not loop or duplicate and that the viewport does not jump; inspect network
requests when fetch timing matters. Do not require animation where stable positioning suffices.

Optional `ui_conventions` in a task record binds each review to repository identity, source,
surface, and current/superseded status. Only current applicable rules participate in delivery.
A failed or unreviewed applicable rule blocks final evidence; an exception needs a reason.
The validator checks recorded decisions, not the truth of screenshots or preference provenance.

When handing off a UI addition or update, apply [UI Design's final-reply visual requirement](../../ui-design/SKILL.md#final-reply-for-ui-changes).

Fresh-task evaluations: Project A has an explicit concise-copy/shared-Select rule and a new
screen must consume it; Project B has no such rule and must not inherit it. Both projects must
still run the default text-purpose and status-feedback pass. A screen-local correction must not
spread. A newer decision must override only the affected rule. Inject a redundant subtitle,
unneeded helper copy, persistent status paragraph, and native select to demonstrate detected
conflicts, then verify the corrected render uses a toast or dialog for status while retaining
essential field validation and accessibility text. Do not use instruction-string tests alone.
Also inject a delayed first response, a partial result shown as final, a duplicate page fetch,
and a viewport jump after append. Check the corresponding rendered transitions and no-demand
interval rather than asserting only that guidance text exists.
