# Zalo SDK developer entry point

The project goal is to inspect the installed Zalo app, reverse engineer its behavior, and build a personal user-account client SDK with authentication and all operations, so applications can build their own client or bot. Full native/provider parity is unfinished.

Start with [project handoff](docs/project-handoff.md), [roadmap](docs/project-roadmap.md), [developer guide](docs/developer-guide.md), and [operation status](docs/operation-status.md). These files are the repository handoff; the original conversation and global plugins are not required.

## Local skills

Read the applicable project-local SKILL.md before work. Discover supporting skills through [.agents/CAPABILITIES.md](.agents/CAPABILITIES.md), with provenance in [.agents/README.md](.agents/README.md).

- Changes and delivery: [.agents/skills/standard-development-workflow/SKILL.md](.agents/skills/standard-development-workflow/SKILL.md).
- Bugs: [.agents/skills/engineering-diagnosis/SKILL.md](.agents/skills/engineering-diagnosis/SKILL.md).
- Source tracing/design: [.agents/skills/zalo-reverse-engineering/SKILL.md](.agents/skills/zalo-reverse-engineering/SKILL.md) and [.agents/skills/engineering-exploration/SKILL.md](.agents/skills/engineering-exploration/SKILL.md).
- Review: [.agents/skills/engineering-review/SKILL.md](.agents/skills/engineering-review/SKILL.md).
- Keep scope simple: [.agents/skills/ponytail/SKILL.md](.agents/skills/ponytail/SKILL.md).
- Agent guidance: [.agents/skills/agent-instruction-design/SKILL.md](.agents/skills/agent-instruction-design/SKILL.md).
- Delegation, when requested or required by the applicable workflow: [.agents/skills/delegation/SKILL.md](.agents/skills/delegation/SKILL.md). Preserve one runtime owner and independent review.

## Repository facts and work boundaries

The original handoff was prepared without Git. On 12 November 2026 the user explicitly requested Git initialization, an initial project commit and public publication as `WilsonLe/zolo-sdk`. See [repository setup](docs/repository-setup.md) for the publication scope. This authorizes repository publication, not resuming SDK feature implementation or publishing an npm release. Future changes should inspect current Git identity and follow the applicable issue/PR workflow.

Root package.json is 0.46.0. `work-in-progress/sdk-0.47/` is an unintegrated candidate, not the root SDK or a released version. Do not copy it over root without completing its remaining review/validation gates. Do not run root and candidate npm commands in the wrong directory.

Preserve unrelated files, saved sessions, cookies and private keys. Never copy node_modules, personal configuration or account stores into evidence. Generated dist and types/zca output come from `npm run build`; preserve the patched vendor tarball and lockfile.

Static evidence, synthetic checks, installed-package behavior, live provider acceptance and recipient delivery are different claims. Historical test totals and one-shot grants cannot establish current behavior or authorize another live probe. User phone approval and secret entry remain user-controlled. Do not automatically send messages, publish keys, rotate credentials, restore backups, execute stock/native/WASM code or replay an uncertain operation during ordinary local verification.
