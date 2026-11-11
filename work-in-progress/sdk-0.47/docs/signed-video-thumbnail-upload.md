# Signed ordinary video-thumbnail uploads

SDK 0.46 contract. Local checks and independent source review have separate evidence; native/provider acceptance, recipient rendering and delivery remain unverified.

`uploadSignedChatVideoThumbnail` stages caller-prepared JPEG or PNG bytes through signed upload and returns a genuine `SignedUploadedChatVideoThumbnail` for the existing `sendUploadedChatVideo`. It uses the caller's same-API realtime feed and starts or stops no listener. Thumbnail generation, MP4 preparation and the later video send remain explicit application work.

SDK 0.47 provides the separate [`uploadSignedSavedVideoThumbnail`](saved-video-thumbnail-upload.md) for the advertised Saved Messages/My Documents destination using fixed feature 9. This ordinary uploader retains its feature 0/5 selection and exact My Documents rejection. The 0.46 example and evidence below remain historical; local SDK 0.47 checks and independent source review have separate evidence.

## Complete signed upload and send example

Prepare an actual MP4 and JPEG/PNG preview first. This example assumes `clip.mp4` is 1920×1080 with a duration of 5500 milliseconds, and `preview.png` is its prepared PNG preview. Replace the paths and video metadata with the actual values. The video must fit the existing 256 MiB video limit; the preview must fit the 5 MiB thumbnail limit. The SDK checks signatures and bounds, without probing codecs or dimensions. The example stages the preview first, then the MP4, then explicitly sends both receipts.

```ts
import { readFile } from 'node:fs/promises';
import {
  uploadSignedChatVideo, uploadSignedChatVideoThumbnail, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendSignedClip(
  api: API,
  feed: RealtimeFrameFeed,
  recipientId: string,
  videoActionId: number,
  thumbnailActionId: number,
) {
  if (!Number.isSafeInteger(videoActionId) || videoActionId < 1
    || !Number.isSafeInteger(thumbnailActionId) || thumbnailActionId < 1
    || videoActionId === thumbnailActionId) {
    throw new TypeError('Supply two distinct positive safe-integer action IDs.');
  }
  const destination = { threadType: 'user' as const, threadId: recipientId };
  const thumbnail = await uploadSignedChatVideoThumbnail(api, {
    ...destination, feed, clientId: thumbnailActionId,
    fileName: 'preview.png', bytes: await readFile('preview.png'),
  });
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: 'clip.mp4', bytes: await readFile('clip.mp4'),
    width: 1920, height: 1080, durationMs: 5500,
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
```

Choose action IDs unused in this API instance. For a group, use `threadType:'group'` with its decimal ID; a supplied `g` prefix is normalized. Each upload and the final send has a separate deadline and outcome. One resource can finish staging before a later call fails. The SDK performs no automatic send, retry, renegotiation or raw-route fallback.

## Prepared input and ordinary-destination admission

The input accepts a safe basename of 1–255 characters, `.jpg`/`.jpeg` with the `FF D8 FF` JPEG prefix or `.png` with the eight-byte `89 50 4E 47 0D 0A 1A 0A` PNG signature, and positive bytes up to 5 MiB. The thumbnail input has no width, height or duration fields and performs no metadata probe. Bytes and own data fields are captured before API callbacks or asynchronous work. Proxies, arrays, accessors, unknown/symbol keys, inherited-only required fields and shared-backed bytes are rejected. Class and null-prototype inputs with the required own data fields are supported. Supply a genuine `AbortSignal` when using `signal`.

This operation supports ordinary direct/group destinations, with a distinct private-destination admission rule:

