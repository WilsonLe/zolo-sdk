# Design references

Primary repositories and skill instructions were initially inspected on 2026-10-06; Taste Skill was reassessed and Hallmark was inspected on 2026-11-02 at the revisions below. Other entries retain their original inspection scope. These are qualitative instruction reviews, not controlled benchmarks of generated interfaces. Links to commits preserve the source context; verify current documentation before making a new installation recommendation.

This plugin is an original synthesis with no upstream runtime dependencies. It does not redistribute the inspected skills or make their workflow gates, packages, or styling prescriptions mandatory.

## Source assessment

| Source at inspected revision | Useful contribution | Fit and limits for this taste |
| --- | --- | --- |
| [Interface Design](https://github.com/Dammyjay93/interface-design/tree/2f9be3206855bcb2d1d0af262c8bae25cba6658d) | Product UI begins with the user/task; meaningful hierarchy, consistent primitives, and a project system record | Closest conceptual foundation for dashboards and tools. Its stated scope excludes marketing sites, so it cannot cover every requested surface by itself |
| [Impeccable](https://github.com/pbakaus/impeccable/tree/459438175f60feb0443165e0fd6dfb07031ac959) | Surface-purpose distinctions, durable product/design context, critique, audit, distillation, layout, and hardening | Useful broad companion for design reasoning and finishing. Its launcher/setup conventions are separate from the user's preferences; they are not inherited here |
| [Emil Design Engineering](https://github.com/emilkowalski/skills/tree/e8a175de22ae1e49370fc144c1f3bb9aeedf988d/skills/emil-design-eng) | Purposeful interaction feedback, motion frequency, interruption, easing, tooltips, and reduced motion | Useful specialist for interaction polish. It does not replace information architecture or role/task design; avoid treating specific values as universal rules |
| [Anthropic Frontend Design](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/SKILL.md) | Subject-grounded visual decisions, restraint, compact tokens, purposeful motion, planning and critique | Useful general frontend craft. Evaluate the current instructions rather than relying on older descriptions of the skill's aesthetic |
| [Vercel Web Design Guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | Review of web interface quality, usability, and accessibility against [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) | Useful verification layer, not an authority for Wilson's taste. These links track upstream and may change |
| [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/477bcb28c9812b385cb51a4605ddf30d7b2266e2) | Searchable style/palette/framework guidance and reusable design-system context | Useful catalogue when exploring alternatives. A style catalogue cannot decide what belongs on a surface; it also adds tooling beyond this instruction-only plugin |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill/tree/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill) | Subject-specific direction, content and evidence before composition, separate page/app reasoning, and critique of rendered results | The current version covers public pages and app screens. Its house rules, randomized direction tooling, mandatory page imagery/motion, and scoring caps remain separate from this skill's task-focused defaults |
| [Hallmark](https://github.com/Nutlope/hallmark/tree/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark) | Scope-aware visual changes, preservation of content and behavior contracts, source-backed brand values, mockup comparison, and portable system notes | Useful discipline for redesigns and implementing a chosen visual target. Its theme dealing, style gates, CSS stamps, hooks, provider-specific generation, and separate approval steps are not inherited |

The inspected Impeccable skill reported version 4.5.0. The other revision identifiers above identify source snapshots, not comparable release numbers. Repository popularity and a modern-looking example were not treated as evidence of task fit.

[Agents with Taste](https://emilkowal.ski/ui/agents-with-taste) also supports writing down the reasons behind design corrections so they become reusable guidance. This plugin applies that idea through a scoped project taste record rather than vague instructions to make a UI look better.

### Taste Skill reassessment, 2026-11-02

The [earlier snapshot](https://github.com/Leonxlnx/taste-skill/tree/ce26fc25c0e5e8cab638f883de62d9a86ee5e45b) informed the original page-oriented assessment. At `12af471f627f866411b4bd785b19646d3672784c`, the [entry point](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/SKILL.md) and [app-screen reference](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/app-screens.md) establish separate workflows. The old apps-excluded assessment no longer describes that revision.

Adapted here: ground a direction in the subject's actual details; organize page sections by reader questions and available proof; retain useful content when simplifying; keep app figures consistent with their data; and compare rendered candidates at matching widths and states. The [copy](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/copy.md) and [critique](https://github.com/Leonxlnx/taste-skill/blob/12af471f627f866411b4bd785b19646d3672784c/skills/taste-skill/references/critique.md) references informed those decisions. The existing visual-and-interaction reference owns this guidance; no separate taste workflow is introduced.

Not adopted: universal device or palette bans, fixed headline limits, required picture or motion counts, generated direction sheets, and award-style score gates. They express upstream house taste and tooling assumptions rather than this user's accepted project decisions. Upstream study and testing claims are not independently verified here and establish no measured improvement in this workflow. This remains an original instruction synthesis with source attribution; no upstream code, asset library, or runtime dependency is bundled.

### Hallmark assessment, 2026-11-02

Inspected the [entry point](https://github.com/Nutlope/hallmark/blob/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark/SKILL.md) and its [redesign](https://github.com/Nutlope/hallmark/blob/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark/references/redesign.md), [brand](https://github.com/Nutlope/hallmark/blob/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark/references/brand-truth.md), [composition comparison](https://github.com/Nutlope/hallmark/blob/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark/references/comp.md), and [system record](https://github.com/Nutlope/hallmark/blob/4f6a46c6dc325d40ab268c93e25c7b96676ebccd/skills/hallmark/references/design-md.md) references at `4f6a46c6dc325d40ab268c93e25c7b96676ebccd`.

Adapted into existing owners: distinguish polish, restyle, and redesign scope; identify and preserve affected content and wiring; derive brand facts from current sources; compare a rendered implementation with an accepted mockup at matching dimensions; and link project taste notes to actual implementation definitions. Before/after critique also asks what the previous version made easier. These additions extend the Taste Skill synthesis without adding another workflow or record format.

The upstream theme library and fixed style/word-count gates remain its own taste and tooling. No Hallmark scripts, hooks, generation providers, mandatory mockup selection, or new approval waits are introduced. Its source review and examples do not establish measured improvement here; no upstream runtime was executed or redistributed.

## Design approach

Use task-first product design as the foundation, then layer disclosure and role-specific information architecture, restrained visual craft, accessible interaction, and rendered verification. Interface Design informed the product-UI foundation; Impeccable informed broader purpose and critique; Emil informed interaction judgment; the guideline sources informed review discipline. Wilson's preferences and the inspected CYOBot macro patterns determine the default direction.

Do not stack every upstream skill blindly. Conflicting tone, fixed style dials, setup questions, and redundant documents can obscure the current brief. Reach for a specialist when the task needs it, preserve its attribution if using it, and resolve conflicts through the user's instructions and the accepted project system.

## Updating the research

When revisiting a source, inspect its actual current instructions, record a date/revision, and distinguish new observations from previous conclusions. When evaluating output quality, use the same task and constraints across candidates and inspect functioning results. Do not claim a performance ranking from instruction review alone.
