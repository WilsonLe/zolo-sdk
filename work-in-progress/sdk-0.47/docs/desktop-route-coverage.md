# Static Desktop route index

[The TSV index](desktop-route-coverage.tsv) records all 454 exact quoted `/api/…` path candidates in the installed Desktop 26.11.10 SHARED member. Its artifact identity and byte offsets match the original [four-column inventory](desktop-route-inventory.tsv). This snapshot accompanies SDK 0.36.0. It is a discovery aid, not operation parity or a runtime coverage percentage.

| Evidence column | Installed routes with evidence |
| --- | ---: |
| Pinned `zca-js` API-module literal | 161 |
| SDK source literal | 106 |
| SDK finite-expression candidate | 85 |
| No evidence in these three columns | 112 |

The columns overlap. A matching upstream literal does not establish an exported callable operation, a correct service or payload, authenticated acceptance, or parity with the installed consumer. An expression candidate means a finite source expression can produce that path under the declared source/type contracts. It does not establish that execution reaches the expression. Unindexed paths may use a builder this matcher does not handle, occur in legacy or gated code, or need implementation. Conversely, operations may use dynamically composed paths absent from the installed exact-literal inventory.

`sdk_literal_sources` and `sdk_expression_candidates` list repository-relative source locations as `src/file.ts:line`. They refer to the accompanying source snapshot; later edits can move lines. Templates, concatenation, conditional branches, local helper returns, finite string types and local record dispatchers are considered. Unknown branches, partial helper returns, external value declarations, unsupported shapes, excessive recursion and alternatives above 256 cause that expression to be omitted rather than partially enumerated. The matcher uses TypeScript source and declared types; assertions, mutable state and call arguments are not an execution model. The matcher never evaluates the SDK or installed application.

Regenerate from the repository with installed development dependencies:

```sh
python3 scripts/desktop-route-inventory.py --sdk > docs/desktop-route-coverage.tsv
node --test test/desktop-route-evidence.test.mjs
```

Without `--sdk`, the inventory command retains its original four-column output. It reads the installed ASAR member directly and verifies the member's SHA-256 against archive integrity metadata. The SDK matcher only reads files under the repository's `src` directory as value declarations. Its regression fixture throws if executed and includes unknown conditional/property/helper branches, external function/record/tuple declarations, implicit fallthrough, bare returns, and valid local finite dispatch.

Use the [operation index](operations.md) and each feature's source evidence, fixture checks and live results to determine usable behavior. Ordinary Desktop QR approval, saved-session bootstrap and profile reading have been verified live. Trusted pairing, task mutations, encrypted-photo delivery and Desktop sign-out retain separate unverified boundaries. The saved Web account's recent-search read returned provider code 212 on 6 November 2026. A separate approved five-GET check of packaged SDK 0.28 verified cloud viewer acquisition, one initial queue page and one selected locator lookup; no locator was fetched. That does not provide live evidence for the current owner refactor, new account-state/family APIs or route parity.

The [cloud viewer](cloud-media.md) and [family viewer](family-media.md) acquisition routes now appear as exact path literals in the private fixed-kind descriptor. Their assembled complete URLs still have an unknown origin expression; the literal match alone does not prove service/payload correctness or authenticated acceptance. Its queue route `/cloudmedia/queue/pc/verify` and locator route `/cloudmedia/downloadurls/pc/v1` are outside this index's explicit `/api/…` scope. The four account-state routes under `/cloudmedia/…` and `/zalocloud/…`, plus family-profile `/zfamily/…` and cloud family-usage routes, are outside that scope too. These omissions do not establish missing SDK functionality or expand the index into full operation parity.

[Pending account-feature contracts](pending-account-features.md) retain source contracts and remaining gaps: native voice URL recovery and unresolved profile-mode and suggested-conversation behavior. Translation coordination, raw voice/video upload, versioned direct boards, password presence, manual translation, transcription, profile reads and catalog resolution have separate implemented guides. Some implemented builders remain unindexed when their complete URL contains an unknown origin expression; the signed password-presence read is one example. Live contact/sticker/profile/direct-board reads, checked V2 catalog resolution and the empty friend emoji-status result are documented in the operation index; these do not establish their write counterparts.

The explicit friend Desktop/Web activity GET now supplies one additional literal at `/api/social/friend/active-pcweb`. Existing ordinary GIF forwarding adds another positively traced kind on the already indexed singular `/forward` routes; it does not create a new endpoint or imply other rich-media kinds. Both remain locally validated with separate live availability/delivery gaps. [Client observations](profile-metadata.md#friend-desktopweb-activity-observations) · [GIF forwarding](gif-media.md#forward-an-existing-ordinary-gif)

Ordinary photo and current non-AI photo-sticker forwarding now add source evidence on those same singular `/forward` routes. Product-catalog single-item view and delete add two literals under `/api/prodcatalog/product/`. The catalog module also projects eight realtime catalog signals without applying native cache or UI effects. These additions have local fixture evidence; live availability, forwarding delivery and deletion effects remain unverified. [Photo forwarding](photo-media.md#forward-existing-ordinary-photos) · [Product catalog](product-catalog.md)

The experimental [phone/PCloud coordinator](pcloud-phone-key.md) uses `/personalcloud_key/req_cloud_key`, which is outside this index's `/api/…` scope. Its explicit prompt, private feed authority, protected persistence and offline enrollment restore require their own workflow checks; this route index supplies no native phone or live interoperability evidence.

The three experimental [group-page reads](group-pages.md) add exact literals for V3 list pages, legacy V2 member pages and feature-gated encrypted-group IDs. Their ordinary account requests and direct response shapes have separate contracts. Static reachability and shipped flags do not establish current server availability, complete membership or encrypted-session trust.

SDK0.41 adds the explicit ordinary TEXT/RTF, STICKER and LINK batch operation on the already indexed `/api/message/mforward` and `/api/group/mforward` routes. Those same literals in the pinned text-only API did not establish the richer callable surface. The new [ordinary batch contract](message-forwarding.md) requires caller-selected metadata/targets/IDs/TTLs and retains native `success`/`failed` partial observations; its 34 synthetic forwarding fixtures pass locally. It does not establish native UI feature enablement, large-group/E2EE orchestration or live delivery. This addition does not rewrite the036 route snapshot as a current parity certificate.

SDK 0.42 adds [ordinary static-location forwarding](location-forwarding.md) on the already indexed singular `/api/message/forward` and `/api/group/forward` routes. Numeric forward kind 7 and its exact point/label projection are distinct from the received card enum 17 and rich batching. All 31 synthetic location fixtures pass locally; this does not regenerate the 0.36 route snapshot or prove native client parity.