- The SDK resolves the account's advertised My Documents destination through the existing `getSavedMessagesThread` owner. It compares both normalized thread kind and ID, including a group-form advertisement. The account's own UID is not a substitute for that advertisement.
- A missing, malformed or unreadable advertisement produces `destination-unavailable`. Selecting its exact kind and ID produces `unsupported-destination`. Initial admission failure makes no URL request or HTTP submission and does not retire the action ID.
- The captured advertisement must remain unchanged before each actual POST and receipt issuance. A changed or unreadable advertisement produces `destination-unavailable`, retaining any earlier submission/acknowledgment facts. Account/context replacement uses `feed-unavailable`. Genuine cancellation or deadline expiry retains its own outcome when it wins the operation check.

The final account/destination binding uses own data fields from the captured API context after all API callbacks. Accessor- or proxy-backed account/advertisement fields cannot grant that binding; they are treated as unavailable. An earlier getter-triggered genuine abort keeps its cancellation outcome. No later API callback occurs between that final data check and the POST or receipt issuer.

The function never guesses My Cloud feature 9 or adds cloud/key headers. This new admission rule applies to signed thumbnails; existing raw thumbnail, signed-photo and signed-video policies are unchanged.

## Negotiation, chunks and result

The fixed request uses version 1, command 800, subcommand 0 on the original owned feed. An ordinary direct thumbnail uses **numeric feature 0** and destination type 1; a group uses **feature 5** and destination type 2. Feature 0 is a real value and is retained in the request. The one file entry supplies the copied size, caller action ID as `cliFileId` and basename, without invented dimensions. The request and client file IDs must match the current privately sent request before an upload URL is admitted.

Signed photo, signed video and signed video-thumbnail calls share one request namespace and at most **32 pending URL negotiations per feed**. Negotiation completion releases its slot before HTTP continues. The function uses the first matched HTTPS upload URL, without credentials, any query or fragment. It refuses redirects and alternate-URL fallback.

Chunks default to **3 MiB**; `chunkSize` accepts integers from 1 through **16 MiB**, independently of the 5 MiB total thumbnail-input limit. Multipart field `file` carries sequential bytes, with full `filesize` and global byte `offset`. Cookie lookup and response-cookie storage use the exact full current endpoint URL. Responses require HTTP 200, no redirect, the expected URL when supplied, and at most **64 KiB of actual byte data**.

Numeric code -600 acknowledges the current chunk and requests continuation. A final local chunk receiving only -600 produces `incomplete`. Codes 0 and -4 are terminal, including before every local chunk has been sent; no subsequent chunk follows. Code -5 produces `stale-upload`; other integer provider refusals produce `rejected`. A transport, redirect, non-200 or unqualified/malformed body after handoff produces `submission-unknown`.

Terminal ordinary data chooses `org`, otherwise `hd` only when `org` is absent/null/empty. A thumb-only reply is insufficient. Every present nonempty `org`, `hd` and optional `thumb` must be a valid ordinary HTTPS locator, without credentials, fragments, whitespace/control/backslash or case-insensitive `e2esession`/`pcloudsession` query key/value markers. A malformed alternate is rejected. A nonempty `secureKey` or explicit case-insensitive `convertible:'jxl'` is unsupported. These result refusals produce `invalid-response`; no converter or capsule decoder is added.

The receipt's `thumbnailUrl` is the selected org/HD URL and `fileSize` is the copied full input size. A valid truthy provider `photoId` gives `photoIdSource:'provider'`. The native falsey fallback uses the shared local uploader-session ID and gives `'local'`; it does not prove provider-issued identity. A malformed truthy ID rejects instead of silently falling back.

