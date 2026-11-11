# Ordinary voice and video byte uploads

`uploadChatVoice`, `uploadChatVideo`, and `uploadChatVideoThumbnail` upload caller-prepared bytes without posting a message. `sendUploadedChatVoice` and `sendUploadedChatVideo` explicitly submit the resulting ordinary chat message. The SDK does no recording, transcoding, thumbnail generation, URL download, or HEAD request. SDK 0.45 also adds a separate [signed ordinary video uploader](signed-video-upload.md) compatible with the same explicit video send and thumbnail receipts.

SDK 0.46 adds the separate [signed video-thumbnail uploader](signed-video-thumbnail-upload.md), `uploadSignedChatVideoThumbnail`. It requires a same-session feed and a stable advertised My Documents destination for ordinary-thread admission, then issues the existing video-thumbnail receipt. The raw thumbnail operation and its optional-feed behavior remain unchanged. Local checks and independent source review have separate evidence; live provider acceptance remains unverified.

SDK 0.47 adds the separate [Saved Messages signed-thumbnail uploader](saved-video-thumbnail-upload.md), `uploadSignedSavedVideoThumbnail`, with fixed feature 9 and no caller destination fields. It returns the same thumbnail receipt. Stage the MP4 using that receipt's `threadType` and `threadId`, then explicitly call `sendUploadedChatVideo`; a fresh destination lookup could select a different target. Local SDK 0.47 checks and independent source review have separate evidence.

```ts
import { readFile } from 'node:fs/promises';
import {
  startRealtimeFrameFeed, uploadChatVoice, sendUploadedChatVoice,
  uploadChatVideo, uploadChatVideoThumbnail, sendUploadedChatVideo,
} from 'zalo-personal-sdk';

const feed = startRealtimeFrameFeed(api);
let nextActionId = Date.now();
const destination = { threadType: 'user' as const, threadId: recipientId };
try {
  if (!(await feed.ready)) throw new Error('Zalo disconnected.');
  const voice = await uploadChatVoice(api, {
    ...destination, clientId: nextActionId++, feed,
    fileName: 'recording.aac', bytes: await readFile('recording.aac'),
  });
  const voiceMessage = await sendUploadedChatVoice(api, voice);

  const video = await uploadChatVideo(api, {
    ...destination, clientId: nextActionId++, feed,
    fileName: 'clip.mp4', bytes: await readFile('clip.mp4'),
    width: 1920, height: 1080, durationMs: 5500,
  });
  const thumbnail = await uploadChatVideoThumbnail(api, {
    ...destination, clientId: nextActionId++, feed,
    fileName: 'preview.jpg', bytes: await readFile('preview.jpg'),
  });
  const videoMessage = await sendUploadedChatVideo(api, video, { thumbnail, title: 'Clip' });
} finally {
  feed.stop();
  await feed.closed;
}
```

Reuse an existing same-session feed when the application already has one. None of these helpers starts or stops a listener. Voice requires a feed because the ordinary raw response does not establish a usable inline AMR/AAC result. Video and thumbnail uploads accept an optional feed: omitting it works only when the finished response contains the established inline URL fields. A supplied foreign or already-closed feed is rejected before HTTP submission.

## Encodings, destinations, and receipts

Voice accepts ADTS AAC `.aac`, an M4A `.m4a` container, or AMR `.amr`. Video accepts an MP4 `.mp4` container. Thumbnails accept JPEG or PNG. The SDK checks the format signature and copies the input bytes before the first wait; actual codec validity, duration, image generation, and video dimensions belong to the caller. Voice is bounded to 64 MiB, video to 256 MiB, and thumbnails to 5 MiB. Video dimensions are positive integers through 32,768 pixels, and duration is a positive integer through 86,400,000 milliseconds. These are explicit SDK resource bounds, not claims about provider account limits. A provider may refuse a smaller upload.

Use a distinct positive safe-integer `clientId` per uploaded resource. The video and its separately uploaded thumbnail require different action IDs. The same ID appears in every chunk of that resource and the corresponding voice/video final send. An action that has started submission cannot be uploaded again through this module in the same API instance. The active action guard is also shared with the raw/signed photo and signed-video uploaders. Submitted raw and signed media share action retirement until the API instance is released.

