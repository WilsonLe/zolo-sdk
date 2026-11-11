# Self-contained developer skills

Start at [../AGENTS.md](../AGENTS.md). The skill files here are a vendored, project-local snapshot from [wilsonle/agentic-workflows](https://github.com/wilsonle/agentic-workflows), installed package version `0.2.0+codex.20261018000000`. This is not a claim to track current upstream HEAD. The installed metadata supplies no Git commit. The MIT notice is retained in [LICENSE.agentic-workflows](LICENSE.agentic-workflows).

The [local capability map](CAPABILITIES.md) lists the 16 engineering skills selected by following relative skill dependencies from delivery, diagnosis, review, exploration, intake, simplicity, instruction design, delegation and human setup. Configuration transfer, interactive planning, orchestration, SDLC loop and UI design are included because those skills reference them. Use them only when their trigger and prerequisites apply. Copying does not enable autopilot, hooks or external services.

Skill bodies and their references are unchanged. Package-level scripts, schemas, examples and hooks are retained as supporting data; hooks are not registered. The local capability map is curated; `UPSTREAM-CAPABILITIES.txt` preserves the original map as provenance only. [vendor-manifest.json](vendor-manifest.json) pins the copied payloads. The project-specific reverse-engineering skill is separately authored here.

No global plugin installation, user home directory, original chat, memory store or visualization directory is required to read these instructions. Actual provider access, optional tools and runtimes remain external prerequisites. Select installed host capabilities when available; if a named MCP tool is absent, use the documented static file workflow or report the exact missing capability. Never invent tool results.

To update: select an explicit upstream revision, retain its license, copy complete changed skill directories and supporting dependencies, regenerate the manifest and check links. Review instruction changes as code. Preserve local project policy and record any adaptations.
