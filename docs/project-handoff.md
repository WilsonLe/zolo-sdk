# Project handoff — 12 November 2026

## Goal and stopping point

> look at installed Zalo app and reverse engineer and build a client sdk with auth and all operations so we can build our own client or bot using a user account

This is a personal-account SDK, with user-controlled sign-in. The long-term goal remains unfinished. This wrap-up preserves the working 0.46 SDK, records unfinished work and equips future developers to continue without the original chat or a global workflow plugin. It does not claim all operations, current account eligibility, native parity or delivery.

## What is available

The root package is `zalo-personal-sdk@0.46.0`, a private Node.js 22+ ESM package with declarations, CLI and `/e2ee` entry point. It uses a pinned, locally patched `zca-js@2.2.0` transport. [README](../README.md) covers sign-in and client/bot usage; [operations](operations.md) lists the public surface and [operation status](operation-status.md) owns per-family gaps.

| Area | Implemented surface | Practical limit |
| --- | --- | --- |
| Authentication | Web/Desktop QR, saved sessions, Desktop bootstrap; explicit password, recovery/security and renewal helpers; opt-in retained companions | Earlier QR/bootstrap/profile/initial socket checks passed with phone approval. Other flows have separate local evidence; historical success does not prove current sessions or trust. |
| Client/bot transport | Typed pinned API, realtime feed, bounded recovery, Web/Desktop echo examples | Examples send only when explicitly configured/run; live echo delivery is not established. |
| Messages and media | Ordinary messages/reactions/receipts, prepared uploads, explicit final sends, forwarding, signed photo/video and 0/5 ordinary thumbnails | Shared state/action ownership and uncertain outcomes are modeled. Provider acceptance, resource lifetime and recipient rendering require separate evidence. |
| Account, contacts and groups | Conversation/settings controls, profiles, contacts, group pages, catalogs/tasks and related reads/mutations | Availability/default gates vary. A listed API or route is not complete parity. |
| Encryption/history/backup/cloud | Experimental device/session/ratchet/content owners, recovery store, archives, mobile and PC-phone components, viewer/resource/key helpers | Native enrollment/peers, complete account history, backup restore and key/resource lifecycle remain incomplete or unverified. |
| Calls | Native bridge and signaling investigation/helpers | Complete authenticated media/call lifecycle remains unfinished. |

Read the linked family guides before depending on an operation. [Desktop evidence](desktop-evidence.md) binds historical source findings to app/member hashes; [route coverage](desktop-route-coverage.md) is discovery evidence, not operation completeness.

## Verified baseline and interrupted candidate

The preserved [0.46 integration record](project-evidence/zalo-sdk-0.46-main-integration.json) and [final review](project-evidence/zalo-sdk-0.46-review-pass2.md) describe the prior local integration. Its recorded scopes were 319 focused workspace tests, 73 installed public tests and 38 strict type fixtures, plus package/import/relocation checks. They are historical, separate scopes, not a newly rerun full suite or hosted CI. The pre-wrap-up owned baseline had 998 files; documentation added by this handoff intentionally changes that baseline.

The next candidate is preserved in [work-in-progress/sdk-0.47](../work-in-progress/sdk-0.47/README.md), with a [1007-file hash manifest](../work-in-progress/sdk-0.47-manifest.json) and the [exact local archive](../work-in-progress/zalo-personal-sdk-0.47.0.tgz). It adds `uploadSignedSavedVideoThumbnail`: prepared JPEG/PNG, fixed feature 9, advertised Saved Messages destination, existing thumbnail receipt/error and an explicit later video send. Destination fields are not caller knobs. This function is absent from root 0.46.

The archived candidate checks completed on 8 November: 319 inherited focused checks plus 22 independently authored new groups; 95 installed public tests; 41 strict type fixtures without skipLibCheck; root 303 and e2ee 99 runtime exports; ESM/CJS/private-helper checks. The previous 0.46 archive passed five positive controls and failed the isolated missing-function assertion as expected. No fixture calibration or production fix was needed for these 22 groups. [Process records and logs](project-evidence/README.md) retain commands and results.

Archive SHA-256: `73d1ec9954d8bef0919ceac640ba63ffc6c6e40dd7460a75b5533a7d4b848add`. All 1710 payloads matched candidate source/dependencies and all 1174 bundled files remained unchanged at that check. Final independent review, source-absent copied/relocated production checks, main integration and main verification were not completed. No 0.47 release, live account/provider check or delivery claim follows from these results. Follow [the roadmap](project-roadmap.md), not the old candidate README's status alone.

## Portable records and external prerequisites

[Project evidence](project-evidence/README.md) retains selected synthetic logs, source reports, plans, manifests and prior review. Absolute visualization paths inside historical JSON identify where checks originally ran; they are provenance, not required paths to resume. Use the local candidate/evidence paths above. Full native app bundles, account stores, keys, node_modules and private history are deliberately not copied. To retrace source, acquire the authorized installed artifact and verify its hash first.

[Local skills](../.agents/README.md) include complete engineering skill dependencies, supporting assets, MIT attribution and provenance hashes. Optional providers/tools still require setup. Copying skills activates no hooks, automation or global configuration.

The original wrap-up was completed without a Git repository or remote. The user subsequently requested an initial Git commit and public publication as `WilsonLe/zolo-sdk`; see [repository setup](repository-setup.md). Earlier non-Git statements in preserved evidence describe the historical checks. Repository publication does not complete 0.47 review/integration, establish hosted CI or prove live SDK behavior.