Provider file/photo/message IDs and account/destination IDs are decimal strings, preserving integers larger than JavaScript's safe range. An optional `g` prefix on an input group destination is removed. A receipt is frozen and bound privately to its issuing API instance, account, media kind, and destination. A copied, serialized/reloaded, or manually constructed receipt is not sendable. A video can use only a real thumbnail receipt from the same account, API, destination, and thread type. No final-send option redirects either receipt to another chat.

## Exact raw upload contract

| Resource | Service | Direct path / command | Group path / command |
| --- | --- | --- | --- |
| Voice | `file` | `/api/message/voice/upload` / 12060 | `/api/group/voice/upload` / 12063 |
| Video | `file` | `/api/message/video/file/upload` / 12058 | `/api/group/video/file/upload` / 12061 |
| Video thumbnail | `file` | `/api/message/video/thumb/upload` / 12059 | `/api/group/video/thumb/upload` / 12062 |

Each POST carries one multipart `chunkContent` file. Account-encrypted query parameters are `totalChunk`, `fileName`, numeric `clientId`, `totalSize`, one-based `chunkId`, `imei`, and either direct `toid` or group `grid`. Voice adds `fileType:"amr"` or `fileType:"aac"`; the installed AAC upload branch includes M4A. The query also has `type=2` for a direct chat or `type=11` for a group. The ordinary raw class does not send `isE2EE`, `eeType`, or a checksum. This implementation also omits photo-specific `jxl` and cloud-specific authenticated headers.

The chunk size defaults to 256,000 bytes. An advertised integer `sharefile.chunk_size_file` of at least 64,000 overrides it; a value above the common transport's 16 MiB multipart bound is rejected. The installed local planner partitions work into roughly 20 MiB parts but keeps chunk numbers global, and does not put a part number in these raw request parameters. The SDK sequentially sends that same global sequence. The installed configurable small/big-file threshold defaults to 100 MiB; the voice/video/thumbnail route selector above does not branch on that distinction. [Signed ordinary video](signed-video-upload.md) is a separate explicit transport, not an implied fallback.

The response uses the normal account AES envelope with a nested status. Status zero plus `finished` and a `fileId` finishes voice/video; thumbnails use `(finished || isFinish)` and `photoId`. A normal finished reply before the final local chunk is refused. Status one is an installed duplicate/cache path: this SDK reports `duplicate-upload` and does not reconstruct or trust an unrelated original upload cache. No automatic retry, last-chunk replay, or redirect follow occurs.

## Completion and explicit final send

The helper subscribes before submitting the first chunk and matches completion controls by the HTTP response's file/photo ID on commands 601/603. It accepts both a bare successful payload and a decoded successful transport envelope whose inner payload omits a redundant `error_code`; a present nonzero status at either level is rejected. The first valid control wins, including when it arrives before the HTTP reply. Ordinary voice completion is `voice_aac_success`, with URLs in numeric data keys `5` (AMR) and `6` (AAC). An AMR result becomes `voiceUrl` and an available AAC alternate becomes `m4aUrl`. An AAC-only result becomes `voiceUrl` with `m4aUrl` omitted. Video uses `video_done` and `data.url`. A thumbnail uses `photo_success`, `act:"photo"`, and `data.org`/`hd`/`thumb`; the chosen original variant falls back to HD or thumbnail exactly as in the ordinary desktop consumer. Inline video uses `url`; inline thumbnail completion requires both `normalUrl` and `thumbUrl` and selects `normalUrl`.

Only ordinary HTTP/HTTPS locators without credentials, fragments, whitespace/control characters, or an `e2esession` key/value are accepted. A nonempty `secureKey` or a capsule-bearing rendition is refused instead of substituting a plaintext preview. Encrypted initial uploads use the separate prepared E2EE media workflow.

The final request is an account-encrypted form POST on the `file` service, using `/api/message/forward` (command 11199) or `/api/group/forward` (11818). This is the installed upload/reupload-to-forward flow, rather than the URL-only upstream shortcut. Common parameters are numeric `clientId`, `ttl` (default zero), `zsource:-1`, `msgType`, and JSON-string `msgInfo`. Direct sends use `toId` and `imei`; groups use `grid` and explicit `visibility` (default zero) with no group IMEI field. Voice has `msgType:3` and content `{voiceUrl,m4aUrl?,fileSize}`. Video has `msgType:5` and `{title,videoUrl,thumbUrl,duration,fileSize,width,height}`; `duration` is the caller's milliseconds. Optional `properties` must be JSON object/null text and stays a string-valued field. Optional numeric `rotation` becomes `videoRotation` only when explicitly supplied; the desktop's rotation feature defaults off. The send response retains raw extra fields and requires a valid `msgId`.

