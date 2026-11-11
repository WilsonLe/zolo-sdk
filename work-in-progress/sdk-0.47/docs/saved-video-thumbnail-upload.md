# Signed Saved Messages video-thumbnail uploads

SDK 0.47 contract. Local check results, installed-consumer compilation, package checks and independent source-review status are recorded separately. Provider eligibility, upload acceptance, fields/IDs, resource lifetime, native parity, recipient rendering and delivery remain unverified.

`uploadSignedSavedVideoThumbnail` stages caller-prepared JPEG or PNG bytes for the account's advertised Saved Messages/My Documents destination. It resolves and freezes that destination's kind and ID, negotiates with fixed feature 9, and returns the existing `SignedUploadedChatVideoThumbnail`. The caller supplies a same-API realtime feed; the helper starts or stops no listener. Uploading stages a preview. Preparing the MP4 and explicitly sending the matched video/thumbnail receipts are separate calls.

## Complete Saved video flow

This function takes already prepared preview and MP4 bytes, along with the MP4's actual dimensions and duration in milliseconds. Prepare those assets before calling it. The preview must be JPEG/PNG within 5 MiB; the MP4 must satisfy the [signed-video input bounds](signed-video-upload.md#prepared-media-and-receipt). The SDK checks signatures and bounds without generating a thumbnail, probing codecs or determining dimensions/duration.

```ts
import {
  uploadSignedSavedVideoThumbnail, uploadSignedChatVideo, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendSavedClip(
  api: API,
  feed: RealtimeFrameFeed,
  thumbnailActionId: number,
  videoActionId: number,
  preview: { fileName: string; bytes: Uint8Array },
  clip: {
    fileName: string; bytes: Uint8Array;
    width: number; height: number; durationMs: number;
  },
) {
  if (!Number.isSafeInteger(thumbnailActionId) || thumbnailActionId < 1
    || !Number.isSafeInteger(videoActionId) || videoActionId < 1
    || thumbnailActionId === videoActionId) {
    throw new TypeError('Supply two distinct positive safe-integer action IDs.');
  }
  const thumbnail = await uploadSignedSavedVideoThumbnail(api, {
    feed, clientId: thumbnailActionId,
    fileName: preview.fileName, bytes: preview.bytes,
  });
  const destination = {
    threadType: thumbnail.threadType, threadId: thumbnail.threadId,
  };
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: clip.fileName, bytes: clip.bytes,
    width: clip.width, height: clip.height, durationMs: clip.durationMs,
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
```

Use two IDs unused in this API instance. The video's destination comes from the issued thumbnail receipt. Do not replace it with the account UID or a fresh `getSavedMessagesThread` lookup: an advertisement change must not silently redirect a staged pair. Each upload and the final send has its own deadline and outcome, so an earlier receipt can exist when a later call fails. There is no automatic send, retry, renegotiation or raw-route fallback.

## Input and destination capture

The only new root runtime export is `uploadSignedSavedVideoThumbnail`; its new input type is `UploadSignedSavedVideoThumbnailInput`, which omits `threadId` and `threadType` from `UploadSignedChatVideoThumbnailInput`. The result remains `SignedUploadedChatVideoThumbnail`, and owned operation failures use the existing `SignedVideoThumbnailUploadError` and code union. No new receipt kind, error class or Saved video-send wrapper is introduced.

Required own data fields are `bytes`, `fileName`, a positive safe-integer numeric `clientId`, and `feed`. Optional fields are `signal` (a genuine native `AbortSignal`), `chunkSize` and `timeoutMs`. Caller `threadId` or `threadType` fields produce `TypeError` even when they match the advertisement. Unknown/symbol/accessor fields, proxy/array inputs, inherited-only required fields and shared-backed bytes are rejected. Class and null-prototype inputs with the required own data fields are supported.

The helper accepts a safe 1–255-character basename ending in `.jpg`/`.jpeg` with an `FF D8 FF` prefix, or `.png` with the eight-byte `89 50 4E 47 0D 0A 1A 0A` signature. Input must contain 1 byte through **5 MiB**. It copies the intrinsic nonshared `Uint8Array`/Buffer range and validates the input before any API callback or asynchronous work. It accepts no dimensions, rotation or duration fields and does not consult raw-upload chunk configuration.