The frozen receipt belongs privately to the existing video-thumbnail registry for its exact API, account, destination and kind. A copied, constructed, foreign-session or photo-kind receipt cannot replace it. The existing final send requires distinct video/thumbnail action IDs, matching destinations and ready receipts, and retains its current refusal/uncertain-send lifecycle. [Existing media receipt and send contract](chat-media-upload.md#completion-and-explicit-final-send)

## Deadline, progress and failures

`timeoutMs` is one total deadline: default **120,000 ms**, configurable from 1 through **600,000 ms**. It covers feed readiness, negotiation, multipart encoding, cookie work, every chunk/body and receipt issuance. Signed photos retain their separate 60-second per-request policy. After a valid upload URL is admitted, feed closure alone does not cancel the independent HTTP phase; the operation still checks its captured account/context and advertised destination.

Native cancellation and deadline expiry return even when an asynchronous cookie, HTTP or body adapter ignores abort. An underlying custom adapter remains responsible for its resources. Late work cannot create a receipt, send another chunk or launch chat. An interruption does not roll back a request already handed to transport.

`SignedVideoThumbnailUploadError` has its own class identity and fixed thumbnail-specific messages; the existing `SignedVideoUploadError` remains unchanged. It exposes `code`, `stage:'negotiate'|'upload'` and readonly progress getters:

| Field | Meaning |
| --- | --- |
| `negotiationSubmitted` | The exact URL request was handed to the original sender; this does not prove server receipt. |
| `submitted` | At least one HTTP POST was handed to the configured adapter, including one that then threw. |
| `acceptedChunks`, `acceptedBytes` | Actual chunk counts/lengths acknowledged by qualified current -600/0/-4 replies. |
| `providerCode`, `status` | Qualified numeric code/current HTTP status for the failing phase, when observed. Prior chunk metadata does not fill a later unobserved response. |

Library errors retain a frozen private snapshot taken at failure. The public constructor accepts only `(code,stage)` and creates neutral false/zero/undefined progress. Public, subclassed, copied or stale errors cannot establish a provider acknowledgment or receipt. Messages contain no URL, cookie, filename, bytes or key material.

The codes are `aborted`, `timeout`, `busy`, `action-reused`, `feed-unavailable`, `rejected`, `invalid-response`, `stale-upload`, `incomplete`, `submission-unknown`, `session-update-failed`, `destination-unavailable` and `unsupported-destination`.

Known acknowledgments survive later rendition validation, destination checks or cookie persistence failure. `acceptedBytes` counts only the actual acknowledged chunk lengths, which can be smaller than the receipt's full `fileSize` after an early terminal reply. Cookie lookup/persistence exceptions produce `session-update-failed`; lookup before the first POST leaves `submitted:false`, while failure after a known ACK retains its code/status and counts. Abort or timeout during that wait keeps `aborted`/`timeout` with those known facts. Inspect submitted/ACK progress and reconcile uncertain work before another explicit attempt; no automatic replay follows any code.

The existing photo/media active-action guard prevents concurrent use of the ID. A raw or signed media action is retired at its first HTTP handoff, including refused or uncertain handoff. Pre-HTTP admission/cancellation does not permanently retire it. Existing completed-photo reuse rules remain unchanged.

## Static evidence and validation boundary

The installed Desktop 26.11.10/build 26.11.10.3400 SHARED member recorded in [Desktop evidence](desktop-evidence.md) has SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Zero-based UTF-8 anchors are the concrete VideoThumb caller/consumer at 3,145,273/3,145,581; conditional signed selection at 3,504,595 and 15,864,544; defaults at 3,712,561; feature mapping at 3,480,617 and enum values at 3,477,765/3,477,926/3,478,084; common builder at 3,475,243; result mapper at 3,489,907 with URL/photo projection at 3,488,313/3,488,767; and image cache/consumer at 3,496,730/7,413,762.

These anchors establish a static route and schema, with conditional account eligibility. The corrected source lane passed 319 focused checks: 283 inherited shared-owner/media checks and 36 thumbnail groups, including seven final-callback binding regressions. The exact 30-line example and the public input/receipt/error/exclusion fixtures have separate strict compilation evidence. Package installation and independent source review are separate scopes. Local fixtures do not establish a successful provider upload, asset lifetime, native interoperability, recipient rendering or delivery. The example's file reads and account calls were not executed to produce this guide.
