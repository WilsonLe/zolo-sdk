# Original-quality and legacy HD photos

Use `uploadChatPhoto` to stage a prepared JPEG or PNG for one ordinary direct or group chat. Call `sendUploadedChatPhoto` separately to post it. A staged receipt belongs to the authenticated API instance and destination that created it.

```ts
import { readFile } from 'node:fs/promises';
import {
  sendUploadedChatPhoto, startRealtimeFrameFeed, uploadChatPhoto,
} from 'zalo-personal-sdk';

const feed = startRealtimeFrameFeed(api);
try {
  if (!(await feed.ready)) throw new Error('Zalo disconnected.');
  const photo = await uploadChatPhoto(api, {
    threadType: 'user',
    threadId: recipientId,
    clientId: Date.now(),
    quality: 'original',
    fileName: 'photo.jpg',
    bytes: await readFile('photo.jpg'),
    width: 3024,
    height: 4032,
    feed,
  });
  const sent = await sendUploadedChatPhoto(api, photo, { text: 'Photo' });
} finally {
  feed.stop();
  await feed.closed;
}
```

Use a distinct positive numeric `clientId` for each action. A bot posting several items in the same millisecond should use a monotonic allocator. Result fields `photoId`, `threadId`, and `msgId` are decimal strings. `clientId` remains numeric. The optional feed must belong to the same API instance. Reuse it if the app already has one. The SDK sends the caller's bytes unchanged and expects the caller to supply their actual dimensions. The local format check verifies the file signature only.

## Quality modes and wire routes

| Quality | Service | Direct upload | Group upload | Local maximum |
| --- | --- | --- | --- | --- |
| `original` | `zcloud_up_file` | `/api/message/zcloud-upload/photo` | `/api/group/zcloud-upload/photo` | 100 MiB and 30,000 px on each axis |
| `legacy-hd` | `file` | `/api/message/photo_original/upload` | `/api/group/photo_original/upload` | 5 MiB and 2,560 px on each axis |

These limits come from the installed desktop defaults. Zalo can apply stricter service or account limits. The desktop selects original mode only when the feature is enabled and the account qualifies. If the original service is unavailable, the SDK returns an error and leaves the choice of quality to the caller.

Both upload variants use a multipart `chunkContent` field and account-encrypted query parameters. Chunks are numbered from 1. The default chunk size is 256,000 bytes. The SDK uses the advertised integer `sharefile.chunk_size_file` when it is at least 64,000 bytes and rejects values above its 16 MiB multipart bound. The same action ID is used across chunks and the final send.

The raw uploader can complete with inline `normalUrl`, `thumbUrl`, and optional `hdUrl`. The installed inline decoder maps `normalUrl` to the `org` variant for this path, including original mode. Alternatively the HTTP reply can give a `photoId` and a finished flag while the URLs arrive as a separate `photo_success` control. The SDK correlates that event by photo ID on realtime commands 601 and 603. In original mode the control must contain its `org` URL. In legacy HD mode the control can supply one variant that the SDK uses for any missing variants, matching desktop behavior.

The final encrypted form POST uses the `file` service and `/api/message/photo_original/send` or `/api/group/photo_original/send`. The request includes the staged URL fields and original mode sends `jcp={"is_original":1}`.

## Completion and errors

A known photo ID with no usable inline URLs needs the optional feed. The default completion wait is 120 seconds and can be shortened with `completionTimeoutMs`. A missing, closed, or timed-out feed produces an error carrying the photo ID. Pass an `AbortSignal` to stop the upload or the completion wait. If cancellation occurs while HTTP submission is in progress, the request can be reported as uncertain.

The SDK makes no automatic chunk or message retries. A confirmed send or an uncertain send consumes the staged receipt. An explicit provider rejection permits another explicit send using that same receipt. This implementation covers the desktop raw upload path, including its legacy HD endpoint. Signed multi-site uploads, the newer HD endpoint, JPEG XL, multi-photo layout, and encrypted conversations are separate paths.

The installed 26.11.10 [desktop SHARED member](desktop-evidence.md) contains route selection at byte 3,939,238, raw upload handling at 3,461,791, inline URL mapping at 7,410,742, default limits at 11,394,498, photo completion controls at 12,024,652, and final submission at 12,503,077. Encrypted HTTP fixtures and a loopback WebSocket exercise the implementation. Provider acceptance with an authenticated session has yet to be measured.

## Forward existing ordinary photos

`forwardPhoto` and `forwardPhotoSticker` submit existing caller-selected metadata through the singular numeric-type2 forward request. They use a fresh stable client action ID supplied by the application. They do not create or accept an uploaded-photo receipt, discover an original message, fetch or renew resources, rewrite JXL/JPEG locators, process bytes, clone, retry or reconstruct albums.

```ts
import { forwardPhoto, forwardPhotoSticker, PhotoForwardError } from 'zalo-personal-sdk';

const normal = await forwardPhoto(api, {
  threadType: 'user', threadId: selectedUserId, clientId: normalActionId,
  source: { photoId: sourceMessageId, originalUrl: selectedOriginalUrl,
    title: selectedCaption, propertiesJson: selectedPropertiesJson },
  original: true,
  signal,
});

const sticker = await forwardPhotoSticker(api, {
  threadType: 'group', threadId: selectedGroupId, clientId: stickerActionId,
  source: selectedNormalizedNonAiSticker,
  visibility: 0, signal,
});
```

The source kind is explicit. A normal photo uses the original global message ID as `source.photoId`; a non-AI sticker uses its selected final content metadata. Existing [AI forwarding](ai-sticker-forward.md), ordinary GIF/file forwarding, protected E2EE forwarding, and staged photo upload/send keep their own contracts.

### Source projections and meaningful differences