The total cancellation/deadline budget begins after that pure input snapshot and before account/feed capture. A valid input with an already-aborted signal returns `aborted` without account lookup, negotiation or HTTP. Otherwise, invalid initial account/feed state produces a sanitized `TypeError`; a genuine abort or deadline expiry triggered by that capture keeps its own outcome when it wins the operation check. Post-capture account/context loss produces `feed-unavailable`.

Destination resolution uses `getSavedMessagesThread`'s advertised tuple, with no own-UID fallback. A bare decimal advertisement denotes a user; safe numeric user advertisements are normalized by that existing owner. `g` followed by decimal digits denotes a group, whose receipt uses the normalized decimal ID and `threadType:'group'`. A same-ID/different-kind advertisement is a different destination. Missing, malformed, unreadable, changed or unavailable destination metadata produces `destination-unavailable`.

The captured account and tuple are rechecked at queued command-800 egress, before each actual HTTP POST and before receipt issuance. The final check reads own primitive account/advertisement data after all API callbacks; getter- or proxy-backed critical metadata cannot grant binding. No API callback runs between that final data fence and handoff/issuance. Cancellation, deadline expiry or feed termination during queued admission prevents a later request from escaping the removed pending entry. A changed advertisement is refused; the operation never silently retargets.

The ordinary [`uploadSignedChatVideoThumbnail`](signed-video-thumbnail-upload.md) remains feature 0 for a user and 5 for a group and rejects the exact advertised My Documents kind/ID with `unsupported-destination`. This Saved operation deliberately selects that tuple with feature 9. Raw thumbnail, signed-photo and signed-video destination policies remain unchanged.

## Negotiation, HTTP and result

The fixed negotiation uses version 1, command 800, subcommand 0, numeric `uploadFeature:9` and destination type 1/2 derived from the captured user/group kind. Its file entry contains `fileSize`, `cliFileId` and `fileName`, without dimensions. Correlation uses the original owned sender/ingress and the current sent request/client file IDs. `negotiationSubmitted` records handoff to that sender, not proven external wire emission or provider receipt.

Signed photos, videos and both thumbnail operations share one request namespace and a maximum of **32 pending URL negotiations per feed**. A completed negotiation releases its slot before HTTP continues. The helper adds no listener and consumes the first matched HTTPS endpoint, requiring no credentials, query or fragment. It refuses redirects and alternate-URL fallback.

Chunks default to **3 MiB**; explicit `chunkSize` accepts integers from 1 through **16 MiB**, separately from the 5 MiB total input bound. Sequential multipart field `file` carries copied bytes. The current endpoint query carries full lowercase `filesize` and the global byte `offset`. Cookie lookup/storage uses the full current URL; the ordinary Origin, Referer, User-Agent and agent transport are retained. HTTP responses require 200, no redirect, the expected response URL when supplied, and at most **64 KiB of actual byte data**.

Qualified numeric -600 acknowledges the current chunk and requests continuation; -600 on the final local chunk is `incomplete`. Codes 0 and -4 are terminal even before all copied bytes are sent, and no later chunk follows. Code -5 is `stale-upload`; other integer provider refusals are `rejected`. Transport, redirect, non-200 or unqualified/malformed-body failure after handoff is `submission-unknown`.

Terminal data selects `org`, falling back to `hd` when `org` is absent/null/empty; a thumb-only result is insufficient. All present nonempty `org`, `hd` and optional `thumb` renditions must be ordinary HTTPS locators. Credentials, fragments, whitespace/control/backslash, case-insensitive `e2esession`/`pcloudsession` query-key/value markers, malformed alternates, nonempty `secureKey` and explicit case-insensitive `convertible:'jxl'` are refused with `invalid-response`. A truthy qualified provider `photoId` gives `photoIdSource:'provider'`; the native falsey fallback uses the shared local uploader-session ID and gives `'local'`. A malformed truthy ID is refused. `fileSize` remains the full copied input size; `thumbnailUrl` is the selected org/HD URL.

