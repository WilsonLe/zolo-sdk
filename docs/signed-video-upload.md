# Signed ordinary video uploads

SDK 0.45. Local verification and review have separate evidence; live provider acceptance remains unverified.

`uploadSignedChatVideo` negotiates an ordinary video upload on the caller's authenticated realtime feed, uploads caller-prepared MP4 bytes and returns a staged video receipt. Uploading does not post a message. Upload a separate thumbnail and call `sendUploadedChatVideo` explicitly when ready.

The separate [`uploadSignedChatVideoThumbnail`](signed-video-thumbnail-upload.md) operation can stage the preview through signed upload as well. The example below retains the raw thumbnail alternative; the new guide includes a complete signed-thumbnail example.

```ts
import { readFile } from 'node:fs/promises';
import {
  uploadSignedChatVideo, uploadChatVideoThumbnail, sendUploadedChatVideo,
} from 'zalo-personal-sdk';
import type { API, RealtimeFrameFeed } from 'zalo-personal-sdk';

export async function sendClip(
  api: API,
  feed: RealtimeFrameFeed,
  recipientId: string,
  videoActionId: number,
  thumbnailActionId: number,
) {
  const destination = { threadType: 'user' as const, threadId: recipientId };
  const video = await uploadSignedChatVideo(api, {
    ...destination, feed, clientId: videoActionId,
    fileName: 'clip.mp4', bytes: await readFile('clip.mp4'),
    width: 1920, height: 1080, durationMs: 5500,
  });
  const thumbnail = await uploadChatVideoThumbnail(api, {
    ...destination, feed, clientId: thumbnailActionId,
    fileName: 'preview.jpg', bytes: await readFile('preview.jpg'),
  });
  return sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
}
```

Supply two distinct positive safe-integer action IDs that are unused in this API instance. Reuse the application's existing feed; it must belong to the same API session. This function starts and stops no listener. For a group, use `threadType:'group'` and its decimal group ID; an input `g` prefix is normalized. The final send uses the original destination.

## Prepared media and receipt

The caller encodes the MP4, generates its thumbnail and supplies the video's actual width, height and duration in milliseconds. The SDK checks `.mp4`/`ftyp`, copies the bytes and metadata before asynchronous work, and accepts at most 256 MiB. Width and height are integers from 1 through 32,768, duration is 1 through 86,400,000 ms, and optional `rotation` is an integer from -360 through 360. These are SDK bounds, not provider account limits. There is no transcoding, dimension probe or URL download.

The frozen `SignedUploadedChatVideo` works with the existing [video send helper](chat-media-upload.md#completion-and-explicit-final-send). `fileIdSource:'provider'` means the response supplied a valid file ID. `'local'` means the installed mapper's falsey-ID fallback used a local uploader-session ID; it is not evidence of provider-issued identity. A copied, constructed, serialized/reloaded or foreign-session receipt cannot be sent. The thumbnail must be a genuine receipt from the same API, account and destination with a different action ID.

## Negotiation and chunks

The source-backed route uses version 1, command 800, subcommand 0 with video feature 2 for both direct and group chats. It matches the request ID and client file ID, selects the first supplied upload URL, and performs sequential multipart POSTs with field `file`, full `filesize` and global byte `offset`. Signed photo, video and video-thumbnail uploads share a maximum of 32 pending URL negotiations per feed. A completed negotiation releases its slot before HTTP uploading continues.

Chunks default to 3 MiB. `chunkSize` accepts an integer from 1 through 16 MiB. The upload endpoint must be HTTPS without credentials, a fragment or existing query parameters. Redirects and alternate-URL fallback are refused. Cookies use the full current chunk URL and response bodies are bounded to 64 KiB.

Code -600 acknowledges a chunk and requests continuation. A final local chunk receiving only -600 produces `incomplete`. Codes 0 and -4 are terminal, including before all local bytes were sent; no further chunk follows. The receipt's `fileSize` remains the full copied input size. If later result validation or cookie persistence fails, the error's `acceptedBytes` counts only actual acknowledged chunk lengths, which can be smaller than that file size. Code -5 is `stale-upload`; other integer provider refusals are `rejected`. There is no automatic renegotiation, reupload, raw-route fallback or message send.

Terminal replies select `org`, falling back to `hd` only when `org` is absent. Both present renditions must be ordinary HTTPS locators. A malformed alternate, nonempty `secureKey`, or case-insensitive `e2esession`/`pcloudsession` query key or value rejects the result. This helper does not decrypt protected resource URLs. Once a valid upload URL has been admitted, feed closure alone does not cancel the independent HTTP phase.

## Deadline, cancellation and failures

`timeoutMs` is one total deadline: default 120,000 ms, configurable from 1 through 600,000 ms. It covers readiness, URL negotiation, multipart encoding, cookie access, all chunks and bodies, and receipt creation. In comparison, [signed photos](signed-photo-upload.md) retain their 60-second default per-request deadline. Each separately invoked thumbnail upload and final send has its own operation deadline.

Pass a genuine `AbortSignal` in `signal` for caller cancellation. Cancellation or timeout returns even when a custom asynchronous adapter ignores abort; that adapter remains responsible for its underlying resources. Neither interruption rolls back a handed-off request or proves the provider discarded it. No later completion automatically retries, creates another receipt or sends chat.

`SignedVideoUploadError` exposes fixed messages and a frozen snapshot of the operation's known progress:

| Field | Meaning |
| --- | --- |
| `code`, `stage` | Failure classification and `negotiate` or `upload` phase. |
| `negotiationSubmitted` | The exact URL request was handed to the feed's original sender; this does not prove server receipt. |
| `submitted` | At least one chunk POST was handed to the configured HTTP adapter, including an adapter that then threw. |
| `acceptedChunks`, `acceptedBytes` | Chunks and actual byte lengths acknowledged by qualified current replies; earlier acknowledgments survive later failures. |
| `providerCode`, `status` | Qualified code/current HTTP status when observed for the failing phase. Earlier chunk statuses do not fill an unobserved later response. |

`aborted` and `timeout` retain their codes even after HTTP handoff, so inspect `submitted` and reconcile an outstanding request before another explicit attempt. A transport/body failure without a qualified response is `submission-unknown`. Cookie lookup or persistence failure is `session-update-failed`; lookup before the first POST leaves `submitted:false`, while failure after an acknowledgment preserves its counts. `invalid-response` can also retain a known terminal acknowledgment. `busy`, `action-reused` and `feed-unavailable` describe local admission/lifecycle failures.

The public constructor accepts only `(code, stage)`. Manually constructed errors have false/zero/undefined progress and cannot supply an upload receipt or provider acknowledgment. Error messages and fields contain no upload URL, cookie, bytes, filename or key material.

An action ID is retired for raw and signed media as soon as its first HTTP POST is handed off, including refusal or uncertain completion. A negotiation-only or other pre-HTTP failure does not retire it. The shared active-upload guard prevents concurrent photo/media use of that ID. This does not change historical completed-photo action reuse rules.

## Evidence boundary

The installed Desktop 26.11.10/build 26.11.10.3400 [SHARED member](desktop-evidence.md) has SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. Zero-based UTF-8 anchors are the shared negotiation builder at 3,475,243, video feature mapping at 3,480,446, video result mapper at 3,489,515, signed multipart/query construction at 3,493,577–3,496,373, terminal cache handling at 3,496,645–3,496,922 and actual Video result consumer at 7,413,041.

These are static shipped-source observations. Account eligibility depends on Zalo's multi-site configuration and active socket, and live signed-video upload, recipient rendering and delivery remain unverified. Signed voice and encrypted initial voice/video uploads retain separate gaps.
