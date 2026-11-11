---
name: ui-design
description: Design, implement, or review frontend UI/UX with minimal defaults, information justified by user purpose, progressive disclosure, and distinct role workflows. Use for websites, dashboards, forms, onboarding, student/instructor/manager apps, reducing interface clutter, or refining a project's frontend taste. Respect an existing design system and the requested scope.
---

<!-- catalog-prerequisites:start -->
## Prerequisites

- No additional setup beyond installing this plugin.

<!-- catalog-prerequisites:end -->

<!-- catalog-capabilities:start -->
## Companion capabilities

Reuse complete skill and reference instructions already available in the current context for the same source/version, including host-loaded content. A name, description, path, summary, or prior-session read alone is not loaded instructions. Read missing instructions when needed; reread only for a known source/version change, unavailable or truncated content (including after compaction), or an explicit request. A stage transition or repeated link does not require reloading.

When another workflow would help, use the [suite capability map](../../CAPABILITIES.md) for discovery as needed. Apply the selected skill using that reuse rule and check availability and prerequisites; carry the user's brief, accepted decisions, artifacts, and verification limits into the handoff. Keep one owner for shared state and timing. A capability listing does not authorize publishing, paid calls, messaging, or delegation.

<!-- catalog-capabilities:end -->

# UI Design

Start with the user's purpose. Make the interface simple enough that the next useful action is evident. Show information because it supports a decision, action, orientation, or outcome; reveal supporting details as interactions make them relevant.

## Taste and authority

Wilson's stated preferences are the seed for this skill: blank, simple, minimal defaults; information present for specific user purposes; gradual revelation through interaction; and CYOBot's macro decisions as a reference, including its student, instructor, and manager apps.

Apply these as defaults within the current brief. Explicit user instructions and accepted project decisions take priority. Preserve an existing design system unless changing it is within scope. Separate user-approved taste, observed examples, and your own design hypotheses. A reference site's palette, typeface, cards, or animation is not automatically the user's preference.

This skill governs frontend judgment, not repository delivery or deployment. Follow the project's engineering workflow for edits and checks. A design review alone does not authorize implementation. When implementation is requested, carry it through using available tools without introducing a separate aesthetic approval gate.

## 1. Frame the surface

Read the existing brief, UI, components, design tokens, and project design notes before proposing changes. Identify the current role, task, starting state, primary action, and successful outcome. Determine whether the surface mainly helps someone discover, operate, or read; a marketing page and a management table need different information density.

For existing UI, infer the depth from the request: polishing keeps the system and layout; restyling changes the visual system while keeping the layout; redesigning can change composition within the agreed scope. State the distinction when it affects the work. A broader opportunity discovered during a narrow change belongs in a recommendation.

Inventory the content, data, and usable assets before choosing a composition. Use the subject's actual product, place, materials, vocabulary, or workflow to guide the design. Identify missing evidence or integrations early; keep fictional fixtures explicit.

Infer routine choices from context. Ask only when missing information materially changes the result, such as who uses the surface or what action completes the task. Continue independent work while waiting. For a narrow fix, keep this framing brief and preserve surrounding structure.

## 2. Make the information earn its place

For a new surface or substantial redesign, sketch the initial view and the important interaction states before coding. A small table or annotated outline is sufficient:

| Element | User purpose | Initially visible? | Reveal trigger | Next action or outcome |
| --- | --- | --- | --- | --- |
| Current lesson | Resume learning | Yes | Arrival | Continue |
| Lesson resources | Support this lesson | No | Open lesson or resources | Use relevant material |
| Progress detail | Understand what remains | No | Open progress | Choose another lesson |

Remove or defer elements without a concrete purpose. Prefer an honest empty state with an actionable next step to invented statistics, filler cards, or ornamental graphs. Keep necessary navigation, identity/context, status, and recovery visible even when the main work area is sparse.

Use one clear primary action per local decision. Secondary and parallel work can remain available; do not force an entire app into a single button or wizard. Preserve comparison data and frequent expert controls when hiding them increases effort or uncertainty.

For a public page, outline the reader's questions and the evidence each section supplies before choosing its layout. For an app, organize around the work and decisions its data supports. Minimalism still needs complete task-relevant content; removing decoration must not remove the substance people came for.

## 3. Design disclosure around the task

Use selection, expansion, contextual menus, drawers, detail pages, and steps where each mechanism fits the work. Reveal row actions when a row is selected, supporting detail when an item is opened, and configuration when it becomes relevant. Give each reveal an understandable label and a clear path back.

