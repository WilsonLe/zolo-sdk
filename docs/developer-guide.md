# Developer guide

Read [AGENTS.md](../AGENTS.md) and [project handoff](project-handoff.md) first. Root is 0.46.0; [0.47](../work-in-progress/sdk-0.47/README.md) is a separate unfinished copy. The local skill catalog is [.agents/CAPABILITIES.md](../.agents/CAPABILITIES.md); no global workflow installation is needed.

## Layout and ownership

| Path | Responsibility |
| --- | --- |
| src/index.ts, src/e2ee-api.ts | Public root and E2EE barrels |
| src/protocol-request.ts, src/realtime-feed.ts | Shared HTTP and owned realtime boundaries; inspect actual callers before changes |
| src/chat-media-upload.ts, src/photo-media.ts, src/signed-photo-upload.ts | Input/action/receipt ownership and raw/signed staging; final sends remain explicit |
| src/desktop-*.ts, src/e2ee-*.ts | Desktop transport/trust and experimental encrypted state/history/recovery |
| bin/, examples/ | CLI and explicit application examples |
| test/, test/types/ | Synthetic behavior and strict consumer fixtures |
| vendor/, package-lock.json | Pinned patched transport and reproducible dependency graph |
| dist/, types/zca/ | Generated outputs from the build |
| docs/operation-status.md, docs/operations.md | Gaps/evidence status and callable-operation navigation |
| docs/project-evidence/, work-in-progress/ | Portable historical evidence and unintegrated candidate |
| .agents/ | Local skills, dependency assets, provenance and project guidance |

Check handoff integrity and local navigation with `python3 scripts/check-project-handoff.py`. This reads files and hashes only; it does not rerun historical SDK checks.

## Local commands

Use Node.js 22+ and the lockfile. In the checkout you intend to change:

```sh
npm ci --ignore-scripts
npm run build
node --test test/signed-photo-upload.test.mjs test/chat-media-upload.test.mjs test/signed-thumbnail046/*.test.mjs
```

Those are focused media checks, not the full suite. `npm test` builds and runs the configured full test globs; reserve it for a justified broad check/release gate. Inspect tests and adapters before execution. Normal local validation uses synthetic inputs and loopback connections. Do not run login, verify, probe, bots or provider mutations as documentation checks. `npm pack --offline` builds and creates a local archive if dependencies/cache are present; it does not publish. Create an explicit output directory before selecting `--pack-destination`.

For the candidate, run commands from `work-in-progress/sdk-0.47/`; its two new runtime files are `test/saved-thumbnail047/saved-core.test.mjs` and `saved-lifecycle.test.mjs`. Do not confuse candidate output with root output. For installed consumers, copy the archive to a separate directory, install it and compile strict declarations without skipLibCheck. Historical exact commands are retained in [evidence process records](project-evidence/README.md); external working directories in them need rebasing, not blind execution.

## Evidence and credentials

Record exact inputs, runtime/tool versions, commands, bounded process completion, source/package hashes and observed results. Keep failed attempts and expected negative controls distinguishable from regressions. Test source must assert independently expected behavior, not duplicate implementation. Native/provider acceptance, rendering and delivery need their own explicit evidence.

CLI session paths and secret-bearing record formats are explained in [authentication](authentication.md) and [Desktop storage](desktop-session-store.md). User approval and secret entry remain user-controlled. Keep account cookies, companion keys, credentials and private databases out of the repository, archives, logs and skill fixtures. A historical account approval does not authorize a fresh live check. Dependency setup and optional analysis tools are not bundled runtimes.

For changes, follow the applicable local skill and update the operation guide and status in the same candidate. Review final generated declarations/export boundaries as well as source. Recheck Git identity before delivery: the handoff checkout had no .git or remote. Do not invent branches/PRs or claim hosted checks. Local documentation delivery requires no provider action.