The frozen receipt is privately bound to the issuing API, account, captured destination kind/ID and existing video-thumbnail media kind. A copied, constructed, serialized/reloaded, wrong-kind or foreign receipt cannot substitute. The existing video upload must use that exact destination and a distinct action ID. The existing final send enforces matched ready receipts and its current ready/sending/used lifecycle: successful or uncertain submission consumes the pair, explicit provider refusal restores it for another explicit attempt, and cancellation before submission leaves it ready. Advertisement stability is enforced through thumbnail issuance. Later advertisement changes do not redirect the issued receipt or final send. [Receipt and explicit-send contract](chat-media-upload.md#completion-and-explicit-final-send)

## Deadline and truthful failures

`timeoutMs` is one total deadline: **120,000 ms** by default, configurable from 1 through **600,000 ms**. It covers account/feed capture, readiness, negotiation, multipart/cookie work, every chunk/body and receipt issuance. After an upload URL is admitted, feed closure alone does not cancel the independent HTTP phase; account/context and destination checks still apply. Native cancellation and timeout return even if an asynchronous adapter ignores abort. That adapter remains responsible for its underlying resources; late completion cannot issue a receipt, upload another chunk or send chat.

`SignedVideoThumbnailUploadError` exposes the same fixed codes and `stage:'negotiate'|'upload'` as the ordinary thumbnail operation. Its readonly progress records `negotiationSubmitted`, HTTP `submitted`, `acceptedChunks`, `acceptedBytes`, and qualified current-phase `providerCode`/`status`. Actual ACK counts/bytes survive later destination, result or cookie failure. A new phase clears prior response metadata rather than implying an unobserved response. Cookie lookup/persistence failure is `session-update-failed`; native abort/timeout retain their codes and known facts. The public `(code,stage)` constructor creates a frozen neutral false/zero/undefined snapshot. Public, subclassed, copied or stale errors cannot donate provider authority. Messages omit URLs, cookies, filenames, bytes and key material. [Full error codes and progress fields](signed-video-thumbnail-upload.md#deadline-progress-and-failures)

The shared raw/signed photo/media guard prevents simultaneous use of an action ID. First actual HTTP-adapter handoff retires it, including refusal or uncertainty. A failure before HTTP releases the active guard and permits an explicit same-ID attempt. `negotiationSubmitted:true` alone does not mean HTTP submission. Inspect progress and reconcile uncertain work before another explicit call; the SDK never retries automatically.

## Static basis and remaining evidence

The installed Desktop 26.11.10/build 26.11.10.3400 SHARED source recorded in [Desktop evidence](desktop-evidence.md) has SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Zero-based UTF-8 byte anchors connect the Video/VideoThumb caller at 3,145,070/3,145,273, ordinary options at 9,956,261/9,956,536 and 9,121,148, My Documents classification at 9,129,894/3,494,439, feature 9 mapping at 3,480,617, negotiation builder at 3,475,243, result projection at 3,489,907/3,488,313/3,488,767, and ordinary video-forward fields at 12,089,483 and 12,458,543/12,459,850/12,460,076.

This ordinary, unencrypted branch has no required My Documents-only key/header carrier. It adds no cloud viewer credential, `x-zl-*`/PCloud headers, encryption/key acquisition, source download or thumbnail generation. It leaves eligibility settings unchanged. Native MultiSite and `enable_my_cloud` gates default off; connected source paths do not establish current account eligibility.

Provider fields/IDs, native cache/control correlation, asset lifetime, native completion parity, recipient rendering and delivery remain unverified. This operation can consume its qualified terminal org/HD result directly without claiming native cache timing parity. The earlier 0.46 319 focused checks, 73 installed public groups and 38 strict fixtures are historical scopes and provide no new SDK 0.47 proof. The SDK 0.47 source lane passed 319 inherited affected-owner checks and 22 new source-blind public groups, with no failures, skips or cancellations. The exact 35-line example passed strict TypeScript compilation. Installed-package checks and independent whole-change review have separate records. These scopes do not establish a full-suite, hosted, native or provider result. This guide was initially authored from static evidence; local verification uses synthetic data and loopback connections.
