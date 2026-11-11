---
name: agentic-workflows
description: Route tasks to appropriate Agentic Workflows skills and explain installation, updates, and setup. Use when a web source read is blocked, returns unusable content, or needs a rendered or signed-in browser session; route that read to the built-in browser guidance. Also use when choosing which installed workflow fits a task, starting, launching, or delegating agent sessions and tasks, or installing, updating, or troubleshooting this plugin. Route plain repository edit requests to Standard Development Workflow when installed.
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

# Agentic Workflows

Select the task's skill and read its prerequisites and verification rules. Request
access only when needed. Focused engineering methods complement repository delivery
rules; they do not replace authority or PR gates.

Load missing skill instructions through Codex. In files a skill reads later,
`<skill-root>` is the loaded skill's base directory and `<plugin-root>` is two
levels above it. Resolve both before running a helper or giving a command.

| Task | Skill |
| --- | --- |
| Stop all simulators, remove residual builds, clean up disk space, or reclaim runtime resources | `standard-development-workflow`; read its cleanup coordination before mutation; no-diff cleanup needs no issue or PR |
| Start, launch, resume, fork, or manage another agent session/task; stay here while another agent works | `delegation` (codex); new independent Git sessions default to isolated worktrees and the saved Codex configuration, with explicit overrides supported |
| Activate portable Codex defaults, update the suite with hook approval, or back up/restore workflow configuration | Codex-only `agentic-workflows-config-transfer`; see [configuration](../agentic-workflows-config-transfer/references/codex-configuration.md) |
| Define an issue/PR or product decision | `engineering-intake` |
| Diagnose a difficult defect | `engineering-diagnosis` |
| Review a diff | `engineering-review` |
| Survey architecture or prototype a design | `engineering-exploration` |
| Choose the smallest complete implementation; Ponytail, YAGNI or bloat check | `ponytail` |
| Stress-test requirements, a plan, or a design | `grill-me` |
| Explore, revise, approve, or resume a plan and manage its todos | `interactive-plan` |
| Improve skills or steering files | `agent-instruction-design` |
| Prepare verified manual provider steps | `human-setup-guide` |
| Design or review a frontend | `ui-design` |
| Playtest an app in the browser and report all observed friction | `product-playtest` |
| Research investments, stock theses or portfolio risk; build, backtest or validate stock/futures strategies | `trading-strategy-research` |
| Audit a website/page for SEO, indexing, schema, local/international discovery or AI search visibility | `seo-audit` |
| Grow a product through UGC/creator, video, short-form, visual or written content; choose sources/channels, coordinate production and measure conversion | `product-growth` |
| Create animated artwork or a product showcase video | `motion-design`; pair with `music-composition` for original sound |
| Storyboard and edit footage with speech, blending, transitions and keyframes | `video-editing` |
| Transcribe speech or generate narration | `speech-to-text` or `text-to-speech` |
| Restore dialogue and mix audio | `audio-editing` |
| Index static fonts and lay out titles/captions | `typography` |
| Compose original music, sonic logos, or timed sound effects | `music-composition` |
| Build or prepare a Chrome extension | `chrome-extensions` |
| Select modern web APIs and fallbacks | `modern-web-guidance` |
| Install REA and connect it to the current agent | `rea-setup` |
| Manage Supabase through Codex or run its local development tools | `supabase-cli` |
| Inspect or manage Vercel through the Codex connected app | `vercel-account-operations` |

Route plain-language Git repository code, documentation, configuration, or
artifact planning and edits to `standard-development-workflow`, including terse follow-ups.
Use ordinary Codex delivery gates. Codex's separate `$sdlc-loop` profile
requires direct invocation and validated authority. For tracked worktree edits, open/update and read back
a reviewable PR before handoff unless explicitly local-only. Follow the workflow's
decomposition contract; child merges do not authorize a parent merge to `main`.