Progressive disclosure must stay discoverable and accessible. Important content cannot depend on hover alone. Preserve selections and input across steps, show where the user is, and support revisiting earlier choices. Keep errors beside the affected control and make successful outcomes evident. Critical consequences belong before commitment.

Read [disclosure and role patterns](references/disclosure-and-roles.md) for multi-role apps, onboarding, tables, or a redesign of information architecture.

## 4. Give the interface a restrained visual system

Use whitespace, alignment, grouping, type hierarchy, and contrast to establish structure before adding containers or decoration. Choose tokens and components from the existing system. For a new system, use a small coherent set of spacing, type, color, radius, and surface values that fits the product.

For a new surface or substantial redesign, state a brief visual direction and why it fits this subject and audience. Carry that decision through the whole surface. A narrow component fix follows the surrounding direction without requiring a new concept or design document.

Reserve emphasis for meaningful priority, state, or brand expression. Cards, colors, icons, and illustrations are allowed when they clarify the task. Avoid repeated boxes, redundant labels, competing calls to action, and decorative motion without a purpose. Minimalism must retain readable contrast, useful labels, and obvious controls.

Read [visual and interaction craft](references/visual-and-interaction-craft.md) when implementing or reviewing visual hierarchy, states, responsiveness, or motion.

## 5. Implement and verify the actual journey

Use the current stack and available components. Preserve affected content and behavior contracts during visual changes, including link destinations, form bindings, routes, and hooks consumed by other code. Build functioning interactions when implementation is requested. Explicitly label prototype-only data or unavailable integrations; never imply a saved or published result without evidence. Keep UI role filtering separate from server authorization.

Inspect the rendered result with the available browser or preview tools. For a redesign or restyle, capture the relevant starting view before edits and compare the candidate at matching viewports and states. Exercise the primary journey, initial/empty/populated/error states relevant to the change, and the interactions that disclose information. Check wide and narrow viewports, intermediate widths where the composition changes, keyboard navigation, focus, dismissal/back behavior, and reduced motion where applicable. Use a supported built preview for final presentation checks when available; state if only development rendering was checked. Run engineering checks appropriate to the change; do not add tests that merely repeat skill wording.

If preview or account access is unavailable, say which states remain unverified. Screenshots establish appearance, not interaction behavior. Do not create records, submit forms, or publish content merely to inspect a reference; use existing views or authorized disposable fixtures.

## 6. Review and retain the taste

Before finishing, ask:

- Is the role's next useful action evident on arrival?
- Does each visible element have a current user purpose?
- Can deferred information be found at the moment it is needed?
- Does disclosure reduce cognitive load without adding unnecessary steps?
- Do hierarchy, responsive layout, and accessible states support the task?
- Does the result carry the subject's real content and identity beyond its first screen?
- Did the design preserve accepted project decisions and the requested scope?

Use the [finishing pass](references/visual-and-interaction-craft.md#finishing-pass) to critique the rendered candidate, address the most consequential in-scope problems, and inspect the affected states again within the engineering workflow's review budget. For a review, prioritize concrete findings with location, user impact, and a specific change. Explain why something should be removed, deferred, or kept visible. For implementation, report the result, verification, and material limitations concisely.

Consult [project taste record](references/project-taste-record.md) when accepted choices or user corrections should carry into later work. Update existing project notes rather than inventing a competing authority. Avoid generating a design dossier for every small fix.

### Final reply for UI changes

When a request adds or updates UI, include at least one screenshot or clearly labelled mockup of the change in the final user-facing reply, unless the user explicitly requests otherwise. Display the image using the host's supported inline image or attachment mechanism. Saving a file, linking to it as ordinary text, or saying screenshots were inspected does not satisfy this requirement. In Codex, embed local images with an absolute filesystem path so they render in the reply.

For implemented UI, capture and inspect the current candidate's changed screen at a relevant viewport and state. Keep private information out of the image. If rendering is unavailable or the deliverable is a design, provide a mockup labelled as such and state what remains unverified; never present a mockup or an old capture as the implemented result. If neither a safe screenshot nor a mockup can be produced within the task's authority, report the missing visual as incomplete rather than claiming visual delivery. An image establishes appearance, not interaction correctness.

## Reference routing

Read only what the current task needs:

- [CYOBot observations](references/cyobot-observations.md) for the inspected inspiration and its limits.
- [Design references](references/design-references.md) for why these defaults were chosen and how upstream skills differ.
- [Evaluation scenarios](references/evaluation-scenarios.md) when testing or revising this skill; these are acceptance cases, not claimed benchmark results.