| Field/policy | Normal photo | Current non-AI photo sticker |
| --- | --- | --- |
| Identity | Required positive safe numeric or positive decimal source `photoId`, up to40digits with exact leading-zero text | Required `contentId` as safe numeric or nonempty text up to256UTF-8bytes; `photoId` absent/null defaults1, while explicit zero/empty/negative/other accepted scalar spelling remains |
| Caption | Absent/null title becomes empty text; no NFC | Own description/title omission/null/empty text retained; no forced caption or NFC |
| Locators | Original required; missing/null/empty thumbnail falls back to original; HD omission/null/empty stays distinct | Original/thumbnail/normal/HD preserve omission/null/empty with no fallback; at least original or normal must be nonempty |
| Dimensions | Already selected final width/height | Already selected base and thumbnail width/height; no extra fallback from WebP/base |
| Properties | Optional exact JSON text of any root; source null is text `'null'` | Optional omission/null/empty retained; nonempty complete JSON text preserved, including source extension metadata |
| WebP | No WebP/content-sticker fields added | Required complete JSON-object text; unknown members retained without rebuilding or filling fields |
| Additional metadata | Explicit `original:true` selects `jcp.is_original:1`; `convertible:'jxl'` selects its member | Neither original/JXL option is accepted; no AI constants or ordinary isAISticker/isPhotoSticker flag added |

The input is normalized metadata after native selection/promotion: it does not accept raw `params` or reproduce native malformed-string spreading. Normal properties and both variants' WebP/property texts retain their exact supplied text; validation does not reserialize it. Known URL fields are checked as ordinary locators. Unknown JSON metadata remains caller-owned provider-visible text, without a claim that every nested resource or secret is independently protected.

Non-AI optional `source.pStickerType` means an **own final source message field**, never a params promotion or inferred default0. When own-present it moves into nested JCP. Own undefined therefore selects `jcp:'{}'`; null selects its null member. No own field adds no JCP. Numeric1 is the known AI enum and is rejected by this SDK's declared non-AI-kind policy; that is not a native validation claim. Other accepted nonnegative safe numeric values are explicit metadata, not a kind/eligibility guarantee.

Normal original/JXL choices express selected metadata effects, not automatic account configuration or codec conversion. With neither selected there is no empty JCP. A `.jxl` suffix does not automatically select a mode. The current MAIN AI/non-AI callers supply reference/decor only; the generic transform's ability to accept other flags does not establish a missing active-caller option in the existing AI helper.

### Wire, bounds and outcomes

Both helpers make one `file` service POST: `/api/message/forward`11199 with `toId`+IMEI, or `/api/group/forward`11818 with prefix-stripped `grid`+visibility and no IMEI. Common query plus account-AES form params carry numeric `msgType:2`, numeric `clientId`/TTL, `zsource:-1` and JSON-text `msgInfo`. Normal uses the eight-field source; non-AI retains its richer selected content. Reference is nested JSON text `{type:3,data:log}` (empty log supported); validated JSON-object `decorLogJson` stays exact outer text. There are no image bytes or album skeleton requests.

Inputs/source are ordinary own-data records with exactly the declared keys. Proxy/class/array/accessor/unknown keys reject fixed TypeError before dispatch. Null-prototype records work. Optional own undefined omits, except the documented native title/thumbnail/photoId defaults and pStickerType presence effect. All active strings are valid UTF8, generally limited to64KiB. Destination is positive decimal text up to40digits; group strips one lowercaseg. TTL/visibility are nonnegative safe numerics default0; direct defined visibility is invalid. Dimension numbers are nonnegative safe integers; null/empty or exact bounded safe decimal strings are retained. These are SDK policies, not provider limits.

Nonempty known locators are HTTP(S), without credentials, whitespace, controls or backslashes. Original spelling is preserved. Explicit decoded/case/legacy E2EE/PCloud session names and literal protected-session markers reject rather than being stripped into an ordinary source. JSON extensions are opaque metadata, not fetched resources. The genuine caller signal is privately bridged; its own accessors, methods and reason are not forwarded.

`PhotoForwardResult` contains exact usable string `msgId` and a shallow owned/frozen raw ACK. Unknown nested extras stay shared. Native source-derived convenience URLs are not fabricated as provider response fields. The ACK establishes neither delivery/rendering nor asset liveness, native cache commit or complete server schema.

`PhotoForwardError(code,submitted=false,outcomeUnknown=false,providerCode?,status?)` uses fixed fresh messages. The five codes are busy/aborted/unsupported-service/request-failed/submission-unknown. Only a current decoded safe nonzero provider refusal is known after handoff (`request-failed,true,false`); other submitted failures are unknown (`submission-unknown,true,true`). Cancellation is aborted with false/false before handoff or true/true afterward. A public/reused error or zero provider code does not prove current refusal. No raw source/URL/body/cause is copied into errors. A helper-only API/client-ID lease covers both new functions and releases on every terminal path; it does not coordinate older uploads/AI/GIF/file helpers or other processes. Reconcile unknown outcomes before choosing another explicit attempt.

HTTP200 and the shared redirect restriction apply before body qualification. Redirect-admission rejected readable bodies are cancelled when available; the HTTP201 decoder gate adds no separate cancellation promise. No new generic response-byte/default deadline guarantee is added. Local synthetic tests and strict public types are separate from live provider acceptance and recipient rendering, which remain unverified.

Source evidence is pinned installed Desktop26.11.10: SHARED12092336–12094818 normal projection,9226313–9227879 current non-AI helper,12458543–12460737 common transform/singular request, and MAIN1015411–1016282/1019103–1019685 normal policy/current non-AI caller. Legacy non-AI literals and current helpers differ; album member/skeleton state, rich share/clone/reupload, URL processing and multi-target workflows remain separate open work.