Before creating or managing another agent session/task, load `delegation`, including
for audits and read-only work without a configuration request. Use Codex's configuration and an isolated worktree for new independent Git sessions
by default; honor explicit requested overrides. Native
capability and effective-setting verification belong to that skill; task-specific
workflow requirements still apply.

Before provider setup, credentials, or external writes, read
[task authority and concealed secrets](references/task-authority-and-secrets.md).
Necessary in-scope steps reuse task authority; explicit user instructions override
skill preferences, while platform restrictions remain enforced.
For remote provider operations, use [Codex plugins/connected apps](references/service-browser-operations.md)
with Codex-managed authentication. This includes Supabase, Cloudflare, DigitalOcean,
Railway, Vercel, PostHog, and Polar. Reuse existing connections, verify the exact
target through tools, and recover missing connections through Codex. Report missing
connections, operations, or permissions without local-token or dashboard fallback.
Worktree bootstrap carries only required application env/config files, never agent
authentication stores. Local-only development tools remain available when needed.
For other browser steps, read [browser selection](references/browser-selection.md);
prefer the Codex in-app browser unless the user or capability requires another.
For Reddit or blocked web source reads, follow its
[built-in browser route](references/browser-selection.md#blocked-source-reads)
before concluding that the source cannot be inspected.

Keep deliverables and corrections current across turns. For authenticated sources
or multiple consoles, use [task continuity](references/task-continuity.md) before
completion claims. For an existing explicit host goal, use
[ordinary Goal continuity](references/ordinary-goal-continuity.md) on continuation.

## Available skills

- `delegation` (codex)
- `academic-writing-workflow` (codex)
- `agentic-workflows-config-transfer` (codex)
- `engineering-intake` (codex)
- `engineering-diagnosis` (codex)
- `engineering-review` (codex)
- `engineering-exploration` (codex)
- `ponytail` (codex)
- `grill-me` (codex)
- `interactive-plan` (codex)
- `agent-instruction-design` (codex)
- `human-setup-guide` (codex)
- `session-reflection` (codex)
- `orchestration` (codex)
- `sdlc-loop` (codex)
- `cloudflare-account-operations` (codex)
- `calorie-tracker` (codex)
- `digitalocean-account-operations` (codex)
- `railway-account-operations` (codex)
- `vercel-account-operations` (codex)
- `supabase-cli` (codex)
- `literature-review-workflow` (codex)
- `guided-writing-coach` (codex)
- `restaurant-marketing-management` (codex)
- `systematic-literature-review-workflow` (codex)
- `trend-product-design` (codex)
- `trend-product-discovery` (codex)
- `trend-product-onboarding` (codex)
- `trend-product-operations` (codex)
- `trend-product-opportunity` (codex)
- `food-image-editing` (codex)
- `qr-code-generation` (codex)
- `humanizer` (codex)
- `standard-development-workflow` (codex)
- `verified-literature-research` (codex)
- `payloadcms-development` (codex)
- `rea-setup` (codex)
- `youtube-content-inspection` (codex)
- `youtube-library-sync` (codex)
- `youtube-media-operations` (codex)
- `budgeting-account-sync` (codex)
- `budgeting-transactions` (codex)
- `reddit-browsing` (codex)
- `ui-design` (codex)
- `trading-strategy-research` (codex)
- `seo-audit` (codex)
- `product-growth` (codex)
- `video-editing` (codex)
- `speech-to-text` (codex)
- `text-to-speech` (codex)
- `audio-editing` (codex)
- `typography` (codex)
- `motion-design` (codex)
- `music-composition` (codex)
- `chrome-extensions` (codex)
- `modern-web-guidance` (codex)

For installation and plugin troubleshooting, see [plugin-troubleshooting.md](references/plugin-troubleshooting.md), the plugin troubleshooting runbook.

See [onboarding](references/onboarding.md) for installation and the [registry](references/plugin-registry.md) for package status.

Codex automatic session naming uses the bundled user-prompt hook and an ephemeral fast model
with low reasoning, capped at 10 words; see [session-title-policy.md](references/session-title-policy.md) for title rules, opt-out, and host support.
