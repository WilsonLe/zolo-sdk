# Signed photo uploads

`uploadSignedChatPhoto` negotiates one photo upload over an existing authenticated realtime feed, submits the caller's JPEG or PNG bytes, and returns a staged receipt for `sendUploadedChatPhoto`.

```ts
import { readFile } from 'node:fs/promises';
import { sendUploadedChatPhoto, uploadSignedChatPhoto } from 'zalo-personal-sdk';

const photo = await uploadSignedChatPhoto(api, {
  feed,
  threadType: 'group',
  threadId: groupId,
  clientId: nextClientId(),
  quality: 'original',
  fileName: 'photo.jpg',
  bytes: await readFile('photo.jpg'),
  width: 3024,
  height: 4032,
});
const sent = await sendUploadedChatPhoto(api, photo, { text: 'Photo' });
```

The feed must belong to the same API session. The SDK snapshots the bytes before negotiation and shares the action guard with ordinary `uploadChatPhoto`. JPEG and PNG signature checks, dimensions, and size limits follow the existing [photo helpers](photo-media.md). The caller prepares the image and supplies its actual dimensions. Each upload needs a distinct positive numeric client action ID.

The desktop enables this path through its `multi_site_upload` configuration and an active chat socket. This SDK function makes the caller's explicit request. Provider support and account eligibility are determined by Zalo.

Signed photo, [signed ordinary video](signed-video-upload.md) and [signed video-thumbnail](signed-video-thumbnail-upload.md) uploads share a maximum of 32 pending URL negotiations per feed. Photo deadlines remain per request; each signed video or thumbnail invocation uses its own total operation deadline.

## Negotiation and chunks

| Stage | Observed contract |
| --- | --- |
| Request URLs | Version 1, command 800, subcommand 0, on the authenticated chat socket. The payload contains `clientType`, `clientVersion`, `httpVer:1`, `destId`, `destType`, `payload`, and a request ID. |
| Select feature | Direct HD uses 4, group HD uses 6, direct original uses 16, and group original uses 17. Destination types are direct 1 and group 2. The existing quality label `legacy-hd` selects HD for this transport. |
| Describe the file | One entry supplies `fileSize`, numeric `cliFileId`, `uploadFeature`, and `fileName`. The installed builder has optional width and height fields, which this upload path leaves absent. |
| Receive URLs | `{error_code:0,data:{reqId,urls:[{cliFileId,listUrls}]}}`. The SDK matches both the request ID and client file ID, then uses the first URL. |
| Upload chunks | Multipart POST with field `file`, plus `filesize` and byte `offset` query parameters. This request uses the provider-issued URL and a plain JSON response. |
| Complete | Code 0 or -4 confirms completion. The response can supply `org`, `thumb`, `hd`, `photoId`, and variant sizes. The resulting receipt can be explicitly sent through the ordinary photo send helper. |

The installed chunk default is 3 MiB. Pass `chunkSize` for a different explicit boundary within the SDK's 16 MiB per-chunk bound. Chunks are submitted sequentially with byte offsets starting at zero. The SDK requires an HTTPS upload URL without credentials, query parameters, or a fragment, matching the installed URL builder that appends its own query. Upload authorization URLs remain inside the operation.

Code -600 accepts a chunk and requests continuation. Code -5 reports stale authorization. Other provider errors retain their numeric code. Codes 0 and -4 are terminal even if some local chunks remain. The shipped mapper marks either response as finished, so the SDK accepts that provider confirmation and stops sending bytes. The fixtures cover this behavior without assuming a particular server deduplication mechanism.

## Receipt identifiers and image variants

`photoIdSource` identifies whether the receipt uses a provider photo ID or a local upload session ID. The installed desktop allocates local session IDs as a process-local sequence starting at 1. Its signed-upload mapper uses that session ID as the photo identifier when the response omits `photoId`. The SDK follows this behavior, and its final send uses the staged URLs and that same identifier.

The installed signed mapper sets both the normal and HD fields from `org`, falling back to `hd` when `org` is absent. Its thumbnail is `thumb` or `org`. The SDK follows this mapping for HD and requires an explicit `org` URL for original quality. JPEG XL and encrypted upload replies are outside this helper's supported inputs.

## Failure behavior

The SDK makes one URL negotiation request and submits each chunk once. It uses the supplied session transport, preserves destination cookies for the selected upload host, and refuses HTTP redirects. The default SDK deadline is 60 seconds per request, configurable from 1 to 120,000 ms with `timeoutMs`. Upload JSON bodies are bounded to 64 KiB. These are SDK limits.

Cookies are selected and response cookies are stored against the full chunk URL, including its path. Path-absent responses use the cookie jar's default upload directory. Existing jar entries are not migrated. [Cookie URL scope and remaining dependency-backed branches](cookie-scope.md).

A transport error, malformed reply, or cancellation while a chunk is in flight produces `submission-unknown`. `acceptedBytes` records the bytes acknowledged before that request. Cancellation before submission is `aborted`. Expired authorization is `stale-upload`. If the final chunk receives continuation, the operation returns `incomplete`. The caller retains responsibility for resolving an uncertain upload before attempting it again.

The [installed 26.11.10 desktop SHARED member](desktop-evidence.md) contains the negotiation builder at byte 3,475,243, feature mapping at 3,480,437, URL/variant mapping at 3,488,313, signed chunk construction at 3,493,583, URL query construction at 3,496,373, and terminal response handling at 3,496,922. The local ID allocator is at 11,332,191 and command 800 request construction is at 14,417,364. The source SHA-256 is `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`.

Loopback WebSocket and synthetic HTTP fixtures exercise negotiation, chunk bytes, success, refusal, timeouts, and the existing final send integration. Authenticated provider acceptance remains unmeasured.