Each operation defaults to a 120-second deadline, configurable from 1 through 600,000 ms. The deadline covers feed readiness, every HTTP response body, and final completion. Cancellation and deadline expiry abort the submitted transport and return even if a custom transport ignores abort. Such a custom transport remains responsible for its own underlying resources. A completion feed closing mid-operation also interrupts the wait. Before acknowledgement, at most 256 distinct completion IDs of that media kind are buffered per upload; exceeding the bound fails the operation. Reusing an active same-kind completion ID invalidates both upload waiters, so one upload cannot receive another's URLs. The feed retains the last 1,024 retired same-kind IDs as a further reuse guard; active owners are never evicted.

`ZaloChatMediaError` exposes a fixed message, `code`, `stage`, `submitted`, `acceptedChunks`, optional provider `mediaId`, and safe numeric `providerCode`. It never includes URLs, file bytes, names, or key material. `submitted:true` means cancellation, timeout, or transport failure may leave a server submission to reconcile. A successful final send or an uncertain final send consumes the voice receipt, or both video and thumbnail receipts. An explicit provider refusal restores those receipts for another explicit final-send attempt. Cancellation before submission leaves them ready. There is no automatic resubmission.

## Evidence and remaining paths

The installed Zalo Desktop 26.11.10 build 26.11.10.3400 SHARED member is [recorded here](desktop-evidence.md), SHA-256 `32090ad21922a614ad11a12bff9709d269bff273667faa9314d237712abca38e`. UTF-8 byte anchors:

| Contract | Byte offset |
| --- | ---: |
| Default raw chunk size and local 20 MiB part planner | 3,448,503 |
| Ordinary `RawFile` completion/duplicate handling | 3,461,791 |
| Ordinary raw multipart fields, absent checksum, voice fileType | 3,465,600 |
| Default multi-site small/big threshold | 3,712,943 |
| Upload-main-type route selection and upload header scope | 3,938,560 |
| Separate video/video-thumbnail/voice routes | 3,940,350 |
| Inline response URL decoder | 7,410,742 |
| Voice and photo/video-thumbnail result consumer | 7,413,500 |
| Voice numeric variant constants 5/6 | 1,530,088 |
| Voice/video/photo completion control handlers | 12,023,519–12,025,300 |
| Forward content transform and direct/group request builders | 12,458,500–12,461,100 |
| Separate video/main thumbnail upload orchestration | 3,144,700–3,146,450 |
| Uploaded video metadata and optional rotation | 14,807,030 |
| Uploaded voice AMR/AAC final content | 14,809,000 |
| Millisecond video duration consumer | 11,613,762 |
| Rotation feature defaults off | 11,595,014 |

Pinned `zca-js@2.2.0` `sendVoice`/`sendVideo` accept URLs and infer size using HEAD; `uploadAttachment` sends MP4 through generic `asyncfile/upload`. Those wrappers do not supply this staged dedicated-route byte pipeline. Their declared video duration is also milliseconds. The installed legacy `/api/message/voicemp3` and `/api/group/sendmp3` binary builders are present at byte 12,463,906, but an active caller was not established in the inspected artifacts. Generic `/asyncfile/msg` is the file-message path, not this ordinary voice/video final message. Those legacy binary builders, recording/transcoding, signed multi-site voice uploads, and new encrypted initial voice/video uploads remain separate gaps. Signed ordinary video is available through the separate explicit uploader; local verification does not establish provider acceptance.

The focused tests use synthetic account AES fixtures plus a loopback WebSocket, including exact direct/group payloads, raw chunk bytes across the 20 MiB part boundary, asynchronous controls in both orders, media-ID collisions, rejected capsule fallbacks, refusal/uncertain-send receipt state, and stalled-body cancellation. No authenticated upload or message send was performed, so live provider acceptance remains unverified.
