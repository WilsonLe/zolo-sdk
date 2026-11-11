# Project taste record

Use accepted decisions to make later work more consistent. Start by looking for existing project context such as DESIGN.md, PRODUCT.md, a component library, or a design-system document. Follow that project's conventions and update the existing record when substantive work or an explicit user correction warrants it.

For a substantial new surface where reusable design context is desired and no record exists, use a small project-local document such as `docs/frontend-design.md`. Avoid creating a competing system file, adding a dossier for a small fix, or storing project/customer details in global skills or memory.

Describe the system using its actual token, component, font, and asset definitions, with links to their implementation sources. Keep shared choices consistent across pages while allowing each page's composition to serve its task. When notes and implementation differ, identify the discrepancy and resolve it through the accepted project decisions; do not silently document an imagined system.

## Compact structure

```markdown
# Frontend design decisions

## User and task
- Role and immediate purpose:
- Primary action and successful outcome:
- Surface and important states:

## Accepted taste
- Decision:
- Reason tied to user purpose:
- Scope or exception:
- Provenance: explicit user instruction / accepted project design

## Information and disclosure
| Information | Initial or deferred | Trigger | Reason |
| --- | --- | --- | --- |

## System
- Existing tokens/components and any deliberate additions:
- Implementation sources for tokens, fonts, and assets:
- Interaction, responsive, and accessibility decisions:

## Corrections and open hypotheses
- Correction, reason, and what it supersedes:
- Unconfirmed hypothesis and how to validate it:

## Verification
- Rendered states/journeys checked:
- Remaining limitations:
```

Record specific reasons: “Keep the manager's member count linked to Members because it starts routine people management” is useful. “Make it clean and modern” is not enough to guide a later decision.

Label agent proposals as hypotheses until accepted through explicit feedback or the project's normal decision process. Silence is not approval. When the user corrects a decision, amend or supersede the old rule so future agents do not treat both as active. Retain only the context needed to apply the correction.

Keep product-specific exceptions scoped. “Instructor bulk actions appear after selection” should not become “hide all secondary actions everywhere.” A data-heavy comparison table and a sparse onboarding view can both satisfy purposeful minimalism.

When applying this plugin in a different project, carry the general principles and read that project's accepted context. Do not carry private data, identifiers, or one product's incidental styling into another.
